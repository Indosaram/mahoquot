use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::scalar_table::Refusal;
use super::settings::Settings;
use super::{lists, scalars};
use crate::state::AppState;

/// A provider key collection: its route, the key its GET answers under, and
/// where the list lives in the settings document.
struct KeyList {
    path: &'static str,
    key: &'static str,
    field: fn(&mut Settings) -> &mut Vec<String>,
}

const KEY_LISTS: &[KeyList] = &[
    KeyList {
        path: "/api-keys",
        key: "api-keys",
        field: |s| &mut s.api_keys,
    },
    KeyList {
        path: "/gemini-api-key",
        key: "gemini-api-key",
        field: |s| &mut s.gemini_api_key,
    },
    KeyList {
        path: "/claude-api-key",
        key: "claude-api-key",
        field: |s| &mut s.claude_api_key,
    },
    KeyList {
        path: "/codex-api-key",
        key: "codex-api-key",
        field: |s| &mut s.codex_api_key,
    },
    KeyList {
        path: "/xai-api-key",
        key: "xai-api-key",
        field: |s| &mut s.xai_api_key,
    },
    KeyList {
        path: "/vertex-api-key",
        key: "vertex-api-key",
        field: |s| &mut s.vertex_api_key,
    },
    KeyList {
        path: "/interactions-api-key",
        key: "interactions-api-key",
        field: |s| &mut s.interactions_api_key,
    },
    KeyList {
        path: "/openai-compatibility",
        key: "openai-compatibility",
        field: |s| &mut s.openai_compatibility,
    },
];

fn find(path: &str) -> Option<&'static KeyList> {
    KEY_LISTS.iter().find(|k| k.path == path)
}

fn entry(path: &'static str) -> &'static KeyList {
    find(path).expect("registered key list")
}

pub fn key_lists_paths() -> impl Iterator<Item = &'static str> {
    KEY_LISTS.iter().map(|k| k.path)
}

async fn read(state: Arc<AppState>, list: &'static KeyList) -> Response {
    let mut settings = Settings::clone(&state.settings.current());
    let value = (list.field)(&mut settings).clone();
    (StatusCode::OK, Json(json!({ list.key: value }))).into_response()
}

fn mutate(
    state: &Arc<AppState>,
    list: &'static KeyList,
    edit: impl FnOnce(&mut Vec<String>) -> Result<(), Refusal>,
) -> Response {
    scalars::apply_edit(state, |settings| edit((list.field)(settings)))
}

async fn replace(state: Arc<AppState>, list: &'static KeyList, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return scalars::refusal_response(Refusal::InvalidBody);
    };
    mutate(&state, list, |target| lists::replace(target, &body))
}

async fn edit(state: Arc<AppState>, list: &'static KeyList, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return scalars::refusal_response(Refusal::InvalidBody);
    };
    mutate(&state, list, |target| lists::edit(target, &body))
}

async fn remove(
    state: Arc<AppState>,
    list: &'static KeyList,
    params: HashMap<String, String>,
) -> Response {
    let index = params.get("index").map(String::as_str);
    let value = params.get("value").map(String::as_str);
    mutate(&state, list, |target| lists::remove(target, index, value))
}

async fn api_key_usage(State(state): State<Arc<AppState>>) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "api-key-usage": state.get_stats() })),
    )
        .into_response()
}

/// Upstream reports the pending usage-record queue here. This build persists
/// usage inline rather than through a queue, so the depth is always zero;
/// reporting a fabricated backlog would be worse than reporting the truth.
async fn usage_queue() -> Response {
    (StatusCode::OK, Json(json!([]))).into_response()
}

pub fn apikeys_routes() -> Router<Arc<AppState>> {
    let mut router = Router::new()
        .route("/api-key-usage", get(api_key_usage))
        .route("/usage-queue", get(usage_queue));

    for list in KEY_LISTS {
        let path = list.path;
        router =
            router.route(
                path,
                get(move |State(state): State<Arc<AppState>>| async move {
                    read(state, entry(path)).await
                })
                .put(
                    move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
                        replace(state, entry(path), body).await
                    },
                )
                .patch(
                    move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
                        edit(state, entry(path), body).await
                    },
                )
                .delete(
                    move |State(state): State<Arc<AppState>>,
                          Query(params): Query<HashMap<String, String>>| async move {
                        remove(state, entry(path), params).await
                    },
                ),
            );
    }
    router
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_upstream_apikey_path_is_registered() {
        // given the upstream route list
        let groups: Value =
            serde_json::from_str(include_str!("../../../../.omo/upstream/route-groups.json"))
                .expect("route groups");
        let paths: std::collections::BTreeSet<String> = groups["apikeys"]
            .as_array()
            .expect("apikeys")
            .iter()
            .map(|r| {
                r.as_str()
                    .expect("route")
                    .split_once(' ')
                    .expect("pair")
                    .1
                    .to_string()
            })
            .collect();
        // then each is either a key list or one of the two read-only reports
        let known = ["/api-key-usage", "/usage-queue"];
        let missing: Vec<_> = paths
            .iter()
            .filter(|p| find(p).is_none() && !known.contains(&p.as_str()))
            .collect();
        assert!(missing.is_empty(), "unregistered apikey paths: {missing:?}");
    }

    #[test]
    fn each_key_list_targets_a_distinct_field() {
        // given every registered list
        let mut settings = Settings::default();
        for list in KEY_LISTS {
            (list.field)(&mut settings).push(list.key.to_string());
        }
        // then no two share a backing field
        for list in KEY_LISTS {
            let target = (list.field)(&mut settings).clone();
            assert_eq!(target, vec![list.key.to_string()], "aliased: {}", list.path);
        }
    }
}
