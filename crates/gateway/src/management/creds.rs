use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Describe one credential file the way upstream does: filesystem metadata
/// plus the `type`/`email` fields read out of the JSON itself, so the desktop
/// app can list accounts without opening every file.
fn describe(dir: &std::path::Path, name: &str) -> Option<Value> {
    let full = dir.join(name);
    let meta = std::fs::metadata(&full).ok()?;
    let mut entry = json!({
        "name": name,
        "size": meta.len(),
        "auth_index": auth_index(name),
        "path": full.to_string_lossy(),
        "label": name.trim_end_matches(".json"),
        "disabled": false,
        "unavailable": false,
        "runtime_only": false,
    });
    if let Ok(modified) = meta.modified() {
        if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
            entry["modtime"] = json!(since.as_secs());
        }
    }
    if let Ok(raw) = std::fs::read_to_string(&full) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            let kind = parsed.get("type").and_then(Value::as_str).unwrap_or_default();
            let email = parsed.get("email").and_then(Value::as_str).unwrap_or_default();
            entry["type"] = json!(kind);
            entry["email"] = json!(email);
            entry["provider"] = json!(kind);
            entry["account"] = json!(email);
            entry["account_type"] = json!("oauth");
            entry["status"] = json!("active");
            if let Some(project) = parsed.get("project_id").and_then(Value::as_str) {
                if !project.trim().is_empty() {
                    entry["project_id"] = json!(project);
                }
            }
        }
    }
    Some(entry)
}

async fn list_auth_files(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let dir = state.settings.current().auth_dir.clone();
    let dir = std::path::PathBuf::from(dir);

    if params
        .get("auth_index")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return json_status(StatusCode::OK, json!({ "files": [] }));
    }
    let name_filter = params.get("name").map(|v| v.trim().to_string());

    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return json_status(StatusCode::OK, json!({ "files": [] }))
        }
        Err(err) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("failed to read auth dir: {err}") }),
            )
        }
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if name_filter.as_deref().is_some_and(|f| !f.is_empty() && f != name) {
            continue;
        }
        if let Some(described) = describe(&dir, &name) {
            files.push(described);
        }
    }
    files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json_status(StatusCode::OK, json!({ "files": files }))
}

async fn create_auth_file(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid body" }));
    };
    let Some(name) = body.get("name").and_then(Value::as_str).map(str::trim) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "name is required" }));
    };
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    let content = body.get("content").cloned().unwrap_or(Value::Null);
    if let Err(error) = validate_provider_credential(&content) {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": error }));
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("failed to write auth file: {err}") }),
        );
    }
    let rendered = match serde_json::to_string_pretty(&content) {
        Ok(rendered) => rendered,
        Err(err) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": format!("invalid content: {err}") }),
            )
        }
    };
    match write_atomically(&dir.join(name), &rendered) {
        Ok(()) => json_status(StatusCode::OK, json!({ "status": "ok", "name": name })),
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("failed to write auth file: {err}") }),
        ),
    }
}

fn required_string<'a>(content: &'a Value, field: &str) -> Result<&'a str, String> {
    content
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("credential field {field} is required"))
}

fn validate_provider_credential(content: &Value) -> Result<(), String> {
    let kind = required_string(content, "type")?;
    match kind {
        "claude" | "cursor" => {
            required_string(content, "access_token")?;
            required_string(content, "refresh_token")?;
            required_string(content, "email")?;
            required_string(content, "expired")?;
        }
        "kiro" => {
            required_string(content, "access_token")?;
            required_string(content, "refresh_token")?;
            required_string(content, "email")?;
            required_string(content, "expired")?;
            if content.get("auth_mode").and_then(Value::as_str) == Some("idc") {
                required_string(content, "client_id")?;
                required_string(content, "client_secret")?;
            }
        }
        "zcode" => {
            let key = required_string(content, "access_token")?;
            if !quotio_providers::zcode::is_provisioned_api_key(key) {
                return Err("zcode access_token must be a provisioned {id}.{secret} key".into());
            }
            required_string(content, "refresh_token")?;
            required_string(content, "email")?;
            required_string(content, "expired")?;
        }
        "codex" | "antigravity" => {}
        _ => return Err(format!("unsupported credential type {kind}")),
    }
    Ok(())
}

/// Upstream addresses a credential by a stable opaque handle rather than its
/// filename, and `POST /reset-quota` takes that handle. It is derived from the
/// name so it survives restarts and stays identical for the same account.
fn auth_index(name: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Map an opaque handle back to the credential FILENAME that produced it. The
/// handle is not stored anywhere, so the directory is scanned and each name
/// re-hashed; the pool is small enough that this stays cheap. Callers match the
/// result against a member's `file_path`, which is the only identifier shared
/// between the directory listing and the loaded pool.
pub fn resolve_auth_index(state: &AppState, wanted: &str) -> Option<String> {
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if auth_index(&name) == wanted || name == wanted {
            return Some(name);
        }
    }
    None
}

/// A credential must never be observed half-written by the loader, which scans
/// this directory continuously; render to a temp file and rename into place.
fn write_atomically(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("tmp{}", std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temp, path)
}

async fn delete_auth_file(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(name) = params.get("name").map(|v| v.trim()) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "name is required" }));
    };
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    match std::fs::remove_file(dir.join(name)) {
        Ok(()) => json_status(StatusCode::OK, json!({ "status": "ok" })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            json_status(StatusCode::NOT_FOUND, json!({ "error": "auth not found" }))
        }
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("failed to delete auth file: {err}") }),
        ),
    }
}

async fn auth_file_models(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if params.get("name").map(|v| v.trim()).unwrap_or("").is_empty() {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "name is required" }));
    }
    json_status(
        StatusCode::OK,
        json!({ "models": crate::models_route::models_payload(&state.models, 0) }),
    )
}

async fn model_definitions(Path(channel): Path<String>) -> Response {
    json_status(
        StatusCode::OK,
        json!({ "channel": channel, "models": Value::Array(vec![]) }),
    )
}

async fn download_auth_file(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(name) = params.get("name").map(|v| v.trim()) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "name is required" }));
    };
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    match std::fs::read(dir.join(name)) {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (
                    header::CONTENT_DISPOSITION,
                    &format!("attachment; filename=\"{name}\""),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => json_status(StatusCode::NOT_FOUND, json!({ "error": "auth not found" })),
    }
}

async fn patch_unsupported() -> Response {
    json_status(
        StatusCode::BAD_REQUEST,
        json!({ "error": "invalid body" }),
    )
}

async fn vertex_import(raw: bytes::Bytes) -> Response {
    let parsed = serde_json::from_slice::<Value>(&raw).unwrap_or(Value::Null);
    let has_file = parsed
        .get("file")
        .and_then(Value::as_str)
        .is_some_and(|f| !f.trim().is_empty());
    if !has_file {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "file required" }));
    }
    json_status(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": "core auth manager unavailable" }),
    )
}

pub fn creds_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/auth-files",
            get(list_auth_files)
                .post(create_auth_file)
                .delete(delete_auth_file),
        )
        .route("/auth-files/models", get(auth_file_models))
        .route("/auth-files/download", get(download_auth_file))
        .route("/auth-files/status", axum::routing::patch(patch_unsupported))
        .route("/auth-files/fields", axum::routing::patch(patch_unsupported))
        .route("/model-definitions/{channel}", get(model_definitions))
        .route("/vertex/import", post(vertex_import))
        .merge(super::oauth::oauth_routes())
        .route("/oauth-session", delete(super::oauth::cancel_session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_listing_reports_type_and_email_from_the_file() {
        // given a credential file on disk
        let dir = std::env::temp_dir().join(format!("quotio-creds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join("acct.json"),
            r#"{"type":"codex","email":"a@b.c","project_id":"p1"}"#,
        )
        .expect("write");
        // when described
        let described = describe(&dir, "acct.json").expect("described");
        // then the loader-visible fields are surfaced
        assert_eq!(described["type"], "codex");
        assert_eq!(described["email"], "a@b.c");
        assert_eq!(described["project_id"], "p1");
        assert_eq!(described["name"], "acct.json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writing_a_credential_leaves_no_temp_file() {
        // given a credential written atomically
        let dir = std::env::temp_dir().join(format!("quotio-creds-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        write_atomically(&dir.join("x.json"), "{}").expect("writes");
        // when the directory is listed
        let names: Vec<_> = std::fs::read_dir(&dir)
            .expect("readable")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        // then only the final file exists, so the loader never sees a partial
        assert_eq!(names, vec!["x.json".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn provider_imports_reject_credentials_the_loader_cannot_use() {
        let invalid_kiro = json!({
            "type": "kiro",
            "auth_mode": "idc",
            "access_token": "a",
            "refresh_token": "r",
            "email": "u@example.com",
            "expired": "2099-01-01T00:00:00Z",
            "client_id": "client"
        });
        assert_eq!(
            validate_provider_credential(&invalid_kiro),
            Err("credential field client_secret is required".to_string())
        );

        let invalid_zcode = json!({
            "type": "zcode",
            "access_token": "oauth-token-not-api-key",
            "refresh_token": "r",
            "email": "u@example.com",
            "expired": "2099-01-01T00:00:00Z"
        });
        assert_eq!(
            validate_provider_credential(&invalid_zcode),
            Err("zcode access_token must be a provisioned {id}.{secret} key".to_string())
        );
    }

    #[test]
    fn provider_imports_accept_reference_credential_shapes() {
        for credential in [
            json!({
                "type": "claude", "access_token": "a", "refresh_token": "r",
                "email": "u@example.com", "expired": "2099-01-01T00:00:00Z"
            }),
            json!({
                "type": "cursor", "access_token": "a", "refresh_token": "r",
                "email": "u@example.com", "expired": "2099-01-01T00:00:00Z"
            }),
            json!({
                "type": "kiro", "auth_mode": "social", "access_token": "a",
                "refresh_token": "r", "email": "u@example.com",
                "expired": "2099-01-01T00:00:00Z"
            }),
            json!({
                "type": "kiro", "auth_mode": "idc", "access_token": "a",
                "refresh_token": "r", "email": "u@example.com",
                "expired": "2099-01-01T00:00:00Z", "client_id": "c",
                "client_secret": "s"
            }),
            json!({
                "type": "zcode", "access_token": "id.secret", "refresh_token": "r",
                "email": "u@example.com", "expired": "2099-01-01T00:00:00Z"
            }),
        ] {
            validate_provider_credential(&credential).expect("reference shape accepted");
        }
    }
}
