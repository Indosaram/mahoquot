use std::sync::Arc;

use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::server::run_server;
use mahoquot_gateway::state::AppState;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = GatewayConfig::from_env()?;

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .init();

    info!(
        port = config.port,
        auth_dir = %config.auth_dir.display(),
        strategy = ?config.strategy,
        max_failover = config.max_failover,
        "starting mahoquot-gateway"
    );

    let state = Arc::new(AppState::new(&config)?);
    state
        .telemetry
        .spawn_flush_worker(std::time::Duration::from_secs(10));
    mahoquot_gateway::quota::spawn_usage_poller(
        Arc::clone(&state),
        std::time::Duration::from_secs(config.usage_poll_secs),
    );
    let app = create_app(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = TcpListener::bind(&addr).await?;
    info!("listening on {}", addr);

    run_server(listener, app).await
}
