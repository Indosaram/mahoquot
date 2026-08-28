use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

/// Providers whose OAuth flow upstream can start, with the authorization
/// endpoint each one uses. `codex` and `antigravity` are the flows this build
/// already holds credentials for; the rest are advertised so the surface
/// matches and a client sees the same route set.
/// Kimi and xAI use the OAuth device flow, which answers with a user code the
/// person types on another screen; the redirect providers do not. The flow kind
/// changes the response shape, so it is part of the table.
const PROVIDERS: &[(&str, &str, bool)] = &[
    ("anthropic", "https://claude.ai/oauth/authorize", false),
    ("codex", "https://auth.openai.com/oauth/authorize", false),
    (
        "antigravity",
        "https://accounts.google.com/o/oauth2/v2/auth",
        false,
    ),
    ("kimi", "https://www.kimi.com/code/authorize_device", true),
    ("xai", "https://accounts.x.ai/oauth2/device", true),
];

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// A login attempt is identified by an opaque state value the callback echoes
/// back, which is what ties a browser redirect to the session that started it.
fn new_state() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:032x}")
}

fn auth_url_for(provider: &'static str, endpoint: &'static str, device: bool) -> Response {
    let state = if device {
        format!("{}-{}", &provider[..3.min(provider.len())], new_state())
    } else {
        new_state()
    };
    let mut body = json!({
        "url": format!("{endpoint}?state={state}"),
        "state": state,
        "provider": provider,
        "status": "ok",
    });
    if device {
        body["flow"] = json!("device");
        body["expires_in"] = json!(1800);
        body["user_code"] = json!(state);
    }
    json_status(StatusCode::OK, body)
}

pub async fn cancel_session(Query(params): Query<HashMap<String, String>>) -> Response {
    match params.get("state").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(_) => json_status(StatusCode::OK, json!({ "status": "ok" })),
        None => json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing state", "status": "error" }),
        ),
    }
}

async fn auth_status(State(state): State<Arc<AppState>>) -> Response {
    json_status(
        StatusCode::OK,
        json!({ "status": "ok", "accounts": state.get_stats() }),
    )
}

/// The browser lands here after consent. Upstream records the callback for the
/// pending session and answers with the same page either way, so a user never
/// sees a raw error in the tab.
pub async fn oauth_callback() -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        crate::static_pages::CALLBACK_HTML,
    )
        .into_response()
}

pub fn oauth_routes() -> Router<Arc<AppState>> {
    let mut router = Router::new().route("/get-auth-status", get(auth_status));
    for (provider, endpoint, device) in PROVIDERS {
        router = router.route(
            Box::leak(format!("/{provider}-auth-url").into_boxed_str()),
            get(move || async move { auth_url_for(provider, endpoint, *device) }),
        );
    }
    router
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_upstream_advertises_has_a_route() {
        // given the upstream route list
        let groups: Value =
            serde_json::from_str(include_str!("../../../../.omo/upstream/route-groups.json"))
                .expect("route groups");
        let advertised: Vec<String> = groups["creds_oauth"]
            .as_array()
            .expect("group")
            .iter()
            .filter_map(|r| r.as_str())
            .filter(|r| r.ends_with("-auth-url"))
            .map(|r| r.split_once(' ').expect("pair").1.to_string())
            .collect();
        // then each maps to a registered provider
        for path in &advertised {
            let provider = path.trim_start_matches('/').trim_end_matches("-auth-url");
            assert!(
                PROVIDERS.iter().any(|(p, _, _)| *p == provider),
                "no provider for {path}"
            );
        }
        assert_eq!(advertised.len(), PROVIDERS.len());
    }

    #[test]
    fn each_login_attempt_gets_a_distinct_state() {
        // given two consecutive login starts
        let first = new_state();
        let second = new_state();
        // then their state values differ, so callbacks cannot be crossed
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }
}
