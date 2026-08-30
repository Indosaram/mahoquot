//! Handlers for the CLIProxyAPI surface beyond the OpenAI/Anthropic chat routes.
//!
//! Several of these are permanent errors rather than relays, and that is the
//! correct implementation: CLIProxyAPI returns the same errors against this
//! credential pool because the ChatGPT/Codex OAuth upstream has no SIP,
//! translation, transcription, image or video capability. Each such handler
//! mirrors the status and body CLIProxyAPI v7.2.140 produced, so a client cannot
//! tell the two proxies apart. Where a route *is* backed by a real upstream it
//! relays for real - see `responses`, `v1beta_generate` and `v1beta_models`.

use std::sync::Arc;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use bytes::Bytes;
use serde_json::{json, Value};

use crate::capability::{self, model_of};
use crate::realtime;
use crate::relay::{handle_relay, RelayMode};
use crate::state::AppState;
use crate::static_pages::{CALLBACK_HTML, MANAGEMENT_HTML, ROOT_JSON};
use crate::v1beta::{self, GeminiAction};

const CODEX_RESPONSES_PATH: &str = "/backend-api/codex/responses";
const CODEX_RESPONSES_COMPACT_PATH: &str = "/backend-api/codex/responses/compact";

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn parse_body(body: &Bytes) -> Result<Value, Box<Response>> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|e| {
        Box::new(json_status(
            StatusCode::BAD_REQUEST,
            json!({"error": {"message": e.to_string(), "type": "invalid_request_error"}}),
        ))
    })
}

fn owner_of(state: &AppState, model: &str) -> Option<String> {
    state
        .pool
        .load()
        .models
        .iter()
        .find(|m| m.id == model)
        .map(|m| m.owned_by.clone())
}

pub async fn root() -> Response {
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        ROOT_JSON,
    )
        .into_response()
}

pub async fn management_html() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        MANAGEMENT_HTML,
    )
        .into_response()
}

pub async fn oauth_callback() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        CALLBACK_HTML,
    )
        .into_response()
}

pub async fn images_generations(body: Bytes) -> Response {
    image_surface(&body)
}

pub async fn images_edits(headers: HeaderMap, body: Bytes) -> Response {
    let is_multipart = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("multipart/form-data"))
        .unwrap_or(false);
    if is_multipart {
        let text = String::from_utf8_lossy(&body);
        let model = multipart_field(&text, "model").unwrap_or_default();
        return match capability::check_image(&model) {
            Some(err) => json_status(StatusCode::BAD_REQUEST, err),
            None => json_status(
                StatusCode::SERVICE_UNAVAILABLE,
                capability::unknown_provider(&model),
            ),
        };
    }
    image_surface(&body)
}

fn multipart_field(text: &str, name: &str) -> Option<String> {
    let marker = format!("name=\"{name}\"");
    let start = text.find(&marker)? + marker.len();
    let rest = &text[start..];
    let value_start = rest.find("\r\n\r\n")? + 4;
    let value = &rest[value_start..];
    let end = value.find("\r\n")?;
    Some(value[..end].to_string())
}

fn image_surface(body: &Bytes) -> Response {
    let parsed = match parse_body(body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let model = model_of(&parsed);
    match capability::check_image(model) {
        Some(err) => json_status(StatusCode::BAD_REQUEST, err),
        None => json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            capability::unknown_provider(model),
        ),
    }
}

pub async fn videos(body: Bytes) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let model = model_of(&parsed);
    match capability::check_video(model) {
        Some(err) => json_status(StatusCode::BAD_REQUEST, err),
        None => json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            capability::unknown_provider(model),
        ),
    }
}

/// `/v1/videos/:id` and the `/openai/v1/videos` family resolve a fixed model
/// before looking at the path, so an unknown id reports the model, not the id.
pub async fn videos_by_id() -> Response {
    json_status(
        StatusCode::BAD_REQUEST,
        capability::unknown_provider(capability::OPENAI_VIDEO_MODEL),
    )
}

pub async fn openai_videos() -> Response {
    json_status(
        StatusCode::BAD_REQUEST,
        capability::unknown_provider(capability::OPENAI_VIDEO_MODEL),
    )
}

pub async fn realtime_offer(body: Bytes) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    match realtime::validate_offer(&parsed) {
        Some(err) => json_status(StatusCode::BAD_REQUEST, err),
        None => json_status(
            StatusCode::NOT_IMPLEMENTED,
            realtime::capability_not_supported("Realtime WebRTC offers"),
        ),
    }
}

pub async fn realtime_client_secrets(body: Bytes) -> Response {
    let parsed = parse_body(&body).unwrap_or_else(|_| json!({}));
    Json(realtime::client_secret(&parsed)).into_response()
}

pub async fn realtime_sessions(body: Bytes) -> Response {
    let parsed = parse_body(&body).unwrap_or_else(|_| json!({}));
    Json(realtime::legacy_session(&parsed)).into_response()
}

pub async fn realtime_transcription() -> Response {
    json_status(
        StatusCode::NOT_IMPLEMENTED,
        realtime::capability_not_supported("Realtime transcription-only sessions"),
    )
}

pub async fn realtime_translations() -> Response {
    json_status(
        StatusCode::NOT_IMPLEMENTED,
        realtime::capability_not_supported("Realtime translation sessions"),
    )
}

pub async fn realtime_hangup() -> Response {
    json_status(StatusCode::NOT_FOUND, realtime::call_not_found())
}

pub async fn realtime_sip(Path((_call_id, action)): Path<(String, String)>) -> Response {
    json_status(
        StatusCode::NOT_IMPLEMENTED,
        realtime::capability_not_supported(&format!("Realtime SIP {action}")),
    )
}

type MaybeUpgrade = Result<WebSocketUpgrade, WebSocketUpgradeRejection>;

pub async fn realtime_call_get(ws: MaybeUpgrade) -> Response {
    match ws {
        Ok(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_nested(),
        ),
        Err(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_nested(),
        ),
    }
}

pub async fn live_sideband(ws: MaybeUpgrade) -> Response {
    match ws {
        Ok(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_flat(),
        ),
        Err(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_flat(),
        ),
    }
}

/// The three GET upgrade endpoints answer 101 so a client's handshake succeeds,
/// then close, because no upstream duplex session is established.
pub async fn ws_upgrade(ws: MaybeUpgrade) -> Response {
    match ws {
        Ok(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_nested(),
        ),
        Err(_) => json_status(
            StatusCode::UPGRADE_REQUIRED,
            realtime::upgrade_required_nested(),
        ),
    }
}

/// Codex speaks the Responses protocol natively, so those accounts get a
/// passthrough. Antigravity does not, so the Responses `input` is normalised
/// into chat messages and the reply is re-rendered as a Responses object.
pub async fn responses(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let model = model_of(&parsed).to_string();

    if owner_of(&state, &model).as_deref() != Some("google") {
        return handle_relay(
            state,
            RelayMode::Native,
            CODEX_RESPONSES_PATH,
            &headers,
            body,
        )
        .await;
    }

    let chat = responses_input_to_chat(&parsed, &model);
    let relayed = handle_relay(
        state,
        RelayMode::OpenAiCompat,
        "/v1/chat/completions",
        &headers,
        Bytes::from(chat.to_string()),
    )
    .await;

    let (parts, body) = relayed.into_parts();
    let Ok(raw) = axum::body::to_bytes(body, MAX_RESPONSE_BYTES).await else {
        return json_status(
            StatusCode::BAD_GATEWAY,
            json!({"error": {"message": "upstream reply too large", "type": "server_error"}}),
        );
    };
    if !parts.status.is_success() {
        return (parts.status, raw).into_response();
    }
    match serde_json::from_slice::<Value>(&raw) {
        Ok(chat_reply) => Json(chat_to_responses(&chat_reply, &model)).into_response(),
        Err(_) => (parts.status, raw).into_response(),
    }
}

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

fn responses_input_to_chat(req: &Value, model: &str) -> Value {
    let mut messages = Vec::new();
    if let Some(instructions) = req.get("instructions").and_then(Value::as_str) {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    match req.get("input") {
        Some(Value::String(text)) => {
            messages.push(json!({"role": "user", "content": text}));
        }
        Some(Value::Array(items)) => {
            for item in items {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let text = match item.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                };
                messages.push(json!({"role": role, "content": text}));
            }
        }
        _ => {}
    }
    let mut chat = json!({"model": model, "messages": messages, "stream": false});
    for key in ["temperature", "top_p", "max_output_tokens"] {
        if let Some(v) = req.get(key) {
            let mapped = if key == "max_output_tokens" {
                "max_tokens"
            } else {
                key
            };
            chat[mapped] = v.clone();
        }
    }
    chat
}

fn chat_to_responses(chat: &Value, model: &str) -> Value {
    let choice = chat.get("choices").and_then(|c| c.get(0));
    let text = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = chat
        .get("id")
        .and_then(Value::as_str)
        .map(|i| format!("resp_{i}"))
        .unwrap_or_else(|| "resp_0".to_string());
    let mut out = json!({
        "id": id,
        "object": "response",
        "created_at": chat.get("created").and_then(Value::as_i64).unwrap_or(0),
        "status": "completed",
        "background": false,
        "error": Value::Null,
        "incomplete_details": Value::Null,
        "model": model,
        "output": [{
            "id": "msg_0",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }],
        "parallel_tool_calls": true,
        "tool_choice": "auto",
        "tools": [],
    });
    if let Some(usage) = chat.get("usage") {
        let input = usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let output = usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        out["usage"] = json!({
            "input_tokens": input,
            "output_tokens": output,
            "total_tokens": input + output,
        });
    }
    out
}

/// `compact` resolves the model first, so an unknown model is a 400 while a
/// known non-codex model reaches the "not supported" branch.
pub async fn responses_compact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let model = model_of(&parsed);
    match owner_of(&state, model) {
        None => json_status(StatusCode::BAD_REQUEST, capability::unknown_provider(model)),
        Some(owner) if owner == "openai" => {
            handle_relay(
                state,
                RelayMode::Native,
                CODEX_RESPONSES_COMPACT_PATH,
                &headers,
                body,
            )
            .await
        }
        Some(_) => json_status(
            StatusCode::NOT_IMPLEMENTED,
            json!({"error": {
                "message": "/responses/compact not supported",
                "type": "server_error",
                "code": "internal_server_error",
            }}),
        ),
    }
}

/// Relayed rather than answered locally: the upstream owns this decision and
/// returns its own HTML body, which a synthesised JSON error would not match.
pub async fn alpha_search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let model = model_of(&parsed);
    if owner_of(&state, model).as_deref() != Some("openai") {
        return json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "auth_not_found: no auth available" }),
        );
    }
    handle_relay(
        state,
        RelayMode::Native,
        "/backend-api/codex/alpha/search",
        &headers,
        body,
    )
    .await
}

pub async fn v1beta_models(State(state): State<Arc<AppState>>) -> Response {
    Json(v1beta::models_payload(&state.pool.load().models)).into_response()
}

pub async fn v1beta_action(
    State(state): State<Arc<AppState>>,
    Path(action): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (model, verb) = v1beta::parse_action(&action);

    let Some(entry) = state
        .pool
        .load()
        .models
        .iter()
        .find(|m| m.id == model)
        .cloned()
    else {
        return json_status(StatusCode::NOT_FOUND, v1beta::model_not_found(&model));
    };

    let Some(verb) = verb else {
        return Json(v1beta::single_model_payload(&entry)).into_response();
    };

    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };

    match verb {
        GeminiAction::Generate | GeminiAction::StreamGenerate => {
            if !parsed.get("contents").map(Value::is_array).unwrap_or(false) {
                return json_status(StatusCode::BAD_REQUEST, v1beta::contents_not_specified());
            }
            let mut chat = parsed.clone();
            if let Some(obj) = chat.as_object_mut() {
                obj.insert("model".into(), json!(model));
                obj.insert(
                    "stream".into(),
                    json!(matches!(verb, GeminiAction::StreamGenerate)),
                );
            }
            handle_relay(
                state,
                RelayMode::GeminiNative,
                "/v1beta/models",
                &headers,
                Bytes::from(chat.to_string()),
            )
            .await
        }
        GeminiAction::CountTokens => {
            if !parsed.get("contents").map(Value::is_array).unwrap_or(false) {
                return json_status(StatusCode::BAD_REQUEST, v1beta::contents_not_specified());
            }
            let mut req = parsed.clone();
            if let Some(obj) = req.as_object_mut() {
                obj.insert("model".into(), json!(model));
            }
            handle_relay(
                state,
                RelayMode::GeminiCountTokens,
                "/v1beta/models",
                &headers,
                Bytes::from(req.to_string()),
            )
            .await
        }
        GeminiAction::Unknown(verb) => json_status(
            StatusCode::BAD_REQUEST,
            json!({"error": {
                "code": 400,
                "message": format!("Unknown method: {verb}"),
                "status": "INVALID_ARGUMENT",
            }}),
        ),
    }
}

pub async fn v1beta_interactions(body: Bytes) -> Response {
    let parsed = match parse_body(&body) {
        Ok(v) => v,
        Err(resp) => return *resp,
    };
    let has_model = parsed.get("model").is_some();
    let has_agent = parsed.get("agent").is_some();
    if has_model == has_agent {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({"error": {
                "message": "request requires exactly one of model or agent",
                "type": "invalid_request_error",
            }}),
        );
    }
    // The interactions schema is not GenerateContentRequest, so a body carrying
    // top-level `contents` is rejected upstream the same way it is here.
    json_status(StatusCode::BAD_REQUEST, v1beta::contents_not_specified())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_model_is_extracted_from_the_part_body() {
        let text =
            "--B\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2\r\n--B--\r\n";
        assert_eq!(
            multipart_field(text, "model"),
            Some("gpt-image-2".to_string())
        );
    }

    #[test]
    fn missing_multipart_field_is_none() {
        let text = "--B\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nhi\r\n--B--\r\n";
        assert_eq!(multipart_field(text, "model"), None);
    }

    #[test]
    fn empty_body_parses_as_an_empty_object() {
        assert_eq!(parse_body(&Bytes::new()).unwrap(), json!({}));
    }

    #[test]
    fn instructions_become_a_system_message_ahead_of_the_input() {
        let chat = responses_input_to_chat(
            &json!({"instructions": "be terse", "input": "hi"}),
            "gemini-3.7-flash-high",
        );
        assert_eq!(chat["messages"][0]["role"], "system");
        assert_eq!(chat["messages"][0]["content"], "be terse");
        assert_eq!(chat["messages"][1]["role"], "user");
        assert_eq!(chat["messages"][1]["content"], "hi");
        assert_eq!(chat["model"], "gemini-3.7-flash-high");
    }

    #[test]
    fn structured_input_parts_are_concatenated_per_message() {
        let chat = responses_input_to_chat(
            &json!({"input": [{
                "role": "user",
                "content": [{"type": "input_text", "text": "al"},
                            {"type": "input_text", "text": "pha"}],
            }]}),
            "m",
        );
        assert_eq!(chat["messages"][0]["content"], "alpha");
    }

    #[test]
    fn max_output_tokens_is_renamed_for_the_chat_surface() {
        let chat = responses_input_to_chat(
            &json!({"input": "hi", "max_output_tokens": 32, "temperature": 0.5}),
            "m",
        );
        assert_eq!(chat["max_tokens"], 32);
        assert_eq!(chat["temperature"], 0.5);
        assert!(chat.get("max_output_tokens").is_none());
    }

    #[test]
    fn chat_reply_is_rewrapped_as_a_responses_object() {
        let out = chat_to_responses(
            &json!({
                "id": "chatcmpl-1",
                "created": 1700,
                "choices": [{"message": {"content": "alpha"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            }),
            "gemini-3.7-flash-high",
        );
        assert_eq!(out["object"], "response");
        assert_eq!(out["id"], "resp_chatcmpl-1");
        assert_eq!(out["status"], "completed");
        assert_eq!(out["created_at"], 1700);
        assert_eq!(out["output"][0]["type"], "message");
        assert_eq!(out["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(out["output"][0]["content"][0]["text"], "alpha");
        assert_eq!(out["usage"]["input_tokens"], 3);
        assert_eq!(out["usage"]["output_tokens"], 4);
        assert_eq!(out["usage"]["total_tokens"], 7);
    }
}
