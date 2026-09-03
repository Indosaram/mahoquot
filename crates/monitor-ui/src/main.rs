#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod bootstrap;
mod cli_config;
mod codex_launcher;
mod gateway_process;
#[cfg(test)]
mod lifecycle_tests;
mod notch;
mod os_integration;
mod platform;
mod secrets;
mod self_certification;
mod stats;
mod tray;
#[cfg(test)]
mod tray_tests;
mod tunnel;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use stats::{build_view, fetch_stats, MonitorView};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const MAIN_WINDOW_LABEL: &str = "main";
const NOTCH_WINDOW_LABEL: &str = "notch";
const TRAY_ID: &str = "mahoquot";
const TRAY_PANEL_LABEL: &str = "traypanel";
const PANEL_WIDTH_LOGICAL: f64 = 340.0;
const GATEWAY_PORT: u16 = tray::GATEWAY_PORT;

const LOCAL_GATEWAY_URL: &str = "http://127.0.0.1:18801";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
struct GatewayProcess {
    pid: std::sync::Arc<std::sync::atomic::AtomicI32>,
}

#[derive(Default)]
struct NativeStateObserver(std::sync::Mutex<os_integration::StateObserver>);

#[derive(Clone, Copy)]
struct StartupContext {
    login_start: bool,
}

impl GatewayProcess {
    fn pid(&self) -> i32 {
        self.pid.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayTargetPolicy {
    ManageLocal,
    UseConfigured,
}

fn gateway_target_policy(base_url: &str) -> GatewayTargetPolicy {
    if base_url == LOCAL_GATEWAY_URL {
        GatewayTargetPolicy::ManageLocal
    } else {
        GatewayTargetPolicy::UseConfigured
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReclaimListenerPolicy {
    Terminate,
    Skip,
}

fn reclaim_listener_policy(
    listener_executable: &std::path::Path,
    own_gateway_binary: &std::path::Path,
) -> ReclaimListenerPolicy {
    if listener_executable == own_gateway_binary {
        ReclaimListenerPolicy::Terminate
    } else {
        ReclaimListenerPolicy::Skip
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopSignal {
    Terminate,
    Kill,
}

fn stop_signal_order() -> [StopSignal; 2] {
    [StopSignal::Terminate, StopSignal::Kill]
}

impl StopSignal {
    fn raw(self) -> i32 {
        match self {
            Self::Terminate => 15,
            Self::Kill => 9,
        }
    }
}

/// Mirrors the gateway child's pid for the signal path. A SIGTERM/SIGINT never
/// reaches `RunEvent::ExitRequested`, so without this the gateway would outlive
/// the app that owns it and strand the port for the next launch.
static GATEWAY_CHILD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

extern "C" fn terminate_gateway_on_signal(signal: i32) {
    tunnel::terminate_tunnel_on_signal();
    let pid = GATEWAY_CHILD_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 {
        #[cfg(unix)]
        unsafe {
            libc_kill(pid, StopSignal::Terminate.raw());
        }
        #[cfg(windows)]
        unsafe {
            let _ = signal_process_windows(pid);
        }
    }
    unsafe {
        signal_raw(signal, 0);
        raise_raw(signal);
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

// signal/raise exist in both libc and the Windows msvcrt; only kill is
// POSIX-only.
extern "C" {
    #[link_name = "signal"]
    fn signal_raw(sig: i32, handler: usize) -> usize;
    #[link_name = "raise"]
    fn raise_raw(sig: i32) -> i32;
}

#[cfg(windows)]
const PROCESS_TERMINATE: u32 = 0x0001;
#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
#[cfg(windows)]
const WAIT_TIMEOUT: u32 = 258;

#[cfg(windows)]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, pid: u32) -> isize;
    fn TerminateProcess(handle: isize, exit_code: u32) -> i32;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
}

fn install_gateway_signal_guard() {
    unsafe {
        let handler = terminate_gateway_on_signal as *const () as usize;
        signal_raw(15, handler);
        signal_raw(2, handler);
        signal_raw(1, handler);
    }
}

/// Shared source of truth for the notch's expanded state: the native hover
/// watcher and the `expand_notch`/`collapse_notch` commands both read and
/// write it, so neither can disagree with the other about the window's size.
struct NotchHoverState {
    expanded: std::sync::Arc<std::sync::atomic::AtomicBool>,
    collapse_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    #[cfg(target_os = "macos")]
    last_hit_test_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum GatewayLifecycleStatus {
    Running,
    Stopped,
}

fn gateway_listening() -> bool {
    std::net::TcpStream::connect(("127.0.0.1", GATEWAY_PORT)).is_ok()
}

fn notification_service_status<R: Runtime>(
    app: &AppHandle<R>,
) -> os_integration::NotificationServiceStatus {
    match app.notification().permission_state() {
        Ok(tauri::plugin::PermissionState::Denied) => {
            os_integration::NotificationServiceStatus::PermissionDenied
        }
        Ok(_) => os_integration::NotificationServiceStatus::Available,
        Err(error) => {
            tracing::warn!(%error, "native notification service unavailable");
            os_integration::NotificationServiceStatus::ServiceUnavailable
        }
    }
}

fn emit_observed_state<R: Runtime>(app: &AppHandle<R>, state: os_integration::ObservedState) {
    let observer = app.state::<NativeStateObserver>();
    let event = match observer.0.lock() {
        Ok(mut observer) => observer.observe(state),
        Err(_) => {
            tracing::error!("native state observer lock is poisoned");
            None
        }
    };
    let Some(event) = event else {
        return;
    };
    if notification_service_status(app) != os_integration::NotificationServiceStatus::Available {
        return;
    }
    if let Err(error) = app
        .notification()
        .builder()
        .title(event.title)
        .body(event.body)
        .show()
    {
        tracing::error!(
            category = event.category.as_str(),
            %error,
            "failed to show native notification"
        );
    }
}

fn clear_observed_state<R: Runtime>(app: &AppHandle<R>, state: &os_integration::ObservedState) {
    let observer = app.state::<NativeStateObserver>();
    if let Ok(mut observer) = observer.0.lock() {
        observer.clear(state);
    };
}

fn observe_monitor_view<R: Runtime>(app: &AppHandle<R>, view: &MonitorView) {
    let isolated = view.accounts.iter().find(|account| {
        account.status == "failed"
            && account
                .last_error
                .as_deref()
                .is_some_and(|detail| detail.to_ascii_lowercase().contains("auth"))
    });
    if let Some(account) = isolated {
        emit_observed_state(
            app,
            os_integration::ObservedState::AuthIsolated {
                account: account.id.clone(),
            },
        );
    } else {
        clear_observed_state(
            app,
            &os_integration::ObservedState::AuthIsolated {
                account: String::new(),
            },
        );
    }
}

fn observe_history_health<R: Runtime>(app: &AppHandle<R>, health: &serde_json::Value) {
    let degraded = health
        .get("degraded")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let detail = health
        .get("last-error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Durable request history is degraded.")
        .to_string();
    let state = os_integration::ObservedState::HistoryDegraded { detail };
    if degraded {
        emit_observed_state(app, state);
    } else {
        clear_observed_state(app, &state);
    }
}

fn observe_scheduler_status<R: Runtime>(app: &AppHandle<R>, status: &serde_json::Value) {
    let exhausted = status
        .get("selected")
        .is_some_and(serde_json::Value::is_null)
        && status
            .get("accounts")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|accounts| !accounts.is_empty());
    let state = os_integration::ObservedState::SchedulerAllExhausted;
    if exhausted {
        emit_observed_state(app, state);
    } else {
        clear_observed_state(app, &state);
    }
}

fn start_native_state_observer<R: Runtime>(app: AppHandle<R>) {
    let config = app.state::<Config>();
    let base_url = config.base_url.clone();
    let api_key = config.api_key.clone();
    let client = config.client.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(raw) = fetch_stats(&client, &base_url, &api_key).await {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0);
                observe_monitor_view(&app, &build_view(&raw, now_ms));
            }
            let get_management = |path: &str| {
                client
                    .get(format!("{base_url}/v0/management/{path}"))
                    .bearer_auth(&api_key)
            };
            if let Ok(response) = get_management("scheduler/status").send().await {
                if let Ok(status) = response.json::<serde_json::Value>().await {
                    observe_scheduler_status(&app, &status);
                }
            }
            if let Ok(response) = get_management("history/health").send().await {
                if let Ok(health) = response.json::<serde_json::Value>().await {
                    observe_history_health(&app, &health);
                }
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

fn wait_until(timeout: Duration, mut finished: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if finished() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL.min(deadline - now));
    }
}

#[cfg(unix)]
fn process_is_running(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    let result = unsafe { libc_kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(3)
}

/// Windows has no POSIX signals: "is running" probes the process handle and
/// any stop signal degrades to TerminateProcess, which is the only
/// termination mechanism the OS offers an external process.
#[cfg(windows)]
fn process_is_running(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle == 0 {
            return false;
        }
        let state = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        state == WAIT_TIMEOUT
    }
}

#[cfg(windows)]
fn signal_process_windows(pid: i32) -> Result<(), String> {
    if pid <= 1 {
        return Err("refusing to signal pid {pid}".replace("{pid}", &pid.to_string()));
    }
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
        if handle == 0 {
            return Err(format!("failed to open gateway pid={pid} for termination"));
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        if ok == 0 {
            return Err(format!("failed to terminate gateway pid={pid}"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn signal_process(pid: i32, signal: StopSignal) -> Result<(), String> {
    if unsafe { libc_kill(pid, signal.raw()) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(3) {
        Ok(())
    } else {
        Err(format!(
            "failed to send signal {} to gateway pid={pid}: {error}",
            signal.raw()
        ))
    }
}

#[cfg(windows)]
fn signal_process(pid: i32, _signal: StopSignal) -> Result<(), String> {
    signal_process_windows(pid)
}

fn terminate_process(
    pid: i32,
    timeout: Duration,
    mut stopped: impl FnMut() -> bool,
) -> Result<(), String> {
    for signal in stop_signal_order() {
        signal_process(pid, signal)?;
        if wait_until(timeout, &mut stopped) {
            return Ok(());
        }
    }
    Err(format!("gateway pid={pid} did not exit after SIGKILL"))
}

fn listener_pids() -> Vec<i32> {
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-tnP", &format!("-iTCP:{GATEWAY_PORT}"), "-sTCP:LISTEN"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1)
        .collect()
}

fn listener_executable_path(pid: i32) -> Option<std::path::PathBuf> {
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "txt", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .map(std::path::PathBuf::from)
}

fn gateway_binary_launchable(path: &std::path::Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Frees the gateway port only when the listener is an orphan of the exact
/// gateway binary this app is about to launch. Foreign listeners are never
/// signalled.
fn reclaim_gateway_port(own_gateway_binary: &std::path::Path) -> bool {
    for pid in listener_pids() {
        let Some(listener_binary) = listener_executable_path(pid) else {
            tracing::warn!(
                pid,
                "skipping gateway port listener with unknown executable"
            );
            continue;
        };
        let listener_binary = std::fs::canonicalize(&listener_binary).unwrap_or(listener_binary);
        if reclaim_listener_policy(&listener_binary, own_gateway_binary)
            == ReclaimListenerPolicy::Skip
        {
            tracing::warn!(
                pid,
                executable = %listener_binary.display(),
                "skipping foreign gateway port listener"
            );
            continue;
        }
        tracing::info!(pid, "reclaiming gateway port from orphan");
        if let Err(error) =
            terminate_process(pid, GATEWAY_STOP_TIMEOUT, || !process_is_running(pid))
        {
            tracing::error!(pid, %error, "failed to reclaim gateway port");
        }
    }
    !gateway_listening()
}

fn clear_gateway_pid(process_pid: &std::sync::atomic::AtomicI32, pid: i32) {
    let _ = process_pid.compare_exchange(
        pid,
        0,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::SeqCst,
    );
    let _ = GATEWAY_CHILD_PID.compare_exchange(
        pid,
        0,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::SeqCst,
    );
}

fn spawn_gateway(process: &GatewayProcess, base_url: &str) -> Option<i32> {
    if gateway_target_policy(base_url) == GatewayTargetPolicy::UseConfigured {
        return None;
    }
    let exe = std::env::current_exe().ok();
    let bin =
        tray::resolve_gateway_binary(std::env::var("MAHOQUOT_GATEWAY_BIN").ok(), exe.as_deref())?;
    if !gateway_binary_launchable(&bin) {
        tracing::error!(path = %bin.display(), "gateway binary unavailable");
        return None;
    }
    let own_gateway_binary = std::fs::canonicalize(&bin).unwrap_or_else(|_| bin.clone());
    if gateway_listening() && !reclaim_gateway_port(&own_gateway_binary) {
        tracing::warn!("gateway port is occupied by a listener this app does not own");
        return None;
    }

    let auth_dir =
        tray::default_auth_dir(&std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    match std::process::Command::new(&bin)
        .env("AUTH_DIR", auth_dir)
        .spawn()
    {
        Ok(mut child) => {
            let pid = child.id() as i32;
            tracing::info!(pid, "mahoquot-gateway spawned");
            process.pid.store(pid, std::sync::atomic::Ordering::SeqCst);
            GATEWAY_CHILD_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
            install_gateway_signal_guard();
            let process_pid = std::sync::Arc::clone(&process.pid);
            std::thread::spawn(move || {
                let result = child.wait();
                clear_gateway_pid(&process_pid, pid);
                match result {
                    Ok(status) => tracing::info!(pid, %status, "mahoquot-gateway exited"),
                    Err(error) => {
                        tracing::error!(pid, %error, "failed to harvest mahoquot-gateway");
                    }
                }
            });
            Some(pid)
        }
        Err(error) => {
            tracing::error!(%error, "failed to spawn mahoquot-gateway");
            None
        }
    }
}

fn wait_for_gateway_ready(process: &GatewayProcess) -> bool {
    wait_until(GATEWAY_READY_TIMEOUT, || {
        gateway_listening() || process.pid() <= 1
    }) && gateway_listening()
}

fn request_gateway_shutdown(config: &Config) {
    let Ok(url) = reqwest::Url::parse(&config.base_url) else {
        return;
    };
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return;
    }
    let Some(port) = url.port_or_known_default() else {
        return;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    ) else {
        return;
    };
    let authorization = if config.api_key.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {}\r\n", config.api_key)
    };
    let request = format!(
        "POST /v0/management/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{authorization}Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = std::io::Write::write_all(&mut stream, request.as_bytes());
}

fn stop_owned_gateway(process: &GatewayProcess, config: Option<&Config>) -> Result<bool, String> {
    let pid = process.pid();
    if pid <= 1 {
        return Ok(false);
    }
    if let Some(config) = config {
        request_gateway_shutdown(config);
        if wait_until(GATEWAY_STOP_TIMEOUT, || !process_is_running(pid)) {
            clear_gateway_pid(&process.pid, pid);
            return Ok(true);
        }
    }
    terminate_process(pid, GATEWAY_STOP_TIMEOUT, || process.pid() != pid)?;
    clear_gateway_pid(&process.pid, pid);
    Ok(true)
}

#[tauri::command]
fn native_settings_state(
    app: tauri::AppHandle,
    process: tauri::State<'_, GatewayProcess>,
) -> os_integration::NativeSettingsState {
    let login_start_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    os_integration::NativeSettingsState::new(
        gateway_listening() || process.pid() > 1,
        notification_service_status(&app),
    )
    .with_login_start(login_start_enabled)
}

#[tauri::command]
fn set_login_start(
    app: tauri::AppHandle,
    process: tauri::State<'_, GatewayProcess>,
    enabled: bool,
) -> Result<os_integration::NativeSettingsState, String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())?;
    Ok(os_integration::NativeSettingsState::new(
        gateway_listening() || process.pid() > 1,
        notification_service_status(&app),
    )
    .with_login_start(enabled))
}

#[tauri::command]
fn request_notification_permission(
    app: tauri::AppHandle,
    process: tauri::State<'_, GatewayProcess>,
) -> os_integration::NativeSettingsState {
    let status = match app.notification().request_permission() {
        Ok(tauri::plugin::PermissionState::Denied) => {
            os_integration::NotificationServiceStatus::PermissionDenied
        }
        Ok(_) => os_integration::NotificationServiceStatus::Available,
        Err(error) => {
            tracing::warn!(%error, "native notification permission request failed");
            os_integration::NotificationServiceStatus::ServiceUnavailable
        }
    };
    os_integration::NativeSettingsState::new(gateway_listening() || process.pid() > 1, status)
        .with_login_start(app.autolaunch().is_enabled().unwrap_or(false))
}

#[derive(serde::Serialize)]
struct UpdateStatus {
    available: bool,
    version: Option<String>,
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(UpdateStatus {
        available: update.is_some(),
        version: update.map(|item| item.version),
    })
}

#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    gateway: tauri::State<'_, GatewayProcess>,
    config: tauri::State<'_, Config>,
) -> Result<(), String> {
    if gateway_target_policy(&config.base_url) != GatewayTargetPolicy::ManageLocal {
        return Err("updates require the desktop-owned local gateway profile".into());
    }
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no signed update is available".to_string())?;
    stop_owned_gateway(&gateway, Some(&config)).map_err(|error| error.to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

#[tauri::command]
fn tunnel_status(manager: tauri::State<'_, tunnel::TunnelManager>) -> tunnel::TunnelStatus {
    manager.status()
}

#[tauri::command]
async fn download_cloudflared(
    manager: tauri::State<'_, tunnel::TunnelManager>,
) -> Result<tunnel::TunnelStatus, String> {
    tunnel::download_cloudflared(&tunnel::default_cloudflared_path()).await?;
    Ok(manager.status())
}

#[tauri::command]
fn start_tunnel(
    app: tauri::AppHandle,
    manager: tauri::State<'_, tunnel::TunnelManager>,
    config: tauri::State<'_, Config>,
) -> Result<tunnel::TunnelStatus, String> {
    match manager.start(&config.base_url) {
        Ok(status) => {
            clear_observed_state(
                &app,
                &os_integration::ObservedState::TunnelFailed {
                    detail: String::new(),
                },
            );
            Ok(status)
        }
        Err(error) => {
            emit_observed_state(
                &app,
                os_integration::ObservedState::TunnelFailed {
                    detail: error.clone(),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn stop_tunnel(
    manager: tauri::State<'_, tunnel::TunnelManager>,
) -> Result<tunnel::TunnelStatus, String> {
    manager.stop()
}

#[tauri::command]
async fn list_codex_instances(
    launcher: tauri::State<'_, codex_launcher::CodexLauncher>,
    config: tauri::State<'_, Config>,
) -> Result<Vec<codex_launcher::CodexInstance>, String> {
    let _ = launcher.reap();
    let instances = launcher.instances();
    for instance in instances
        .iter()
        .filter(|instance| instance.state == codex_launcher::InstanceState::Crashed)
    {
        let _ = scheduler_reservation(
            &config,
            reqwest::Method::DELETE,
            &format!(
                "/management/scheduler/reservations/{}",
                instance.instance_id
            ),
            None,
        )
        .await;
    }
    Ok(instances)
}

#[tauri::command]
async fn launch_codex_instance(
    launcher: tauri::State<'_, codex_launcher::CodexLauncher>,
    config: tauri::State<'_, Config>,
    request: codex_launcher::CodexLaunchRequest,
) -> Result<codex_launcher::CodexInstance, String> {
    scheduler_reservation(
        &config,
        reqwest::Method::POST,
        "/management/scheduler/reservations",
        Some(serde_json::json!({ "instance_id": request.instance_id, "account_id": request.account_id })),
    )
    .await?;
    match launcher.launch(request.clone()) {
        Ok(instance) => Ok(instance),
        Err(error) => {
            let _ = scheduler_reservation(
                &config,
                reqwest::Method::DELETE,
                &format!("/management/scheduler/reservations/{}", request.instance_id),
                None,
            )
            .await;
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn stop_codex_instance(
    launcher: tauri::State<'_, codex_launcher::CodexLauncher>,
    config: tauri::State<'_, Config>,
    instance_id: String,
) -> Result<Vec<codex_launcher::CodexInstance>, String> {
    launcher
        .stop(&instance_id)
        .map_err(|error| error.to_string())?;
    scheduler_reservation(
        &config,
        reqwest::Method::DELETE,
        &format!("/management/scheduler/reservations/{instance_id}"),
        None,
    )
    .await?;
    Ok(launcher.instances())
}

async fn scheduler_reservation(
    config: &Config,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut request = config
        .client
        .request(method, format!("{}{path}", config.base_url))
        .bearer_auth(&config.api_key);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("scheduler reservation failed ({status}): {body}"))
    }
}

#[tauri::command]
fn gateway_status() -> GatewayLifecycleStatus {
    if gateway_listening() {
        GatewayLifecycleStatus::Running
    } else {
        GatewayLifecycleStatus::Stopped
    }
}

#[tauri::command]
fn start_gateway(
    process: tauri::State<'_, GatewayProcess>,
    config: tauri::State<'_, Config>,
) -> Result<GatewayLifecycleStatus, String> {
    if gateway_target_policy(&config.base_url) == GatewayTargetPolicy::UseConfigured {
        return Err("gateway lifecycle is unavailable for a configured remote URL".to_string());
    }
    if gateway_listening() {
        return Ok(GatewayLifecycleStatus::Running);
    }
    if process.pid() <= 1 {
        spawn_gateway(&process, &config.base_url)
            .ok_or_else(|| "gateway binary unavailable or local port occupied".to_string())?;
    }
    if wait_for_gateway_ready(&process) {
        Ok(GatewayLifecycleStatus::Running)
    } else {
        let _ = stop_owned_gateway(&process, None);
        Err("gateway did not begin listening within 5 seconds".to_string())
    }
}

#[tauri::command]
fn stop_gateway(
    process: tauri::State<'_, GatewayProcess>,
    config: tauri::State<'_, Config>,
) -> Result<GatewayLifecycleStatus, String> {
    let ownership = if process.pid() > 1 {
        gateway_process::GatewayOwnership::OwnedLocal
    } else {
        gateway_process::GatewayOwnership::Remote
    };
    let _shutdown_policy = gateway_process::shutdown_plan(ownership, false);
    if stop_owned_gateway(&process, Some(&config))? {
        tracing::info!("mahoquot-gateway terminated");
    } else if gateway_listening() {
        return Ok(GatewayLifecycleStatus::Running);
    }
    Ok(GatewayLifecycleStatus::Stopped)
}

fn notched_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<tauri::Monitor>> {
    app.primary_monitor()
}

fn position_notch_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let outer = window.outer_size()?;
    position_notch_window_sized(
        app,
        window,
        notch::Size {
            width: f64::from(outer.width) / scale,
            height: f64::from(outer.height) / scale,
        },
    )
}

/// Placement must be derived from the size the window is *becoming*: querying
/// `outer_size()` right after `set_size()` still reports the previous frame, so
/// the notch would be anchored for the old size and then grow off-screen.
fn position_notch_window_sized<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    logical: notch::Size,
) -> tauri::Result<()> {
    // Absolute placement — used only at startup, re-anchor, and display-change
    // paths where the window is hidden or fresh, so the two-step position+size
    // cannot flash. Hover transitions go through set_notch_window_frame instead
    // (single atomic relative setFrame).
    let Some(monitor) = notched_monitor(app)? else {
        return Ok(());
    };
    let scale_factor = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let display = notch::Rect {
        x: f64::from(monitor_position.x) / scale_factor,
        y: f64::from(monitor_position.y) / scale_factor,
        width: f64::from(monitor_size.width) / scale_factor,
        height: f64::from(monitor_size.height) / scale_factor,
    };
    let (x, y) = notch::physical_origin(display, logical, scale_factor);

    window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    window.set_size(LogicalSize::new(logical.width, logical.height))
}

fn toggle_operations_console<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        window.hide()
    } else {
        window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
    };
    if let Err(error) = result {
        tracing::error!(%error, "failed to toggle Mahoquot Operations Console");
    }
}

#[cfg(target_os = "macos")]
fn sync_notch_hover(
    app: &AppHandle,
    expanded: &std::sync::atomic::AtomicBool,
    collapse_pending: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    generation: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    last_hit_test_ms: &std::sync::Arc<std::sync::atomic::AtomicU64>,
) {
    use std::sync::atomic::Ordering;

    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Some(rect) = platform::notch_screen_rect(&window) else {
        return;
    };
    let cursor = platform::cursor_location();
    let displays = display_logical_bounds(app);
    // Tolerance of 4.0 logical pixels accounts for fractional scaling / AppKit coordinate rounding
    if !notch::notch_is_right_anchored_any_display(&rect, &displays, 4.0) {
        // The window drifted off its target display edge (monitor unplugged,
        // resolution or arrangement changed, or stranded in the center after resize).
        // Re-anchor it and skip hover for this sample: the frame reported next will be docked.
        if let Err(error) = position_notch_window(app, &window) {
            tracing::warn!(%error, "failed to re-anchor misplaced notch");
        }
        return;
    }
    let was_open = expanded.load(Ordering::Relaxed);
    let was_pending = collapse_pending.load(Ordering::Relaxed);
    let inside = notch::hover_cursor_inside(
        &rect,
        displays
            .iter()
            .find(|display| notch::rects_overlap(&rect, display)),
        &cursor,
        was_open,
    );
    if was_open {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64);
        // Only advance the throttle when a hit test is actually forwarded.
        // Updating it on every sample would reset the window each time the
        // pointer moves, keeping the gate closed forever during motion.
        let previous_ms = last_hit_test_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(previous_ms) >= 16 {
            last_hit_test_ms.store(now_ms, Ordering::Relaxed);
            // wry's WKWebView builds its own tracking areas, which stay silent while
            // another app is frontmost, so the webview can never hit-test the icons
            // itself. Forward the pointer the global monitor can still see.
            if let Some(point) = notch::cursor_to_window_local(&rect, &cursor) {
                let _ = window.eval(format!(
                    "window.dispatchEvent(new CustomEvent('mahoquot:notch-cursor',{{detail:{{x:{},y:{}}}}}));",
                    point.x, point.y
                ));
            } else {
                let _ = window.eval(
                    "window.dispatchEvent(new CustomEvent('mahoquot:notch-cursor',{detail:null}));",
                );
            }
        }
    }
    match tray::brink_hover_intent(was_open, was_pending, inside) {
        tray::HoverIntent::Expand => {
            collapse_pending.store(false, Ordering::Relaxed);
            generation.fetch_add(1, Ordering::Relaxed);
            expanded.store(true, Ordering::Relaxed);
            resize_notch(app, notch::EXPANDED.width, notch::EXPANDED.height);
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:true}));",
            );
            tracing::debug!(
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                cursor.x,
                cursor.y,
                "notch hover open=true"
            );
        }
        tray::HoverIntent::ScheduleCollapse => {
            collapse_pending.store(false, Ordering::Relaxed);
            let scheduled_generation = generation.fetch_add(1, Ordering::Relaxed) + 1;
            expanded.store(false, Ordering::Relaxed);
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:false}));",
            );
            tracing::debug!("notch hover open=false immediate=true");
            let app = app.clone();
            let state = app.state::<NotchHoverState>();
            let expanded = state.expanded.clone();
            let generation = state.generation.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let current = generation.load(Ordering::Relaxed);
                if tray::should_apply_delayed_collapse(
                    scheduled_generation,
                    current,
                    expanded.load(Ordering::Relaxed),
                ) {
                    resize_notch(&app, notch::COMPACT.width, notch::COMPACT.height);
                }
            });
        }
        tray::HoverIntent::CancelCollapse => {
            collapse_pending.store(false, Ordering::Relaxed);
            generation.fetch_add(1, Ordering::Relaxed);
        }
        tray::HoverIntent::None => {}
    }
}

/// Logical bounds of every connected display in AppKit screen space (origin
/// bottom-left). Tauri reports physical coordinates with a top-left origin;
/// positions only flip vertically, so each monitor's y range survives a
/// straight scale division untouched.
#[cfg(target_os = "macos")]
fn display_logical_bounds(app: &AppHandle) -> Vec<notch::Rect> {
    let monitors = app.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            notch::Rect {
                x: f64::from(position.x) / scale,
                y: f64::from(position.y) / scale,
                width: f64::from(size.width) / scale,
                height: f64::from(size.height) / scale,
            }
        })
        .collect()
}

fn toggle_notch_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        window.hide()
    } else {
        if let Err(error) = platform::ensure_session_supported() {
            tracing::error!(code = %error.code, message = %error.message, "session unsupported");
            return;
        }
        window.show().and_then(|_| {
            platform::apply_menu_bar_level(&window);
            position_notch_window(app, &window)
        })
    };
    if let Err(error) = result {
        tracing::error!(%error, "failed to toggle Mahoquot notch window");
    }
}

fn resize_notch<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(current) = window.outer_size() {
        let logical = current.to_logical::<f64>(scale);
        if (logical.width - width).abs() < 1.0 && (logical.height - height).abs() < 1.0 {
            return;
        }
    }
    let target = notch::Size { width, height };
    // Hover expand/collapse must be atomic: a position call sized for the
    // target followed by a resize composited the small strip at the expanded
    // anchor for a frame (the black-line flash). The relative setFrame slides
    // the window in one transaction instead.
    if let Err(error) = platform::set_notch_window_frame(app, &window, NOTCH_WINDOW_LABEL, target) {
        tracing::error!(%error, "failed to resize notch window");
    }
    tracing::debug!(width, height, scale, "notch resized");
}

#[tauri::command]
fn expand_notch(app: tauri::AppHandle, state: tauri::State<'_, NotchHoverState>) {
    state
        .collapse_pending
        .store(false, std::sync::atomic::Ordering::Relaxed);
    state
        .expanded
        .store(true, std::sync::atomic::Ordering::Relaxed);
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    resize_notch(&app, notch::EXPANDED.width, notch::EXPANDED.height);
}

#[tauri::command]
fn collapse_notch(app: tauri::AppHandle, state: tauri::State<'_, NotchHoverState>) {
    state
        .collapse_pending
        .store(false, std::sync::atomic::Ordering::Relaxed);
    state
        .expanded
        .store(false, std::sync::atomic::Ordering::Relaxed);
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    resize_notch(&app, notch::COMPACT.width, notch::COMPACT.height);
}

fn refresh_windows<R: Runtime>(app: &AppHandle<R>) {
    for label in [MAIN_WINDOW_LABEL, NOTCH_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.eval("window.location.reload()") {
                tracing::error!(label, %error, "failed to refresh Mahoquot window");
            }
        }
    }
}

fn handle_tray_action<R: Runtime>(app: &AppHandle<R>, action: tray::TrayMenuAction) {
    match action {
        tray::TrayMenuAction::ToggleNotch => toggle_notch_window(app),
        tray::TrayMenuAction::RefreshUsage => refresh_windows(app),
        tray::TrayMenuAction::ToggleConsole => toggle_operations_console(app),
        tray::TrayMenuAction::Quit => app.exit(0),
    }
}

fn toggle_tray_panel<R: Runtime>(
    app: &AppHandle<R>,
    icon_x: f64,
    icon_y: f64,
    icon_width: f64,
    icon_height: f64,
) {
    let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }

    let scale = panel.scale_factor().unwrap_or(1.0);
    let panel_width = (PANEL_WIDTH_LOGICAL * scale).round();
    let icon_right = icon_x + icon_width;
    let below_icon = icon_y + icon_height + 6.0;
    let x = (icon_right - panel_width).max(icon_x);
    let y = below_icon;
    panel
        .set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ))
        .map_err(|error| tracing::error!(%error, "failed to position tray panel"))
        .ok();
    let _ = panel.show();
    let _ = panel.set_focus();
}

/// Rebuilds the tray menu with one live quota line per reporting account.
fn initialize_native_ui(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(
        app,
        tray::MENU_ID_TOGGLE,
        "Show / Hide Mahoquot Notch",
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        tray::MENU_ID_REFRESH,
        "Refresh Usage",
        true,
        None::<&str>,
    )?;
    let gateway = MenuItem::with_id(
        app,
        tray::MENU_ID_GATEWAY,
        "Show / Hide Operations Console",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, tray::MENU_ID_QUIT, "Quit Mahoquot", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &refresh, &gateway, &separator, &quit])?;

    let mut tray_icon = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("mahoquot")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(action) = tray::resolve_tray_menu_action(event.id().as_ref()) {
                handle_tray_action(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let (icon_x, icon_y) = match rect.position {
                    tauri::Position::Physical(point) => (point.x as f64, point.y as f64),
                    tauri::Position::Logical(point) => (point.x, point.y),
                };
                let (icon_width, icon_height) = match rect.size {
                    tauri::Size::Physical(size) => (size.width as f64, size.height as f64),
                    tauri::Size::Logical(size) => (size.width, size.height),
                };
                toggle_tray_panel(tray.app_handle(), icon_x, icon_y, icon_width, icon_height);
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_icon = tray_icon.icon(icon).icon_as_template(false);
    }
    tray_icon.build(app)?;

    #[cfg(target_os = "macos")]
    platform::apply_dock_icon();

    platform::ensure_session_supported()
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let notch = app
        .get_webview_window(NOTCH_WINDOW_LABEL)
        .ok_or("missing notch window")?;
    position_notch_window(app.handle(), &notch)?;
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        return Err("missing main window".into());
    }

    // Layer-shell init must happen BEFORE the window is realized: show()
    // first would map the notch as a plain toplevel and the layer-shell
    // initialization would fail silently.
    platform::apply_menu_bar_level(&notch);
    let _ = notch.show();
    position_notch_window(app.handle(), &notch)?;
    let handle = app.handle().clone();
    let notch_clone = notch.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Err(error) = position_notch_window(&handle, &notch_clone) {
            tracing::error!(%error, "delayed notch positioning failed");
            return;
        }
        if let Ok(position) = notch_clone.outer_position() {
            tracing::debug!(position.x, position.y, "notch position settled");
        }
        #[cfg(target_os = "macos")]
        if let Some(rect) = platform::notch_screen_rect(&notch_clone) {
            tracing::debug!(
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                "notch hover target rect"
            );
        }
    });

    platform::start_notch_hover_watch(app.handle(), &app.state::<NotchHoverState>());
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    if let Some(output) = std::env::var_os("MAHOQUOT_NATIVE_CERTIFY") {
        self_certification::schedule(app.handle(), std::path::PathBuf::from(output));
    } else {
        start_native_state_observer(app.handle().clone());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        start_native_state_observer(app.handle().clone());
    }

    tracing::info!(
        windows = format!("{MAIN_WINDOW_LABEL},{NOTCH_WINDOW_LABEL}"),
        "mahoquot-monitor-ready"
    );
    Ok(())
}

struct Config {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

type DesktopSecretStore = secrets::SecretStore<secrets::PlainFileBackend>;
type DesktopCliConfig = std::sync::Mutex<cli_config::CliConfigManager>;

fn cli_config_manager<'a>(
    state: &'a tauri::State<'a, DesktopCliConfig>,
) -> Result<std::sync::MutexGuard<'a, cli_config::CliConfigManager>, cli_config::CliConfigError> {
    state.lock().map_err(|_| cli_config::CliConfigError {
        kind: cli_config::CliConfigErrorKind::State,
        message: "CLI configuration manager lock is poisoned".to_string(),
    })
}

#[tauri::command]
fn list_cli_agents(
    state: tauri::State<'_, DesktopCliConfig>,
) -> Result<Vec<cli_config::CliAgentStatus>, cli_config::CliConfigError> {
    cli_config_manager(&state)?.inspect_all()
}

#[tauri::command]
fn preview_cli_agent(
    state: tauri::State<'_, DesktopCliConfig>,
    request: cli_config::ConfigureCliAgentRequest,
) -> Result<cli_config::CliConfigPreview, cli_config::CliConfigError> {
    cli_config_manager(&state)?.preview(request)
}

#[tauri::command]
fn configure_cli_agent(
    state: tauri::State<'_, DesktopCliConfig>,
    request: cli_config::ConfigureCliAgentRequest,
) -> Result<cli_config::CliAgentActionResult, cli_config::CliConfigError> {
    cli_config_manager(&state)?.configure(request)
}

#[tauri::command]
fn restore_cli_agent(
    state: tauri::State<'_, DesktopCliConfig>,
    agent_id: cli_config::CliAgentId,
) -> Result<cli_config::CliAgentActionResult, cli_config::CliConfigError> {
    cli_config_manager(&state)?.restore(agent_id)
}

fn secret_ref(endpoint: &str, profile: &str, kind: secrets::SecretKind) -> secrets::SecretRef {
    secrets::SecretRef::new(endpoint, profile, kind)
}

#[derive(serde::Deserialize)]
struct SecretRequest {
    endpoint: String,
    profile: String,
    kind: secrets::SecretKind,
}

#[derive(serde::Deserialize)]
struct WriteSecretRequest {
    endpoint: String,
    profile: String,
    kind: secrets::SecretKind,
    value: String,
}

#[derive(serde::Deserialize)]
struct MigrateLegacySecretRequest {
    endpoint: String,
    profile: String,
    kind: secrets::SecretKind,
    legacy_value: Option<String>,
}

#[tauri::command]
fn read_secret(
    store: tauri::State<'_, DesktopSecretStore>,
    config: tauri::State<'_, Config>,
    request: SecretRequest,
) -> Result<Option<String>, secrets::SecretStoreError> {
    if let Some(val) = store.read(&secret_ref(
        &request.endpoint,
        &request.profile,
        request.kind,
    ))? {
        return Ok(Some(val));
    }
    if request.kind == secrets::SecretKind::ManagementKey && !config.api_key.is_empty() {
        return Ok(Some(config.api_key.clone()));
    }
    Ok(None)
}

#[tauri::command]
fn write_secret(
    store: tauri::State<'_, DesktopSecretStore>,
    request: WriteSecretRequest,
) -> Result<(), secrets::SecretStoreError> {
    store.write(
        &secret_ref(&request.endpoint, &request.profile, request.kind),
        &request.value,
    )
}

#[tauri::command]
fn delete_secret(
    store: tauri::State<'_, DesktopSecretStore>,
    request: SecretRequest,
) -> Result<(), secrets::SecretStoreError> {
    store.delete(&secret_ref(
        &request.endpoint,
        &request.profile,
        request.kind,
    ))
}

#[tauri::command]
fn migrate_legacy_secret(
    store: tauri::State<'_, DesktopSecretStore>,
    config: tauri::State<'_, Config>,
    request: MigrateLegacySecretRequest,
) -> Result<secrets::MigrationOutcome, secrets::SecretStoreError> {
    let outcome = store.migrate_legacy(
        &secret_ref(&request.endpoint, &request.profile, request.kind),
        request.legacy_value.as_deref(),
    )?;

    if outcome.value.is_some() {
        return Ok(outcome);
    }

    // If no secret was saved in keychain or legacy storage, fall back to the
    // master API key configured for this gateway so the UI is automatically unlocked.
    if request.kind == secrets::SecretKind::ManagementKey && !config.api_key.is_empty() {
        let master = &config.api_key;
        let _ = store.write(
            &secret_ref(&request.endpoint, &request.profile, request.kind),
            master,
        );
        return Ok(secrets::MigrationOutcome {
            value: Some(master.clone()),
            remove_legacy: false,
            reconnect: true,
        });
    }

    Ok(outcome)
}

#[tauri::command]
async fn load_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, Config>,
) -> Result<MonitorView, String> {
    let raw = fetch_stats(&state.client, &state.base_url, &state.api_key).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let view = build_view(&raw, now_ms);
    observe_monitor_view(&app, &view);
    Ok(view)
}

#[tauri::command]
fn gateway_url(state: tauri::State<'_, Config>) -> String {
    state.base_url.clone()
}

#[tauri::command]
fn open_console(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|error| format!("invalid external URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("only https external URLs are allowed".to_string());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|error| format!("failed to open browser: {error}"))?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

async fn post_admin(cfg: &Config, path: &str) -> Result<serde_json::Value, String> {
    let resp = cfg
        .client
        .post(format!("{}{path}", cfg.base_url))
        .bearer_auth(&cfg.api_key)
        .timeout(std::time::Duration::from_secs(240))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("http {status}")))
    }
}

/// Spend one reset credit to clear an account's 5h window from the app.
#[tauri::command]
async fn reset_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/reset")).await
}

#[tauri::command]
async fn warm_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/warmup")).await
}

#[tauri::command]
async fn warm_all(state: tauri::State<'_, Config>) -> Result<serde_json::Value, String> {
    post_admin(&state, "/admin/warmup").await
}

#[tauri::command]
async fn refresh_usage(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    post_admin(&state, "/admin/usage/refresh").await?;
    let raw = fetch_stats(&state.client, &state.base_url, &state.api_key).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok(build_view(&raw, now_ms))
}

fn extract_first_api_key(yaml: &str) -> Option<String> {
    let mut in_keys = false;
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("api-keys:") {
            in_keys = true;
            if let Some(rest) = trimmed.strip_prefix("api-keys:").map(str::trim) {
                if rest.starts_with('[') && rest.ends_with(']') {
                    let inner = rest[1..rest.len() - 1].trim();
                    let key = inner.trim_matches(|c| c == '\'' || c == '"' || c == ' ');
                    if !key.is_empty() {
                        return Some(key.to_string());
                    }
                }
            }
            continue;
        }
        if in_keys {
            if trimmed.starts_with('-') {
                let key = trimmed
                    .trim_start_matches('-')
                    .trim()
                    .trim_matches(|c| c == '\'' || c == '"');
                if !key.is_empty() {
                    return Some(key.to_string());
                }
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                break;
            }
        }
    }
    None
}

/// Ensure a master API key exists in config.yaml so both local agents and the
/// desktop app can authenticate with the gateway. Returns the master key.
fn ensure_master_api_key() -> String {
    let auth_dir =
        tray::default_auth_dir(&std::env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    let config_path = auth_dir.join("config.yaml");
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Some(key) = extract_first_api_key(&content) {
            return key;
        }
    }

    // Generate a fresh secure master key
    let generated = format!("mq-master-{}", uuid::Uuid::new_v4().simple());
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        let updated = if content.contains("api-keys: []") {
            content.replace("api-keys: []", &format!("api-keys:\n- {generated}"))
        } else if content.contains("api-keys:") {
            content.replace("api-keys:", &format!("api-keys:\n- {generated}"))
        } else {
            format!("{content}\napi-keys:\n- {generated}\n")
        };
        let _ = std::fs::write(&config_path, updated);
    }
    generated
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let base_url = std::env::var("MAHOQUOT_URL").unwrap_or_else(|_| LOCAL_GATEWAY_URL.to_string());
    let gateway = GatewayProcess::default();
    let _ = spawn_gateway(&gateway, &base_url);
    let master_key = ensure_master_api_key();
    let api_key = std::env::var("MAHOQUOT_API_KEY").unwrap_or_else(|_| master_key.clone());
    let init_script = bootstrap::console_initialization_script(&base_url, &api_key);
    let login_start = std::env::args().any(|argument| argument == "--login-start");

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("mahoquot")
                .arg("--login-start")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(gateway)
        .manage(NativeStateObserver::default())
        .manage(StartupContext { login_start })
        .manage(tunnel::TunnelManager::new(
            tunnel::default_cloudflared_path(),
        ))
        .manage(codex_launcher::CodexLauncher::new(
            codex_launcher::default_codex_binary(),
            codex_launcher::default_instance_root(),
        ))
        .manage(secrets::SecretStore::new(secrets::PlainFileBackend))
        .manage(std::sync::Mutex::new(
            cli_config::CliConfigManager::for_current_process(),
        ))
        .manage(NotchHoverState {
            expanded: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            collapse_pending: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            #[cfg(target_os = "macos")]
            last_hit_test_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        })
        .manage(Config {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        })
        .append_invoke_initialization_script(init_script)
        .invoke_handler(tauri::generate_handler![
            load_stats,
            gateway_url,
            open_console,
            open_external_url,
            quit_app,
            gateway_status,
            start_gateway,
            stop_gateway,
            tunnel_status,
            download_cloudflared,
            start_tunnel,
            stop_tunnel,
            list_codex_instances,
            launch_codex_instance,
            stop_codex_instance,
            native_settings_state,
            set_login_start,
            request_notification_permission,
            check_for_update,
            install_update,
            reset_account,
            warm_account,
            warm_all,
            refresh_usage,
            expand_notch,
            collapse_notch,
            list_cli_agents,
            preview_cli_agent,
            configure_cli_agent,
            restore_cli_agent,
            read_secret,
            write_secret,
            delete_secret,
            migrate_legacy_secret
        ])
        .setup(initialize_native_ui)
        .on_window_event(|window, event| {
            if window.label() == NOTCH_WINDOW_LABEL {
                if let tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                    let app = window.app_handle();
                    if let Some(notch_webview) = app.get_webview_window(NOTCH_WINDOW_LABEL) {
                        let _ = position_notch_window(app, &notch_webview);
                    }
                }
            }
            if window.label() == TRAY_PANEL_LABEL {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                }
                if let Err(error) = window.hide() {
                    tracing::error!(label = %window.label(), %error, "failed to hide Mahoquot window");
                }
            }
        })
        .on_page_load(|webview, payload| {
            if webview.label() == MAIN_WINDOW_LABEL
                && payload.event() == tauri::webview::PageLoadEvent::Finished
                && !webview.state::<StartupContext>().login_start
            {
                let window = webview.window();
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build mahoquot monitor");
    // Re-arm after Tauri/AppKit finish installing their own handlers, otherwise
    // ours is overwritten during setup and SIGTERM strands the gateway.
    install_gateway_signal_guard();
    app.run(|app, event| {
        // A macOS Dock click arrives as a Reopen event: reveal the hidden
        // console window so clicking the icon feels like "open the app".
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if crate::self_certification::CERTIFY_IN_FLIGHT
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                // The certification harness is mid-sequence; a window-close
                // exit in headless sessions must not race the report write.
                api.prevent_exit();
                return;
            }
            platform::cleanup_notch_hover_watch(app);
            let tunnel = app.state::<tunnel::TunnelManager>();
            if let Err(error) = tunnel.stop() {
                tracing::error!(%error, "failed to stop cloudflared on exit");
            }
            let codex = app.state::<codex_launcher::CodexLauncher>();
            if let Err(error) = codex.stop_all() {
                tracing::error!(%error, "failed to stop Codex instances on exit");
            }
            let gateway = app.state::<GatewayProcess>();
            let config = app.state::<Config>();
            match stop_owned_gateway(&gateway, Some(&config)) {
                Ok(true) => tracing::info!("mahoquot-gateway terminated"),
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "failed to stop mahoquot-gateway on exit"),
            }
        }
    });
}
