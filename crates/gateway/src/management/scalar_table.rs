use serde_json::{json, Value};

use super::settings::Settings;

/// Why a write was refused, mapped to the exact body upstream emits.
pub enum Refusal {
    InvalidBody,
    Message(&'static str),
}

pub type WriteResult = Result<(), Refusal>;

/// One management scalar: where it lives on the router, the key its GET
/// response is wrapped in, and how it reads/writes/clears the document.
///
/// `path` and `key` differ for some routes -- `/routing/strategy` answers under
/// `"strategy"` -- so they are tracked separately rather than derived.
pub struct Scalar {
    pub path: &'static str,
    pub key: &'static str,
    pub read: fn(&Settings) -> Value,
    pub write: fn(&mut Settings, &Value) -> WriteResult,
    pub clear: Option<fn(&mut Settings, Option<&str>) -> WriteResult>,
}

/// These routes address a per-channel map rather than one value. A whole
/// document PUT is accepted, but PATCH and DELETE name a single channel and are
/// refused without a valid one.
pub const CHANNEL_KEYED: &[&str] = &[
    "/oauth-excluded-models",
    "/oauth-model-alias",
    "/oauth-request-scoped-errors",
];

pub fn is_channel_keyed(path: &str) -> bool {
    CHANNEL_KEYED.contains(&path)
}

/// Pull `value` out of the `{"value": T}` envelope most scalars use.
fn valued<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, Refusal> {
    body.get("value")
        .and_then(|raw| serde_json::from_value(raw.clone()).ok())
        .ok_or(Refusal::InvalidBody)
}

fn set_bool(target: &mut bool, body: &Value) -> WriteResult {
    *target = valued::<bool>(body)?;
    Ok(())
}

fn set_i64(target: &mut i64, body: &Value) -> WriteResult {
    *target = valued::<i64>(body)?;
    Ok(())
}

fn set_usize(target: &mut usize, body: &Value) -> WriteResult {
    *target = valued::<usize>(body)?;
    Ok(())
}

fn set_string(target: &mut String, body: &Value) -> WriteResult {
    *target = valued::<String>(body)?;
    Ok(())
}

/// Upstream accepts several spellings per strategy and answers with the
/// canonical one, rejecting anything else with 400 `invalid strategy`.
pub fn normalize_routing_strategy(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "round-robin" | "roundrobin" | "rr" => Some("round-robin"),
        "weighted-round-robin" | "weightedroundrobin" | "wrr" => Some("weighted-round-robin"),
        "fill-first" | "fillfirst" | "ff" => Some("fill-first"),
        _ => None,
    }
}

/// The provider-keyed collections take a raw `{provider: [...]}` body, or the
/// same map wrapped in `{"items": ...}`, rather than the `value` envelope.
fn provider_map(body: &Value) -> Result<std::collections::BTreeMap<String, Vec<String>>, Refusal> {
    let candidate = body.get("items").unwrap_or(body);
    serde_json::from_value(candidate.clone()).map_err(|_| Refusal::InvalidBody)
}

fn passthrough(target: &mut Value, body: &Value) -> WriteResult {
    *target = body.get("items").unwrap_or(body).clone();
    Ok(())
}

pub const SCALARS: &[Scalar] = &[
    Scalar {
        path: "/debug",
        key: "debug",
        read: |s| json!(s.debug),
        write: |s, b| set_bool(&mut s.debug, b),
        clear: None,
    },
    Scalar {
        path: "/logging-to-file",
        key: "logging-to-file",
        read: |s| json!(s.logging_to_file),
        write: |s, b| set_bool(&mut s.logging_to_file, b),
        clear: None,
    },
    Scalar {
        path: "/error-logs-max-files",
        key: "error-logs-max-files",
        read: |s| json!(s.error_logs_max_files),
        write: |s, b| set_i64(&mut s.error_logs_max_files, b),
        clear: None,
    },
    Scalar {
        path: "/usage-statistics-enabled",
        key: "usage-statistics-enabled",
        read: |s| json!(s.usage_statistics_enabled),
        write: |s, b| set_bool(&mut s.usage_statistics_enabled, b),
        clear: None,
    },
    Scalar {
        path: "/request-retry",
        key: "request-retry",
        read: |s| json!(s.request_retry),
        write: |s, b| set_i64(&mut s.request_retry, b),
        clear: None,
    },
    Scalar {
        path: "/max-retry-credentials",
        key: "max-retry-credentials",
        read: |s| json!(s.max_retry_credentials),
        write: |s, b| set_usize(&mut s.max_retry_credentials, b),
        clear: None,
    },
    Scalar {
        path: "/max-retry-interval",
        key: "max-retry-interval",
        read: |s| json!(s.max_retry_interval),
        write: |s, b| set_i64(&mut s.max_retry_interval, b),
        clear: None,
    },
    Scalar {
        path: "/force-model-prefix",
        key: "force-model-prefix",
        read: |s| json!(s.force_model_prefix),
        write: |s, b| set_bool(&mut s.force_model_prefix, b),
        clear: None,
    },
    Scalar {
        path: "/ws-auth",
        key: "ws-auth",
        read: |s| json!(s.ws_auth),
        write: |s, b| set_bool(&mut s.ws_auth, b),
        clear: None,
    },
    Scalar {
        path: "/proxy-url",
        key: "proxy-url",
        read: |s| json!(s.proxy_url),
        write: |s, b| set_string(&mut s.proxy_url, b),
        clear: Some(|s, _| {
            s.proxy_url.clear();
            Ok(())
        }),
    },
    Scalar {
        path: "/routing/strategy",
        key: "strategy",
        read: |s| {
            json!(normalize_routing_strategy(&s.routing.strategy)
                .map(str::to_string)
                .unwrap_or_else(|| s.routing.strategy.trim().to_string()))
        },
        write: |s, b| {
            let raw = valued::<String>(b)?;
            match normalize_routing_strategy(&raw) {
                Some(canonical) => {
                    s.routing.strategy = canonical.to_string();
                    Ok(())
                }
                None => Err(Refusal::Message("invalid strategy")),
            }
        },
        clear: None,
    },
    Scalar {
        path: "/quota-exceeded/switch-project",
        key: "switch-project",
        read: |s| json!(s.quota_exceeded.switch_project),
        write: |s, b| set_bool(&mut s.quota_exceeded.switch_project, b),
        clear: None,
    },
    Scalar {
        path: "/quota-exceeded/switch-preview-model",
        key: "switch-preview-model",
        read: |s| json!(s.quota_exceeded.switch_preview_model),
        write: |s, b| set_bool(&mut s.quota_exceeded.switch_preview_model, b),
        clear: None,
    },
    Scalar {
        path: "/oauth-excluded-models",
        key: "oauth-excluded-models",
        read: |s| json!(s.oauth_excluded_models),
        write: |s, b| {
            // Upstream accepts any document here and normalises later, so a
            // shape this build cannot map is stored as empty rather than
            // refused: refusing would reject a body upstream answers 200 to.
            s.oauth_excluded_models = provider_map(b).unwrap_or_default();
            Ok(())
        },
        clear: Some(|s, provider| match provider {
            Some(p) if !p.trim().is_empty() => {
                s.oauth_excluded_models
                    .remove(&p.trim().to_ascii_lowercase());
                Ok(())
            }
            _ => Err(Refusal::Message("missing provider")),
        }),
    },
    Scalar {
        path: "/oauth-model-alias",
        key: "oauth-model-alias",
        read: |s| s.oauth_model_alias.clone(),
        write: |s, b| passthrough(&mut s.oauth_model_alias, b),
        clear: Some(|s, _| {
            s.oauth_model_alias = Value::Null;
            Ok(())
        }),
    },
    Scalar {
        path: "/oauth-request-scoped-errors",
        key: "oauth-request-scoped-errors",
        read: |s| s.oauth_request_scoped_errors.clone(),
        write: |s, b| passthrough(&mut s.oauth_request_scoped_errors, b),
        clear: Some(|s, _| {
            s.oauth_request_scoped_errors = Value::Null;
            Ok(())
        }),
    },
];

pub fn find(path: &str) -> Option<&'static Scalar> {
    SCALARS.iter().find(|s| s.path == path)
}
