use serde_json::{json, Value};

const DEFAULT_MODELS: [&str; 7] = [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
];

pub fn model_ids_from_env(raw: Option<&str>) -> Vec<String> {
    if let Some(s) = raw {
        let parsed: Vec<String> = s
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    DEFAULT_MODELS.iter().map(|&s| s.to_string()).collect()
}

pub fn models_payload(ids: &[String], created_unix: i64) -> Value {
    let data: Vec<Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "object": "model",
                "created": created_unix,
                "owned_by": "quotio",
            })
        })
        .collect();

    json!({
        "object": "list",
        "data": data,
    })
}
