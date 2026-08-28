use serde_json::{json, Value};

use quotio_providers::ANTIGRAVITY_MODELS;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ModelEntry {
    pub id: String,
    pub owned_by: String,
}

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

/// Advertise a model only when an account that can actually serve it is loaded,
/// so a client selecting from /v1/models never gets a routing failure.
pub fn model_entries(
    has_codex: bool,
    has_antigravity: bool,
    env_override: Option<&str>,
) -> Vec<ModelEntry> {
    let mut entries: Vec<ModelEntry> = Vec::new();

    if has_codex {
        for id in model_ids_from_env(env_override) {
            entries.push(ModelEntry {
                id,
                owned_by: "openai".to_string(),
            });
        }
    }

    if has_antigravity {
        for id in ANTIGRAVITY_MODELS {
            entries.push(ModelEntry {
                id: id.to_string(),
                owned_by: "google".to_string(),
            });
        }
    }

    entries
}

pub fn models_payload(entries: &[ModelEntry], created_unix: i64) -> Value {
    let data: Vec<Value> = entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "object": "model",
                "created": created_unix,
                "owned_by": entry.owned_by,
            })
        })
        .collect();

    json!({
        "object": "list",
        "data": data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_track_loaded_providers() {
        let codex_only = model_entries(true, false, None);
        assert_eq!(codex_only.len(), 7);
        assert!(codex_only.iter().all(|e| e.owned_by == "openai"));

        let ag_only = model_entries(false, true, None);
        assert_eq!(ag_only.len(), 13);
        assert!(ag_only.iter().any(|e| e.id == "gemini-3.7-flash-high"));
        assert!(ag_only.iter().all(|e| e.owned_by == "google"));

        let both = model_entries(true, true, None);
        assert_eq!(both.len(), 20);

        assert!(model_entries(false, false, None).is_empty());
    }

    #[test]
    fn env_override_scopes_codex_only() {
        let entries = model_entries(true, true, Some("gpt-x, gpt-y"));
        let codex: Vec<_> = entries.iter().filter(|e| e.owned_by == "openai").collect();
        assert_eq!(codex.len(), 2);
        assert_eq!(codex[0].id, "gpt-x");
        assert_eq!(
            entries.iter().filter(|e| e.owned_by == "google").count(),
            13
        );
    }
}
