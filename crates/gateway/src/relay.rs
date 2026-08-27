use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use quotio_types::{Health, Outcome, PoolMember, SessionHint};

use crate::state::AppState;
use crate::url::build_target_url;

struct FinalFailure {
    status: StatusCode,
    content_type: Option<String>,
    body: Bytes,
}

pub async fn handle_relay(
    state: Arc<AppState>,
    req_path: &str,
    headers: &HeaderMap,
    body_bytes: Bytes,
) -> Response {
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

        let target_url = build_target_url(member.upstream_override.as_deref(), req_path);
        let mut req_builder = state.http_client.post(&target_url);

        for (name, val) in member.inner.build_upstream_headers() {
            req_builder = req_builder.header(name, val);
        }

        if let Some(ct) = headers.get(header::CONTENT_TYPE) {
            if let Ok(val) = ct.to_str() {
                req_builder = req_builder.header(header::CONTENT_TYPE.as_str(), val);
            }
        }

        let resp = match req_builder.body(body_bytes.clone()).send().await {
            Ok(r) => r,
            Err(_) => {
                member.record_fail();
                state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        let status_code = resp.status().as_u16();

        if (200..=399).contains(&status_code) {
            member.record_ok();
            state.metrics.served.fetch_add(1, Ordering::Relaxed);
            state.router.feedback(member.id(), Outcome::Success);

            let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
            let mut res_builder = Response::builder().status(status);

            if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
                if let Ok(v) = HeaderValue::from_bytes(ct.as_bytes()) {
                    res_builder = res_builder.header(header::CONTENT_TYPE, v);
                }
            }

            let stream = resp.bytes_stream();
            let body = Body::from_stream(stream);
            return res_builder.body(body).unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
            });
        }

        if status_code == 429
            || status_code == 500
            || status_code == 502
            || status_code == 503
            || status_code == 504
        {
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

            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let body = resp.bytes().await.unwrap_or_default();
            last_failure = Some(FinalFailure {
                status: StatusCode::from_u16(status_code)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                content_type,
                body,
            });
            continue;
        }

        if status_code == 401 || status_code == 403 {
            member.set_health(Health::AuthFailed);
            member.record_fail();
            state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);

            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let body = resp.bytes().await.unwrap_or_default();
            last_failure = Some(FinalFailure {
                status: StatusCode::from_u16(status_code).unwrap_or(StatusCode::UNAUTHORIZED),
                content_type,
                body,
            });
            continue;
        }

        // Other status codes (e.g. 400 Bad Request) - exposed client errors
        state
            .metrics
            .exposed_client_errors
            .fetch_add(1, Ordering::Relaxed);
        let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_REQUEST);
        let mut res_builder = Response::builder().status(status);

        if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
            if let Ok(v) = HeaderValue::from_bytes(ct.as_bytes()) {
                res_builder = res_builder.header(header::CONTENT_TYPE, v);
            }
        }

        let body = resp.bytes().await.unwrap_or_default();
        return res_builder
            .body(Body::from(body))
            .unwrap_or_else(|_| (status, "error").into_response());
    }

    state.metrics.exposed_errors.fetch_add(1, Ordering::Relaxed);

    if let Some(final_fail) = last_failure {
        let mut res_builder = Response::builder().status(final_fail.status);
        if let Some(ct) = final_fail.content_type {
            if let Ok(v) = HeaderValue::from_str(&ct) {
                res_builder = res_builder.header(header::CONTENT_TYPE, v);
            }
        }
        res_builder
            .body(Body::from(final_fail.body))
            .unwrap_or_else(|_| (final_fail.status, "error").into_response())
    } else {
        (
            StatusCode::BAD_GATEWAY,
            [("Content-Type", "application/json")],
            r#"{"error":"all failover attempts failed"}"#,
        )
            .into_response()
    }
}
