mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::{Health, PoolMember, Strategy};

#[tokio::test]
async fn test_t3_failover() {
    // Given: Account A override always 429, Account B 200 SSE
    let listener_a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_a = listener_a.local_addr().unwrap().port();
    let app_a = Router::new().route(
        common::CODEX_PATH,
        post(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("Retry-After", "300")],
                "{\"error\":\"rate limited\"}",
            )
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener_a, app_a).await.unwrap();
    });

    let listener_b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_b = listener_b.local_addr().unwrap().port();
    let app_b = Router::new().route(
        common::CODEX_PATH,
        post(|| async {
            (
                StatusCode::OK,
                [("Content-Type", "text/event-stream")],
                common::codex_sse("hello"),
            )
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener_b, app_b).await.unwrap();
    });

    let temp_dir = unique_temp_dir("qgw-test-t3");
    let json_a = create_auth_file_json(
        "a",
        "acc_a",
        "token_a",
        Some(&format!("http://127.0.0.1:{port_a}")),
    );
    std::fs::write(temp_dir.join("codex-a-plus.json"), json_a).unwrap();

    let json_b = create_auth_file_json(
        "b",
        "acc_b",
        "token_b",
        Some(&format!("http://127.0.0.1:{port_b}")),
    );
    std::fs::write(temp_dir.join("codex-b-plus.json"), json_b).unwrap();

    let config = GatewayConfig {
        usage_poll_secs: 120,
        port: 0,
        auth_dir: temp_dir.clone(),
        strategy: Strategy::FillFirst, // FillFirst will always try 'a' first
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
    let gw_url = format!("http://127.0.0.1:{gw_port}/v1/chat/completions");

    // When: client makes single request
    let res = client
        .post(&gw_url)
        .header("Content-Type", "application/json")
        .body(common::OPENAI_REQUEST)
        .send()
        .await
        .unwrap();

    // Then: single client response 200 SSE
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        res.headers().get("content-type").unwrap().to_str().unwrap(),
        "text/event-stream"
    );
    let body = res.text().await.unwrap();
    assert!(body.contains("data: [DONE]"));

    // Stats checks
    let stats = state.get_stats();
    assert!(
        stats.failed_over >= 1,
        "failed_over must be >= 1, got {}",
        stats.failed_over
    );
    assert_eq!(
        stats.exposed_errors, 0,
        "exposed_errors must be 0, got {}",
        stats.exposed_errors
    );

    // Account A state is Cooldown
    let acct_a = state.find_member("a").expect("member a exists");
    assert!(
        matches!(acct_a.health(), Health::Cooldown { .. }),
        "acct a must be in Cooldown, was {:?}",
        acct_a.health()
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}
