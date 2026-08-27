use axum::Router;
use tokio::net::TcpListener;

pub async fn run_server(listener: TcpListener, app: Router) -> anyhow::Result<()> {
    axum::serve(listener, app)
        .await
        .map_err(|e| anyhow::anyhow!("server error: {}", e))
}
