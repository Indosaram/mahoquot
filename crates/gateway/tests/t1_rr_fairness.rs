mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::Strategy;

const CODEX_SSE: &str = concat!(
    "event: response.created\n",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_rr\"}}\n\n",
    "event: response.output_item.added\n",
    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_rr\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"ok\",\"item_id\":\"msg_rr\",\"output_index\":0}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_rr\",\"status\":\"completed\"}}\n\n",
);

#[tokio::test]
async fn test_t1_rr_fairness() {
    // Given: 4 upstream mock servers and 4 account fixtures
    let counts: Vec<Arc<AtomicUsize>> = (0..4).map(|_| Arc::new(AtomicUsize::new(0))).collect();
    let mut upstream_uris = Vec::new();

    for count in &counts {
        let count_clone = count.clone();
        let mock_app = Router::new().route(
            "/backend-api/codex/responses",
            post(move || {
                let c = count_clone.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::OK,
                        [("Content-Type", "text/event-stream")],
                        CODEX_SSE,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        upstream_uris.push(format!("http://127.0.0.1:{port}"));
        tokio::spawn(async move {
            axum::serve(listener, mock_app).await.unwrap();
        });
    }

    let temp_dir = unique_temp_dir("qgw-test-t1");
    let ids = ["a", "b", "c", "d"];
    for (i, id) in ids.iter().enumerate() {
        let file_path = temp_dir.join(format!("codex-{id}-plus.json"));
        let json_content = create_auth_file_json(
            id,
            &format!("acc_{id}"),
            &format!("token_{id}"),
            Some(&upstream_uris[i]),
        );
        std::fs::write(file_path, json_content).unwrap();
    }

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
    let gw_url = format!("http://127.0.0.1:{gw_port}/v1/chat/completions");

    // When: 40 sequential POSTs
    for _ in 0..40 {
        let res = client
            .post(&gw_url)
            .header("Content-Type", "application/json")
            .body(r#"{"model":"codex","stream":true,"messages":[{"role":"user","content":"hi"}]}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::OK);
    }

    // Then: exactly 10 per mock
    for (i, count) in counts.iter().enumerate() {
        assert_eq!(
            count.load(Ordering::SeqCst),
            10,
            "mock {} should receive exactly 10 requests",
            ids[i]
        );
    }

    std::fs::remove_dir_all(&temp_dir).ok();
}
