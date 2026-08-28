use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::scalar_table::Refusal;
use super::{scalars, settings::Settings};
use crate::state::AppState;

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Upstream serves log files out of a directory beside the config, and refuses
/// every log route with 400 while `logging-to-file` is off rather than
/// returning an empty list, so a client can tell "disabled" from "no logs".
fn log_dir(settings: &Settings) -> std::path::PathBuf {
    std::path::PathBuf::from(&settings.auth_dir).join("logs")
}

fn require_file_logging(settings: &Settings) -> Option<Response> {
    if settings.logging_to_file {
        return None;
    }
    Some(json_status(
        StatusCode::BAD_REQUEST,
        json!({ "error": "logging to file disabled" }),
    ))
}

fn list_log_files(dir: &std::path::Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<Value> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(json!({
                "name": entry.file_name().to_string_lossy(),
                "size": meta.len(),
            }))
        })
        .collect();
    files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    files
}

async fn get_logs(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    if let Some(refusal) = require_file_logging(&settings) {
        return refusal;
    }
    json_status(
        StatusCode::OK,
        json!({ "files": list_log_files(&log_dir(&settings)) }),
    )
}

async fn delete_logs(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    if let Some(refusal) = require_file_logging(&settings) {
        return refusal;
    }
    let dir = log_dir(&settings);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    json_status(StatusCode::OK, json!({ "status": "ok" }))
}

async fn request_error_logs(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    if let Some(refusal) = require_file_logging(&settings) {
        return refusal;
    }
    json_status(
        StatusCode::OK,
        json!({ "files": list_log_files(&log_dir(&settings)) }),
    )
}

async fn request_error_log_by_name(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    let settings = state.settings.current();
    if let Some(refusal) = require_file_logging(&settings) {
        return refusal;
    }
    if name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    match std::fs::read_to_string(log_dir(&settings).join(&name)) {
        Ok(body) => (StatusCode::OK, body).into_response(),
        Err(_) => json_status(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
    }
}

async fn request_log_by_id(Path(id): Path<String>) -> Response {
    json_status(
        StatusCode::NOT_FOUND,
        json!({ "error": "not found", "id": id }),
    )
}

pub fn observability_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/logs", get(get_logs).delete(delete_logs))
        .route("/request-error-logs", get(request_error_logs))
        .route("/request-error-logs/{name}", get(request_error_log_by_name))
        .route("/request-log-by-id/{id}", get(request_log_by_id))
        .route(
            "/request-log",
            get(|State(state): State<Arc<AppState>>| async move {
                let value = state.settings.current().request_log;
                json_status(StatusCode::OK, json!({ "request-log": value }))
            })
            .put(write_request_log)
            .patch(write_request_log),
        )
        .route(
            "/logs-max-total-size-mb",
            get(|State(state): State<Arc<AppState>>| async move {
                let value = state.settings.current().logs_max_total_size_mb;
                json_status(StatusCode::OK, json!({ "logs-max-total-size-mb": value }))
            })
            .put(write_logs_cap)
            .patch(write_logs_cap),
        )
}

async fn write_request_log(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    write_field(state, raw, |settings, value| {
        settings.request_log = value.as_bool().ok_or(Refusal::InvalidBody)?;
        Ok(())
    })
}

async fn write_logs_cap(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    write_field(state, raw, |settings, value| {
        settings.logs_max_total_size_mb = value.as_i64().ok_or(Refusal::InvalidBody)?;
        Ok(())
    })
}

fn write_field(
    state: Arc<AppState>,
    raw: bytes::Bytes,
    set: impl FnOnce(&mut Settings, &Value) -> Result<(), Refusal>,
) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return scalars::refusal_response(Refusal::InvalidBody);
    };
    let Some(value) = body.get("value").cloned() else {
        return scalars::refusal_response(Refusal::InvalidBody);
    };
    scalars::apply_edit(&state, |settings| set(settings, &value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_routes_are_refused_while_file_logging_is_off() {
        // given a config with logging-to-file disabled
        let settings = Settings::default();
        // when a log route checks availability
        let refusal = require_file_logging(&settings);
        // then it refuses rather than reporting an empty list
        assert!(refusal.is_some());
    }

    #[test]
    fn log_routes_are_available_once_file_logging_is_on() {
        // given logging enabled
        let settings = Settings {
            logging_to_file: true,
            ..Settings::default()
        };
        // then the guard lets the request through
        assert!(require_file_logging(&settings).is_none());
    }

    #[test]
    fn listing_reports_real_files_and_skips_directories() {
        // given a log directory holding a file and a subdirectory
        let dir = std::env::temp_dir().join(format!("quotio-logs-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("nested")).expect("dirs");
        std::fs::write(dir.join("app.log"), "hello").expect("write");
        // when listed
        let files = list_log_files(&dir);
        // then only the real file is reported, with its true size
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[0]["name"], "app.log");
        assert_eq!(files[0]["size"], 5);
        std::fs::remove_dir_all(&dir).ok();
    }
}
