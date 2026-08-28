use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::settings::Settings;
use crate::state::AppState;

/// Upstream answers a scalar GET with a single-key object whose key is the
/// YAML name, and accepts `{"value": <T>}` on PUT/PATCH, rejecting anything
/// else with 400 `{"error":"invalid body"}`. PUT and PATCH share one handler
/// upstream, so a scalar has no merge semantics to distinguish them.
struct Scalar {
    key: &'static str,
    read: fn(&Settings) -> Value,
    write: fn(&mut Settings, Value) -> bool,
}

fn ok_value(key: &str, value: Value) -> Response {
    (StatusCode::OK, Json(json!({ key: value }))).into_response()
}

fn invalid_body() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid body" })),
    )
        .into_response()
}

/// Pull `value` out of the request body, honouring upstream's contract that a
/// missing key, a null, or a wrong-typed value are all "invalid body" rather
/// than a silent default.
fn extract<T: DeserializeOwned>(body: &Value) -> Option<T> {
    let raw = body.get("value")?;
    serde_json::from_value(raw.clone()).ok()
}

fn write_bool(target: &mut bool, body: Value) -> bool {
    match extract::<bool>(&body) {
        Some(v) => {
            *target = v;
            true
        }
        None => false,
    }
}

fn write_i64(target: &mut i64, body: Value) -> bool {
    match extract::<i64>(&body) {
        Some(v) => {
            *target = v;
            true
        }
        None => false,
    }
}

fn write_usize(target: &mut usize, body: Value) -> bool {
    match extract::<usize>(&body) {
        Some(v) => {
            *target = v;
            true
        }
        None => false,
    }
}

fn write_string(target: &mut String, body: Value) -> bool {
    match extract::<String>(&body) {
        Some(v) => {
            *target = v;
            true
        }
        None => false,
    }
}

fn write_string_list(target: &mut Vec<String>, body: Value) -> bool {
    match extract::<Vec<String>>(&body) {
        Some(v) => {
            *target = v;
            true
        }
        None => false,
    }
}

/// Every scalar route, paired with how it reads and writes the settings
/// document. Adding a route here registers its GET/PUT/PATCH trio.
const SCALARS: &[Scalar] = &[
    Scalar {
        key: "debug",
        read: |s| json!(s.debug),
        write: |s, b| write_bool(&mut s.debug, b),
    },
    Scalar {
        key: "logging-to-file",
        read: |s| json!(s.logging_to_file),
        write: |s, b| write_bool(&mut s.logging_to_file, b),
    },
    Scalar {
        key: "error-logs-max-files",
        read: |s| json!(s.error_logs_max_files),
        write: |s, b| write_i64(&mut s.error_logs_max_files, b),
    },
    Scalar {
        key: "usage-statistics-enabled",
        read: |s| json!(s.usage_statistics_enabled),
        write: |s, b| write_bool(&mut s.usage_statistics_enabled, b),
    },
    Scalar {
        key: "request-retry",
        read: |s| json!(s.request_retry),
        write: |s, b| write_i64(&mut s.request_retry, b),
    },
    Scalar {
        key: "max-retry-credentials",
        read: |s| json!(s.max_retry_credentials),
        write: |s, b| write_usize(&mut s.max_retry_credentials, b),
    },
    Scalar {
        key: "max-retry-interval",
        read: |s| json!(s.max_retry_interval),
        write: |s, b| write_i64(&mut s.max_retry_interval, b),
    },
    Scalar {
        key: "force-model-prefix",
        read: |s| json!(s.force_model_prefix),
        write: |s, b| write_bool(&mut s.force_model_prefix, b),
    },
    Scalar {
        key: "ws-auth",
        read: |s| json!(s.ws_auth),
        write: |s, b| write_bool(&mut s.ws_auth, b),
    },
    Scalar {
        key: "proxy-url",
        read: |s| json!(s.proxy_url),
        write: |s, b| write_string(&mut s.proxy_url, b),
    },
    Scalar {
        key: "oauth-excluded-models",
        read: |s| json!(s.oauth_excluded_models),
        write: |s, b| write_string_list(&mut s.oauth_excluded_models, b),
    },
];

fn find(key: &str) -> Option<&'static Scalar> {
    SCALARS.iter().find(|s| s.key == key)
}

async fn read_scalar(State(state): State<Arc<AppState>>, key: &'static str) -> Response {
    match find(key) {
        Some(scalar) => ok_value(scalar.key, (scalar.read)(&state.settings.current())),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn write_scalar(state: Arc<AppState>, key: &'static str, raw: bytes::Bytes) -> Response {
    let Some(scalar) = find(key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Take the body as bytes and parse it here: axum's Json extractor would
    // reject a malformed payload with its own parser message, which upstream
    // never emits -- every bad body must read `{"error":"invalid body"}`.
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return invalid_body();
    };

    let mut accepted = false;
    let outcome = state.settings.mutate(|settings| {
        accepted = (scalar.write)(settings, body.clone());
    });

    if !accepted {
        return invalid_body();
    }
    match outcome {
        Ok(settings) => ok_value(scalar.key, (scalar.read)(&settings)),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

macro_rules! scalar_route {
    ($router:expr, $key:literal) => {
        $router.route(
            concat!("/", $key),
            get(|state: State<Arc<AppState>>| read_scalar(state, $key))
                .put({
                    |State(state): State<Arc<AppState>>, body: bytes::Bytes| {
                        write_scalar(state, $key, body)
                    }
                })
                .patch({
                    |State(state): State<Arc<AppState>>, body: bytes::Bytes| {
                        write_scalar(state, $key, body)
                    }
                }),
        )
    };
}

pub fn scalars_routes() -> Router<Arc<AppState>> {
    let router = Router::new();
    let router = scalar_route!(router, "debug");
    let router = scalar_route!(router, "logging-to-file");
    let router = scalar_route!(router, "error-logs-max-files");
    let router = scalar_route!(router, "usage-statistics-enabled");
    let router = scalar_route!(router, "request-retry");
    let router = scalar_route!(router, "max-retry-credentials");
    let router = scalar_route!(router, "max-retry-interval");
    let router = scalar_route!(router, "force-model-prefix");
    let router = scalar_route!(router, "ws-auth");
    let router = scalar_route!(router, "oauth-excluded-models");
    scalar_route!(router, "proxy-url")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_scalar_is_reachable_by_key() {
        // given the scalar table
        // then each entry resolves by its yaml key
        for scalar in SCALARS {
            assert!(find(scalar.key).is_some(), "unreachable: {}", scalar.key);
        }
    }

    #[test]
    fn a_scalar_reads_the_yaml_key_name_upstream_uses() {
        // given a settings document with debug on
        let settings = Settings {
            debug: true,
            ..Settings::default()
        };
        // when the debug scalar is read
        let scalar = find("debug").expect("registered");
        // then the value comes back under upstream's key
        assert_eq!((scalar.read)(&settings), json!(true));
        assert_eq!(scalar.key, "debug");
    }

    #[test]
    fn a_write_rejects_a_missing_value_key() {
        // given a body with no "value"
        let mut settings = Settings::default();
        let scalar = find("debug").expect("registered");
        // when written
        let accepted = (scalar.write)(&mut settings, json!({ "debug": true }));
        // then it is refused rather than defaulting
        assert!(!accepted);
        assert!(!settings.debug);
    }

    #[test]
    fn a_write_rejects_a_wrongly_typed_value() {
        // given a string where a bool is required
        let mut settings = Settings::default();
        let scalar = find("debug").expect("registered");
        // when written
        let accepted = (scalar.write)(&mut settings, json!({ "value": "yes" }));
        // then it is refused
        assert!(!accepted);
        assert!(!settings.debug);
    }

    #[test]
    fn a_write_accepts_a_correctly_typed_value() {
        // given a valid body for each representative type
        let mut settings = Settings::default();
        assert!((find("debug").unwrap().write)(&mut settings, json!({ "value": true })));
        assert!((find("request-retry").unwrap().write)(&mut settings, json!({ "value": 7 })));
        assert!((find("proxy-url").unwrap().write)(
            &mut settings,
            json!({ "value": "http://127.0.0.1:1" })
        ));
        assert!((find("oauth-excluded-models").unwrap().write)(
            &mut settings,
            json!({ "value": ["a", "b"] })
        ));
        // then each lands in the document
        assert!(settings.debug);
        assert_eq!(settings.request_retry, 7);
        assert_eq!(settings.proxy_url, "http://127.0.0.1:1");
        assert_eq!(settings.oauth_excluded_models, vec!["a", "b"]);
    }
}
