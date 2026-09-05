use super::*;
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn native_reservations_cover_launch_rollback_stop_and_reap() {
    let root = tempfile::tempdir().unwrap();
    let mut listener = None;
    for port in 18840..=18899 {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => panic!("fixture bind failed: {error}"),
        }
    }
    let listener = listener.expect("no fixture port available");
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(Vec::new()));
    let requests = captured.clone();
    let gateway_url = std::env::var("MAHOQUOT_REVIEW_GATEWAY_URL").ok();
    let forwarded_gateway = gateway_url.clone();
    let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
        let requests = requests.clone();
        let gateway = forwarded_gateway.clone();
        async move {
            let method = request.method().clone();
            let path = request.uri().path().to_string();
            assert_eq!(
                request.headers().get("authorization").unwrap(),
                "Bearer fixture-key"
            );
            let bytes = axum::body::to_bytes(request.into_body(), 4096)
                .await
                .unwrap();
            let body = if bytes.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            let status = if let Some(gateway) = gateway {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap();
                let mut forwarded = client
                    .request(method.clone(), format!("{gateway}{path}"))
                    .bearer_auth("fixture-key");
                if !body.is_null() {
                    forwarded = forwarded.json(&body);
                }
                forwarded.send().await.unwrap().status()
            } else if !path.starts_with("/v0/management/scheduler/reservations")
                || body.get("account_id").and_then(|id| id.as_str()) == Some("missing-account")
            {
                axum::http::StatusCode::NOT_FOUND
            } else {
                axum::http::StatusCode::OK
            };
            requests.lock().unwrap().push((method, path, body));
            status
        }
    });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // Abort on assertion unwind as well as the successful path.
    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let mut server = Server(server);
    let config = Config {
        base_url: base_url.clone(),
        api_key: "fixture-key".into(),
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap(),
    };
    assert_eq!(
        config
            .client
            .post(format!("{base_url}/management/scheduler/reservations"))
            .bearer_auth("fixture-key")
            .json(&serde_json::json!({"instance_id":"old","account_id":"account-a"}))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let request = |id: &str| codex_launcher::CodexLaunchRequest {
        instance_id: id.into(),
        account_id: "account-a".into(),
        model: "gpt-5.6-codex".into(),
        reasoning_effort: "high".into(),
    };
    // A tiny script provides a deterministic exit, never a real Codex process.
    #[cfg(unix)]
    let binary = {
        use std::os::unix::fs::PermissionsExt;
        let binary = root.path().join("fake-codex");
        std::fs::write(&binary, "#!/bin/sh\nexit 42\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        binary
    };
    #[cfg(windows)]
    let binary = std::path::PathBuf::from("C:\\Windows\\System32\\whoami.exe");
    let launcher = codex_launcher::CodexLauncher::new(binary, root.path().join("instances"));
    let launched = launch_codex_instance_inner(&launcher, &config, request("qa-start"))
        .await
        .unwrap();

    launcher.wait_for_test_exit("qa-start");
    stop_codex_instance_inner(&launcher, &config, "qa-start".into())
        .await
        .unwrap();

    assert!(launcher.instances().is_empty());
    assert!(!launched.codex_home.exists());
    let missing = codex_launcher::CodexLauncher::new(
        root.path().join("missing"),
        root.path().join("missing-instances"),
    );
    let error = launch_codex_instance_inner(&missing, &config, request("qa-rollback"))
        .await
        .unwrap_err();
    assert!(error.contains("Codex executable not found"), "{error}");

    launch_codex_instance_inner(&launcher, &config, request("qa-crash"))
        .await
        .unwrap();
    launcher.wait_for_test_exit("qa-crash");
    let instances = list_codex_instances_inner(&launcher, &config)
        .await
        .unwrap();
    assert_eq!(instances[0].state, codex_launcher::InstanceState::Crashed);

    launcher.stop_all().unwrap();
    let mut unknown = request("qa-unknown");
    unknown.account_id = "missing-account".into();
    assert!(launch_codex_instance_inner(&launcher, &config, unknown)
        .await
        .unwrap_err()
        .contains("404"));
    assert!(launcher.instances().is_empty());
    if let Some(gateway) = gateway_url {
        let reservations: serde_json::Value = config
            .client
            .get(format!("{gateway}/v0/management/scheduler/reservations"))
            .bearer_auth("fixture-key")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reservations["reservations"], serde_json::json!({}));
    }
    server.0.abort();
    assert!((&mut server.0).await.unwrap_err().is_cancelled());
    let requests = captured.lock().unwrap();
    let routes: Vec<_> = requests
        .iter()
        .map(|(method, path, _)| (method.as_str(), path.as_str()))
        .collect();
    assert_eq!(
        routes,
        [
            ("POST", "/management/scheduler/reservations"),
            ("POST", "/v0/management/scheduler/reservations"),
            ("DELETE", "/v0/management/scheduler/reservations/qa-start"),
            ("POST", "/v0/management/scheduler/reservations"),
            (
                "DELETE",
                "/v0/management/scheduler/reservations/qa-rollback"
            ),
            ("POST", "/v0/management/scheduler/reservations"),
            ("DELETE", "/v0/management/scheduler/reservations/qa-crash"),
            ("POST", "/v0/management/scheduler/reservations"),
        ]
    );
    for (index, id) in [(1, "qa-start"), (3, "qa-rollback"), (5, "qa-crash")] {
        assert_eq!(
            requests[index].2,
            serde_json::json!({"instance_id": id, "account_id": "account-a"})
        );
    }
    drop(requests);
    drop(config);
    drop(launcher);
    drop(missing);
    drop(captured);
    root.close().unwrap();
}
