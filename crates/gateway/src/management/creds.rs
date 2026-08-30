use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

const ACCOUNT_ORDER_FILE: &str = ".mahoquot-account-order.json";

fn is_credential_filename(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.ends_with(".json") && name != ACCOUNT_ORDER_FILE && lowered != "telemetry.json"
}

fn ordered_names(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(dir.join(ACCOUNT_ORDER_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn sort_described_files(files: &mut [Value], order: &[String]) {
    files.sort_by(|a, b| {
        let a_name = a["name"].as_str().unwrap_or_default();
        let b_name = b["name"].as_str().unwrap_or_default();
        let a_index = order
            .iter()
            .position(|name| name == a_name)
            .unwrap_or(usize::MAX);
        let b_index = order
            .iter()
            .position(|name| name == b_name)
            .unwrap_or(usize::MAX);
        a_index.cmp(&b_index).then_with(|| a_name.cmp(b_name))
    });
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
            let kind = parsed
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let email = parsed
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or_default();
            entry["type"] = json!(kind);
            entry["email"] = json!(email);
            entry["provider"] = parsed
                .get("provider")
                .cloned()
                .unwrap_or_else(|| json!(kind));
            entry["account"] = json!(email);
            entry["account_type"] = json!("oauth");
            let disabled = parsed
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            entry["disabled"] = json!(disabled);
            entry["status"] = json!(if disabled { "disabled" } else { "active" });
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
        if !is_credential_filename(&name) {
            continue;
        }
        if name_filter
            .as_deref()
            .is_some_and(|f| !f.is_empty() && f != name)
        {
            continue;
        }
        if let Some(described) = describe(&dir, &name) {
            files.push(described);
        }
    }
    sort_described_files(&mut files, &ordered_names(&dir));
    json_status(StatusCode::OK, json!({ "files": files }))
}

async fn save_auth_file_order(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid body" }));
    };
    let Some(names) = body.get("names").and_then(Value::as_array) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "names is required" }),
        );
    };
    let names: Vec<String> = names
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.contains('/') && !name.contains(".."))
        .map(str::to_string)
        .collect();
    if names.len() != body["names"].as_array().map_or(0, Vec::len) {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid credential name" }),
        );
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        );
    }
    let rendered = match serde_json::to_string_pretty(&names) {
        Ok(rendered) => rendered,
        Err(err) => {
            return json_status(StatusCode::BAD_REQUEST, json!({ "error": err.to_string() }))
        }
    };
    match write_atomically(&dir.join(ACCOUNT_ORDER_FILE), &rendered) {
        Ok(()) => json_status(StatusCode::OK, json!({ "status": "ok", "names": names })),
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        ),
    }
}

fn decode_claude_credentials(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    let decoded = if trimmed.starts_with('{') {
        trimmed.to_string()
    } else {
        let bytes = trimmed.as_bytes();
        if !bytes.len().is_multiple_of(2) || !bytes.iter().all(u8::is_ascii_hexdigit) {
            return Err("Claude Code credential has an unknown format".into());
        }
        let decoded: Result<Vec<u8>, _> = bytes
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap_or_default(), 16))
            .collect();
        String::from_utf8(decoded.map_err(|_| "invalid Claude Code credential encoding")?)
            .map_err(|_| "Claude Code credential is not UTF-8")?
    };
    serde_json::from_str(&decoded)
        .map_err(|err| format!("invalid Claude Code credential JSON: {err}"))
}

fn claude_credential_from_store(value: &Value) -> Result<Value, String> {
    let oauth = value
        .get("claudeAiOauth")
        .ok_or_else(|| "Claude Code OAuth credential is missing".to_string())?;
    let access_token = required_string(oauth, "accessToken")?;
    let refresh_token = required_string(oauth, "refreshToken")?;
    let expires_at = oauth
        .get("expiresAt")
        .and_then(Value::as_u64)
        .ok_or_else(|| "credential field expiresAt is required".to_string())?;
    Ok(json!({
        "type": "claude",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "email": "Claude Code subscription",
        "expired": super::oauth::format_rfc3339(expires_at / 1000),
        "identity_slug": "claude-code",
        "disabled": false
    }))
}

async fn import_local_claude(State(state): State<Arc<AppState>>) -> Response {
    let credential_bytes = tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("security")
                .args([
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                ])
                .output()
                .map_err(|err| err.to_string())?;
            if output.status.success() {
                Ok(output.stdout)
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let home = std::env::var("HOME").map_err(|err| err.to_string())?;
            std::fs::read(std::path::PathBuf::from(home).join(".claude/.credentials.json"))
                .map_err(|err| err.to_string())
        }
    })
    .await;

    let credential_bytes = match credential_bytes {
        Ok(Ok(bytes)) => bytes,
        _ => {
            return json_status(
                StatusCode::NOT_FOUND,
                json!({ "error": "Claude Code OAuth credential not found" }),
            )
        }
    };
    let raw = String::from_utf8_lossy(&credential_bytes);
    let stored = match decode_claude_credentials(&raw)
        .and_then(|value| claude_credential_from_store(&value))
    {
        Ok(stored) => stored,
        Err(error) => return json_status(StatusCode::BAD_REQUEST, json!({ "error": error })),
    };
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        );
    }
    let rendered = serde_json::to_string_pretty(&stored).unwrap_or_default();
    match write_atomically(&dir.join("claude-local.json"), &rendered) {
        Ok(()) => {
            if let Err(error) = state.rescan_pool() {
                eprintln!("pool rescan failed after claude import: {error}");
            }
            json_status(
                StatusCode::OK,
                json!({ "status": "ok", "name": "claude-local.json" }),
            )
        }
        Err(err) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        ),
    }
}

async fn create_auth_file(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid body" }));
    };
    let Some(name) = body.get("name").and_then(Value::as_str).map(str::trim) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name is required" }),
        );
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
        Ok(()) => {
            if let Err(error) = state.rescan_pool() {
                eprintln!("pool rescan failed after credential write: {error}");
            }
            json_status(StatusCode::OK, json!({ "status": "ok", "name": name }))
        }
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
        "claude" | "anthropic" | "cursor" => {
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
            if !mahoquot_providers::zcode::is_provisioned_api_key(key) {
                return Err("zcode access_token must be a provisioned {id}.{secret} key".into());
            }
            required_string(content, "email")?;
            // A provisioned key never expires and has nothing to refresh from,
            // so demanding those two fields would reject the only credential
            // shape an operator can actually paste.
        }
        "generic" => {
            for field in ["provider", "adapter", "base_url"] {
                required_string(content, field)?;
            }
        }
        "vertex" | "google-vertex" => {
            required_string(content, "project_id")?;
        }
        "monitor" => {
            required_string(content, "provider")?;
            required_string(content, "label")?;
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
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name is required" }),
        );
    };
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    match std::fs::remove_file(dir.join(name)) {
        Ok(()) => {
            if let Err(error) = state.rescan_pool() {
                eprintln!("pool rescan failed after credential delete: {error}");
            }
            json_status(StatusCode::OK, json!({ "status": "ok" }))
        }
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
    if params
        .get("name")
        .map(|v| v.trim())
        .unwrap_or("")
        .is_empty()
    {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name is required" }),
        );
    }
    json_status(
        StatusCode::OK,
        json!({ "models": crate::models_route::models_payload(&state.pool.load().models, 0) }),
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
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name is required" }),
        );
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

async fn patch_auth_file_status(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(name) = body.get("name").and_then(Value::as_str) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "name is required" }),
        );
    };
    let Some(disabled) = body.get("disabled").and_then(Value::as_bool) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "disabled is required" }),
        );
    };
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid name" }));
    }
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let path = dir.join(name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json_status(StatusCode::NOT_FOUND, json!({ "error": "auth not found" }))
        }
        Err(error) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": error.to_string() }),
            )
        }
    };
    let mut value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": error.to_string() }),
            )
        }
    };
    value["disabled"] = json!(disabled);
    let rendered = match serde_json::to_string_pretty(&value) {
        Ok(rendered) => rendered,
        Err(error) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": error.to_string() }),
            )
        }
    };
    if let Err(error) = write_atomically(&path, &rendered) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    if let Err(error) = state.rescan_pool() {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    json_status(
        StatusCode::OK,
        json!({ "status": "ok", "name": name, "disabled": disabled }),
    )
}

async fn patch_unsupported() -> Response {
    json_status(StatusCode::BAD_REQUEST, json!({ "error": "invalid body" }))
}

#[derive(serde::Serialize)]
struct VertexClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

async fn vertex_import(State(state): State<Arc<AppState>>, raw: bytes::Bytes) -> Response {
    let parsed = serde_json::from_slice::<Value>(&raw).unwrap_or(Value::Null);
    let Some(file) = parsed
        .get("file")
        .and_then(Value::as_str)
        .filter(|file| !file.trim().is_empty())
    else {
        return json_status(StatusCode::BAD_REQUEST, json!({ "error": "file required" }));
    };
    let service: Value = match serde_json::from_str(file) {
        Ok(value) => value,
        Err(error) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": error.to_string() }),
            )
        }
    };
    let required = |field: &str| {
        service
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let (Some(project_id), Some(private_key), Some(client_email)) = (
        required("project_id"),
        required("private_key"),
        required("client_email"),
    ) else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "service account missing project_id, private_key, or client_email" }),
        );
    };
    let token_uri = required("token_uri").unwrap_or("https://oauth2.googleapis.com/token");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let key = match jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes()) {
        Ok(key) => key,
        Err(error) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": error.to_string() }),
            )
        }
    };
    let assertion = match jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &VertexClaims {
            iss: client_email,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            aud: token_uri,
            iat: now,
            exp: now + 3600,
        },
        &key,
    ) {
        Ok(assertion) => assertion,
        Err(error) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": error.to_string() }),
            )
        }
    };
    let response = match state
        .http_client
        .post(token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return json_status(
                StatusCode::BAD_GATEWAY,
                json!({ "error": error.to_string() }),
            )
        }
    };
    let status = response.status();
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(error) => {
            return json_status(
                StatusCode::BAD_GATEWAY,
                json!({ "error": error.to_string() }),
            )
        }
    };
    if !status.is_success() {
        return json_status(
            StatusCode::BAD_GATEWAY,
            json!({ "error": format!("token exchange failed ({status}): {body}") }),
        );
    }
    let Some(access_token) = body.get("access_token").and_then(Value::as_str) else {
        return json_status(
            StatusCode::BAD_GATEWAY,
            json!({ "error": "token response missing access_token" }),
        );
    };
    let location = parsed
        .get("location")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|loc| !loc.is_empty())
        .unwrap_or("us-central1");
    let project_slug = project_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let credential = json!({
        "type": "vertex",
        "identity_slug": format!("vertex-{project_slug}"),
        "provider": "google-vertex",
        "label": client_email,
        "project_id": project_id,
        "location": location,
        "email": client_email,
        "private_key": private_key,
        "private_key_id": service.get("private_key_id").and_then(Value::as_str),
        "token_url": token_uri,
        "access_token": access_token,
        "expired": mahoquot_providers::format_expired_rfc3339((now + 3600) as i64),
        "last_refresh": mahoquot_providers::format_expired_rfc3339(now as i64),
        "disabled": false,
        "service_account": service,
    });
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let path = dir.join(format!("vertex-{project_slug}.json"));
    let rendered = match serde_json::to_string_pretty(&credential) {
        Ok(rendered) => rendered,
        Err(error) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": error.to_string() }),
            )
        }
    };
    if let Err(error) = write_atomically(&path, &rendered) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    if let Err(error) = state.rescan_pool() {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": error.to_string() }),
        );
    }
    json_status(
        StatusCode::OK,
        json!({ "status":"ok", "name":path.file_name().and_then(|name|name.to_str()) }),
    )
}

async fn command_code_import(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(api_key) = body
        .get("api_key")
        .or_else(|| body.get("apiKey"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return json_status(StatusCode::BAD_REQUEST, json!({"error":"api_key required"}));
    };
    let label = body
        .get("label")
        .or_else(|| body.get("userName"))
        .and_then(Value::as_str)
        .unwrap_or("Command Code");
    let credential = json!({"type":"generic","provider":"command-code","label":label,"adapter":"openai-chat",
        "base_url":"https://api.commandcode.ai/provider/v1","api_key":api_key,
        "models":["deepseek/deepseek-v4-flash"],"disabled":false});
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let path = dir.join(format!("generic-command-code-{}.json", std::process::id()));
    let rendered = match serde_json::to_string_pretty(&credential) {
        Ok(value) => value,
        Err(error) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error":error.to_string()}),
            )
        }
    };
    if let Err(error) = write_atomically(&path, &rendered) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":error.to_string()}),
        );
    }
    if let Err(error) = state.rescan_pool() {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":error.to_string()}),
        );
    }
    json_status(
        StatusCode::OK,
        json!({"status":"ok","name":path.file_name().and_then(|name|name.to_str())}),
    )
}

async fn trae_import(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_default()
                .join("Library/Application Support/Trae/User/globalStorage/storage.json")
        });
    let raw = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) => {
            return json_status(StatusCode::NOT_FOUND, json!({"error":error.to_string()}))
        }
    };
    let storage: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            return json_status(StatusCode::BAD_REQUEST, json!({"error":error.to_string()}))
        }
    };
    let auth = storage
        .get("iCubeAuthInfo://icube.cloudide")
        .and_then(|value| {
            if value.is_string() {
                value
                    .as_str()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            } else {
                Some(value.clone())
            }
        });
    let Some(auth) = auth else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({"error":"Trae auth record not found"}),
        );
    };
    let Some(token) = auth
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({"error":"Trae token missing"}),
        );
    };
    let label = auth
        .get("account")
        .and_then(|v| v.get("email"))
        .and_then(Value::as_str)
        .unwrap_or("Trae");
    let credential = json!({"type":"monitor","provider":"trae","label":label,"token":token,
        "base_url":auth.get("host").and_then(Value::as_str).unwrap_or("https://api-sg-central.trae.ai"),"disabled":false});
    let dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let target = dir.join("monitor-trae.json");
    let rendered = serde_json::to_string_pretty(&credential).unwrap_or_default();
    if let Err(error) = write_atomically(&target, &rendered) {
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":error.to_string()}),
        );
    }
    json_status(
        StatusCode::OK,
        json!({"status":"ok","name":"monitor-trae.json"}),
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
        .route("/auth-files/order", put(save_auth_file_order))
        .route("/claude/import-local", post(import_local_claude))
        .route("/auth-files/models", get(auth_file_models))
        .route("/auth-files/download", get(download_auth_file))
        .route(
            "/auth-files/status",
            axum::routing::patch(patch_auth_file_status),
        )
        .route(
            "/auth-files/fields",
            axum::routing::patch(patch_unsupported),
        )
        .route("/model-definitions/{channel}", get(model_definitions))
        .route("/vertex/import", post(vertex_import))
        .route("/command-code/import", post(command_code_import))
        .route("/trae/import-local", post(trae_import))
        .merge(super::oauth::oauth_routes())
        .route("/oauth-session", delete(super::oauth::cancel_session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_hex_store_converts_without_exposing_tokens() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":1893456000000}}"#;
        let hex = raw
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let decoded = decode_claude_credentials(&hex).expect("decode");
        let credential = claude_credential_from_store(&decoded).expect("convert");
        assert_eq!(credential["type"], "claude");
        assert_eq!(credential["identity_slug"], "claude-code");
        assert_eq!(credential["expired"], "2030-01-01T00:00:00Z");
    }

    #[test]
    fn explicit_account_order_precedes_unlisted_files() {
        let mut files = vec![
            json!({"name":"b.json"}),
            json!({"name":"a.json"}),
            json!({"name":"c.json"}),
        ];
        sort_described_files(&mut files, &["c.json".into(), "a.json".into()]);
        assert_eq!(
            files
                .iter()
                .map(|file| file["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["c.json", "a.json", "b.json"]
        );
    }

    #[test]
    fn account_order_manifest_is_not_a_credential() {
        assert!(!is_credential_filename(ACCOUNT_ORDER_FILE));
        assert!(is_credential_filename("claude-local.json"));
    }

    #[test]
    fn a_credential_listing_reports_type_and_email_from_the_file() {
        // given a credential file on disk
        let dir = std::env::temp_dir().join(format!("mahoquot-creds-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("mahoquot-creds-w-{}", std::process::id()));
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
    fn zcode_accepts_a_pasted_provisioned_key_without_oauth_fields() {
        // The console can only ever supply these two fields for Z.ai, because a
        // provisioned key has no refresh token and no expiry.
        assert_eq!(
            validate_provider_credential(&json!({
                "type": "zcode",
                "access_token": "keyid.keysecret",
                "email": "u@example.com"
            })),
            Ok(())
        );
    }

    #[test]
    fn provider_imports_accept_reference_credential_shapes() {
        for credential in [
            json!({
                "type": "anthropic", "access_token": "a", "refresh_token": "r",
                "email": "u@example.com", "expired": "2099-01-01T00:00:00Z"
            }),
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

#[cfg(test)]
mod reserved_file_tests {
    use super::is_credential_filename;

    #[test]
    fn reserved_data_files_are_not_listed_as_credentials() {
        assert!(!is_credential_filename("telemetry.json"));
        assert!(!is_credential_filename("TELEMETRY.JSON"));
        assert!(!is_credential_filename("config.yaml"));
        assert!(is_credential_filename("codex-1.json"));
        assert!(!is_credential_filename(".mahoquot-account-order.json"));
    }
}
