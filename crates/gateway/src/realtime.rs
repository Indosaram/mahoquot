//! The `/v1/realtime`, `/v1/live` and SIP-control surface.
//!
//! CLIProxyAPI fronts these with the ChatGPT/Codex OAuth upstream, which has no
//! SIP, translation or transcription capability, so several endpoints are
//! permanent `501`s rather than relays. The bodies below were captured from
//! CLIProxyAPI v7.2.140 against this credential pool.
//!
//! Request validation order was measured, not assumed: `sdp` is checked before
//! `session`, and both are checked before the model is resolved, so a request
//! with no model at all still fails on `sdp` first.

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};

const EPHEMERAL_TTL_SECS: u64 = 600;
const DEFAULT_REALTIME_MODEL: &str = "gpt-realtime";

fn token(prefix: &str, bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf)
    )
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `{"error":{"code":..,"message":..,"param":null,"type":"not_supported_error"}}`
pub fn capability_not_supported(what: &str) -> Value {
    json!({"error": {
        "code": "realtime_capability_not_supported",
        "message": format!("{what} are not supported by the ChatGPT/Codex OAuth upstream"),
        "param": null,
        "type": "not_supported_error",
    }})
}

pub fn call_not_found() -> Value {
    json!({"error": {
        "code": "realtime_call_not_found",
        "message": "Realtime call not found",
        "param": null,
        "type": "invalid_request_error",
    }})
}

/// 426 body for `/v1/realtime/calls/:call_id`, which nests under `error`.
pub fn upgrade_required_nested() -> Value {
    json!({"error": {
        "code": "realtime_request_failed",
        "message": "WebSocket upgrade required",
        "param": null,
        "type": "invalid_request_error",
    }})
}

/// 426 body for `/v1/live/:call_id`, which is flat rather than nested.
pub fn upgrade_required_flat() -> Value {
    json!({"error": "WebSocket upgrade required"})
}

fn detail(msg: &str) -> Value {
    json!({ "detail": msg })
}

pub fn validate_offer(body: &Value) -> Option<Value> {
    if !body.get("sdp").map(Value::is_string).unwrap_or(false) {
        return Some(detail("Field `sdp` must be a string"));
    }
    if !body.get("session").map(Value::is_object).unwrap_or(false) {
        return Some(detail("Field `session` must be an object"));
    }
    None
}

fn session_object(model: &str, expires_at: u64) -> Value {
    json!({
        "expires_at": expires_at,
        "id": token("sess_", 18),
        "model": model,
        "object": "realtime.session",
        "type": "realtime",
    })
}

fn requested_model(body: &Value) -> String {
    body.get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_REALTIME_MODEL)
        .to_string()
}

pub fn client_secret(body: &Value) -> Value {
    let expires_at = now_unix() + EPHEMERAL_TTL_SECS;
    json!({
        "value": token("ek_", 32),
        "expires_at": expires_at,
        "session": session_object(&requested_model(body), expires_at),
    })
}

pub fn legacy_session(body: &Value) -> Value {
    let expires_at = now_unix() + EPHEMERAL_TTL_SECS;
    let mut out = session_object(&requested_model(body), expires_at);
    out.as_object_mut()
        .expect("session_object builds a map")
        .insert(
            "client_secret".into(),
            json!({"expires_at": expires_at, "value": token("ek_", 32)}),
        );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdp_is_rejected_before_session() {
        let v = validate_offer(&json!({})).expect("missing sdp");
        assert_eq!(v["detail"], "Field `sdp` must be a string");

        let v = validate_offer(&json!({"model": "x"})).expect("missing sdp");
        assert_eq!(v["detail"], "Field `sdp` must be a string");
    }

    #[test]
    fn session_is_rejected_once_sdp_is_present() {
        let v = validate_offer(&json!({"sdp": "v=0"})).expect("missing session");
        assert_eq!(v["detail"], "Field `session` must be an object");
    }

    #[test]
    fn a_well_formed_offer_passes_validation() {
        assert!(validate_offer(&json!({"sdp": "v=0", "session": {}})).is_none());
    }

    #[test]
    fn capability_message_matches_captured_upstream_text() {
        let v = capability_not_supported("Realtime SIP accept");
        assert_eq!(
            v["error"]["message"],
            "Realtime SIP accept are not supported by the ChatGPT/Codex OAuth upstream"
        );
        assert_eq!(v["error"]["type"], "not_supported_error");
        assert!(v["error"]["param"].is_null());
    }

    #[test]
    fn client_secret_carries_prefixed_token_and_nested_session() {
        let v = client_secret(&json!({}));
        assert!(v["value"].as_str().unwrap().starts_with("ek_"));
        assert!(v["session"]["id"].as_str().unwrap().starts_with("sess_"));
        assert_eq!(v["session"]["model"], DEFAULT_REALTIME_MODEL);
        assert_eq!(v["session"]["object"], "realtime.session");
        assert_eq!(v["expires_at"], v["session"]["expires_at"]);
    }

    #[test]
    fn legacy_session_nests_the_secret_instead_of_the_session() {
        let v = legacy_session(&json!({"model": "gpt-realtime-mini"}));
        assert!(v["client_secret"]["value"]
            .as_str()
            .unwrap()
            .starts_with("ek_"));
        assert_eq!(v["model"], "gpt-realtime-mini");
        assert_eq!(v["object"], "realtime.session");
        assert_eq!(v["expires_at"], v["client_secret"]["expires_at"]);
    }
}
