//! Model-capability gating for the image and video surfaces.
//!
//! CLIProxyAPI resolves the requested model against a per-surface allow-list
//! before it ever selects an account, so an unsupported model fails with a
//! surface-specific 400 while an unknown model fails with the generic
//! `model_not_found` shape. Both strings are reproduced verbatim because
//! clients match on them; they were captured from CLIProxyAPI v7.2.140 sharing
//! this credential pool.

use serde_json::{json, Value};

/// Models CLIProxyAPI accepts on `/v1/images/generations` and `/v1/images/edits`.
pub const IMAGE_MODELS: &[&str] = &["gpt-image-1.5", "gpt-image-2"];

/// Models CLIProxyAPI accepts on the `/v1/videos/*` surface.
pub const VIDEO_MODELS: &[&str] = &[];

/// The model `/openai/v1/videos` resolves against regardless of the request body.
pub const OPENAI_VIDEO_MODEL: &str = "grok-imagine-video";

const IMAGE_HINT: &str =
    "Use gpt-image-1.5, gpt-image-2, or a configured openai-compatibility image model.";

const VIDEO_HINT: &str = "No reference-backed video model is configured.";

/// `{"error":{"message":..,"type":"invalid_request_error"}}` - no code/param.
pub fn unsupported_on_surface(model: &str, surface: &str, hint: &str) -> Value {
    json!({"error": {
        "message": format!("Model {model} is not supported on {surface}. {hint}"),
        "type": "invalid_request_error",
    }})
}

/// `{"error":{..,"code":"model_not_found","param":"model"}}`.
pub fn unknown_provider(model: &str) -> Value {
    json!({"error": {
        "message": format!("unknown provider for model {model}"),
        "type": "invalid_request_error",
        "code": "model_not_found",
        "param": "model",
    }})
}

pub fn check_image(model: &str) -> Option<Value> {
    if IMAGE_MODELS.contains(&model) {
        return None;
    }
    Some(unsupported_on_surface(
        model,
        "/v1/images/generations or /v1/images/edits",
        IMAGE_HINT,
    ))
}

pub fn check_video(model: &str) -> Option<Value> {
    if VIDEO_MODELS.contains(&model) {
        return None;
    }
    Some(unsupported_on_surface(
        model,
        "/v1/videos/generations, /v1/videos/edits, or /v1/videos/extensions",
        VIDEO_HINT,
    ))
}

/// Model named in a request body, falling back to the empty string like the
/// upstream does when the field is absent.
pub fn model_of(body: &Value) -> &str {
    body.get("model").and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_error_matches_captured_upstream_text() {
        let v = check_image("gemini-3-pro-image-preview").expect("unsupported");
        assert_eq!(
            v["error"]["message"].as_str().unwrap(),
            "Model gemini-3-pro-image-preview is not supported on \
             /v1/images/generations or /v1/images/edits. Use gpt-image-1.5, \
             gpt-image-2, or a configured openai-compatibility image model."
        );
        assert_eq!(v["error"]["type"], "invalid_request_error");
        assert!(v["error"].get("code").is_none());
    }

    #[test]
    fn video_error_matches_captured_upstream_text() {
        let v = check_video("veo-3.1").expect("unsupported");
        assert_eq!(
            v["error"]["message"].as_str().unwrap(),
            "Model veo-3.1 is not supported on /v1/videos/generations, \
             /v1/videos/edits, or /v1/videos/extensions. No reference-backed \
             video model is configured."
        );
    }

    #[test]
    fn unknown_provider_carries_code_and_param() {
        let v = unknown_provider("grok-imagine-video");
        assert_eq!(
            v["error"]["message"],
            "unknown provider for model grok-imagine-video"
        );
        assert_eq!(v["error"]["code"], "model_not_found");
        assert_eq!(v["error"]["param"], "model");
    }

    #[test]
    fn reference_backed_image_models_pass_surface_gate() {
        assert!(check_image("gpt-image-2").is_none());
    }

    #[test]
    fn unimplemented_media_models_are_not_advertised_as_routable() {
        assert!(check_image("grok-imagine-image").is_some());
        assert!(check_image("grok-imagine-image-quality").is_some());
        assert!(check_image("grok-imagine-image-2.0").is_some());
        assert!(check_video("grok-imagine-video").is_some());
    }
}
