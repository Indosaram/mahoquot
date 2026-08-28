use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::auth::{presented_key, AuthOutcome};
use crate::state::AppState;

/// Identity headers CLIProxyAPI stamps on every management response. Values
/// track the release this surface mirrors so a client cannot tell the two
/// proxies apart; `capability.rs` and `cp_routes.rs` pin the same version.
const CPA_VERSION: &str = "7.2.140";
const CPA_COMMIT: &str = "a7e3596b";
const CPA_BUILD_DATE: &str = "2026-08-22T14:51:09Z";
const CPA_SUPPORT_PLUGIN: &str = "1";

const EXPOSE_HEADERS: &str = "X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id";

pub fn cpa_version() -> &'static str {
    CPA_VERSION
}

fn stamp(headers: &mut HeaderMap) {
    headers.insert("X-CPA-VERSION", HeaderValue::from_static(CPA_VERSION));
    headers.insert("X-CPA-COMMIT", HeaderValue::from_static(CPA_COMMIT));
    headers.insert("X-CPA-BUILD-DATE", HeaderValue::from_static(CPA_BUILD_DATE));
    headers.insert(
        "X-CPA-SUPPORT-PLUGIN",
        HeaderValue::from_static(CPA_SUPPORT_PLUGIN),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message });
    let mut response = (status, axum::Json(body)).into_response();
    stamp(response.headers_mut());
    response
}

/// Availability + authentication for `/v0/management`, in upstream's order.
///
/// Upstream answers **404** when the surface is switched off, so a build with
/// no management secret is indistinguishable from one that never registered
/// the routes. Only once available does authentication run, which answers 403
/// for a caller who may not use the surface at all and 401 for a bad key.
/// Collapsing these into one status would be observably different.
pub async fn require_management_access(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let auth = state.management_auth();

    if !auth.is_enabled() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let ip = peer.ip();
    let provided = presented_key(req.headers());
    let outcome = state
        .management_attempts
        .authenticate(&auth, &ip.to_string(), ip.is_loopback(), &provided);

    match outcome {
        AuthOutcome::Allow => {
            let mut response = next.run(req).await;
            stamp(response.headers_mut());
            response
        }
        AuthOutcome::Unauthorized(message) => error_response(StatusCode::UNAUTHORIZED, message),
        AuthOutcome::Forbidden(message) => error_response(StatusCode::FORBIDDEN, &message),
    }
}
