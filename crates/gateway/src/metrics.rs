use mahoquot_types::Health;
use serde::Serialize;
use std::sync::atomic::AtomicU64;

use crate::monitor::{LastError, TtftSnapshot};
use crate::telemetry::TelemetryBucket;

#[derive(Default)]
pub struct GatewayMetrics {
    pub served: AtomicU64,
    pub failed_over: AtomicU64,
    pub exposed_errors: AtomicU64,
    pub exposed_client_errors: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountStats {
    pub id: String,
    pub provider: String,
    #[serde(default)]
    pub usage: crate::usage::AccountUsage,
    pub health: HealthStats,
    pub ok: u64,
    pub fails: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub reset_at_unix_ms: Option<i64>,
    pub last_error: Option<LastError>,
    pub ttft: Option<TtftSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HealthStats {
    Available,
    Cooldown { until_unix_ms: i64 },
    AuthFailed,
    Disabled,
}

impl From<Health> for HealthStats {
    fn from(h: Health) -> Self {
        match h {
            Health::Available => Self::Available,
            Health::Cooldown { until_unix_ms } => Self::Cooldown { until_unix_ms },
            Health::AuthFailed => Self::AuthFailed,
            Health::Disabled => Self::Disabled,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminStatsResponse {
    pub uptime_secs: u64,
    pub in_flight: u64,
    pub served: u64,
    pub failed_over: u64,
    pub refreshed: u64,
    pub exposed_errors: u64,
    pub exposed_client_errors: u64,
    pub ttft: TtftSnapshot,
    pub accounts: Vec<AccountStats>,
    pub history: Vec<TelemetryBucket>,
}
