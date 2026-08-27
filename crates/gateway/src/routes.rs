use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;

use crate::relay::handle_relay;
use crate::state::AppState;

pub fn create_app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/admin/stats", get(admin_stats_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route(
            "/backend-api/codex/responses",
            post(codex_responses_handler),
        )
        .with_state(state)
}

async fn healthz_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn admin_stats_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.get_stats())
}

async fn chat_completions_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_relay(state, "/v1/chat/completions", &headers, body).await
}

async fn codex_responses_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_relay(state, "/backend-api/codex/responses", &headers, body).await
}
