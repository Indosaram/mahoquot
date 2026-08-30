use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::scalar_table::{find, Refusal, Scalar, SCALARS};
use crate::state::AppState;

/// Upstream answers every successful write with `{"status":"ok"}` from its
/// shared persist helper, never an echo of the written value.
fn saved() -> Response {
    (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response()
}

pub fn refusal_response(refusal: Refusal) -> Response {
    let message = match refusal {
        Refusal::InvalidBody => "invalid body",
        Refusal::Message(m) => m,
    };
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn persist_failed(err: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("failed to save config: {err}") })),
    )
        .into_response()
}

async fn read_scalar(state: Arc<AppState>, scalar: &'static Scalar) -> Response {
    let value = (scalar.read)(&state.settings.current());
    (StatusCode::OK, Json(json!({ scalar.key: value }))).into_response()
}

/// Apply a change, refusing before anything is written when the body is bad.
///
/// The edit runs inside the store's mutate so persistence and publication stay
/// atomic, and its refusal is captured out rather than returned, because the
/// store's closure cannot fail the mutation itself.
/// Record management writes to the live tail (and the log file while it is
/// enabled) so the log view reflects real activity rather than staying empty
/// until some other subsystem logs.
fn note_edit(state: &AppState, what: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let line = serde_json::json!({
        "kind": "proxy",
        "timestamp": timestamp,
        "message": format!("management: {what}"),
    })
    .to_string();
    state.log_tail.push(line.clone());
    let settings = state.settings.current();
    super::observability::append_log_line(&settings, &line);
}

pub fn apply_edit(
    state: &Arc<AppState>,
    edit: impl FnOnce(&mut super::settings::Settings) -> Result<(), Refusal>,
) -> Response {
    let mut refusal = None;
    let outcome = state.settings.mutate(|settings| {
        if let Err(reason) = edit(settings) {
            refusal = Some(reason);
        }
    });

    if let Some(reason) = refusal {
        return refusal_response(reason);
    }
    if outcome.is_ok() {
        note_edit(state, "config updated");
    }
    match outcome {
        Ok(_) => saved(),
        Err(err) => persist_failed(err),
    }
}

async fn write_scalar(
    state: Arc<AppState>,
    scalar: &'static Scalar,
    raw: bytes::Bytes,
) -> Response {
    // Parse here rather than through axum's Json extractor: that extractor
    // answers a malformed payload with its own parser text, which upstream
    // never emits -- every bad body must read {"error":"invalid body"}.
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return refusal_response(Refusal::InvalidBody);
    };
    apply_edit(&state, |settings| (scalar.write)(settings, &body))
}

async fn clear_scalar(
    state: Arc<AppState>,
    scalar: &'static Scalar,
    params: HashMap<String, String>,
) -> Response {
    let Some(clear) = scalar.clear else {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    };
    if super::scalar_table::is_channel_keyed(scalar.path) {
        let channel = params.get("channel").map(|c| c.trim()).unwrap_or("");
        return refusal_response(Refusal::Message(if channel.is_empty() {
            "missing channel"
        } else {
            "channel not found"
        }));
    }
    let provider = params.get("provider").map(String::as_str);
    apply_edit(&state, |settings| clear(settings, provider))
}

fn patch_channel(raw: bytes::Bytes) -> Response {
    let parsed = serde_json::from_slice::<Value>(&raw).unwrap_or(Value::Null);
    let channel = parsed.get("channel").and_then(Value::as_str).unwrap_or("");
    refusal_response(Refusal::Message(if channel.trim().is_empty() {
        "invalid channel"
    } else {
        "channel not found"
    }))
}

pub fn scalars_routes() -> Router<Arc<AppState>> {
    let mut router = Router::new();
    for scalar in SCALARS {
        let path = scalar.path;
        let mut method = get(move |State(state): State<Arc<AppState>>| async move {
            read_scalar(state, find(path).expect("registered")).await
        })
        .put(
            move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
                write_scalar(state, find(path).expect("registered"), body).await
            },
        )
        .patch(
            move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
                let scalar = find(path).expect("registered");
                if super::scalar_table::is_channel_keyed(scalar.path) {
                    return patch_channel(body);
                }
                write_scalar(state, scalar, body).await
            },
        );
        if scalar.clear.is_some() {
            method = method.delete(
                move |State(state): State<Arc<AppState>>,
                      Query(params): Query<HashMap<String, String>>| async move {
                    clear_scalar(state, find(path).expect("registered"), params).await
                },
            );
        }
        router = router.route(path, method);
    }
    router
}

#[cfg(test)]
mod tests {
    use super::super::scalar_table::normalize_routing_strategy;
    use super::*;
    use crate::management::settings::Settings;

    #[test]
    fn every_upstream_scalar_path_is_registered() {
        // given the route list captured from upstream
        let groups: Value =
            serde_json::from_str(include_str!("../../../../.omo/upstream/route-groups.json"))
                .expect("route groups");
        let expected: std::collections::BTreeSet<String> = groups["scalars"]
            .as_array()
            .expect("scalars")
            .iter()
            .map(|r| {
                r.as_str()
                    .expect("route")
                    .split_once(' ')
                    .expect("method path")
                    .1
                    .to_string()
            })
            .collect();
        // then every one has a table entry
        let missing: Vec<_> = expected.iter().filter(|p| find(p).is_none()).collect();
        assert!(missing.is_empty(), "unregistered scalar paths: {missing:?}");
    }

    #[test]
    fn routing_strategy_answers_under_its_own_key() {
        // given the routing scalar
        let scalar = find("/routing/strategy").expect("registered");
        // then its response key is "strategy", not the path
        assert_eq!(scalar.key, "strategy");
    }

    #[test]
    fn routing_strategy_normalizes_every_upstream_spelling() {
        // given each accepted alias
        for (input, canonical) in [
            ("", "round-robin"),
            ("rr", "round-robin"),
            ("RoundRobin", "round-robin"),
            ("wrr", "weighted-round-robin"),
            ("ff", "fill-first"),
            ("Fill-First", "fill-first"),
        ] {
            // then it maps to upstream's canonical spelling
            assert_eq!(
                normalize_routing_strategy(input),
                Some(canonical),
                "{input}"
            );
        }
        // and an unknown strategy is rejected
        assert_eq!(normalize_routing_strategy("nonsense"), None);
    }

    #[test]
    fn an_invalid_strategy_is_refused_with_its_own_message() {
        // given a write of an unknown strategy
        let scalar = find("/routing/strategy").expect("registered");
        let mut settings = Settings::default();
        // when applied
        let result = (scalar.write)(&mut settings, &json!({ "value": "nonsense" }));
        // then upstream's specific message is used, not the generic one
        assert!(matches!(result, Err(Refusal::Message("invalid strategy"))));
    }

    #[test]
    fn a_provider_map_accepts_both_upstream_body_shapes() {
        // given the bare map and the items-wrapped form
        let scalar = find("/oauth-excluded-models").expect("registered");
        let mut bare = Settings::default();
        let mut wrapped = Settings::default();
        assert!((scalar.write)(&mut bare, &json!({ "gemini": ["a"] })).is_ok());
        assert!((scalar.write)(&mut wrapped, &json!({ "items": { "gemini": ["a"] } })).is_ok());
        // then both land identically
        assert_eq!(bare.oauth_excluded_models, wrapped.oauth_excluded_models);
        assert_eq!(bare.oauth_excluded_models["gemini"], vec!["a"]);
    }

    #[test]
    fn deleting_a_provider_list_requires_the_provider_query() {
        // given the collection scalar
        let scalar = find("/oauth-excluded-models").expect("registered");
        let clear = scalar.clear.expect("supports delete");
        let mut settings = Settings::default();
        // when no provider is supplied
        let result = clear(&mut settings, None);
        // then upstream's missing-provider error is returned
        assert!(matches!(result, Err(Refusal::Message("missing provider"))));
    }
}
