// allow: SIZE_OK — single-loop failover relay state machine with auth refresh, retry, and in-flight tracking

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use quotio_types::{Health, Outcome, PoolMember, SessionHint};

use crate::account::AccountMember;
use crate::compat;
use crate::usage::parse_codex_headers;
use crate::state::AppState;
use crate::url::build_target_url;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RelayMode {
    Native,
    OpenAiCompat,
    Anthropic,
}

struct FinalFailure {
    status: StatusCode,
    content_type: Option<String>,
    body: Bytes,
}

struct RelayPlan {
    upstream_path: String,
    body: Bytes,
    model: Option<String>,
    mode: RelayMode,
    client_stream: bool,
    include_usage: bool,
    openai_body: Option<serde_json::Value>,
}

struct UpstreamTarget {
    url: String,
    body: Bytes,
    protocol: compat::Protocol,
}

fn resolve_target(member: &AccountMember, plan: &RelayPlan) -> Result<UpstreamTarget, String> {
    if member.kind() != crate::account::ProviderKind::Antigravity {
        return Ok(UpstreamTarget {
            url: build_target_url(member.upstream_override.as_deref(), &plan.upstream_path),
            body: plan.body.clone(),
            protocol: compat::Protocol::Codex,
        });
    }

    let openai_body = plan
        .openai_body
        .as_ref()
        .ok_or_else(|| "antigravity requires an openai-shaped request".to_string())?;
    let project = member
        .project_id()
        .ok_or_else(|| "antigravity account missing project_id".to_string())?;
    let translated = compat::openai_to_antigravity(openai_body, &project)?;

    Ok(UpstreamTarget {
        url: crate::url::build_antigravity_url(member.upstream_override.as_deref()),
        body: Bytes::from(translated.to_string()),
        protocol: compat::Protocol::Antigravity,
    })
}

async fn send_upstream(
    state: &AppState,
    target_url: &str,
    member: &AccountMember,
    headers: &HeaderMap,
    body_bytes: &Bytes,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut req_builder = state.http_client.post(target_url);
    for (name, val) in member.build_upstream_headers() {
        req_builder = req_builder.header(name, val);
    }
    if let Some(ct) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        req_builder = req_builder.header(header::CONTENT_TYPE.as_str(), ct);
    }
    let req_start = std::time::Instant::now();
    let resp = req_builder.body(body_bytes.clone()).send().await?;
    let elapsed_ms = req_start.elapsed().as_secs_f64() * 1000.0;
    state.monitor.record_ttft(member.id(), elapsed_ms);
    Ok(resp)
}

async fn extract_failure(resp: reqwest::Response, status_code: u16) -> FinalFailure {
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string);
    let body = resp.bytes().await.unwrap_or_default();
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    FinalFailure {
        status,
        content_type,
        body,
    }
}

async fn record_cooldown(
    resp: reqwest::Response,
    member: &AccountMember,
    status_code: u16,
    state: &AppState,
) -> FinalFailure {
    let retry_after_secs = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(300);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    member.set_health(Health::Cooldown {
        until_unix_ms: now_ms + retry_after_secs * 1000,
    });
    member.record_fail();
    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
    state
        .monitor
        .record_error(member.id(), status_code, "upstream error");
    extract_failure(resp, status_code).await
}

async fn record_auth_failure(
    resp: reqwest::Response,
    member: &AccountMember,
    status_code: u16,
    state: &AppState,
) -> FinalFailure {
    member.set_health(Health::AuthFailed);
    member.record_fail();
    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
    state
        .monitor
        .record_error(member.id(), status_code, "auth failed");
    extract_failure(resp, status_code).await
}

fn content_type_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string)
}

fn stream_response(resp: reqwest::Response, status_code: u16) -> Response {
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
    let mut res_builder = Response::builder().status(status);
    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        if let Ok(v) = HeaderValue::from_bytes(ct.as_bytes()) {
            res_builder = res_builder.header(header::CONTENT_TYPE, v);
        }
    }
    res_builder
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
        })
}

fn body_response(status: StatusCode, content_type: Option<&str>, body: Bytes) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = content_type {
        if let Ok(v) = HeaderValue::from_str(ct) {
            builder = builder.header(header::CONTENT_TYPE, v);
        }
    }
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| (status, "error").into_response())
}

fn json_error(status: StatusCode, message: &str) -> Response {
    let payload = serde_json::json!({
        "error": {"message": message, "type": "invalid_request_error"}
    });
    body_response(
        status,
        Some("application/json"),
        Bytes::from(payload.to_string()),
    )
}

fn is_account_scoped_model_rejection(status_code: u16, body: &[u8]) -> bool {
    if status_code != 400 {
        return false;
    }
    let text = String::from_utf8_lossy(body);
    text.contains("is not supported when using Codex") || text.contains("model is not supported")
}

fn build_plan(
    mode: RelayMode,
    req_path: &str,
    body_bytes: Bytes,
    restricted: bool,
) -> Result<RelayPlan, String> {
    match mode {
        RelayMode::Native => Ok(RelayPlan {
            upstream_path: req_path.to_string(),
            model: if restricted {
                compat::extract_model(&body_bytes)
            } else {
                None
            },
            body: body_bytes,
            mode,
            client_stream: true,
            include_usage: false,
            openai_body: None,
        }),
        RelayMode::Anthropic => {
            let anthropic: serde_json::Value = serde_json::from_slice(&body_bytes)
                .map_err(|e| format!("invalid anthropic request: {e}"))?;
            let openai = compat::anthropic_to_openai(&anthropic)?;
            let openai_bytes = Bytes::from(openai.to_string());
            let translated =
                compat::openai_to_codex(&openai_bytes).map_err(|e| e.to_string())?;
            Ok(RelayPlan {
                upstream_path: compat::CODEX_PATH.to_string(),
                body: Bytes::from(translated.body),
                model: Some(translated.model),
                mode,
                client_stream: translated.stream,
                include_usage: translated.include_usage,
                openai_body: Some(openai),
            })
        }
        RelayMode::OpenAiCompat => match compat::openai_to_codex(&body_bytes) {
            Ok(translated) => Ok(RelayPlan {
                upstream_path: compat::CODEX_PATH.to_string(),
                body: Bytes::from(translated.body),
                model: Some(translated.model),
                mode,
                client_stream: translated.stream,
                include_usage: translated.include_usage,
                openai_body: serde_json::from_slice(&body_bytes).ok(),
            }),
            Err(err) => Err(err.to_string()),
        },
    }
}

fn eligible_indices(state: &AppState, model: Option<&str>, now_ms: i64) -> Vec<usize> {
    state
        .members
        .iter()
        .enumerate()
        .filter(|(_, m)| m.health().is_available(now_ms))
        .filter(|(_, m)| model.is_none_or(|model| m.supports_model(model)))
        .map(|(i, _)| i)
        .collect()
}

fn select_index(state: &AppState, hint: &SessionHint, model: Option<&str>) -> Option<usize> {
    let restricted = state.model_restrictions.load(Ordering::Relaxed);
    let Some(model) = model.filter(|_| restricted) else {
        return state.router.select(&state.pool_members, hint);
    };

    let mut candidates: Vec<Arc<dyn PoolMember>> = Vec::with_capacity(state.members.len());
    let mut origin: Vec<usize> = Vec::with_capacity(state.members.len());
    for (index, member) in state.members.iter().enumerate() {
        if member.supports_model(model) {
            candidates.push(state.pool_members[index].clone());
            origin.push(index);
        }
    }
    state
        .router
        .select(&candidates, hint)
        .and_then(|idx| origin.get(idx).copied())
}

/// Codex reports quota state on every response; antigravity sends none, so its
/// accounts stay "unknown" rather than being reported as having full quota.
fn capture_usage(member: &AccountMember, headers: &HeaderMap) {
    if member.kind() != crate::account::ProviderKind::Codex {
        return;
    }
    let map: std::collections::HashMap<String, String> = headers
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str();
            if !name.starts_with("x-codex-") {
                return None;
            }
            Some((name.to_string(), v.to_str().ok()?.to_string()))
        })
        .collect();
    if map.is_empty() {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    member.set_usage(parse_codex_headers(&map, now));
}

async fn finish_success(
    state: &AppState,
    member: &AccountMember,
    plan: &RelayPlan,
    resp: reqwest::Response,
    status_code: u16,
    created: i64,
    protocol: compat::Protocol,
) -> Result<Response, String> {
    let content_type = content_type_of(&resp);
    capture_usage(member, resp.headers());

    if plan.mode == RelayMode::Native {
        if content_type
            .as_deref()
            .is_some_and(|ct| ct.trim_start().starts_with("text/html"))
        {
            return Err("upstream returned html instead of an api response".to_string());
        }
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(stream_response(resp, status_code));
    }

    if content_type
        .as_deref()
        .is_some_and(|ct| ct.trim_start().starts_with("text/html"))
    {
        return Err("upstream body is not an event stream: html response".to_string());
    }

    let (first, stream) = compat::open_stream(resp).await?;
    let model = plan.model.clone().unwrap_or_default();

    if plan.mode == RelayMode::Anthropic {
        let raw = compat::collect_stream(first, stream).await?;
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(compat::anthropic_response(
            &raw,
            &model,
            created,
            protocol,
            plan.client_stream,
        ));
    }

    if plan.client_stream {
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        let body = compat::streaming_body(
            first,
            stream,
            model,
            created,
            plan.include_usage,
            protocol,
        );
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body)
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
            }));
    }

    let raw = compat::collect_stream(first, stream).await?;
    let completion = compat::aggregate(&raw, model, created, protocol)?;
    member.record_ok();
    state.metrics.served.fetch_add(1, Ordering::Relaxed);
    state.router.feedback(member.id(), Outcome::Success);
    Ok(body_response(
        StatusCode::OK,
        Some("application/json"),
        Bytes::from(completion.to_string()),
    ))
}

/// Identify the conversation a request belongs to, so successive turns keep
/// landing on the same upstream account. Codex and Anthropic clients both send a
/// stable per-session id; without one the request routes by plain round-robin.
fn affinity_key(headers: &HeaderMap) -> Option<String> {
    for name in [
        "session_id",
        "x-session-id",
        "conversation_id",
        "x-conversation-id",
        "anthropic-client-session",
    ] {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub async fn handle_relay(
    state: Arc<AppState>,
    mode: RelayMode,
    req_path: &str,
    headers: &HeaderMap,
    body_bytes: Bytes,
) -> Response {
    let _in_flight = state.monitor.track_in_flight();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let created = now_ms / 1000;

    let restricted = state.model_restrictions.load(Ordering::Relaxed);
    let plan = match build_plan(mode, req_path, body_bytes, restricted) {
        Ok(plan) => plan,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
    };

    let available_count = eligible_indices(&state, plan.model.as_deref(), now_ms).len();
    let max_attempts = std::cmp::min(available_count, state.max_failover);
    if max_attempts == 0 {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no available accounts for this model",
        );
    }

    let mut last_failure: Option<FinalFailure> = None;
    let hint = SessionHint {
        affinity_key: affinity_key(headers),
    };

    for _ in 0..max_attempts {
        let chosen_idx = match select_index(&state, &hint, plan.model.as_deref()) {
            Some(idx) => idx,
            None => break,
        };
        let member = match state.members.get(chosen_idx) {
            Some(m) => m.clone(),
            None => break,
        };

        let mut refreshed_this_account = false;
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let member_at = member.access_token();

        if state.auth_refresh_enabled && member.is_expired(now_unix) {
            match state.refresh_member(&member, None).await {
                Ok(_) => refreshed_this_account = true,
                Err(e) => {
                    member.set_health(Health::AuthFailed);
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state
                        .monitor
                        .record_error(member.id(), 401, &format!("refresh failed: {e}"));
                    continue;
                }
            }
        }

        let target = match resolve_target(&member, &plan) {
            Ok(t) => t,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
        };
        let target_url = target.url;
        let mut resp = match send_upstream(&state, &target_url, &member, headers, &target.body).await
        {
            Ok(r) => r,
            Err(e) => {
                member.record_fail();
                state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                state
                    .monitor
                    .record_error(member.id(), 502, &format!("request error: {e}"));
                continue;
            }
        };

        let mut status_code = resp.status().as_u16();

        if (status_code == 401 || status_code == 403)
            && state.auth_refresh_enabled
            && !refreshed_this_account
        {
            match state.refresh_member(&member, Some(&member_at)).await {
                Ok(_) => {
                    match send_upstream(&state, &target_url, &member, headers, &target.body).await {
                        Ok(retry_resp) => {
                            resp = retry_resp;
                            status_code = resp.status().as_u16();
                        }
                        Err(e) => {
                            member.set_health(Health::AuthFailed);
                            member.record_fail();
                            state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                            state.monitor.record_error(
                                member.id(),
                                502,
                                &format!("retry error: {e}"),
                            );
                            continue;
                        }
                    }
                }
                Err(e) => {
                    member.set_health(Health::AuthFailed);
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state.monitor.record_error(
                        member.id(),
                        status_code,
                        &format!("refresh failed: {e}"),
                    );
                    last_failure = Some(extract_failure(resp, status_code).await);
                    continue;
                }
            }
        }

        if (200..=399).contains(&status_code) {
            match finish_success(
                &state,
                &member,
                &plan,
                resp,
                status_code,
                created,
                target.protocol,
            )
            .await
            {
                Ok(response) => return response,
                Err(reason) => {
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state.monitor.record_error(member.id(), 502, &reason);
                    last_failure = Some(FinalFailure {
                        status: StatusCode::BAD_GATEWAY,
                        content_type: Some("application/json".to_string()),
                        body: Bytes::from(
                            serde_json::json!({"error": {"message": reason, "type": "upstream_error"}})
                                .to_string(),
                        ),
                    });
                    continue;
                }
            }
        }

        if status_code == 429 || (500..=504).contains(&status_code) {
            last_failure = Some(record_cooldown(resp, &member, status_code, &state).await);
            continue;
        }

        if status_code == 401 || status_code == 403 {
            last_failure = Some(record_auth_failure(resp, &member, status_code, &state).await);
            continue;
        }

        let failure = extract_failure(resp, status_code).await;

        if let Some(model) = plan.model.as_deref() {
            if is_account_scoped_model_rejection(status_code, &failure.body) {
                member.mark_model_unsupported(model);
                state.model_restrictions.store(true, Ordering::Relaxed);
                member.record_fail();
                state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                state.monitor.record_error(
                    member.id(),
                    status_code,
                    "model not supported by account",
                );
                last_failure = Some(failure);
                continue;
            }
        }

        state
            .metrics
            .exposed_client_errors
            .fetch_add(1, Ordering::Relaxed);
        state
            .monitor
            .record_error(member.id(), status_code, "client error");
        return body_response(
            failure.status,
            failure.content_type.as_deref(),
            failure.body,
        );
    }

    state.metrics.exposed_errors.fetch_add(1, Ordering::Relaxed);

    match last_failure {
        Some(final_fail) => body_response(
            final_fail.status,
            final_fail.content_type.as_deref(),
            final_fail.body,
        ),
        None if plan.mode == RelayMode::OpenAiCompat && plan.client_stream => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(compat::error_stream_body("all failover attempts failed"))
            .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "upstream failure").into_response()),
        None => json_error(StatusCode::BAD_GATEWAY, "all failover attempts failed"),
    }
}
