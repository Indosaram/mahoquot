use std::sync::atomic::Ordering;
use std::sync::Arc;

use quotio_router::Router;
use quotio_types::{Health, PoolMember};

use crate::account::{load_account_members, AccountMember};
use crate::config::GatewayConfig;
use crate::metrics::{AdminStatsResponse, GatewayMetrics};

pub struct AppState {
    pub router: Router,
    pub members: Vec<Arc<AccountMember>>,
    pub pool_members: Vec<Arc<dyn PoolMember>>,
    pub http_client: reqwest::Client,
    pub metrics: Arc<GatewayMetrics>,
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

        Ok(Self {
            router,
            members,
            pool_members,
            http_client,
            metrics,
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

    pub fn get_stats(&self) -> AdminStatsResponse {
        let accounts = self
            .members
            .iter()
            .map(|m| crate::metrics::AccountStats {
                id: m.id.clone(),
                health: m.health().into(),
                ok: m.ok_count.load(Ordering::Relaxed),
                fails: m.fail_count.load(Ordering::Relaxed),
            })
            .collect();

        AdminStatsResponse {
            served: self.metrics.served.load(Ordering::Relaxed),
            failed_over: self.metrics.failed_over.load(Ordering::Relaxed),
            exposed_errors: self.metrics.exposed_errors.load(Ordering::Relaxed),
            exposed_client_errors: self.metrics.exposed_client_errors.load(Ordering::Relaxed),
            accounts,
        }
    }
}
