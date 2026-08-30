use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteManagement {
    #[serde(rename = "allow-remote", default)]
    pub allow_remote: bool,
    #[serde(rename = "secret-key", default)]
    pub secret_key: String,
    #[serde(rename = "disable-control-panel", default)]
    pub disable_control_panel: bool,
}

/// Upstream exposes these through `GET /config` even when unset, and a client
/// that reads the config expects the key to exist. They are carried verbatim so
/// the document round-trips without dropping fields this build does not act on.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PassthroughSettings {
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginsSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub dir: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingSettings {
    #[serde(default)]
    pub strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaExceededSettings {
    #[serde(rename = "switch-project", default = "yes")]
    pub switch_project: bool,
    #[serde(rename = "switch-preview-model", default = "yes")]
    pub switch_preview_model: bool,
}

impl Default for QuotaExceededSettings {
    fn default() -> Self {
        Self {
            switch_project: true,
            switch_preview_model: true,
        }
    }
}

fn yes() -> bool {
    true
}

fn default_log_size_mb() -> i64 {
    100
}

fn default_port() -> u16 {
    18801
}

fn default_max_retry() -> usize {
    3
}

/// The persisted settings document, mirroring the YAML keys CLIProxyAPI uses
/// so a `config.yaml` written by either proxy is readable by the other.
///
/// Only the fields mahoquot-rs actually honours are modelled. `extra` captures
/// every other key verbatim so round-tripping a CLIProxyAPI config through
/// mahoquot never silently drops settings this build does not implement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "auth-dir", default)]
    pub auth_dir: String,
    #[serde(default)]
    pub debug: bool,
    #[serde(rename = "logging-to-file", default = "yes")]
    pub logging_to_file: bool,
    #[serde(rename = "logs-max-total-size-mb", default = "default_log_size_mb")]
    pub logs_max_total_size_mb: i64,
    #[serde(rename = "error-logs-max-files", default)]
    pub error_logs_max_files: i64,
    #[serde(rename = "usage-statistics-enabled", default)]
    pub usage_statistics_enabled: bool,
    #[serde(rename = "request-log", default)]
    pub request_log: bool,
    #[serde(rename = "proxy-url", default)]
    pub proxy_url: String,
    #[serde(rename = "request-retry", default)]
    pub request_retry: i64,
    #[serde(rename = "max-retry-credentials", default = "default_max_retry")]
    pub max_retry_credentials: usize,
    #[serde(rename = "max-retry-interval", default)]
    pub max_retry_interval: i64,
    #[serde(rename = "force-model-prefix", default)]
    pub force_model_prefix: bool,
    #[serde(rename = "ws-auth", default)]
    pub ws_auth: bool,
    #[serde(default)]
    pub routing: RoutingSettings,
    #[serde(default)]
    pub plugins: PluginsSettings,
    #[serde(default, rename = "commercial-mode")]
    pub commercial_mode: bool,
    #[serde(default, rename = "disable-cooling")]
    pub disable_cooling: bool,
    #[serde(default, rename = "disable-image-generation")]
    pub disable_image_generation: bool,
    #[serde(default, rename = "disable-claude-cloak-mode")]
    pub disable_claude_cloak_mode: bool,
    #[serde(default, rename = "save-cooldown-status")]
    pub save_cooldown_status: bool,
    #[serde(default, rename = "passthrough-headers")]
    pub passthrough_headers: bool,
    #[serde(default, rename = "auth-auto-refresh-workers")]
    pub auth_auto_refresh_workers: i64,
    #[serde(default, rename = "transient-error-cooldown-seconds")]
    pub transient_error_cooldown_seconds: i64,
    #[serde(default, rename = "redis-usage-queue-retention-seconds")]
    pub redis_usage_queue_retention_seconds: i64,
    #[serde(default, rename = "claude-code")]
    pub claude_code: PassthroughSettings,
    #[serde(default)]
    pub codex: PassthroughSettings,
    #[serde(default)]
    pub antigravity: PassthroughSettings,
    #[serde(default)]
    pub xai: PassthroughSettings,
    #[serde(default)]
    pub tls: PassthroughSettings,
    #[serde(default)]
    pub payload: PassthroughSettings,
    #[serde(default)]
    pub streaming: PassthroughSettings,
    #[serde(default)]
    pub pprof: PassthroughSettings,
    #[serde(default, rename = "claude-header-defaults")]
    pub claude_header_defaults: PassthroughSettings,
    #[serde(default, rename = "codex-header-defaults")]
    pub codex_header_defaults: PassthroughSettings,
    #[serde(default, rename = "credential-concurrency")]
    pub credential_concurrency: PassthroughSettings,
    #[serde(default, rename = "credential-in-flight")]
    pub credential_in_flight: PassthroughSettings,
    #[serde(rename = "quota-exceeded", default)]
    pub quota_exceeded: QuotaExceededSettings,
    #[serde(rename = "remote-management", default)]
    pub remote_management: RemoteManagement,
    #[serde(rename = "api-keys", default)]
    pub api_keys: Vec<String>,
    #[serde(rename = "oauth-excluded-models", default)]
    pub oauth_excluded_models: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(rename = "gemini-api-key", default)]
    pub gemini_api_key: Vec<String>,
    #[serde(rename = "claude-api-key", default)]
    pub claude_api_key: Vec<String>,
    #[serde(rename = "codex-api-key", default)]
    pub codex_api_key: Vec<String>,
    #[serde(rename = "xai-api-key", default)]
    pub xai_api_key: Vec<String>,
    #[serde(rename = "vertex-api-key", default)]
    pub vertex_api_key: Vec<String>,
    #[serde(rename = "interactions-api-key", default)]
    pub interactions_api_key: Vec<String>,
    #[serde(rename = "openai-compatibility", default)]
    pub openai_compatibility: Vec<String>,
    #[serde(rename = "oauth-model-alias", default)]
    pub oauth_model_alias: serde_json::Value,
    #[serde(rename = "oauth-request-scoped-errors", default)]
    pub oauth_request_scoped_errors: serde_json::Value,

    #[serde(flatten)]
    pub extra: serde_yaml::Mapping,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: default_port(),
            auth_dir: String::new(),
            debug: false,
            logging_to_file: true,
            logs_max_total_size_mb: default_log_size_mb(),
            error_logs_max_files: 0,
            usage_statistics_enabled: false,
            request_log: false,
            proxy_url: String::new(),
            request_retry: 0,
            max_retry_credentials: default_max_retry(),
            max_retry_interval: 0,
            force_model_prefix: false,
            ws_auth: false,
            routing: RoutingSettings::default(),
            plugins: PluginsSettings::default(),
            commercial_mode: false,
            disable_cooling: false,
            disable_image_generation: false,
            disable_claude_cloak_mode: false,
            save_cooldown_status: false,
            passthrough_headers: false,
            auth_auto_refresh_workers: 0,
            transient_error_cooldown_seconds: 0,
            redis_usage_queue_retention_seconds: 60,
            claude_code: PassthroughSettings::default(),
            codex: PassthroughSettings::default(),
            antigravity: PassthroughSettings::default(),
            xai: PassthroughSettings::default(),
            tls: PassthroughSettings::default(),
            payload: PassthroughSettings::default(),
            streaming: PassthroughSettings::default(),
            pprof: PassthroughSettings::default(),
            claude_header_defaults: PassthroughSettings::default(),
            codex_header_defaults: PassthroughSettings::default(),
            credential_concurrency: PassthroughSettings::default(),
            credential_in_flight: PassthroughSettings::default(),
            quota_exceeded: QuotaExceededSettings::default(),
            remote_management: RemoteManagement::default(),
            api_keys: Vec::new(),
            oauth_excluded_models: std::collections::BTreeMap::new(),
            gemini_api_key: Vec::new(),
            claude_api_key: Vec::new(),
            codex_api_key: Vec::new(),
            xai_api_key: Vec::new(),
            vertex_api_key: Vec::new(),
            interactions_api_key: Vec::new(),
            openai_compatibility: Vec::new(),
            oauth_model_alias: serde_json::Value::Null,
            oauth_request_scoped_errors: serde_json::Value::Null,
            extra: serde_yaml::Mapping::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("failed to read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("failed to serialise settings: {0}")]
    Serialise(#[from] serde_yaml::Error),
    #[error("failed to write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl Settings {
    pub fn load(path: &Path) -> Result<Self, SettingsError> {
        let raw = std::fs::read_to_string(path).map_err(|source| SettingsError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_yaml(&raw).map_err(|source| SettingsError::Parse {
            path: path.to_path_buf(),
            source,
        })
    }

    pub fn from_yaml(raw: &str) -> Result<Self, serde_yaml::Error> {
        if raw.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_yaml::from_str(raw)
    }

    pub fn to_yaml(&self) -> Result<String, SettingsError> {
        Ok(serde_yaml::to_string(self)?)
    }

    /// Write the document so a reader never observes a partial file: render to
    /// a sibling temp file, fsync it, then rename over the target. A crash
    /// mid-write leaves either the old file or the new one, never a truncated
    /// config that would fail to parse on the next boot.
    pub fn persist(&self, path: &Path) -> Result<(), SettingsError> {
        use std::io::Write;

        let rendered = self.to_yaml()?;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|source| SettingsError::Write {
                    path: path.to_path_buf(),
                    source,
                })?;
            }
        }

        let temp_path = path.with_extension(format!("tmp{}", std::process::id()));
        let write = |target: &Path| -> std::io::Result<()> {
            let mut file = std::fs::File::create(target)?;
            file.write_all(rendered.as_bytes())?;
            file.sync_all()
        };
        write(&temp_path).map_err(|source| SettingsError::Write {
            path: temp_path.clone(),
            source,
        })?;

        std::fs::rename(&temp_path, path).map_err(|source| {
            let _ = std::fs::remove_file(&temp_path);
            SettingsError::Write {
                path: path.to_path_buf(),
                source,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_upstream_keys_survive_a_round_trip() {
        // given a config carrying keys this build does not model
        let raw =
            "port: 9999\nauth-dir: /tmp/a\nclaude-api-key:\n  - sk-test\ntls:\n  enable: true\n";
        // when it is parsed and re-rendered
        let settings = Settings::from_yaml(raw).expect("parses");
        let rendered = settings.to_yaml().expect("renders");
        // then the unmodelled keys are still present
        assert!(rendered.contains("claude-api-key"), "{rendered}");
        assert!(rendered.contains("tls"), "{rendered}");
        // and the modelled ones round-trip by value
        assert_eq!(settings.port, 9999);
        assert_eq!(settings.auth_dir, "/tmp/a");
    }

    #[test]
    fn upstream_yaml_key_names_are_kebab_case() {
        // given a config written with upstream's key spelling
        let raw = concat!(
            "logging-to-file: true\n",
            "logs-max-total-size-mb: 42\n",
            "request-retry: 7\n",
            "max-retry-credentials: 5\n",
            "force-model-prefix: true\n",
            "remote-management:\n  allow-remote: true\n  secret-key: shh\n",
        );
        // when parsed
        let settings = Settings::from_yaml(raw).expect("parses");
        // then every field binds
        assert!(settings.logging_to_file);
        assert_eq!(settings.logs_max_total_size_mb, 42);
        assert_eq!(settings.request_retry, 7);
        assert_eq!(settings.max_retry_credentials, 5);
        assert!(settings.force_model_prefix);
        assert!(settings.remote_management.allow_remote);
        assert_eq!(settings.remote_management.secret_key, "shh");
    }

    #[test]
    fn an_empty_document_yields_defaults() {
        // given an empty config file
        let settings = Settings::from_yaml("   \n").expect("parses");
        // then defaults apply rather than an error
        assert_eq!(settings.port, default_port());
        assert_eq!(settings.max_retry_credentials, default_max_retry());
        assert!(settings.quota_exceeded.switch_project);
    }

    #[test]
    fn persist_then_load_round_trips() {
        // given a settings document persisted to a temp dir
        let dir = std::env::temp_dir().join(format!("mahoquot-settings-{}", std::process::id()));
        let path = dir.join("config.yaml");
        let settings = Settings {
            port: 18899,
            remote_management: RemoteManagement {
                secret_key: "abc".to_string(),
                ..RemoteManagement::default()
            },
            ..Settings::default()
        };
        settings.persist(&path).expect("persists");
        // when reloaded from disk
        let loaded = Settings::load(&path).expect("loads");
        // then it matches what was written
        assert_eq!(loaded.port, 18899);
        assert_eq!(loaded.remote_management.secret_key, "abc");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persist_leaves_no_temp_file_behind() {
        // given a persisted config
        let dir =
            std::env::temp_dir().join(format!("mahoquot-settings-tmp-{}", std::process::id()));
        let path = dir.join("config.yaml");
        Settings::default().persist(&path).expect("persists");
        // when the directory is listed
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("readable")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "config.yaml")
            .collect();
        // then only the final file remains
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
