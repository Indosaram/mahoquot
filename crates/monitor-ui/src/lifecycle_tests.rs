use std::io::Read;
use std::net::TcpListener;
use std::path::Path;

use crate::{
    gateway_target_policy, migrate_legacy_secret_inner, read_secret_inner, reclaim_listener_policy,
    request_gateway_shutdown, secrets, stop_owned_gateway, stop_signal_order, target_gateway_port,
    Config, DesktopSecretStore, GatewayProcess, GatewayTargetPolicy, MigrateLegacySecretRequest,
    ReclaimListenerPolicy, SecretRequest, StopSignal,
};

#[test]
fn reclaim_policy_kills_only_the_gateway_executable() {
    let own_gateway = Path::new("/Applications/Mahoquot.app/Contents/MacOS/mahoquot-gateway");

    assert_eq!(
        reclaim_listener_policy(
            Path::new("/Applications/Mahoquot.app/Contents/MacOS/mahoquot-gateway"),
            own_gateway,
        ),
        ReclaimListenerPolicy::Terminate
    );
    assert_eq!(
        reclaim_listener_policy(Path::new("/usr/local/bin/foreign-service"), own_gateway),
        ReclaimListenerPolicy::Skip
    );
}

#[test]
fn a_remote_gateway_target_never_launches_or_reclaims_the_local_port() {
    assert_eq!(
        gateway_target_policy("http://127.0.0.1:18801"),
        GatewayTargetPolicy::ManageLocal
    );
    assert_eq!(
        gateway_target_policy("http://gateway.example.test:18801"),
        GatewayTargetPolicy::UseConfigured
    );
}

#[test]
fn target_gateway_port_resolution_and_qa_loopback_policy() {
    assert_eq!(target_gateway_port("http://127.0.0.1:18801"), 18801);
    assert_eq!(target_gateway_port("http://127.0.0.1:18845"), 18845);
    assert_eq!(target_gateway_port("not-a-valid-url"), 18801);

    assert_eq!(
        crate::gateway_target_policy_with_qa("http://127.0.0.1:18845", false),
        GatewayTargetPolicy::UseConfigured
    );

    assert_eq!(
        crate::gateway_target_policy_with_qa("http://127.0.0.1:18845", true),
        GatewayTargetPolicy::ManageLocal
    );
    assert_eq!(
        crate::gateway_target_policy_with_qa("http://localhost:18845", true),
        GatewayTargetPolicy::ManageLocal
    );
    assert_eq!(
        crate::gateway_target_policy_with_qa("http://remote.host.test:18845", true),
        GatewayTargetPolicy::UseConfigured
    );
}

fn qa_listener() -> TcpListener {
    (18840..=18899)
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .expect("an available QA port")
}

#[test]
fn stop_policy_attempts_graceful_shutdown_before_forcing_exit() {
    assert_eq!(
        stop_signal_order(),
        [StopSignal::Terminate, StopSignal::Kill]
    );
}

fn config_for(base_url: &str, api_key: &str) -> Config {
    Config {
        base_url: base_url.to_string(),
        api_key: api_key.to_string(),
        management_key: api_key.to_string(),
        client: reqwest::Client::new(),
    }
}

/// The shutdown request is hand-rolled onto a raw socket, so the wire bytes are
/// the only place its framing and credential can be observed.
fn accept_request(listener: &TcpListener) -> String {
    let (mut stream, _) = listener.accept().expect("queued connection");
    let mut request = Vec::new();
    stream.read_to_end(&mut request).expect("request bytes");
    String::from_utf8_lossy(&request).into_owned()
}

#[test]
fn a_local_gateway_is_asked_to_shut_itself_down_with_the_management_key() {
    // given a listener standing in for the local gateway
    let listener = qa_listener();
    let port = listener.local_addr().expect("addr").port();

    // when the desktop asks it to stop
    request_gateway_shutdown(&config_for(
        &format!("http://127.0.0.1:{port}"),
        "console-key",
    ));

    // then it receives one complete, authenticated shutdown request
    let request = accept_request(&listener);
    assert!(
        request.starts_with("POST /v0/management/shutdown HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        request.contains(&format!("Host: 127.0.0.1:{port}\r\n")),
        "{request}"
    );
    assert!(
        request.contains("Authorization: Bearer console-key\r\n"),
        "{request}"
    );
    assert!(request.contains("Content-Length: 0\r\n"), "{request}");
    assert!(request.ends_with("\r\n\r\n"), "{request}");
}

#[test]
fn an_unauthenticated_local_gateway_is_not_sent_an_empty_bearer() {
    // given a listener and a profile with no management key
    let listener = qa_listener();
    let port = listener.local_addr().expect("addr").port();

    // when the desktop asks it to stop
    request_gateway_shutdown(&config_for(&format!("http://127.0.0.1:{port}"), ""));

    // then the request carries no Authorization header at all
    let request = accept_request(&listener);
    assert!(
        request.starts_with("POST /v0/management/shutdown HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        !request.to_ascii_lowercase().contains("authorization"),
        "{request}"
    );
}

#[test]
fn a_remote_or_unparsable_target_is_never_contacted() {
    // given a listener that must stay untouched
    let listener = qa_listener();
    let port = listener.local_addr().expect("addr").port();
    listener.set_nonblocking(true).expect("nonblocking");

    // when the configured gateway is remote, or the url does not parse
    for base_url in [
        format!("http://gateway.example.test:{port}"),
        format!("https://gateway.example.test:{port}"),
        "not a url".to_string(),
    ] {
        request_gateway_shutdown(&config_for(&base_url, "console-key"));

        // then nothing is dispatched to the local port
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "{base_url} must not reach the local gateway"
        );
    }
}

#[test]
fn stopping_a_gateway_the_desktop_does_not_own_is_a_no_op() {
    // given no owned child process
    let process = GatewayProcess::default();
    let listener = qa_listener();
    let port = listener.local_addr().expect("addr").port();
    listener.set_nonblocking(true).expect("nonblocking");
    let config = config_for(&format!("http://127.0.0.1:{port}"), "console-key");

    // when a stop is requested
    let stopped = stop_owned_gateway(&process, Some(&config)).expect("stop");

    // then nothing is signalled and no shutdown is sent to the running gateway
    assert!(!stopped);
    assert_eq!(process.pid(), 0);
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "an unowned gateway must not be shut down"
    );
}

#[test]
fn read_secret_falls_back_to_master_key_only_for_matching_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let backend = secrets::PlainFileBackend::for_path(dir.path().join("secrets.json"));
    let store = DesktopSecretStore::new(backend);
    let config = config_for("http://127.0.0.1:18801", "master-api-key");

    // 1. Same endpoint: falls back to config.api_key
    let matching = read_secret_inner(
        &store,
        &config,
        SecretRequest {
            endpoint: "http://127.0.0.1:18801".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
        },
    )
    .unwrap();
    assert_eq!(matching, Some("master-api-key".into()));

    // 2. Normalized endpoint (trailing slash): also matches and falls back
    let with_slash = read_secret_inner(
        &store,
        &config,
        SecretRequest {
            endpoint: "http://127.0.0.1:18801/".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
        },
    )
    .unwrap();
    assert_eq!(with_slash, Some("master-api-key".into()));

    // 3. Empty endpoint: defaults to config.base_url and falls back
    let empty_ep = read_secret_inner(
        &store,
        &config,
        SecretRequest {
            endpoint: "".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
        },
    )
    .unwrap();
    assert_eq!(empty_ep, Some("master-api-key".into()));

    // 4. Localhost loopback: matches 127.0.0.1 loopback and falls back
    let localhost_ep = read_secret_inner(
        &store,
        &config,
        SecretRequest {
            endpoint: "http://localhost:18801".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
        },
    )
    .unwrap();
    assert_eq!(localhost_ep, Some("master-api-key".into()));

    // 5. Foreign endpoint: must NOT fall back to config.api_key
    let foreign = read_secret_inner(
        &store,
        &config,
        SecretRequest {
            endpoint: "http://127.0.0.1:18861".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
        },
    )
    .unwrap();
    assert_eq!(
        foreign, None,
        "foreign endpoint must not receive the master API key"
    );
}

#[test]
fn migrate_legacy_secret_falls_back_and_persists_only_for_matching_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let backend = secrets::PlainFileBackend::for_path(dir.path().join("secrets.json"));
    let store = DesktopSecretStore::new(backend);
    let config = config_for("http://127.0.0.1:18801", "master-api-key");

    // Foreign endpoint migration with no legacy key must NOT persist master key to foreign endpoint
    let foreign_outcome = migrate_legacy_secret_inner(
        &store,
        &config,
        MigrateLegacySecretRequest {
            endpoint: "http://127.0.0.1:18861".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
            legacy_value: None,
        },
    )
    .unwrap();
    assert_eq!(foreign_outcome.value, None);
    assert!(!foreign_outcome.reconnect);

    // Matching endpoint migration falls back and writes to the store
    let matching_outcome = migrate_legacy_secret_inner(
        &store,
        &config,
        MigrateLegacySecretRequest {
            endpoint: "http://127.0.0.1:18801".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
            legacy_value: None,
        },
    )
    .unwrap();
    assert_eq!(matching_outcome.value, Some("master-api-key".into()));
    assert!(matching_outcome.reconnect);

    // Empty endpoint migration defaults to config.base_url and reads the already persisted key
    let empty_outcome = migrate_legacy_secret_inner(
        &store,
        &config,
        MigrateLegacySecretRequest {
            endpoint: "".into(),
            profile: "default".into(),
            kind: secrets::SecretKind::ManagementKey,
            legacy_value: None,
        },
    )
    .unwrap();
    assert_eq!(empty_outcome.value, Some("master-api-key".into()));
}

#[cfg(unix)]
static EXIT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(unix)]
#[test]
fn stop_during_backoff_finishes_old_watchdog_before_replacement() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::Ordering;
    let _lock = EXIT_TEST_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("fake-gateway");
    std::fs::write(
        &binary,
        "#!/bin/sh\nprintf 'spawned\\n' >> \"$AUTH_DIR/spawns\"\nexit 17\n",
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let process = GatewayProcess::default();
    let (backoff_tx, backoff_rx) = std::sync::mpsc::channel();
    *process.backoff_observer.lock().unwrap() = Some(backoff_tx);
    for expected in 1..=2 {
        crate::spawn_gateway_child(&process, &binary, dir.path(), 18849).unwrap();
        backoff_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(process.pid(), 0);
        let gate = process
            .lifecycle
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .gate
            .clone();
        assert!(!stop_owned_gateway(&process, None).unwrap());
        assert!(process.lifecycle.lock().unwrap().is_none());
        assert!(gate
            .run(|| panic!("old generation authorized a launch"))
            .is_none());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("spawns"))
                .unwrap()
                .lines()
                .count(),
            expected
        );
        assert_eq!(crate::GATEWAY_CHILD_PID.load(Ordering::SeqCst), 0);
    }
    dir.close().unwrap();
}

#[test]
fn cancellation_serializes_with_spawn_authorization() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let gate = Arc::new(crate::gateway_process::SpawnGate::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (cancelled_tx, cancelled_rx) = mpsc::channel();
    let launching = gate.clone();
    let launch = std::thread::spawn(move || {
        launching.run(|| {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            1
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let cancelling = gate.clone();
    let cancel = std::thread::spawn(move || {
        cancelling.cancel();
        cancelled_tx.send(()).unwrap();
    });
    assert!(matches!(
        cancelled_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_tx.send(()).unwrap();
    cancelled_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(launch.join().unwrap(), Some(1));
    cancel.join().unwrap();
    assert!(gate
        .run(|| panic!("cancelled generation launched"))
        .is_none());
    assert!(!gate.wait(Duration::from_secs(60)));
}

#[test]
fn windows_listener_ownership_requires_exact_port_state_and_pid() {
    let output = "Active Connections\n\
      Proto Local Address Foreign Address State PID\n\
      TCP 127.0.0.1:18849 0.0.0.0:0 LISTENING 42\n\
      TCP [::1]:18849 [::]:0 LISTENING 43\n\
      TCP 0.0.0.0:18849 0.0.0.0:0 LISTENING 44\n\
      TCP [::]:18849 [::]:0 LISTENING 45\n\
      TCP 127.0.0.1:18848 0.0.0.0:0 LISTENING 46\n\
      TCP 127.0.0.1:18849 127.0.0.1:50000 ESTABLISHED 47\n\
      TCP 192.0.2.1:18849 0.0.0.0:0 LISTENING 48\n\
      UDP 127.0.0.1:18849 *:* LISTENING 49\n\
      TCP 127.0.0.1:18849 0.0.0.0:0 LISTENING invalid\n";
    assert_eq!(crate::windows_listener_pids(output, 18849), vec![42, 43, 44, 45]);
    assert!(crate::windows_listener_pids(output, 18850).is_empty());
}

#[test]
fn listener_discovery_identifies_the_actual_owner() {
    let listener = qa_listener();
    let port = listener.local_addr().unwrap().port();
    assert!(crate::listener_pids_for(port).contains(&(std::process::id() as i32)));
}

#[test]
fn manual_start_rejects_foreign_listener_without_signalling_it() {
    let listener = qa_listener();
    let port = listener.local_addr().unwrap().port();
    let process = GatewayProcess::default();
    let result = crate::start_local_gateway(&process, port, || {
        crate::require_gateway_port(port, Path::new("/nonexistent/owned-fake-gateway"))?;
        panic!("foreign listener must prevent launch")
    });
    assert!(result.is_err());
    assert!(!crate::owned_gateway_ready(&process, port));
    let stream = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    drop(stream);
    assert_eq!(process.pid(), 0);
}

#[tokio::test]
async fn configured_status_uses_configured_http_endpoint_not_local_port() {
    use std::io::{BufRead, Write};
    let listener = qa_listener();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut request = String::new();
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            request.push_str(&line);
        }
        stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        request_tx.send(request).unwrap();
    });
    assert!(
        !crate::configured_gateway_available(&config_for(
            &format!("http://127.0.0.1:{port}/remote"),
            "fixture-key"
        ))
        .await
    );
    let request = request_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(request.starts_with("GET /remote/admin/stats HTTP/1.1\r\n"));
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer fixture-key\r\n"));
    server.join().unwrap();
}

#[test]
fn master_key_bootstrap_propagates_errors_and_preserves_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.yaml");
    for malformed in [
        "api-keys: [unterminated",
        "api-keys: [123]\n",
        "- not-a-mapping\n",
    ] {
        std::fs::write(&path, malformed).unwrap();
        assert!(crate::ensure_master_api_key_at(&path, |_, _| panic!(
            "invalid document reached writer"
        ))
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), malformed);
    }
    let original = "api-keys: [] # empty\nrouting: {strategy: fill-first}\n";
    std::fs::write(&path, original).unwrap();
    let result =
        crate::ensure_master_api_key_at(&path, |_, _| Err("injected write failure".into()));
    assert_eq!(result.unwrap_err(), "injected write failure");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert!(crate::ensure_master_api_key_at(dir.path(), |_, _| panic!(
        "read failure reached writer"
    ))
    .is_err());
    let key = crate::ensure_master_api_key_at(&path, crate::persist_master_config).unwrap();
    let saved = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        crate::tray::extract_first_api_key(&saved).unwrap(),
        Some(key.clone())
    );
    let document: serde_yaml::Value = serde_yaml::from_str(&saved).unwrap();
    assert_eq!(document["routing"]["strategy"].as_str(), Some("fill-first"));
    assert_eq!(
        crate::ensure_master_api_key_at(&path, |_, _| panic!("existing key rewritten")).unwrap(),
        key
    );
    assert!(crate::persist_master_config(dir.path(), "cannot replace a directory").is_err());
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "failed atomic write left staging file"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
    dir.close().unwrap();
}

#[test]
fn stop_owned_gateway_terminates_running_child_and_clears_pid() {
    #[cfg(unix)]
    {
        let _lock = EXIT_TEST_LOCK.lock().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        let (exited_tx, exited_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || exited_tx.send(child.wait()).unwrap());
        let process = GatewayProcess::default();
        process.pid.store(pid, std::sync::atomic::Ordering::SeqCst);
        crate::GATEWAY_CHILD_PID.store(pid, std::sync::atomic::Ordering::SeqCst);

        let stopped = stop_owned_gateway(&process, None).expect("stop");
        assert!(stopped);
        assert_eq!(process.pid(), 0);
        assert_eq!(
            crate::GATEWAY_CHILD_PID.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(!exited_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap()
            .success());
    }
}

#[test]
fn process_exit_guard_terminates_orphaned_gateway_child() {
    #[cfg(unix)]
    {
        let _lock = EXIT_TEST_LOCK.lock().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        let (exited_tx, exited_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || exited_tx.send(child.wait()).unwrap());
        crate::GATEWAY_CHILD_PID.store(pid, std::sync::atomic::Ordering::SeqCst);

        crate::terminate_gateway_on_exit();

        assert_eq!(
            crate::GATEWAY_CHILD_PID.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(!exited_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap()
            .success());
    }
}
