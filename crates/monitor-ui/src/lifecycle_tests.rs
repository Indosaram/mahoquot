use std::io::Read;
use std::net::TcpListener;
use std::path::Path;

use crate::{
    gateway_target_policy, migrate_legacy_secret_inner, read_secret_inner, reclaim_listener_policy,
    request_gateway_shutdown, secrets, stop_owned_gateway, stop_signal_order, Config,
    DesktopSecretStore, GatewayProcess, GatewayTargetPolicy, MigrateLegacySecretRequest,
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
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
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
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
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
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
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
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
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

    // 3. Foreign endpoint: must NOT fall back to config.api_key
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
}
