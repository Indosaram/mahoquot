use quotio_gateway::monitor::{MonitorState, PromAccount};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use quotio_gateway::config::GatewayConfig;
use quotio_gateway::inbound::ApiKeys;
use quotio_gateway::management::observability::append_log_line;
use quotio_gateway::routes::create_app;
use quotio_gateway::state::AppState;
use tower::ServiceExt;

#[tokio::test]
async fn persisted_history_and_logs_are_exposed_after_state_recreation() {
    let auth_dir = std::env::temp_dir().join(format!(
        "quotio-monitor-restart-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["history-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let first = AppState::new(&config).expect("first state");
    first.telemetry.record(1_800, "codex", true);
    first.telemetry.flush().expect("flush history");
    append_log_line(&first.settings.current(), r#"{"provider":"codex","status":200}"#);

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
    assert!(logs_json["lines"][0].as_str().unwrap().contains("codex"));
    std::fs::remove_dir_all(auth_dir).ok();
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
        "quotio_uptime_seconds",
        "quotio_in_flight_requests",
        "quotio_ttft_milliseconds",
        "quotio_account_requests_total",
        "quotio_account_cooldown_until_seconds",
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

        if trimmed.starts_with("quotio_account_cooldown_until_seconds") {
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
