use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

async fn get_config(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    match serde_json::to_value(&*settings) {
        Ok(value) => json_status(StatusCode::OK, redact(value)),
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "encode_failed", "message": err.to_string() }),
        ),
    }
}

/// The management secret must never leave the process: upstream tags
/// RemoteManagement `json:"-"` so `GET /config` omits it entirely.
fn redact(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.remove("remote-management");
    }
    value
}

async fn get_config_yaml(State(state): State<Arc<AppState>>) -> Response {
    let path = state.settings.path();
    match std::fs::read_to_string(path) {
        Ok(raw) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
            raw,
        )
            .into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => json_status(
            StatusCode::NOT_FOUND,
            json!({ "error": "not_found", "message": "config file not found" }),
        ),
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "read_failed", "message": err.to_string() }),
        ),
    }
}

async fn put_config_yaml(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let Ok(text) = std::str::from_utf8(&raw) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_yaml", "message": "cannot read request body" }),
        );
    };
    let parsed = match super::settings::Settings::from_yaml(text) {
        Ok(parsed) => parsed,
        Err(err) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": "invalid_yaml", "message": err.to_string() }),
            )
        }
    };
    match state.settings.mutate(|current| *current = parsed) {
        // Upstream reports which document sections it rewrote, and a
        // whole-config write is always reported as the single "config"
        // section regardless of what actually differed.
        Ok(_) => json_status(StatusCode::OK, json!({ "ok": true, "changed": ["config"] })),
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("failed to save config: {err}") }),
        ),
    }
}

async fn get_latest_version() -> Response {
    json_status(
        StatusCode::OK,
        json!({ "latest-version": format!("v{}", super::gate::cpa_version()) }),
    )
}

async fn reset_quota(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid request body" }),
        );
    };
    let auth_index = body
        .get("auth_index")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if auth_index.is_empty() {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "auth_index is required" }),
        );
    }
    // Callers address an account by the opaque handle `GET /auth-files`
    // publishes, so resolve that back to the credential the pool knows before
    // falling back to treating the value as a direct account identifier.
    let resolved = super::creds::resolve_auth_index(&state, &auth_index);
    let by_file = resolved.as_deref().and_then(|file_name| {
        state
            .pool
            .load()
            .members
            .iter()
            .find(|m| {
                m.file_path
                    .file_name()
                    .map(|n| n.to_string_lossy() == file_name)
                    .unwrap_or(false)
            })
            .cloned()
    });
    let Some(member) = by_file.or_else(|| state.find_member(&auth_index)) else {
        return json_status(StatusCode::NOT_FOUND, json!({ "error": "auth not found" }));
    };
    match crate::quota::consume_reset_credit(&state, &member).await {
        Ok(()) => json_status(
            StatusCode::OK,
            json!({
                "status": "ok",
                "auth_index": auth_index,
                "models": member.usage_snapshot(),
            }),
        ),
        // A provider without a resettable window is not a failure: upstream
        // answers 200 with an empty model list, so the caller sees the same
        // outcome whether or not this provider tracks a 5h quota.
        Err(_) => json_status(
            StatusCode::OK,
            json!({ "status": "ok", "auth_index": auth_index, "models": Value::Array(vec![]) }),
        ),
    }
}

/// Upstream proxies an arbitrary upstream call here. Without a configured
/// target this build has nothing to forward to, and upstream answers the same
/// way when its own auth manager is unavailable.
async fn api_call(raw: bytes::Bytes) -> Response {
    let parsed = serde_json::from_slice::<Value>(&raw).unwrap_or(Value::Null);
    let has_method = parsed
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|m| !m.trim().is_empty());
    if !has_method {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing method" }),
        );
    }
    json_status(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": "core auth manager unavailable" }),
    )
}

pub fn core_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/config", get(get_config))
        .route("/config.yaml", get(get_config_yaml).put(put_config_yaml))
        .route("/latest-version", get(get_latest_version))
        .route("/api-call", post(api_call))
        .route("/reset-quota", post(reset_quota))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::management::settings::{RemoteManagement, Settings};

    #[test]
    fn get_config_never_exposes_the_management_secret() {
        // given a config carrying a secret
        let settings = Settings {
            remote_management: RemoteManagement {
                secret_key: "top-secret".to_string(),
                ..RemoteManagement::default()
            },
            ..Settings::default()
        };
        // when it is rendered for GET /config
        let rendered = redact(serde_json::to_value(&settings).expect("encodes"));
        // then the whole block is gone, secret included
        let text = rendered.to_string();
        assert!(!text.contains("top-secret"), "{text}");
        assert!(!text.contains("remote-management"), "{text}");
    }

    #[test]
    fn redaction_keeps_the_rest_of_the_document() {
        // given a config with an ordinary field set
        let settings = Settings {
            request_retry: 4,
            ..Settings::default()
        };
        // when redacted
        let rendered = redact(serde_json::to_value(&settings).expect("encodes"));
        // then non-secret fields survive
        assert_eq!(rendered["request-retry"], 4);
    }
}
