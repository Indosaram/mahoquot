mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::{Health, Strategy};

#[tokio::test]
async fn test_t2_churn_via_force_health() {
    // Given: 3 upstream accounts (a, b, c)
    let counts: Vec<Arc<AtomicUsize>> = (0..3).map(|_| Arc::new(AtomicUsize::new(0))).collect();
    let mut upstream_uris = Vec::new();

    for count in &counts {
        let count_clone = count.clone();
        let mock_app = Router::new().route(
            common::CODEX_PATH,
            post(move || {
                let c = count_clone.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::OK,
                        [("Content-Type", "text/event-stream")],
                        common::codex_sse("ok"),
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

    let temp_dir = unique_temp_dir("qgw-test-t2");
    let ids = ["a", "b", "c"];
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

    // Burn 3 requests
    for _ in 0..3 {
        let res = client
            .post(&gw_url)
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::OK);
    }
    assert_eq!(counts[0].load(Ordering::SeqCst), 1);
    assert_eq!(counts[1].load(Ordering::SeqCst), 1);
    assert_eq!(counts[2].load(Ordering::SeqCst), 1);

    // When: cool member b mid-sequence
    state.force_health(
        "b",
        Health::Cooldown {
            until_unix_ms: i64::MAX,
        },
    );

    // Subsequent picks alternate remaining two evenly (8 requests: 4 to a, 4 to c)
    for _ in 0..8 {
        let res = client
            .post(&gw_url)
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::OK);
    }
    assert_eq!(counts[1].load(Ordering::SeqCst), 1); // b remained untouched
    assert_eq!(counts[0].load(Ordering::SeqCst), 5); // 1 + 4 = 5
    assert_eq!(counts[2].load(Ordering::SeqCst), 5); // 1 + 4 = 5

    // When: restore b
    state.force_health("b", Health::Available);

    // Then: b rejoins cycle evenly (3 requests => a, b, c each served +1)
    for _ in 0..3 {
        let res = client
            .post(&gw_url)
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::OK);
    }
    assert_eq!(counts[0].load(Ordering::SeqCst), 6);
    assert_eq!(counts[1].load(Ordering::SeqCst), 2);
    assert_eq!(counts[2].load(Ordering::SeqCst), 6);

    std::fs::remove_dir_all(&temp_dir).ok();
}
