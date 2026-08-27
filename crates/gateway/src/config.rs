use quotio_types::Strategy;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub port: u16,
    pub auth_dir: PathBuf,
    pub strategy: Strategy,
    pub max_failover: usize,
    pub log_level: String,
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

        Ok(Self {
            port,
            auth_dir,
            strategy,
            max_failover,
            log_level,
        })
    }
}
