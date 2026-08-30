use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

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

/// Upstream serves log files out of a directory beside the config. While
/// `logging-to-file` is off the file-backed routes keep refusing with 400 so a
/// client can tell "disabled" from "no logs"; `/logs` itself always answers,
/// falling back to the in-memory tail (see `LogTail`).
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

/// Capacity of the in-memory tail served while file logging is off.
const LOG_TAIL_CAPACITY: usize = 1000;

/// Bounded in-memory tail of recent log lines. File persistence is a setting;
/// the live tail is always fed, so the Logs surface keeps showing real-time
/// output even while `logging-to-file` is off.
#[derive(Default)]
pub struct LogTail {
    lines: Mutex<VecDeque<String>>,
}

impl LogTail {
    pub fn push(&self, line: String) {
        let mut lines = self.lines.lock().expect("log tail lock");
        if lines.len() >= LOG_TAIL_CAPACITY {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn snapshot(&self) -> Vec<String> {
        let lines = self.lines.lock().expect("log tail lock");
        lines.iter().cloned().collect()
    }

    pub fn clear(&self) {
        self.lines.lock().expect("log tail lock").clear();
    }
}

pub fn append_log_line(settings: &Settings, line: &str) {
    if !settings.logging_to_file {
        return;
    }
    let dir = log_dir(settings);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write;
    let path = dir.join("gateway.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
    let max_bytes = settings.logs_max_total_size_mb.max(0) as u64 * 1024 * 1024;
    if max_bytes > 0 {
        trim_log_file(&path, max_bytes);
    }
}

fn trim_log_file(path: &std::path::Path, max_bytes: u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if metadata.len() <= max_bytes {
        return;
    }
    let Ok(body) = std::fs::read(path) else {
        return;
    };
    let keep = max_bytes.min(body.len() as u64) as usize;
    let start = body.len().saturating_sub(keep);
    let boundary = body[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| start + offset + 1)
        .unwrap_or(start);
    let _ = std::fs::write(path, &body[boundary..]);
}

fn read_log_lines(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .filter(|e| e.metadata().map(|m| m.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    paths.sort();
    paths
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .flat_map(|body| body.lines().map(str::to_string).collect::<Vec<_>>())
        .collect()
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

/// Parse one stored log line into a structured record. Well-formed records
/// pass through; legacy or foreign lines degrade to proxy events so the UI
/// never loses them.
fn parse_log_record(line: &str) -> Value {
    match serde_json::from_str::<Value>(line) {
        Ok(value) if value.get("kind").is_some() => value,
        _ => json!({ "kind": "proxy", "timestamp": Value::Null, "message": line }),
    }
}

async fn get_logs(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    let dir = log_dir(&settings);
    let lines = if settings.logging_to_file {
        read_log_lines(&dir)
    } else {
        // File logging is off, but the live tail is still being fed: answer
        // with it instead of refusing, so the Logs surface shows real-time
        // output rather than an error.
        state.log_tail.snapshot()
    };
    let records: Vec<Value> = lines.iter().map(|line| parse_log_record(line)).collect();
    let request_count = records
        .iter()
        .filter(|record| record["kind"] == "request")
        .count();
    json_status(
        StatusCode::OK,
        json!({
            "records": records,
            "request-count": request_count,
            "proxy-count": records.len() - request_count,
            "latest-timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default(),
        }),
    )
}

async fn delete_logs(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.current();
    // The tail is the live data while file logging is off, so a clear must
    // always reach it; files are only touched while logging is enabled.
    state.log_tail.clear();
    let dir = log_dir(&settings);
    let mut removed = 0u64;
    if settings.logging_to_file {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.metadata().map(|m| m.is_file()).unwrap_or(false)
                    && std::fs::remove_file(entry.path()).is_ok()
                {
                    removed += 1;
                }
            }
        }
    }
    json_status(
        StatusCode::OK,
        json!({ "success": true, "removed": removed, "message": "Logs cleared successfully" }),
    )
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
    fn file_backed_log_routes_are_refused_while_file_logging_is_off() {
        // given a config with logging-to-file disabled
        let settings = Settings {
            logging_to_file: false,
            ..Settings::default()
        };
        // when a file-backed log route checks availability
        let refusal = require_file_logging(&settings);
        // then it refuses rather than reporting an empty list
        assert!(refusal.is_some());
    }

    #[test]
    fn log_tail_serves_recent_lines_in_order_and_stays_bounded() {
        // given a tail already at capacity
        let tail = LogTail::default();
        for index in 0..(LOG_TAIL_CAPACITY as u64) {
            tail.push(index.to_string());
        }
        // when one more line is pushed
        tail.push("newest".to_string());
        // then the oldest line was dropped and order is preserved
        let snapshot = tail.snapshot();
        assert_eq!(snapshot.len(), LOG_TAIL_CAPACITY);
        assert_eq!(snapshot[0], (1u64).to_string());
        assert_eq!(snapshot[LOG_TAIL_CAPACITY - 1], "newest");
        // and clearing empties it completely
        tail.clear();
        assert!(tail.snapshot().is_empty());
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
        let dir = std::env::temp_dir().join(format!("mahoquot-logs-{}", std::process::id()));
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

    #[test]
    fn append_log_line_obeys_the_total_size_cap() {
        let dir = std::env::temp_dir().join(format!("mahoquot-log-cap-{}", std::process::id()));
        let settings = Settings {
            auth_dir: dir.to_string_lossy().to_string(),
            logging_to_file: true,
            logs_max_total_size_mb: 1,
            ..Settings::default()
        };
        let line = "x".repeat(700_000);
        append_log_line(&settings, &line);
        append_log_line(&settings, &line);
        let size = std::fs::metadata(dir.join("logs/gateway.log"))
            .expect("log metadata")
            .len();
        assert!(size <= 1024 * 1024);
        std::fs::remove_dir_all(dir).ok();
    }
}
