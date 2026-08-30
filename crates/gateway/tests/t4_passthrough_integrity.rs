mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use bytes::Bytes;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::Strategy;

#[tokio::test]
async fn test_t4_passthrough_integrity() {
    // Given: upstream emits 20 SSE chunks ending with data: [DONE]
    let chunks: Vec<String> = (0..19)
        .map(|i| format!("data: {{\"chunk\":{i}}}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_string()))
        .collect();

    let chunks_clone = chunks.clone();
    let mock_app = Router::new().route(
        "/backend-api/codex/responses",
        post(move || {
            let chunks_clone = chunks_clone.clone();
            async move {
                let stream = futures::stream::iter(
                    chunks_clone
                        .into_iter()
                        .map(|c| Ok::<_, std::io::Error>(Bytes::from(c))),
                );
                let body = Body::from_stream(stream);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .body(body)
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream_uri = format!("http://127.0.0.1:{port}");
    tokio::spawn(async move {
        axum::serve(listener, mock_app).await.unwrap();
    });

    let temp_dir = unique_temp_dir("qgw-test-t4");
    let json_a = create_auth_file_json("a", "acc_a", "token_a", Some(&upstream_uri));
    std::fs::write(temp_dir.join("codex-a-plus.json"), json_a).unwrap();

    let config = GatewayConfig {
        usage_poll_secs: 120,
        port: 0,
        auth_dir: temp_dir.clone(),
        strategy: Strategy::StrictRoundRobin,
        max_failover: 3,
        log_level: "info".to_string(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
        models_env: None,
        refresh_url: mahoquot_providers::refresh::REFRESH_TOKEN_URL.to_string(),
        auth_refresh_enabled: true,
        ..Default::default()
    };

    let state = Arc::new(AppState::new(&config).unwrap());
    let app = create_app(state.clone());
    let gw_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gw_port = gw_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(gw_listener, app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let gw_url = format!("http://127.0.0.1:{gw_port}/backend-api/codex/responses");

    // When: client sends request
    let res = client
        .post(&gw_url)
        .header("Content-Type", "application/json")
        .body(r#"{"prompt":"write rust"}"#)
        .send()
        .await
        .unwrap();

    // Then: 20 chunks ending with data: [DONE], content-type preserved
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        res.headers().get("content-type").unwrap().to_str().unwrap(),
        "text/event-stream"
    );

    let body = res.text().await.unwrap();
    let received_chunks: Vec<&str> = body
        .split("\n\n")
        .filter(|s| !s.trim().is_empty())
        .collect();

    assert_eq!(received_chunks.len(), 20);
    assert_eq!(received_chunks.last(), Some(&"data: [DONE]"));

    std::fs::remove_dir_all(&temp_dir).ok();
}
