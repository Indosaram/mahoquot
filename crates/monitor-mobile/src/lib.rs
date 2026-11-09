//! Native command surface for the mobile console.
//!
//! The desktop shell owns a gateway child process, a keychain-backed secret
//! store, Codex instances, CLI configs, and signed updates. A phone has none of
//! those, so this crate implements only what makes the console usable against a
//! remote gateway and answers the rest with the same typed shapes the frontend
//! already handles for a browser-only session.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};

const SECRETS_FILE: &str = "secrets.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    ManagementKey,
    Totp,
}

impl SecretKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ManagementKey => "management_key",
            Self::Totp => "totp",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum SecretStoreError {
    Unavailable,
    Backend(String),
}

#[derive(Debug, Deserialize)]
pub struct SecretRequest {
    endpoint: String,
    profile: String,
    kind: SecretKind,
}

#[derive(Debug, Deserialize)]
pub struct WriteSecretRequest {
    endpoint: String,
    profile: String,
    kind: SecretKind,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateLegacySecretRequest {
    endpoint: String,
    profile: String,
    kind: SecretKind,
    legacy_value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MigrationOutcome {
    value: Option<String>,
    remove_legacy: bool,
    reconnect: bool,
}

fn normalize(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn secret_account(kind: SecretKind, endpoint: &str, profile: &str) -> String {
    format!(
        "{}|{}|{}",
        kind.as_str(),
        normalize(endpoint),
        profile.trim().to_ascii_lowercase()
    )
}

/// Secrets live in the app's private data directory rather than the iOS
/// keychain: the keychain requires an entitlement profile this build does not
/// carry, and a failed keychain write would leave the console unable to reach
/// its own gateway. The file is created 0600 and stays inside the sandbox.
pub struct SecretStore {
    path: Mutex<PathBuf>,
    cache: Mutex<BTreeMap<String, String>>,
}

impl SecretStore {
    fn new(path: PathBuf) -> Self {
        let loaded = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
            .unwrap_or_default();
        Self {
            path: Mutex::new(path),
            cache: Mutex::new(loaded),
        }
    }

    fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
        let cache = self
            .cache
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        Ok(cache.get(account).cloned())
    }

    fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        let previous = cache.insert(account.to_string(), value.to_string());
        if let Err(error) = self.persist(&cache) {
            match previous {
                Some(value) => cache.insert(account.to_string(), value),
                None => cache.remove(account),
            };
            return Err(error);
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        let previous = cache.remove(account);
        if let Err(error) = self.persist(&cache) {
            if let Some(value) = previous {
                cache.insert(account.to_string(), value);
            }
            return Err(error);
        }
        Ok(())
    }

    fn persist(&self, cache: &BTreeMap<String, String>) -> Result<(), SecretStoreError> {
        let path = self
            .path
            .lock()
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        let payload = serde_json::to_vec(cache)
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        let temporary = path.with_extension("json.tmp");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        }
        fs::write(&temporary, payload)
            .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
        restrict_to_owner(&temporary)?;
        fs::rename(&temporary, &*path).map_err(|error| SecretStoreError::Backend(error.to_string()))
    }
}

#[cfg(unix)]
fn restrict_to_owner(path: &std::path::Path) -> Result<(), SecretStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| SecretStoreError::Backend(error.to_string()))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &std::path::Path) -> Result<(), SecretStoreError> {
    Ok(())
}

fn store_for<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<SecretStore, SecretStoreError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| SecretStoreError::Backend(error.to_string()))?;
    Ok(SecretStore::new(dir.join(SECRETS_FILE)))
}

#[tauri::command]
fn read_secret<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: SecretRequest,
) -> Result<Option<String>, SecretStoreError> {
    let store = store_for(&app)?;
    store.read(&secret_account(
        request.kind,
        &request.endpoint,
        &request.profile,
    ))
}

#[tauri::command]
fn write_secret<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: WriteSecretRequest,
) -> Result<(), SecretStoreError> {
    let store = store_for(&app)?;
    store.write(
        &secret_account(request.kind, &request.endpoint, &request.profile),
        &request.value,
    )
}

#[tauri::command]
fn delete_secret<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: SecretRequest,
) -> Result<(), SecretStoreError> {
    let store = store_for(&app)?;
    store.delete(&secret_account(
        request.kind,
        &request.endpoint,
        &request.profile,
    ))
}

#[tauri::command]
fn migrate_legacy_secret<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: MigrateLegacySecretRequest,
) -> Result<MigrationOutcome, SecretStoreError> {
    let store = store_for(&app)?;
    let account = secret_account(request.kind, &request.endpoint, &request.profile);
    if let Some(stored) = store.read(&account)? {
        return Ok(MigrationOutcome {
            value: Some(stored),
            remove_legacy: true,
            reconnect: false,
        });
    }
    match request
        .legacy_value
        .filter(|value| !value.trim().is_empty())
    {
        Some(legacy) => {
            store.write(&account, legacy.trim())?;
            Ok(MigrationOutcome {
                value: Some(legacy.trim().to_string()),
                remove_legacy: true,
                reconnect: true,
            })
        }
        None => Ok(MigrationOutcome {
            value: None,
            remove_legacy: false,
            reconnect: false,
        }),
    }
}

/// A phone never supervises a gateway process, so the console's lifecycle
/// control reports the remote gateway as already running.
#[tauri::command]
fn gateway_status() -> &'static str {
    "running"
}

#[tauri::command]
fn start_gateway() -> &'static str {
    "running"
}

#[tauri::command]
fn stop_gateway() -> &'static str {
    "stopped"
}

#[tauri::command]
fn restart_gateway() -> &'static str {
    "running"
}

#[tauri::command]
fn gateway_failure() -> Option<serde_json::Value> {
    None
}

#[tauri::command]
fn save_gateway_connection<R: Runtime>(app: tauri::AppHandle<R>, base_url: String) {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(
        dir.join("connection.json"),
        serde_json::json!({ "base_url": base_url }).to_string(),
    );
}

#[tauri::command]
fn open_external_url<R: Runtime>(app: tauri::AppHandle<R>, url: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

#[derive(Debug, Serialize)]
pub struct NativeSettingsState {
    login_start_enabled: bool,
    notifications: &'static str,
    action: Option<String>,
    gateway_running: bool,
    notch: &'static str,
}

fn mobile_settings() -> NativeSettingsState {
    NativeSettingsState {
        login_start_enabled: false,
        notifications: "service_unavailable",
        action: Some("Startup login and notifications are managed by the operating system.".into()),
        gateway_running: true,
        notch: "compact",
    }
}

#[tauri::command]
fn native_settings_state() -> NativeSettingsState {
    mobile_settings()
}

#[tauri::command]
fn set_login_start(_enabled: bool) -> NativeSettingsState {
    mobile_settings()
}

#[tauri::command]
fn request_notification_permission() -> NativeSettingsState {
    mobile_settings()
}

#[derive(Debug, Serialize)]
pub struct TunnelStatus {
    enabled: bool,
    running: bool,
    public_url: Option<String>,
    has_binary: bool,
}

fn no_tunnel() -> TunnelStatus {
    TunnelStatus {
        enabled: false,
        running: false,
        public_url: None,
        has_binary: false,
    }
}

#[tauri::command]
fn tunnel_status() -> TunnelStatus {
    no_tunnel()
}

#[tauri::command]
fn download_cloudflared() -> TunnelStatus {
    no_tunnel()
}

#[tauri::command]
fn start_tunnel() -> TunnelStatus {
    no_tunnel()
}

#[tauri::command]
fn stop_tunnel() -> TunnelStatus {
    no_tunnel()
}

#[tauri::command]
fn check_for_update() -> serde_json::Value {
    serde_json::json!({ "available": false, "version": null })
}

#[tauri::command]
fn list_codex_instances() -> Vec<serde_json::Value> {
    Vec::new()
}

#[tauri::command]
fn list_cli_agents() -> Vec<serde_json::Value> {
    Vec::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_secret,
            write_secret,
            delete_secret,
            migrate_legacy_secret,
            gateway_status,
            start_gateway,
            stop_gateway,
            restart_gateway,
            gateway_failure,
            save_gateway_connection,
            open_external_url,
            native_settings_state,
            set_login_start,
            request_notification_permission,
            tunnel_status,
            download_cloudflared,
            start_tunnel,
            stop_tunnel,
            check_for_update,
            list_codex_instances,
            list_cli_agents,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build mahoquot mobile")
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(dir: &tempfile::TempDir) -> SecretStore {
        SecretStore::new(dir.path().join(SECRETS_FILE))
    }

    #[test]
    fn a_key_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let account = secret_account(
            SecretKind::ManagementKey,
            "http://127.0.0.1:18801/",
            "default",
        );
        open(&dir).write(&account, "sk-test").unwrap();

        let reopened = open(&dir);
        assert_eq!(reopened.read(&account).unwrap(), Some("sk-test".into()));
    }

    #[test]
    fn endpoints_differing_only_by_trailing_slash_share_a_secret() {
        let bare = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        let slashed = secret_account(SecretKind::ManagementKey, "HTTP://HOST:18801/", "default");
        assert_eq!(bare, slashed);
    }

    #[test]
    fn profiles_do_not_share_a_secret() {
        let a = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        let b = secret_account(SecretKind::ManagementKey, "http://host:18801", "work");
        assert_ne!(a, b);
    }

    #[test]
    fn totp_and_management_key_are_separate_accounts() {
        let key = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        let totp = secret_account(SecretKind::Totp, "http://host:18801", "default");
        assert_ne!(key, totp);
    }

    #[test]
    fn deleting_removes_the_persisted_value() {
        let dir = tempfile::tempdir().unwrap();
        let account = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        let store = open(&dir);
        store.write(&account, "sk-test").unwrap();
        store.delete(&account).unwrap();

        assert_eq!(open(&dir).read(&account).unwrap(), None);
    }

    #[test]
    fn a_later_write_replaces_the_earlier_value() {
        let dir = tempfile::tempdir().unwrap();
        let account = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        let store = open(&dir);
        store.write(&account, "first").unwrap();
        store.write(&account, "second").unwrap();

        assert_eq!(open(&dir).read(&account).unwrap(), Some("second".into()));
    }

    #[cfg(unix)]
    #[test]
    fn the_secret_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let account = secret_account(SecretKind::ManagementKey, "http://host:18801", "default");
        open(&dir).write(&account, "sk-test").unwrap();

        let mode = fs::metadata(dir.path().join(SECRETS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
