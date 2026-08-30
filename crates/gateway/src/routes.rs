use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use mahoquot_types::{Health, PoolMember};

use crate::cp_routes;
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
        .route("/admin/usage", get(admin_usage_handler))
        .route("/admin/warmup", post(admin_warmup_handler))
        .route(
            "/admin/accounts/{id}/warmup",
            post(admin_warmup_one_handler),
        )
        .route("/admin/usage/refresh", post(admin_usage_refresh_handler))
        .route("/admin/accounts/{id}/reset", post(admin_reset_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/v1/completions", post(completions_handler))
        .route("/v1/messages", post(messages_handler))
        .route("/v1/messages/count_tokens", post(count_tokens_handler))
        .route(
            "/backend-api/codex/responses",
            get(cp_routes::ws_upgrade).post(codex_responses_handler),
        )
        .route(
            "/backend-api/codex/responses/compact",
            post(cp_routes::responses_compact),
        )
        .route(
            "/backend-api/codex/alpha/search",
            post(cp_routes::alpha_search),
        )
        .route(
            "/v1/responses",
            get(cp_routes::ws_upgrade).post(cp_routes::responses),
        )
        .route("/v1/responses/compact", post(cp_routes::responses_compact))
        .route("/v1/alpha/search", post(cp_routes::alpha_search))
        .route(
            "/v1/images/generations",
            post(cp_routes::images_generations),
        )
        .route("/v1/images/edits", post(cp_routes::images_edits))
        .route("/v1/videos", post(cp_routes::videos))
        .route("/v1/videos/generations", post(cp_routes::videos))
        .route("/v1/videos/edits", post(cp_routes::videos))
        .route("/v1/videos/extensions", post(cp_routes::videos))
        .route("/v1/videos/{request_id}", get(cp_routes::videos_by_id))
        .route("/openai/v1/videos", post(cp_routes::openai_videos))
        .route(
            "/openai/v1/videos/{video_id}",
            get(cp_routes::openai_videos),
        )
        .route(
            "/openai/v1/videos/{video_id}/content",
            get(cp_routes::openai_videos),
        )
        .route("/v1/live", post(cp_routes::realtime_offer))
        .route("/v1/live/{call_id}", get(cp_routes::live_sideband))
        .route(
            "/v1/realtime",
            get(cp_routes::ws_upgrade).post(cp_routes::realtime_offer),
        )
        .route("/v1/realtime/calls", post(cp_routes::realtime_offer))
        .route(
            "/v1/realtime/calls/{call_id}",
            get(cp_routes::realtime_call_get),
        )
        .route(
            "/v1/realtime/calls/{call_id}/hangup",
            post(cp_routes::realtime_hangup),
        )
        .route(
            "/v1/realtime/calls/{call_id}/{action}",
            post(cp_routes::realtime_sip),
        )
        .route(
            "/v1/realtime/client_secrets",
            post(cp_routes::realtime_client_secrets),
        )
        .route("/v1/realtime/sessions", post(cp_routes::realtime_sessions))
        .route(
            "/v1/realtime/transcription_sessions",
            post(cp_routes::realtime_transcription),
        )
        .route(
            "/v1/realtime/translations",
            get(cp_routes::realtime_translations).post(cp_routes::realtime_translations),
        )
        .route(
            "/v1/realtime/translations/client_secrets",
            post(cp_routes::realtime_translations),
        )
        .route("/v1beta/models", get(cp_routes::v1beta_models))
        .route(
            "/v1beta/models/{*action}",
            get(cp_routes::v1beta_action).post(cp_routes::v1beta_action),
        )
        .route("/v1beta/interactions", post(cp_routes::v1beta_interactions))
        .layer(from_fn_with_state(state.api_keys.clone(), require_api_key));

    // Public surface: Prometheus scrapers and liveness probes never send credentials,
    // and CLIProxyAPI exposes its metrics endpoint unauthenticated too.
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/metrics", get(metrics_handler))
        .route("/", get(cp_routes::root))
        .route("/management.html", get(cp_routes::management_html))
        .route("/anthropic/callback", get(cp_routes::oauth_callback))
        .route("/codex/callback", get(cp_routes::oauth_callback))
        .route("/antigravity/callback", get(cp_routes::oauth_callback))
        .route(
            "/v0/management/oauth-callback",
            get(crate::management::oauth::oauth_callback)
                .post(crate::management::oauth::oauth_callback),
        )
        .nest(
            "/v0/management",
            crate::management::management_router(Arc::clone(&state)),
        )
        .merge(authed_routes)
        .layer(from_fn(cors))
        .with_state(state)
}

/// CP answers every route with wildcard CORS and short-circuits preflight with
/// 204, so browser clients pointed at either proxy behave identically.
async fn cors(method: Method, req: axum::extract::Request, next: Next) -> Response {
    let mut response = if method == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        // WebKit does not honor a wildcard for Authorization, so the desktop
        // webview console needs it named explicitly.
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

async fn healthz_handler() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
}

async fn models_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Json(models_payload(&state.pool.load().models, now_unix))
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let accounts: Vec<PromAccount> = state
        .pool
        .load()
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

async fn admin_usage_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.get_stats())
}

async fn admin_warmup_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({ "results": crate::warmup::warm_all(&state).await }))
}

async fn admin_warmup_one_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.find_member(&id) {
        Some(member) => Json(crate::warmup::warm_account(&state, &member).await).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown account" })),
        )
            .into_response(),
    }
}

async fn admin_usage_refresh_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    crate::quota::refresh_all_usage(&state).await;
    Json(state.get_stats())
}

async fn admin_reset_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let Some(member) = state.find_member(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown account" })),
        )
            .into_response();
    };
    match crate::quota::consume_reset_credit(&state, &member).await {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "id": id,
            "usage": member.usage_snapshot(),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
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
        RelayMode::LegacyCompletions,
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
