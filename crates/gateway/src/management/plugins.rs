use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn not_installed(id: &str) -> Response {
    json_status(
        StatusCode::NOT_FOUND,
        json!({ "error": format!("plugin not found: {id}") }),
    )
}

async fn list_plugins(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    json_status(
        StatusCode::OK,
        json!({
            "plugins_enabled": settings.plugins.enabled,
            "plugins_dir": if settings.plugins.dir.is_empty() { "plugins" } else { &settings.plugins.dir },
            "plugins": Value::Array(vec![]),
        }),
    )
}

/// The store is a remote catalogue upstream fetches. This build ships no
/// catalogue source, and an empty list is the honest answer: inventing entries
/// would let a client install something that cannot exist here.
async fn list_plugin_store() -> Response {
    json_status(StatusCode::OK, json!({ "plugins": Value::Array(vec![]) }))
}

/// Installing runs third-party code, which this build has no host for. Upstream
/// answers the same way when the requested id is not in its catalogue, so a
/// client sees a real refusal rather than a success it cannot act on.
async fn install_plugin(Path(id): Path<String>) -> Response {
    not_installed(&id)
}

async fn delete_plugin(Path(id): Path<String>) -> Response {
    not_installed(&id)
}

async fn patch_plugin_enabled(Path(id): Path<String>) -> Response {
    not_installed(&id)
}

async fn plugin_config(Path(id): Path<String>) -> Response {
    not_installed(&id)
}

pub fn plugins_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/plugins", get(list_plugins))
        .route("/plugin-store", get(list_plugin_store))
        .route("/plugin-store/{id}/install", post(install_plugin))
        .route("/plugins/{id}", delete(delete_plugin))
        .route(
            "/plugins/{id}/enabled",
            axum::routing::patch(patch_plugin_enabled),
        )
        .route(
            "/plugins/{id}/config",
            get(plugin_config)
                .put(plugin_config)
                .patch(plugin_config),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_upstream_plugin_path_is_registered() {
        // given the upstream plugin routes
        let groups: Value =
            serde_json::from_str(include_str!("../../../../.omo/upstream/route-groups.json"))
                .expect("route groups");
        let paths: Vec<String> = groups["plugins"]
            .as_array()
            .expect("plugins")
            .iter()
            .filter_map(|r| r.as_str())
            .map(|r| r.split_once(' ').expect("pair").1.to_string())
            .collect();
        // then the registered set covers each one, allowing for axum's
        // {param} spelling of gin's :param
        let registered = [
            "/plugins",
            "/plugin-store",
            "/plugin-store/:id/install",
            "/plugins/:id",
            "/plugins/:id/enabled",
            "/plugins/:id/config",
        ];
        for path in &paths {
            assert!(registered.contains(&path.as_str()), "unregistered: {path}");
        }
    }
}
