use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use quotio_types::{Health, PoolMember};

use crate::inbound::require_api_key;
use crate::models_route::models_payload;
use crate::monitor::PromAccount;
use crate::relay::{handle_relay, RelayMode};
use crate::state::AppState;

pub fn create_app(state: Arc<AppState>) -> Router {
    // /admin/stats stays behind the key: it exposes account emails and reset times.
    let authed_routes = Router::new()
        .route("/v1/models", get(models_handler))
        .route("/admin/stats", get(admin_stats_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/v1/completions", post(completions_handler))
        .route("/v1/messages", post(messages_handler))
        .route("/v1/messages/count_tokens", post(count_tokens_handler))
        .route(
            "/backend-api/codex/responses",
            post(codex_responses_handler),
        )
        .layer(from_fn_with_state(state.api_keys.clone(), require_api_key));

    // Public surface: Prometheus scrapers and liveness probes never send credentials,
    // and CLIProxyAPI exposes its metrics endpoint unauthenticated too.
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/metrics", get(metrics_handler))
        .merge(authed_routes)
        .with_state(state)
}

async fn healthz_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn models_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Json(models_payload(&state.models, now_unix))
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let accounts: Vec<PromAccount> = state
        .members
        .iter()
        .map(|m| {
            let cooldown_until_unix_ms = match m.health() {
                Health::Cooldown { until_unix_ms } => Some(until_unix_ms),
                _ => None,
            };
            PromAccount {
                id: m.id.clone(),
                ok: m.ok_count.load(Ordering::Relaxed),
                fails: m.fail_count.load(Ordering::Relaxed),
                cooldown_until_unix_ms,
            }
        })
        .collect();

    let body = state.monitor.render_prometheus(now_unix_ms, &accounts);
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

async fn admin_stats_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.get_stats())
}

async fn chat_completions_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_relay(
        state,
        RelayMode::OpenAiCompat,
        "/v1/chat/completions",
        &headers,
        body,
    )
    .await
}

async fn messages_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_relay(state, RelayMode::Anthropic, "/v1/messages", &headers, body).await
}

async fn count_tokens_handler(body: Bytes) -> Response {
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "type": "error",
                    "error": { "type": "invalid_request_error", "message": e.to_string() }
                })),
            )
                .into_response()
        }
    };
    Json(serde_json::json!({
        "input_tokens": crate::compat::estimate_input_tokens(&parsed)
    }))
    .into_response()
}

/// Legacy text-completions clients send `prompt`; lift it into the chat shape
/// so one relay path serves both surfaces.
async fn completions_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": { "message": e.to_string() } })),
            )
                .into_response()
        }
    };

    let prompt = parsed
        .get("prompt")
        .and_then(|p| match p {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(items) => Some(
                items
                    .iter()
                    .filter_map(|i| i.as_str())
                    .collect::<Vec<_>>()
                    .join(""),
            ),
            _ => None,
        })
        .unwrap_or_default();

    let mut chat = parsed.clone();
    if let Some(obj) = chat.as_object_mut() {
        obj.remove("prompt");
        obj.insert(
            "messages".to_string(),
            serde_json::json!([{ "role": "user", "content": prompt }]),
        );
    }

    handle_relay(
        state,
        RelayMode::OpenAiCompat,
        "/v1/chat/completions",
        &headers,
        Bytes::from(chat.to_string()),
    )
    .await
}

async fn codex_responses_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_relay(
        state,
        RelayMode::Native,
        "/backend-api/codex/responses",
        &headers,
        body,
    )
    .await
}
