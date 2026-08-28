use std::net::SocketAddr;

use axum::Router;
use tokio::net::TcpListener;

pub async fn run_server(listener: TcpListener, app: Router) -> anyhow::Result<()> {
    // Management auth distinguishes loopback from remote callers, which needs
    // the peer address; axum only supplies it via ConnectInfo.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("server error: {}", e))
}
