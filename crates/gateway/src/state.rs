use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use quotio_router::Router;
use quotio_types::{Health, PoolMember};

use crate::account::{load_account_members, AccountMember};
use crate::config::GatewayConfig;
use crate::inbound::ApiKeys;
use crate::metrics::{AdminStatsResponse, GatewayMetrics};
use crate::monitor::MonitorState;

pub struct AppState {
    pub router: Router,
    pub members: Vec<Arc<AccountMember>>,
    pub pool_members: Vec<Arc<dyn PoolMember>>,
    pub http_client: reqwest::Client,
    pub metrics: Arc<GatewayMetrics>,
    pub monitor: Arc<MonitorState>,
    pub api_keys: Arc<ApiKeys>,
    pub models: Vec<String>,
    pub refresh_url: String,
    pub auth_refresh_enabled: bool,
    pub refreshed: AtomicU64,
    pub max_failover: usize,
}

impl AppState {
    pub fn new(config: &GatewayConfig) -> anyhow::Result<Self> {
        let members = load_account_members(&config.auth_dir)?;
        let pool_members: Vec<Arc<dyn PoolMember>> = members
            .iter()
            .map(|m| m.clone() as Arc<dyn PoolMember>)
            .collect();

        let http_client = reqwest::Client::builder()
            .tcp_nodelay(true)
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build reqwest client: {}", e))?;

        let router = Router::new(config.strategy);
        let metrics = Arc::new(GatewayMetrics::default());
        let monitor = Arc::new(MonitorState::default());
        let api_keys = Arc::new(config.api_keys.clone());
        let models = config.models.clone();
        let refresh_url = config.refresh_url.clone();
        let auth_refresh_enabled = config.auth_refresh_enabled;

        Ok(Self {
            router,
            members,
            pool_members,
            http_client,
            metrics,
            monitor,
            api_keys,
            models,
            refresh_url,
            auth_refresh_enabled,
            refreshed: AtomicU64::new(0),
            max_failover: config.max_failover,
        })
    }

    pub fn find_member(&self, id: &str) -> Option<Arc<AccountMember>> {
        self.members.iter().find(|m| m.id == id).cloned()
    }

    pub fn force_health(&self, id: &str, health: Health) {
        if let Some(m) = self.find_member(id) {
            m.set_health(health);
        }
    }

    pub async fn refresh_member(
        &self,
        member: &AccountMember,
        presented_token: Option<&str>,
    ) -> Result<bool, quotio_providers::refresh_exec::RefreshError> {
        let did_refresh = member
            .refresh(&self.http_client, &self.refresh_url, presented_token)
            .await?;
        if did_refresh {
            self.refreshed.fetch_add(1, Ordering::Relaxed);
        }
        Ok(did_refresh)
    }

    pub fn get_stats(&self) -> AdminStatsResponse {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let accounts = self
            .members
            .iter()
            .map(|m| {
                let health = m.health();
                let reset_at_unix_ms = match health {
                    Health::Cooldown { until_unix_ms } => Some(until_unix_ms),
                    _ => None,
                };
                crate::metrics::AccountStats {
                    id: m.id.clone(),
                    health: health.into(),
                    ok: m.ok_count.load(Ordering::Relaxed),
                    fails: m.fail_count.load(Ordering::Relaxed),
                    reset_at_unix_ms,
                    last_error: self.monitor.last_error(&m.id),
                    ttft: self.monitor.account_ttft(&m.id),
                }
            })
            .collect();

        AdminStatsResponse {
            uptime_secs: self.monitor.uptime_secs(now_ms),
            in_flight: self.monitor.in_flight(),
            served: self.metrics.served.load(Ordering::Relaxed),
            failed_over: self.metrics.failed_over.load(Ordering::Relaxed),
            refreshed: self.refreshed.load(Ordering::Relaxed),
            exposed_errors: self.metrics.exposed_errors.load(Ordering::Relaxed),
            exposed_client_errors: self.metrics.exposed_client_errors.load(Ordering::Relaxed),
            ttft: self.monitor.ttft_percentiles(),
            accounts,
        }
    }
}
