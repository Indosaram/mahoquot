use std::path::PathBuf;

use quotio_types::Strategy;

use crate::inbound::ApiKeys;
use crate::models_route::model_ids_from_env;

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub port: u16,
    pub auth_dir: PathBuf,
    pub strategy: Strategy,
    pub max_failover: usize,
    pub log_level: String,
    pub api_keys: ApiKeys,
    pub models: Vec<String>,
    pub refresh_url: String,
    pub auth_refresh_enabled: bool,
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

        let models = model_ids_from_env(std::env::var("MODELS").ok().as_deref());

        let refresh_url = std::env::var("REFRESH_URL")
            .unwrap_or_else(|_| quotio_providers::refresh::REFRESH_TOKEN_URL.to_string());

        let auth_refresh_enabled =
            !matches!(std::env::var("AUTH_REFRESH").as_deref(), Ok("false" | "0"));

        Ok(Self {
            port,
            auth_dir,
            strategy,
            max_failover,
            log_level,
            api_keys,
            models,
            refresh_url,
            auth_refresh_enabled,
        })
    }
}
