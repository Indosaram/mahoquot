use std::path::PathBuf;

use mahoquot_types::Strategy;

use crate::inbound::ApiKeys;
use crate::management::settings::{RemoteManagement, RoutingSettings, Settings};

#[derive(Debug, Clone, Default)]
pub struct GatewayConfig {
    pub port: u16,
    pub auth_dir: PathBuf,
    pub strategy: Strategy,
    pub max_failover: usize,
    pub log_level: String,
    pub api_keys: ApiKeys,
    pub models_env: Option<String>,
    pub refresh_url: String,
    pub auth_refresh_enabled: bool,
    pub usage_poll_secs: u64,
    pub config_path: PathBuf,
}

impl GatewayConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let port = std::env::var("GATEWAY_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(18801);

        let auth_dir_str = std::env::var("AUTH_DIR")
            .map_err(|_| anyhow::anyhow!("AUTH_DIR environment variable is required"))?;
        let auth_dir = PathBuf::from(auth_dir_str);

        let strategy = match std::env::var("STRATEGY").as_deref() {
            Ok("fill_first") => Strategy::FillFirst,
            _ => Strategy::StrictRoundRobin,
        };

        let max_failover = std::env::var("MAX_FAILOVER")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(3);

        let log_level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());

        let api_keys = match std::env::var("API_KEYS") {
            Ok(val) => ApiKeys::from_env_value(&val),
            Err(_) => ApiKeys::default(),
        };

        let models_env = std::env::var("MODELS").ok();

        let refresh_url = std::env::var("REFRESH_URL")
            .unwrap_or_else(|_| mahoquot_providers::refresh::REFRESH_TOKEN_URL.to_string());

        let auth_refresh_enabled =
            !matches!(std::env::var("AUTH_REFRESH").as_deref(), Ok("false" | "0"));

        let config_path = std::env::var("CONFIG_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| auth_dir.join("config.yaml"));

        let usage_poll_secs = std::env::var("USAGE_POLL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(120);

        Ok(Self {
            config_path,
            usage_poll_secs,
            port,
            auth_dir,
            strategy,
            max_failover,
            log_level,
            api_keys,
            models_env,
            refresh_url,
            auth_refresh_enabled,
        })
    }

    /// The environment-derived document used when no `config.yaml` exists yet,
    /// so a deployment that only sets env vars keeps working unchanged.
    pub fn as_settings(&self) -> Settings {
        Settings {
            port: self.port,
            auth_dir: self.auth_dir.display().to_string(),
            max_retry_credentials: self.max_failover,
            routing: RoutingSettings {
                strategy: match self.strategy {
                    Strategy::FillFirst => "fill-first".to_string(),
                    Strategy::StrictRoundRobin => "round-robin".to_string(),
                },
            },
            remote_management: RemoteManagement {
                secret_key: String::new(),
                ..RemoteManagement::default()
            },
            ..Settings::default()
        }
    }
}
