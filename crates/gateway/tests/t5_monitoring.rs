mod common;

use mahoquot_gateway::monitor::{MonitorState, PromAccount};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::inbound::ApiKeys;
use mahoquot_gateway::management::observability::append_log_line;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use tower::ServiceExt;

#[tokio::test]
async fn persisted_history_and_logs_are_exposed_after_state_recreation() {
    let auth_dir =
        std::env::temp_dir().join(format!("mahoquot-monitor-restart-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["history-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let first = AppState::new(&config).expect("first state");
    first
        .telemetry
        .record_with_account(1_800, "codex", Some("codex"), true);
    first.telemetry.flush().expect("flush history");
    append_log_line(
        &first.settings.current(),
        r#"{"provider":"codex","status":200}"#,
    );

    let restored = Arc::new(AppState::new(&config).expect("restored state"));
    let app = create_app(restored);
    let stats = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/admin/stats")
                .header(header::AUTHORIZATION, "Bearer history-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stats.status(), StatusCode::OK);
    let stats_body = stats.into_body().collect().await.unwrap().to_bytes();
    let stats_json: serde_json::Value = serde_json::from_slice(&stats_body).unwrap();
    assert_eq!(stats_json["history"][0]["requests"], 1);

    let logs = app
        .oneshot(
            Request::builder()
                .uri("/v0/management/logs")
                .header(header::AUTHORIZATION, "Bearer history-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logs.status(), StatusCode::OK);
    let logs_body = logs.into_body().collect().await.unwrap().to_bytes();
    let logs_json: serde_json::Value = serde_json::from_slice(&logs_body).unwrap();
    let records = logs_json["records"].as_array().expect("records array");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["kind"], "proxy");
    assert!(records[0]["message"].as_str().unwrap().contains("codex"));
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn logs_endpoint_serves_the_live_tail_while_file_logging_is_off() {
    let auth_dir = std::env::temp_dir().join(format!("mahoquot-live-tail-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    std::fs::write(auth_dir.join("config.yaml"), "logging-to-file: false\n").expect("config");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["tail-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).expect("state"));
    let app = create_app(Arc::clone(&state));

    // A management edit lands in the live tail even with file logging off.
    let edit = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v0/management/logs-max-total-size-mb")
                .header("authorization", "Bearer tail-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"value": 5}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(edit.status(), StatusCode::OK);

    let logs = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/logs")
                .header("authorization", "Bearer tail-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logs.status(), StatusCode::OK);
    let logs_json: serde_json::Value =
        serde_json::from_slice(&logs.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let records = logs_json["records"].as_array().expect("records array");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["kind"], "proxy");
    assert!(records[0]["message"]
        .as_str()
        .unwrap()
        .contains("management: config updated"));
    assert!(!auth_dir.join("logs").exists(), "no file should be written");

    // File-backed error-log routes still refuse while logging is disabled.
    let error_logs = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/request-error-logs")
                .header("authorization", "Bearer tail-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(error_logs.status(), StatusCode::BAD_REQUEST);

    // And clearing empties the live tail too.
    let cleared = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v0/management/logs")
                .header("authorization", "Bearer tail-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let after = app
        .oneshot(
            Request::builder()
                .uri("/v0/management/logs")
                .header("authorization", "Bearer tail-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let after_json: serde_json::Value =
        serde_json::from_slice(&after.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(after_json["records"].as_array().expect("records").len(), 0);
    assert_eq!(after_json["request-count"], 0);
    assert_eq!(after_json["proxy-count"], 0);
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn streamed_requests_record_bytes_and_tokens_at_stream_end() {
    use axum::response::Response;
    use axum::routing::post;
    use axum::Router;
    use common::{create_auth_file_json, unique_temp_dir};

    // Given: an upstream that streams frames ending with a usage frame
    let mut frames: Vec<String> = (0..3)
        .map(|i| format!("data: {{\"chunk\":{i}}}\n\n"))
        .collect();
    frames.push(
        "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n"
            .to_string(),
    );
    frames.push("data: [DONE]\n\n".to_string());
    let expected_bytes_out: usize = frames.iter().map(|f| f.len()).sum();

    let frames_for_mock = frames.clone();
    let mock_app = Router::new().route(
        "/backend-api/codex/responses",
        post(move || {
            let frames = frames_for_mock.clone();
            async move {
                let stream = futures::stream::iter(
                    frames
                        .into_iter()
                        .map(|c| Ok::<_, std::io::Error>(bytes::Bytes::from(c))),
                );
                Response::builder()
                    .status(axum::http::StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }
        }),
    );
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(upstream_listener, mock_app).await.unwrap();
    });
    let upstream_uri = format!("http://127.0.0.1:{upstream_port}");

    let temp_dir = unique_temp_dir("qgw-test-t5-stream-record");
    let json_a = create_auth_file_json("a", "acc_a", "token_a", Some(&upstream_uri));
    std::fs::write(temp_dir.join("codex-a-plus.json"), json_a).unwrap();
    std::fs::write(temp_dir.join("config.yaml"), "logging-to-file: false\n").unwrap();

    let config = GatewayConfig {
        auth_dir: temp_dir.clone(),
        api_keys: ApiKeys::new(vec!["stream-key".to_string()]),
        config_path: temp_dir.join("config.yaml"),
        max_failover: 3,
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).expect("state"));
    let app = create_app(Arc::clone(&state));
    let gw_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gw_port = gw_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(gw_listener, app).await.unwrap();
    });

    // When: a client streams the request to completion
    let request_body = r#"{"prompt":"write rust"}"#;
    let client = reqwest::Client::new();
    let res = client
        .post(format!(
            "http://127.0.0.1:{gw_port}/backend-api/codex/responses"
        ))
        .header("Authorization", "Bearer stream-key")
        .header("Content-Type", "application/json")
        .body(request_body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let delivered = res.text().await.unwrap();
    assert_eq!(delivered.len(), expected_bytes_out);

    // Then: the finalized record carries bytes and tokens; the record is
    // written by a spawned task, so poll the endpoint with a bounded timeout.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let record = loop {
        assert!(
            std::time::Instant::now() < deadline,
            "record never appeared"
        );
        let logs = client
            .get(format!("http://127.0.0.1:{gw_port}/v0/management/logs"))
            .header("Authorization", "Bearer stream-key")
            .send()
            .await
            .unwrap();
        let logs_json: serde_json::Value = logs.json().await.unwrap();
        let records = logs_json["records"].as_array().cloned().unwrap_or_default();
        if let Some(record) = records.iter().find(|r| r["kind"] == "request") {
            break record.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };

    assert_eq!(record["provider"], "codex");
    assert_eq!(record["account"], "a");
    assert_eq!(record["success"], true);
    assert_eq!(record["bytes-in"], request_body.len() as u64);
    assert_eq!(record["bytes-out"], expected_bytes_out as u64);
    assert_eq!(record["tokens"], 15);
    assert!(record["latency-ms"].as_u64().is_some());

    let stats = client
        .get(format!("http://127.0.0.1:{gw_port}/admin/stats"))
        .header("Authorization", "Bearer stream-key")
        .send()
        .await
        .unwrap();
    let stats_json: serde_json::Value = stats.json().await.unwrap();
    let account = &stats_json["accounts"][0];
    assert_eq!(account["input_tokens"], 10);
    assert_eq!(account["output_tokens"], 5);
    assert_eq!(account["total_tokens"], 15);

    state.telemetry.flush().expect("flush token usage");
    let restored = AppState::new(&config)
        .expect("restored token state")
        .get_stats();
    assert_eq!(restored.accounts[0].input_tokens, 10);
    assert_eq!(restored.accounts[0].output_tokens, 5);
    assert_eq!(restored.accounts[0].total_tokens, 15);
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn test_in_flight_tracking() {
    let monitor = Arc::new(MonitorState::new(1000));
    assert_eq!(monitor.in_flight(), 0);

    {
        let guard = monitor.track_in_flight();
        assert_eq!(monitor.in_flight(), 1);
        drop(guard);
    }
    assert_eq!(monitor.in_flight(), 0);

    let early_return_res = (|| {
        let _guard = monitor.track_in_flight();
        assert_eq!(monitor.in_flight(), 1);
        if true {
            return 42;
        }
        0
    })();
    assert_eq!(early_return_res, 42);
    assert_eq!(monitor.in_flight(), 0);

    let guard1 = monitor.track_in_flight();
    let guard2 = monitor.track_in_flight();
    assert_eq!(monitor.in_flight(), 2);
    drop(guard1);
    assert_eq!(monitor.in_flight(), 1);
    drop(guard2);
    assert_eq!(monitor.in_flight(), 0);
}

#[test]
fn test_ttft_percentiles_1_to_100() {
    let monitor = MonitorState::new(1000);
    for ms in 1..=100 {
        monitor.record_ttft("acc_1", ms as f64);
    }

    let snap = monitor.ttft_percentiles();
    assert_eq!(snap.samples, 100);
    assert!(
        (49.0..=51.0).contains(&snap.p50_ms),
        "p50 was {}",
        snap.p50_ms
    );
    assert!(
        (89.0..=91.0).contains(&snap.p90_ms),
        "p90 was {}",
        snap.p90_ms
    );
    assert!(
        (98.0..=100.0).contains(&snap.p99_ms),
        "p99 was {}",
        snap.p99_ms
    );

    let acc_snap = monitor.account_ttft("acc_1").expect("account snap exists");
    assert_eq!(acc_snap.samples, 100);
    assert!((49.0..=51.0).contains(&acc_snap.p50_ms));
    assert!((89.0..=91.0).contains(&acc_snap.p90_ms));
    assert!((98.0..=100.0).contains(&acc_snap.p99_ms));
}

#[test]
fn test_ttft_ring_buffer_capacity() {
    let monitor = MonitorState::new(1000);
    for ms in 1..=5000 {
        monitor.record_ttft("acc_1", ms as f64);
    }

    let snap = monitor.ttft_percentiles();
    assert!(snap.samples <= 1024, "samples was {}", snap.samples);
    assert_eq!(snap.samples, 1024);
    assert!(snap.p50_ms.is_finite());
    assert!(snap.p90_ms.is_finite());
    assert!(snap.p99_ms.is_finite());
}

#[test]
fn test_render_prometheus() {
    let monitor = MonitorState::new(1000);
    monitor.record_ttft("acc_1", 50.0);

    let accounts = vec![
        PromAccount {
            id: "acc_active".to_string(),
            ok: 10,
            fails: 1,
            cooldown_until_unix_ms: None,
        },
        PromAccount {
            id: "acc_cooling".to_string(),
            ok: 5,
            fails: 3,
            cooldown_until_unix_ms: Some(20000),
        },
    ];

    let rendered = monitor.render_prometheus(10000, &accounts);

    let metric_names = [
        "mahoquot_uptime_seconds",
        "mahoquot_in_flight_requests",
        "mahoquot_ttft_milliseconds",
        "mahoquot_account_requests_total",
        "mahoquot_account_cooldown_until_seconds",
    ];
    for name in &metric_names {
        assert!(
            rendered.contains(name),
            "rendered output missing metric: {}",
            name
        );
    }

    let mut cooldown_lines = Vec::new();
    for line in rendered.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let is_valid = if let Some(idx) = trimmed.find(' ') {
            let metric_part = &trimmed[..idx];
            let val_part = &trimmed[idx + 1..];

            let valid_metric = if let Some(label_start) = metric_part.find('{') {
                metric_part.ends_with('}')
                    && metric_part[..label_start]
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '_')
            } else {
                metric_part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_')
            };

            let valid_val = val_part.parse::<f64>().is_ok();
            valid_metric && valid_val
        } else {
            false
        };

        assert!(
            is_valid,
            "line did not match metric format pattern: {:?}",
            trimmed
        );

        if trimmed.starts_with("mahoquot_account_cooldown_until_seconds") {
            cooldown_lines.push(trimmed.to_string());
        }
    }

    assert_eq!(cooldown_lines.len(), 2);
    let cooling_line = cooldown_lines
        .iter()
        .find(|l| l.contains("acc_cooling"))
        .expect("cooling account line present");
    let active_line = cooldown_lines
        .iter()
        .find(|l| l.contains("acc_active"))
        .expect("active account line present");

    let cooling_val: f64 = cooling_line
        .split_whitespace()
        .last()
        .unwrap()
        .parse()
        .unwrap();
    let active_val: f64 = active_line
        .split_whitespace()
        .last()
        .unwrap()
        .parse()
        .unwrap();

    assert!(cooling_val > 0.0, "cooling value was {}", cooling_val);
    assert_eq!(active_val, 0.0, "active value was {}", active_val);
}

#[test]
fn test_record_and_last_error() {
    let monitor = MonitorState::new(1000);
    assert_eq!(monitor.last_error("unknown_acc"), None);

    monitor.record_error("acc_err", 503, "Service Unavailable");
    let err = monitor.last_error("acc_err").expect("error recorded");
    assert_eq!(err.status, 503);
    assert_eq!(err.message, "Service Unavailable");
    assert!(err.unix_ms > 0);

    assert_eq!(monitor.last_error("unknown_acc"), None);
}
