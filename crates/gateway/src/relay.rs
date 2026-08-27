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
use crate::state::AppState;
use crate::url::build_target_url;

struct FinalFailure {
    status: StatusCode,
    content_type: Option<String>,
    body: Bytes,
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

pub async fn handle_relay(
    state: Arc<AppState>,
    req_path: &str,
    headers: &HeaderMap,
    body_bytes: Bytes,
) -> Response {
    let _in_flight = state.monitor.track_in_flight();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);

    let available_count = state
        .pool_members
        .iter()
        .filter(|m| m.health().is_available(now_ms))
        .count();

    let max_attempts = std::cmp::min(available_count, state.max_failover);
    if max_attempts == 0 {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("Content-Type", "application/json")],
            r#"{"error":"no available accounts"}"#,
        )
            .into_response();
    }

    let mut last_failure: Option<FinalFailure> = None;
    let hint = SessionHint::default();

    for _ in 0..max_attempts {
        let chosen_idx = match state.router.select(&state.pool_members, &hint) {
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

        let target_url = build_target_url(member.upstream_override.as_deref(), req_path);
        let mut resp = match send_upstream(&state, &target_url, &member, headers, &body_bytes).await
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
                    match send_upstream(&state, &target_url, &member, headers, &body_bytes).await {
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
            member.record_ok();
            state.metrics.served.fetch_add(1, Ordering::Relaxed);
            state.router.feedback(member.id(), Outcome::Success);
            return stream_response(resp, status_code);
        }

        if status_code == 429 || (500..=504).contains(&status_code) {
            last_failure = Some(record_cooldown(resp, &member, status_code, &state).await);
            continue;
        }

        if status_code == 401 || status_code == 403 {
            last_failure = Some(record_auth_failure(resp, &member, status_code, &state).await);
            continue;
        }

        state
            .metrics
            .exposed_client_errors
            .fetch_add(1, Ordering::Relaxed);
        state
            .monitor
            .record_error(member.id(), status_code, "client error");

        let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_REQUEST);
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(ToString::to_string);
        let body = resp.bytes().await.unwrap_or_default();
        return body_response(status, ct.as_deref(), body);
    }

    state.metrics.exposed_errors.fetch_add(1, Ordering::Relaxed);

    if let Some(final_fail) = last_failure {
        body_response(
            final_fail.status,
            final_fail.content_type.as_deref(),
            final_fail.body,
        )
    } else {
        (
            StatusCode::BAD_GATEWAY,
            [("Content-Type", "application/json")],
            r#"{"error":"all failover attempts failed"}"#,
        )
            .into_response()
    }
}
