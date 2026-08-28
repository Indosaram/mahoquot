use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::auth::ManagementAuth;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteManagement {
    #[serde(rename = "allow-remote", default)]
    pub allow_remote: bool,
    #[serde(rename = "secret-key", default)]
    pub secret_key: String,
    #[serde(rename = "disable-control-panel", default)]
    pub disable_control_panel: bool,
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

fn default_port() -> u16 {
    18801
}

fn default_max_retry() -> usize {
    3
}

/// The persisted settings document, mirroring the YAML keys CLIProxyAPI uses
/// so a `config.yaml` written by either proxy is readable by the other.
///
/// Only the fields quotio-rs actually honours are modelled. `extra` captures
/// every other key verbatim so round-tripping a CLIProxyAPI config through
/// quotio never silently drops settings this build does not implement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(rename = "auth-dir", default)]
    pub auth_dir: String,
    #[serde(default)]
    pub debug: bool,
    #[serde(rename = "logging-to-file", default)]
    pub logging_to_file: bool,
    #[serde(rename = "logs-max-total-size-mb", default)]
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
    #[serde(rename = "routing-strategy", default)]
    pub routing_strategy: String,
    #[serde(rename = "quota-exceeded", default)]
    pub quota_exceeded: QuotaExceededSettings,
    #[serde(rename = "remote-management", default)]
    pub remote_management: RemoteManagement,
    #[serde(rename = "api-keys", default)]
    pub api_keys: Vec<String>,
    #[serde(rename = "oauth-excluded-models", default)]
    pub oauth_excluded_models: Vec<String>,

    #[serde(flatten)]
    pub extra: serde_yaml::Mapping,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: default_port(),
            auth_dir: String::new(),
            debug: false,
            logging_to_file: false,
            logs_max_total_size_mb: 0,
            error_logs_max_files: 0,
            usage_statistics_enabled: false,
            request_log: false,
            proxy_url: String::new(),
            request_retry: 0,
            max_retry_credentials: default_max_retry(),
            max_retry_interval: 0,
            force_model_prefix: false,
            ws_auth: false,
            routing_strategy: String::new(),
            quota_exceeded: QuotaExceededSettings::default(),
            remote_management: RemoteManagement::default(),
            api_keys: Vec::new(),
            oauth_excluded_models: Vec::new(),
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

        let temp_path = path.with_extension(format!(
            "tmp{}",
            std::process::id()
        ));
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

    pub fn management_auth(&self, env_secret: String, local_password: String) -> ManagementAuth {
        ManagementAuth {
            allow_remote: self.remote_management.allow_remote,
            secret_key: self.remote_management.secret_key.clone(),
            env_secret,
            local_password,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_upstream_keys_survive_a_round_trip() {
        // given a config carrying keys this build does not model
        let raw = "port: 9999\nauth-dir: /tmp/a\nclaude-api-key:\n  - sk-test\ntls:\n  enable: true\n";
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
        let dir = std::env::temp_dir().join(format!("quotio-settings-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("quotio-settings-tmp-{}", std::process::id()));
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

    #[test]
    fn management_auth_is_derived_from_the_document_and_environment() {
        // given a config with a secret and remote access enabled
        let settings = Settings {
            remote_management: RemoteManagement {
                allow_remote: true,
                secret_key: "file-secret".to_string(),
                ..RemoteManagement::default()
            },
            ..Settings::default()
        };
        // when the auth view is derived with an env secret
        let auth = settings.management_auth("env-secret".to_string(), String::new());
        // then both sources are carried through
        assert!(auth.allow_remote);
        assert_eq!(auth.secret_key, "file-secret");
        assert_eq!(auth.env_secret, "env-secret");
        assert!(auth.is_enabled());
    }
}
