mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;

const CLAUDE_JSON: &str = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}"#;

/// A live Claude relay must land the subscription quota headers in the snapshot
/// the console reads. Parsing them in isolation proves nothing about the path a
/// real request takes.
#[tokio::test]
async fn claude_relay_records_subscription_usage_in_admin_stats() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let upstream_app = Router::new().fallback(post(|| async {
        (
            StatusCode::OK,
            [
                ("content-type", "application/json"),
                ("anthropic-ratelimit-unified-status", "allowed"),
                ("anthropic-ratelimit-unified-5h-utilization", "0.03"),
                ("anthropic-ratelimit-unified-5h-reset", "4102444800"),
                ("anthropic-ratelimit-unified-7d-utilization", "0.12"),
                ("anthropic-ratelimit-unified-7d-reset", "4102531200"),
                (
                    "anthropic-ratelimit-unified-representative-claim",
                    "five_hour",
                ),
            ],
            CLAUDE_JSON,
        )
    }));
    let mock_task = tokio::spawn(async move {
        axum::serve(listener, upstream_app).await.unwrap();
    });

    let auth_dir = common::unique_temp_dir("t16-claude-usage");
    std::fs::write(
        auth_dir.join("claude-relay.json"),
        serde_json::to_string(&serde_json::json!({
            "identity_slug": "claude-relay",
            "access_token": "claude-token",
            "refresh_token": "claude-refresh",
            "email": "u@claude.test",
            "expired": "2099-01-01T00:00:00Z",
            "type": "claude",
            "upstream_override": upstream,
        }))
        .unwrap(),
    )
    .unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = format!("http://{}", gateway_listener.local_addr().unwrap());
    let gateway_task = tokio::spawn(async move {
        axum::serve(gateway_listener, create_app(state))
            .await
            .unwrap();
    });

    let relayed = reqwest::Client::new()
        .post(format!("{gateway}/v1/messages"))
        .header("x-api-key", "relay-key")
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-5-20250929",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "hi"}],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(relayed.status(), StatusCode::OK);

    let stats: serde_json::Value = reqwest::Client::new()
        .get(format!("{gateway}/admin/stats"))
        .bearer_auth("relay-key")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let usage = &stats["accounts"][0]["usage"];
    assert_eq!(usage["primary"]["used_percent"], 3.0, "stats: {stats}");
    assert_eq!(usage["primary"]["limit_name"], "Session");
    assert_eq!(usage["secondary"]["used_percent"], 12.0);
    assert_eq!(usage["secondary"]["limit_name"], "Weekly");
    assert_eq!(usage["active_limit"], "five_hour");

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

/// Every other provider fills its quota from the poller, so an idle Claude
/// account must too. Relying on relayed response headers alone left it blank
/// forever whenever traffic did not happen to go through this gateway.
#[tokio::test]
async fn claude_usage_is_polled_without_any_relayed_traffic() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen_for_route = seen.clone();
    let usage_app = Router::new().route(
        "/api/oauth/usage",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let seen = seen_for_route.clone();
            async move {
                let beta = headers
                    .get("anthropic-beta")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                seen.lock().unwrap().push(beta);
                axum::Json(serde_json::json!({
                    "five_hour": {
                        "utilization": 80.0,
                        "resets_at": "2026-08-30T03:50:00.351899+00:00",
                        "locked_reason": null
                    },
                    "seven_day": {
                        "utilization": 26.0,
                        "resets_at": "2026-09-02T00:00:00.351925+00:00",
                        "locked_reason": null
                    },
                    "seven_day_opus": null,
                    "extra_usage": { "is_enabled": false }
                }))
            }
        }),
    );
    let mock_task = tokio::spawn(async move {
        axum::serve(listener, usage_app).await.unwrap();
    });

    let auth_dir = common::unique_temp_dir("t16-claude-poll");
    std::fs::write(
        auth_dir.join("claude-poll.json"),
        serde_json::to_string(&serde_json::json!({
            "identity_slug": "claude-poll",
            "access_token": "claude-token",
            "refresh_token": "claude-refresh",
            "email": "u@claude.test",
            "expired": "2099-01-01T00:00:00Z",
            "type": "claude",
            "upstream_override": upstream,
        }))
        .unwrap(),
    )
    .unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let snapshot = state.pool.load();
    let member = snapshot
        .members
        .iter()
        .find(|m| m.kind() == mahoquot_gateway::account::ProviderKind::Claude)
        .expect("claude member")
        .clone();

    mahoquot_gateway::quota::refresh_account_usage(&state, &member)
        .await
        .expect("poll claude usage");

    let usage = member.usage_snapshot();
    assert_eq!(usage.primary.used_percent, Some(80.0));
    assert_eq!(usage.primary.limit_name.as_deref(), Some("Session"));
    assert_eq!(usage.secondary.used_percent, Some(26.0));
    assert_eq!(usage.primary.reset_at_unix, Some(1788061800));
    assert_eq!(usage.secondary.limit_name.as_deref(), Some("Weekly"));
    assert!(usage.observed_at_unix.is_some());
    assert_eq!(seen.lock().unwrap().as_slice(), ["oauth-2025-04-20"]);

    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}
