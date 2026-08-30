//! The Gemini-native `/v1beta` surface.
//!
//! Clients that already speak Gemini (Gemini CLI, the Antigravity IDE) post
//! `{"contents":[...]}` with the model in the URL path rather than the body,
//! so this surface wraps the request instead of translating it - the antigravity
//! upstream envelope is `{model, project, request}` and `request` is exactly the
//! Gemini body the client sent.
//!
//! Two shape details were captured from CLIProxyAPI v7.2.140 and are load-bearing:
//! the collection response omits the OpenAI-style `object` field and nests under
//! `models`, and the single-model response drops `supportedGenerationMethods`
//! that the collection includes.

use serde_json::{json, Value};

use crate::models_route::ModelEntry;

#[derive(Debug, PartialEq, Eq)]
pub enum GeminiAction {
    Generate,
    StreamGenerate,
    CountTokens,
    Unknown(String),
}

/// Model ids never contain a colon, so the first one splits id from verb.
pub fn parse_action(action: &str) -> (String, Option<GeminiAction>) {
    let trimmed = action.trim_start_matches('/');
    match trimmed.split_once(':') {
        None => (trimmed.to_string(), None),
        Some((model, verb)) => {
            let parsed = match verb {
                "generateContent" => GeminiAction::Generate,
                "streamGenerateContent" => GeminiAction::StreamGenerate,
                "countTokens" => GeminiAction::CountTokens,
                other => GeminiAction::Unknown(other.to_string()),
            };
            (model.to_string(), Some(parsed))
        }
    }
}

fn modalities_for(id: &str) -> (Vec<&'static str>, Vec<&'static str>) {
    let out = if id.contains("image") {
        vec!["text", "image"]
    } else {
        vec!["text"]
    };
    (vec!["text", "image", "audio", "video"], out)
}

fn model_object(entry: &ModelEntry, with_methods: bool) -> Value {
    let (inputs, outputs) = modalities_for(&entry.id);
    let mut obj = json!({
        "name": format!("models/{}", entry.id),
        "displayName": entry.id,
        "description": entry.id,
        "supportedInputModalities": inputs,
        "supportedOutputModalities": outputs,
    });
    if with_methods {
        obj.as_object_mut()
            .expect("model_object builds a map")
            .insert(
                "supportedGenerationMethods".into(),
                json!(["generateContent"]),
            );
    }
    obj
}

pub fn models_payload(entries: &[ModelEntry]) -> Value {
    json!({
        "models": entries
            .iter()
            .map(|e| model_object(e, true))
            .collect::<Vec<_>>(),
    })
}

pub fn single_model_payload(entry: &ModelEntry) -> Value {
    model_object(entry, false)
}

/// Gemini's own 404 shape, which nests `error` with a numeric `code`.
pub fn model_not_found(name: &str) -> Value {
    json!({"error": {
        "code": 404,
        "message": format!("models/{name} is not found or your account does not have access to it."),
        "status": "NOT_FOUND",
    }})
}

pub fn contents_not_specified() -> Value {
    json!({"error": {
        "code": 400,
        "message": "* GenerateContentRequest.contents: contents is not specified\n",
        "status": "INVALID_ARGUMENT",
    }})
}

pub fn wrap_for_antigravity(model: &str, project_id: &str, body: &Value) -> Value {
    json!({
        "model": model,
        "project": project_id,
        "request": body.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            owned_by: "google".to_string(),
        }
    }

    #[test]
    fn action_splits_on_the_verb_colon() {
        let (m, a) = parse_action("/gemini-3.7-flash-high:generateContent");
        assert_eq!(m, "gemini-3.7-flash-high");
        assert_eq!(a, Some(GeminiAction::Generate));

        let (m, a) = parse_action("gemini-3-flash:streamGenerateContent");
        assert_eq!(m, "gemini-3-flash");
        assert_eq!(a, Some(GeminiAction::StreamGenerate));

        let (m, a) = parse_action("/gemini-3-flash:countTokens");
        assert_eq!(m, "gemini-3-flash");
        assert_eq!(a, Some(GeminiAction::CountTokens));
    }

    #[test]
    fn a_bare_model_path_has_no_action() {
        let (m, a) = parse_action("/gemini-3.7-flash-high");
        assert_eq!(m, "gemini-3.7-flash-high");
        assert_eq!(a, None);
    }

    #[test]
    fn collection_nests_under_models_and_keeps_methods() {
        let payload = models_payload(&[entry("gemini-3.7-flash-high")]);
        assert!(payload.get("object").is_none());
        let first = &payload["models"][0];
        assert_eq!(first["name"], "models/gemini-3.7-flash-high");
        assert_eq!(first["supportedGenerationMethods"][0], "generateContent");
    }

    #[test]
    fn single_model_drops_generation_methods() {
        let payload = single_model_payload(&entry("gemini-3.7-flash-high"));
        assert_eq!(payload["name"], "models/gemini-3.7-flash-high");
        assert!(payload.get("supportedGenerationMethods").is_none());
    }

    #[test]
    fn image_models_advertise_image_output() {
        let payload = single_model_payload(&entry("gemini-3.1-flash-image"));
        let outputs = payload["supportedOutputModalities"].as_array().unwrap();
        assert!(outputs.iter().any(|v| v == "image"));
    }

    #[test]
    fn envelope_passes_the_client_body_through_untranslated() {
        let body = json!({"contents": [{"role": "user", "parts": [{"text": "hi"}]}]});
        let wrapped = wrap_for_antigravity("gemini-3-flash", "proj-1", &body);
        assert_eq!(wrapped["model"], "gemini-3-flash");
        assert_eq!(wrapped["project"], "proj-1");
        assert_eq!(wrapped["request"], body);
    }
}
