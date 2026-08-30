mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::{Health, PoolMember, Strategy};

#[derive(Clone)]
struct MockOAuthState {
    hit_count: Arc<AtomicUsize>,
    fail_with_400: Arc<AtomicBool>,
}

#[derive(Clone)]
struct MockUpstreamState {
    call_count: Arc<AtomicUsize>,
    return_401_on_first: Arc<AtomicBool>,
    always_401: Arc<AtomicBool>,
}

#[tokio::test]
async fn test_t7_refresh_lifecycle() {
    // --- Setup Mock OAuth Server ---
    let oauth_hit_count = Arc::new(AtomicUsize::new(0));
    let oauth_fail_400 = Arc::new(AtomicBool::new(false));
    let oauth_state = MockOAuthState {
        hit_count: oauth_hit_count.clone(),
        fail_with_400: oauth_fail_400.clone(),
    };

    let oauth_app = Router::new()
        .route(
            "/oauth/token",
            post(
                |State(state): State<MockOAuthState>, body: String| async move {
                    state.hit_count.fetch_add(1, Ordering::SeqCst);
                    assert!(
                        body.contains("grant_type=refresh_token"),
                        "must include grant_type"
                    );

                    if state.fail_with_400.load(Ordering::SeqCst) {
                        return (
                            StatusCode::BAD_REQUEST,
                            [("content-type", "application/json")],
                            r#"{"error":"invalid_grant","error_description":"refresh failed"}"#,
                        );
                    }

                    (
                        StatusCode::OK,
                        [("content-type", "application/json")],
                        r#"{"access_token":"refreshed_at_123","refresh_token":"refreshed_rt_123","id_token":"refreshed_idt_123","token_type":"Bearer","expires_in":3600}"#,
                    )
                },
            ),
        )
        .with_state(oauth_state);

    let oauth_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oauth_port = oauth_listener.local_addr().unwrap().port();
    let oauth_url = format!("http://127.0.0.1:{oauth_port}/oauth/token");
    tokio::spawn(async move {
        axum::serve(oauth_listener, oauth_app).await.unwrap();
    });

    // --- Setup Mock Upstream Server ---
    let upstream_call_count = Arc::new(AtomicUsize::new(0));
    let upstream_return_401_on_first = Arc::new(AtomicBool::new(false));
    let upstream_always_401 = Arc::new(AtomicBool::new(false));
    let upstream_state = MockUpstreamState {
        call_count: upstream_call_count.clone(),
        return_401_on_first: upstream_return_401_on_first.clone(),
        always_401: upstream_always_401.clone(),
    };

    let upstream_app = Router::new()
        .route(
            common::CODEX_PATH,
            post(
                |State(state): State<MockUpstreamState>, headers: HeaderMap| async move {
                    let call = state.call_count.fetch_add(1, Ordering::SeqCst);

                    if state.always_401.load(Ordering::SeqCst) {
                        return (
                            StatusCode::UNAUTHORIZED,
                            [("content-type", "application/json")],
                            r#"{"error":{"message":"unauthorized_custom_body"}}"#.to_string(),
                        );
                    }

                    if state.return_401_on_first.load(Ordering::SeqCst) && call == 0 {
                        return (
                            StatusCode::UNAUTHORIZED,
                            [("content-type", "application/json")],
                            r#"{"error":{"message":"token_expired_first_call"}}"#.to_string(),
                        );
                    }

                    let auth = headers
                        .get("Authorization")
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("");
                    if auth == "Bearer refreshed_at_123" {
                        (
                            StatusCode::OK,
                            [("content-type", "text/event-stream")],
                            common::codex_sse("ok"),
                        )
                    } else {
                        (
                            StatusCode::UNAUTHORIZED,
                            [("content-type", "application/json")],
                            r#"{"error":{"message":"stale_token"}}"#.to_string(),
                        )
                    }
                },
            ),
        )
        .with_state(upstream_state);

    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_url = format!("http://127.0.0.1:{upstream_port}");
    tokio::spawn(async move {
        axum::serve(upstream_listener, upstream_app).await.unwrap();
    });

    let client = reqwest::Client::new();

    // =========================================================================
    // Scenario A: Expired in past -> Proactive refresh before upstream call -> 200
    // =========================================================================
    {
        let temp_dir = unique_temp_dir("qgw-test-t7-a");
        let file_path = temp_dir.join("codex-acc_a-plus.json");
        let json_content = serde_json::json!({
            "identity_slug": "acc_a",
            "access_token": "stale_token_a",
            "account_id": "acc_id_a",
            "email": "acc_a@example.com",
            "expired": "2020-01-01T00:00:00Z", // EXPIRED in past
            "id_token": "id_token_a",
            "last_refresh": "2019-01-01T00:00:00Z",
            "refresh_token": "rt_token_a",
            "type": "plus",
            "upstream_override": upstream_url,
            "custom_unknown_key": "preserved_value_a"
        });
        std::fs::write(
            &file_path,
            serde_json::to_string_pretty(&json_content).unwrap(),
        )
        .unwrap();

        let config = GatewayConfig {
            usage_poll_secs: 120,
            port: 0,
            auth_dir: temp_dir.clone(),
            strategy: Strategy::StrictRoundRobin,
            max_failover: 3,
            log_level: "info".to_string(),
            api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
            models_env: None,
            refresh_url: oauth_url.clone(),
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

        oauth_hit_count.store(0, Ordering::SeqCst);
        upstream_call_count.store(0, Ordering::SeqCst);

        // When: client calls chat completions
        let res = client
            .post(format!("http://127.0.0.1:{gw_port}/v1/chat/completions"))
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();

        // Then (a): client gets 200, refreshed before first upstream call
        assert_eq!(res.status(), reqwest::StatusCode::OK);
        assert_eq!(oauth_hit_count.load(Ordering::SeqCst), 1);
        assert_eq!(upstream_call_count.load(Ordering::SeqCst), 1);

        // Then (c): auth JSON on disk updated with new access_token, future expired, unknown keys preserved
        let updated_raw = std::fs::read_to_string(&file_path).unwrap();
        let updated_json: serde_json::Value = serde_json::from_str(&updated_raw).unwrap();
        assert_eq!(
            updated_json["access_token"].as_str().unwrap(),
            "refreshed_at_123"
        );
        assert_eq!(
            updated_json["refresh_token"].as_str().unwrap(),
            "refreshed_rt_123"
        );
        assert_eq!(
            updated_json["custom_unknown_key"].as_str().unwrap(),
            "preserved_value_a"
        );
        let expired_str = updated_json["expired"].as_str().unwrap();
        assert_ne!(
            expired_str, "2020-01-01T00:00:00Z",
            "expired must have updated from the 2020 timestamp"
        );
        assert!(
            expired_str > "2026-01-01T00:00:00Z",
            "expired must be in the future, was {expired_str}"
        );

        // Then (d): /admin/stats reports refreshed >= 1
        let stats = state.get_stats();
        assert!(
            stats.refreshed >= 1,
            "stats.refreshed was {}",
            stats.refreshed
        );

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    // =========================================================================
    // Scenario B: Upstream answers 401 once -> Reactive refresh + retry same account -> 200
    // =========================================================================
    {
        let temp_dir = unique_temp_dir("qgw-test-t7-b");
        let file_path = temp_dir.join("codex-acc_b-plus.json");
        let json_content = serde_json::json!({
            "identity_slug": "acc_b",
            "access_token": "stale_token_b",
            "account_id": "acc_id_b",
            "email": "acc_b@example.com",
            "expired": "2099-01-01T00:00:00Z", // Future expiry so no proactive refresh
            "id_token": "id_token_b",
            "last_refresh": "2026-08-27T00:00:00Z",
            "refresh_token": "rt_token_b",
            "type": "plus",
            "upstream_override": upstream_url,
            "extra_tag": "keep_me"
        });
        std::fs::write(
            &file_path,
            serde_json::to_string_pretty(&json_content).unwrap(),
        )
        .unwrap();

        let config = GatewayConfig {
            usage_poll_secs: 120,
            port: 0,
            auth_dir: temp_dir.clone(),
            strategy: Strategy::StrictRoundRobin,
            max_failover: 3,
            log_level: "info".to_string(),
            api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
            models_env: None,
            refresh_url: oauth_url.clone(),
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

        oauth_hit_count.store(0, Ordering::SeqCst);
        upstream_call_count.store(0, Ordering::SeqCst);
        upstream_return_401_on_first.store(true, Ordering::SeqCst);
        upstream_always_401.store(false, Ordering::SeqCst);

        // When: client calls chat completions
        let res = client
            .post(format!("http://127.0.0.1:{gw_port}/v1/chat/completions"))
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();

        // Then (b): client gets 200, exactly ONE refresh triggered, retry succeeded
        assert_eq!(res.status(), reqwest::StatusCode::OK);
        assert_eq!(
            oauth_hit_count.load(Ordering::SeqCst),
            1,
            "oauth mock must be hit exactly once"
        );
        assert_eq!(
            upstream_call_count.load(Ordering::SeqCst),
            2,
            "upstream must be called first with 401 then retried with 200"
        );

        // Then (c): disk JSON updated
        let updated_raw = std::fs::read_to_string(&file_path).unwrap();
        let updated_json: serde_json::Value = serde_json::from_str(&updated_raw).unwrap();
        assert_eq!(
            updated_json["access_token"].as_str().unwrap(),
            "refreshed_at_123"
        );
        assert_eq!(updated_json["extra_tag"].as_str().unwrap(), "keep_me");

        std::fs::remove_dir_all(&temp_dir).ok();
    }

    // =========================================================================
    // Scenario E: OAuth mock returns 400 -> Health::AuthFailed + upstream 401 body verbatim
    // =========================================================================
    {
        let temp_dir = unique_temp_dir("qgw-test-t7-e");
        let file_path = temp_dir.join("codex-acc_e-plus.json");
        let json_content =
            create_auth_file_json("acc_e", "acc_id_e", "stale_token_e", Some(&upstream_url));
        std::fs::write(&file_path, json_content).unwrap();

        let config = GatewayConfig {
            usage_poll_secs: 120,
            port: 0,
            auth_dir: temp_dir.clone(),
            strategy: Strategy::StrictRoundRobin,
            max_failover: 1,
            log_level: "info".to_string(),
            api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
            models_env: None,
            refresh_url: oauth_url.clone(),
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

        oauth_hit_count.store(0, Ordering::SeqCst);
        upstream_call_count.store(0, Ordering::SeqCst);
        upstream_always_401.store(true, Ordering::SeqCst);
        oauth_fail_400.store(true, Ordering::SeqCst); // OAuth returns 400

        // When: client calls chat completions
        let res = client
            .post(format!("http://127.0.0.1:{gw_port}/v1/chat/completions"))
            .header("Content-Type", "application/json")
            .body(common::OPENAI_REQUEST)
            .send()
            .await
            .unwrap();

        // Then (e): client gets 401 with verbatim upstream body
        assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
        let body = res.text().await.unwrap();
        assert_eq!(
            body,
            r#"{"error":{"message":"unauthorized_custom_body"}}"#.to_string(),
            "client must receive upstream's 401 body verbatim"
        );

        // Account must end up AuthFailed
        let member = state.find_member("acc_e").unwrap();
        assert_eq!(member.health(), Health::AuthFailed);

        std::fs::remove_dir_all(&temp_dir).ok();
    }
}

#[tokio::test]
async fn test_t7_concurrent_single_flight_refresh() {
    // Given: Mock OAuth server with slight latency to force concurrency overlap
    let oauth_hit_count = Arc::new(AtomicUsize::new(0));
    let hit_count_clone = oauth_hit_count.clone();

    let oauth_app = Router::new().route(
        "/oauth/token",
        post(move |body: String| {
            let hits = hit_count_clone.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                assert!(body.contains("grant_type=refresh_token"));
                // Artificial delay to ensure concurrent requests overlap during refresh
                tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"access_token":"refreshed_at_burst","refresh_token":"refreshed_rt_burst","id_token":"refreshed_idt_burst","token_type":"Bearer","expires_in":3600}"#,
                )
            }
        }),
    );

    let oauth_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oauth_port = oauth_listener.local_addr().unwrap().port();
    let oauth_url = format!("http://127.0.0.1:{oauth_port}/oauth/token");
    tokio::spawn(async move {
        axum::serve(oauth_listener, oauth_app).await.unwrap();
    });

    // Mock Upstream server accepting only the refreshed token
    let upstream_app = Router::new().route(
        common::CODEX_PATH,
        post(|headers: HeaderMap| async move {
            let auth = headers
                .get("Authorization")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if auth == "Bearer refreshed_at_burst" {
                (
                    StatusCode::OK,
                    [("content-type", "text/event-stream")],
                    common::codex_sse("burst_ok"),
                )
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    [("content-type", "application/json")],
                    r#"{"error":{"message":"stale_token"}}"#.to_string(),
                )
            }
        }),
    );

    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_url = format!("http://127.0.0.1:{upstream_port}");
    tokio::spawn(async move {
        axum::serve(upstream_listener, upstream_app).await.unwrap();
    });

    // Single account expired in the past
    let temp_dir = unique_temp_dir("qgw-test-t7-burst");
    let file_path = temp_dir.join("codex-burst-plus.json");
    let json_content = serde_json::json!({
        "identity_slug": "burst",
        "access_token": "stale_burst_token",
        "account_id": "acc_burst_id",
        "email": "burst@example.com",
        "expired": "2020-01-01T00:00:00Z", // Expired
        "id_token": "burst_id_token",
        "last_refresh": "2019-01-01T00:00:00Z",
        "refresh_token": "burst_rt",
        "type": "plus",
        "upstream_override": upstream_url
    });
    std::fs::write(
        &file_path,
        serde_json::to_string_pretty(&json_content).unwrap(),
    )
    .unwrap();

    let config = GatewayConfig {
        usage_poll_secs: 120,
        port: 0,
        auth_dir: temp_dir.clone(),
        strategy: Strategy::StrictRoundRobin,
        max_failover: 3,
        log_level: "info".to_string(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
        models_env: None,
        refresh_url: oauth_url.clone(),
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

    // When: N = 10 concurrent requests hit the gateway simultaneously
    let concurrency = 10;
    let mut handles = Vec::new();
    for _ in 0..concurrency {
        let cl = client.clone();
        let url = gw_url.clone();
        handles.push(tokio::spawn(async move {
            cl.post(&url)
                .header("Content-Type", "application/json")
                .body(common::OPENAI_REQUEST)
                .send()
                .await
        }));
    }

    let results = futures::future::join_all(handles).await;

    // Then: All N requests succeed with 200 OK
    for res_wrap in results {
        let resp = res_wrap.unwrap().unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        let body = resp.text().await.unwrap();
        assert!(body.contains("burst_ok"));
    }

    // Then: OAuth endpoint was hit EXACTLY once
    assert_eq!(
        oauth_hit_count.load(Ordering::SeqCst),
        1,
        "single-flight refresh must hit OAuth mock exactly once for concurrent requests"
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn generic_oauth_accounts_refresh_with_provider_contracts() {
    // Given: expired xAI and Kimi credentials created by the onboarding routes.
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<(String, String)>::new()));
    let seen_for_server = Arc::clone(&seen);
    let oauth_app = Router::new().route(
        "/token",
        post(move |body: String| {
            let seen = Arc::clone(&seen_for_server);
            async move {
                seen.lock().await.push(("token".to_string(), body));
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"access_token":"fresh-generic","refresh_token":"fresh-refresh","expires_in":3600}"#,
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/token", listener.local_addr().unwrap());
    let oauth_task = tokio::spawn(async move { axum::serve(listener, oauth_app).await.unwrap() });

    for (provider, client_id) in [
        ("xai", "b1a00492-073a-47ea-816f-4c329264a828"),
        ("kimi", "17e5f671-d194-4dfb-9706-5516cb48c098"),
    ] {
        let temp_dir = unique_temp_dir(&format!("qgw-test-t7-{provider}"));
        let file_path = temp_dir.join(format!("generic-{provider}-oauth.json"));
        std::fs::write(
            &file_path,
            serde_json::json!({
                "type": "generic",
                "provider": provider,
                "label": provider,
                "adapter": "openai-chat",
                "base_url": "http://127.0.0.1:9",
                "api_key": "stale-generic",
                "auth_mode": "oauth",
                "refresh_token": "generic-refresh",
                "expired": "2020-01-01T00:00:00Z",
                "token_url": token_url,
                "client_id": client_id,
                "models": [format!("{provider}-model")]
            })
            .to_string(),
        )
        .unwrap();

        let members = mahoquot_gateway::account::load_account_members(&temp_dir).unwrap();
        assert_eq!(members.len(), 1);
        let member = &members[0];
        assert!(member.is_expired(2_000_000_000));
        assert_eq!(member.refresh_token(), "generic-refresh");

        let refreshed = member
            .refresh(&reqwest::Client::new(), "unused", None)
            .await
            .unwrap();
        assert!(refreshed);
        assert_eq!(member.access_token(), "fresh-generic");

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file_path).unwrap()).unwrap();
        assert_eq!(saved["api_key"], "fresh-generic");
        assert_eq!(saved["refresh_token"], "fresh-refresh");
        std::fs::remove_dir_all(temp_dir).ok();
    }

    let requests = seen.lock().await;
    assert_eq!(requests.len(), 2);
    for (_, body) in requests.iter() {
        assert!(body.contains("grant_type=refresh_token"));
        assert!(body.contains("refresh_token=generic-refresh"));
    }
    oauth_task.abort();
}
