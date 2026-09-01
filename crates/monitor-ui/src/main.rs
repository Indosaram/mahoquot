#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod bootstrap;
#[cfg(test)]
mod lifecycle_tests;
mod stats;
mod tray;
#[cfg(test)]
mod tray_tests;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use stats::{build_view, fetch_stats, MonitorView};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const NOTCH_WINDOW_LABEL: &str = "notch";
const TRAY_ID: &str = "mahoquot";
const TRAY_PANEL_LABEL: &str = "traypanel";
const PANEL_WIDTH_LOGICAL: f64 = 340.0;
const NOTCH_EXPANDED_WIDTH: f64 = 420.0;
const NOTCH_EXPANDED_HEIGHT: f64 = 560.0;
const NOTCH_COMPACT_WIDTH: f64 = 8.0;
const NOTCH_COMPACT_HEIGHT: f64 = 180.0;
const NOTCH_VERTICAL_OFFSET: f64 = 0.0;
const GATEWAY_PORT: u16 = tray::GATEWAY_PORT;

// NSStatusWindowLevel: floats above regular windows and the menu bar extras.
#[cfg(target_os = "macos")]
const NS_STATUS_WINDOW_LEVEL: i64 = 25;
// NSWindowCollectionBehaviorCanJoinAllSpaces | Stationary: follows space
// switches instead of being stranded on the space where it was created.
#[cfg(target_os = "macos")]
const NS_WINDOW_BEHAVIOR_ALL_SPACES_STATIONARY: i64 = (1 << 0) | (1 << 8);

const LOCAL_GATEWAY_URL: &str = "http://127.0.0.1:18801";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
struct GatewayProcess {
    pid: std::sync::Arc<std::sync::atomic::AtomicI32>,
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
    let pid = GATEWAY_CHILD_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc_kill(pid, StopSignal::Terminate.raw());
        }
    }
    unsafe {
        signal_raw(signal, 0);
        raise_raw(signal);
    }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
    #[link_name = "signal"]
    fn signal_raw(sig: i32, handler: usize) -> usize;
    #[link_name = "raise"]
    fn raise_raw(sig: i32) -> i32;
}

fn install_gateway_signal_guard() {
    unsafe {
        signal_raw(15, terminate_gateway_on_signal as usize);
        signal_raw(2, terminate_gateway_on_signal as usize);
        signal_raw(1, terminate_gateway_on_signal as usize);
    }
}

/// Shared source of truth for the notch's expanded state: the native hover
/// watcher and the `expand_notch`/`collapse_notch` commands both read and
/// write it, so neither can disagree with the other about the window's size.
struct NotchHoverState {
    expanded: std::sync::Arc<std::sync::atomic::AtomicBool>,
    collapse_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    last_hit_test_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// Tokens returned by `addGlobal/LocalMonitorForEventsMatchingMask:`, kept so
/// the monitors can be removed (and their blocks released) at exit instead of
/// firing against a half-torn-down app.
#[cfg(target_os = "macos")]
struct NotchHoverMonitors(std::sync::Mutex<[*mut objc::runtime::Object; 2]>);
// Raw ObjC pointers are not `Send`/`Sync`; the tokens are only ever read on
// the main thread inside `removeMonitor:` at exit.
#[cfg(target_os = "macos")]
unsafe impl Send for NotchHoverMonitors {}
#[cfg(target_os = "macos")]
unsafe impl Sync for NotchHoverMonitors {}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum GatewayLifecycleStatus {
    Running,
    Stopped,
}

fn gateway_listening() -> bool {
    std::net::TcpStream::connect(("127.0.0.1", GATEWAY_PORT)).is_ok()
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

fn process_is_running(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    let result = unsafe { libc_kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(3)
}

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
            eprintln!("skipping gateway port listener with unknown executable pid={pid}");
            continue;
        };
        let listener_binary = std::fs::canonicalize(&listener_binary).unwrap_or(listener_binary);
        if reclaim_listener_policy(&listener_binary, own_gateway_binary)
            == ReclaimListenerPolicy::Skip
        {
            eprintln!(
                "skipping foreign gateway port listener pid={pid} executable={}",
                listener_binary.display()
            );
            continue;
        }
        println!("reclaiming gateway port from orphan pid={pid}");
        if let Err(error) =
            terminate_process(pid, GATEWAY_STOP_TIMEOUT, || !process_is_running(pid))
        {
            eprintln!("failed to reclaim gateway port from pid={pid}: {error}");
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
        eprintln!("gateway binary unavailable: {}", bin.display());
        return None;
    }
    let own_gateway_binary = std::fs::canonicalize(&bin).unwrap_or_else(|_| bin.clone());
    if gateway_listening() && !reclaim_gateway_port(&own_gateway_binary) {
        eprintln!("gateway port is occupied by a listener this app does not own");
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
            println!("mahoquot-gateway spawned pid={pid}");
            process.pid.store(pid, std::sync::atomic::Ordering::SeqCst);
            GATEWAY_CHILD_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
            install_gateway_signal_guard();
            let process_pid = std::sync::Arc::clone(&process.pid);
            std::thread::spawn(move || {
                let result = child.wait();
                clear_gateway_pid(&process_pid, pid);
                match result {
                    Ok(status) => println!("mahoquot-gateway exited pid={pid} status={status}"),
                    Err(error) => {
                        eprintln!("failed to harvest mahoquot-gateway pid={pid}: {error}")
                    }
                }
            });
            Some(pid)
        }
        Err(error) => {
            eprintln!("failed to spawn mahoquot-gateway: {error}");
            None
        }
    }
}

fn wait_for_gateway_ready(process: &GatewayProcess) -> bool {
    wait_until(GATEWAY_READY_TIMEOUT, || {
        gateway_listening() || process.pid() <= 1
    }) && gateway_listening()
}

fn stop_owned_gateway(process: &GatewayProcess) -> Result<bool, String> {
    let pid = process.pid();
    if pid <= 1 {
        return Ok(false);
    }
    terminate_process(pid, GATEWAY_STOP_TIMEOUT, || process.pid() != pid)?;
    clear_gateway_pid(&process.pid, pid);
    Ok(true)
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
        let _ = stop_owned_gateway(&process);
        Err("gateway did not begin listening within 5 seconds".to_string())
    }
}

#[tauri::command]
fn stop_gateway(
    process: tauri::State<'_, GatewayProcess>,
) -> Result<GatewayLifecycleStatus, String> {
    if stop_owned_gateway(&process)? {
        println!("mahoquot-gateway terminated");
    } else if gateway_listening() {
        return Ok(GatewayLifecycleStatus::Running);
    }
    Ok(GatewayLifecycleStatus::Stopped)
}

fn notched_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<tauri::Monitor>> {
    let monitors = app.available_monitors()?;
    let summaries: Vec<tray::MonitorSummary> = monitors
        .iter()
        .map(|monitor| tray::MonitorSummary {
            scale_factor: monitor.scale_factor(),
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    if let Some(index) = tray::pick_notched_monitor_index(&summaries) {
        println!(
            "notch monitor selected name={:?} scale={}",
            monitors[index].name(),
            monitors[index].scale_factor()
        );
        return Ok(Some(monitors[index].clone()));
    }
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
        tray::WindowDimensions {
            width: f64::from(outer.width) / scale,
            height: f64::from(outer.height) / scale,
        },
    )
}

#[cfg(target_os = "macos")]
fn set_notch_window_frame<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    logical: tray::WindowDimensions,
) -> tauri::Result<()> {
    use objc::{class, msg_send, sel, sel_impl};
    let is_main: bool = unsafe { msg_send![class!(NSThread), isMainThread] };
    if !is_main {
        let app_handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(win) = app_handle.get_webview_window(NOTCH_WINDOW_LABEL) else {
                return;
            };
            let _ = set_notch_window_frame(&app_handle, &win, logical);
        });
        return Ok(());
    }

    let Ok(ns_window) = window.ns_window() else {
        return Err(tauri::Error::WindowNotFound);
    };
    let ns_window = ns_window as *mut objc::runtime::Object;
    unsafe {
        // Relative-only frame change: read the window's own Cocoa frame and
        // slide it so the right edge stays glued to the screen edge and the
        // vertical center stays put. No coordinate-space conversion is ever
        // involved, so the move cannot misplace the window across displays,
        // and a single setFrame makes the grow/shrink atomic — no frame is
        // ever composited with the strip at the expanded anchor position
        // (the old black-line flash).
        let frame: CgRect = msg_send![ns_window, frame];
        let dw = logical.width - frame.size.width;
        let dh = logical.height - frame.size.height;
        let new_frame = CgRect {
            origin: CgPoint {
                x: frame.origin.x - dw,
                y: frame.origin.y - dh / 2.0,
            },
            size: CgSize {
                width: frame.size.width + dw,
                height: frame.size.height + dh,
            },
        };
        let _: () = msg_send![ns_window, setFrame: new_frame display: false];
    }
    Ok(())
}

/// Placement must be derived from the size the window is *becoming*: querying
/// `outer_size()` right after `set_size()` still reports the previous frame, so
/// the notch would be anchored for the old size and then grow off-screen.
fn position_notch_window_sized<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    logical: tray::WindowDimensions,
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
    let display = tray::DisplayBounds {
        origin_x: f64::from(monitor_position.x) / scale_factor,
        origin_y: f64::from(monitor_position.y) / scale_factor,
        width: f64::from(monitor_size.width) / scale_factor,
        height: f64::from(monitor_size.height) / scale_factor,
    };
    let position = tray::calculate_notch_window_physical_position(
        &display,
        &logical,
        &tray::NotchInsets {
            vertical_offset: NOTCH_VERTICAL_OFFSET,
        },
        scale_factor,
    );

    window.set_position(PhysicalPosition::new(
        position.x.round() as i32,
        position.y.round() as i32,
    ))?;
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
        eprintln!("failed to toggle Mahoquot Operations Console: {error}");
    }
}

#[cfg(target_os = "macos")]
fn apply_menu_bar_level<R: Runtime>(window: &WebviewWindow<R>) {
    use objc::{msg_send, sel, sel_impl};
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as *mut objc::runtime::Object;
    unsafe {
        let _: () = msg_send![ns_window, setLevel: NS_STATUS_WINDOW_LEVEL];
        let _: () = msg_send![
            ns_window,
            setCollectionBehavior: NS_WINDOW_BEHAVIOR_ALL_SPACES_STATIONARY
        ];
        // Re-classing a live NSWindow to NSPanel blanks its rendered content, and
        // the panel styling is unnecessary anyway: the native cursor forwarding in
        // `sync_notch_hover` owns hover, so nothing here depends on DOM pointer
        // events reaching an inactive app.
        let _: () = msg_send![ns_window, setHidesOnDeactivate: false];
        let _: () = msg_send![ns_window, setAcceptsMouseMovedEvents: true];
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

#[cfg(target_os = "macos")]
fn notch_screen_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<tray::ScreenRect> {
    use objc::{msg_send, sel, sel_impl};
    let ns_window = window.ns_window().ok()? as *mut objc::runtime::Object;
    let frame: CgRect = unsafe { msg_send![ns_window, frame] };
    Some(tray::ScreenRect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    })
}

#[cfg(target_os = "macos")]
fn cursor_location() -> tray::CursorPoint {
    use objc::{class, msg_send, sel, sel_impl};
    let point: CgPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    tray::CursorPoint {
        x: point.x,
        y: point.y,
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
    let Some(rect) = notch_screen_rect(&window) else {
        return;
    };
    let cursor = cursor_location();
    let displays = display_logical_bounds(app);
    if !tray::screen_rect_touches_display(&rect, &displays) {
        // The window drifted off every connected display (monitor unplugged,
        // resolution or arrangement changed). Re-anchor it and skip hover for
        // this sample: the frame AppKit reports next will be on-screen again.
        if let Err(error) = position_notch_window(app, &window) {
            eprintln!("failed to re-anchor off-screen notch: {error}");
        }
        return;
    }
    let was_open = expanded.load(Ordering::Relaxed);
    let was_pending = collapse_pending.load(Ordering::Relaxed);
    let inside = tray::hover_cursor_inside(
        &rect,
        displays
            .iter()
            .find(|display| tray::rects_overlap(&rect, display)),
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
            if let Some(point) = tray::cursor_to_window_local(&rect, &cursor) {
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
            resize_notch(app, NOTCH_EXPANDED_WIDTH, NOTCH_EXPANDED_HEIGHT);
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:true}));",
            );
            println!(
                "notch hover open=true rect=({},{},{},{}) cursor=({},{})",
                rect.x, rect.y, rect.width, rect.height, cursor.x, cursor.y
            );
        }
        tray::HoverIntent::ScheduleCollapse => {
            collapse_pending.store(false, Ordering::Relaxed);
            let scheduled_generation = generation.fetch_add(1, Ordering::Relaxed) + 1;
            expanded.store(false, Ordering::Relaxed);
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:false}));",
            );
            println!("notch hover open=false immediate=true");
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
                    resize_notch(&app, NOTCH_COMPACT_WIDTH, NOTCH_COMPACT_HEIGHT);
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
fn display_logical_bounds(app: &AppHandle) -> Vec<tray::ScreenRect> {
    let monitors = app.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            tray::ScreenRect {
                x: f64::from(position.x) / scale,
                y: f64::from(position.y) / scale,
                width: f64::from(size.width) / scale,
                height: f64::from(size.height) / scale,
            }
        })
        .collect()
}

/// The notch never takes focus, and macOS routes pointer events only to the
/// frontmost app, so the webview's own mouseenter never fires while the user
/// works elsewhere. A global NSEvent monitor gives us the cursor regardless.
#[cfg(target_os = "macos")]
fn start_notch_hover_watch(app: &AppHandle, state: &NotchHoverState) {
    use block::ConcreteBlock;
    use objc::{class, msg_send, sel, sel_impl};

    let global_handle = app.clone();
    let global_state = state.expanded.clone();
    let global_pending = state.collapse_pending.clone();
    let global_generation = state.generation.clone();
    let global_last_hit_test_ms = state.last_hit_test_ms.clone();
    let global_handler = ConcreteBlock::new(move |_event: *mut objc::runtime::Object| {
        sync_notch_hover(
            &global_handle,
            &global_state,
            &global_pending,
            &global_generation,
            &global_last_hit_test_ms,
        );
    })
    .copy();

    // A global monitor is silent while Mahoquot itself is frontmost, so the
    // active-app case needs a local monitor, which must hand the event back.
    let local_handle = app.clone();
    let local_state = state.expanded.clone();
    let local_pending = state.collapse_pending.clone();
    let local_generation = state.generation.clone();
    let local_last_hit_test_ms = state.last_hit_test_ms.clone();
    let local_handler = ConcreteBlock::new(
        move |event: *mut objc::runtime::Object| -> *mut objc::runtime::Object {
            sync_notch_hover(
                &local_handle,
                &local_state,
                &local_pending,
                &local_generation,
                &local_last_hit_test_ms,
            );
            event
        },
    )
    .copy();

    unsafe {
        let mouse_moved_mask: u64 = 1 << 5;
        let global_token: *mut objc::runtime::Object = msg_send![
            class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: mouse_moved_mask
            handler: &*global_handler
        ];
        if global_token.is_null() {
            eprintln!("failed to install notch hover monitor for background use");
        }
        let local_token: *mut objc::runtime::Object = msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: mouse_moved_mask
            handler: &*local_handler
        ];
        if local_token.is_null() {
            eprintln!("failed to install notch hover monitor for foreground use");
        }
        app.manage(NotchHoverMonitors(std::sync::Mutex::new([
            global_token,
            local_token,
        ])));
    }
    println!("notch hover watch armed");
    // The monitors own the blocks until they are removed at exit.
    std::mem::forget(global_handler);
    std::mem::forget(local_handler);
}

#[cfg(target_os = "macos")]
fn apply_dock_icon() {
    use objc::{class, msg_send, sel, sel_impl};
    let bytes = include_bytes!("../icons/icon.png");
    unsafe {
        let data: *mut objc::runtime::Object =
            msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
        let image: *mut objc::runtime::Object = msg_send![class!(NSImage), alloc];
        let image: *mut objc::runtime::Object = msg_send![image, initWithData: data];
        if image.is_null() {
            eprintln!("failed to decode mahoquot dock icon");
            return;
        }
        let app: *mut objc::runtime::Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage: image];
    }
}

fn toggle_notch_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        window.hide()
    } else {
        window
            .show()
            .and_then(|_| {
                apply_menu_bar_level(&window);
                position_notch_window(app, &window)
            })
            .and_then(|_| window.set_focus())
    };
    if let Err(error) = result {
        eprintln!("failed to toggle Mahoquot notch window: {error}");
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
    let target = tray::WindowDimensions { width, height };
    // Hover expand/collapse must be atomic: a position call sized for the
    // target followed by a resize composited the small strip at the expanded
    // anchor for a frame (the black-line flash). The relative setFrame slides
    // the window in one transaction instead.
    if let Err(error) = set_notch_window_frame(app, &window, target) {
        eprintln!("failed to resize notch window: {error}");
    }
    println!("notch resized width={width} height={height} scale={scale}");
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
    resize_notch(&app, NOTCH_EXPANDED_WIDTH, NOTCH_EXPANDED_HEIGHT);
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
    resize_notch(&app, NOTCH_COMPACT_WIDTH, NOTCH_COMPACT_HEIGHT);
}

fn refresh_windows<R: Runtime>(app: &AppHandle<R>) {
    for label in [MAIN_WINDOW_LABEL, NOTCH_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.eval("window.location.reload()") {
                eprintln!("failed to refresh Mahoquot window {label}: {error}");
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
        .map_err(|error| eprintln!("failed to position tray panel: {error}"))
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
    apply_dock_icon();

    let notch = app
        .get_webview_window(NOTCH_WINDOW_LABEL)
        .ok_or("missing notch window")?;
    position_notch_window(app.handle(), &notch)?;
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        return Err("missing main window".into());
    }

    let _ = notch.show();
    apply_menu_bar_level(&notch);
    position_notch_window(app.handle(), &notch)?;
    let handle = app.handle().clone();
    let notch_clone = notch.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Err(error) = position_notch_window(&handle, &notch_clone) {
            eprintln!("delayed notch positioning failed: {error}");
            return;
        }
        if let Ok(position) = notch_clone.outer_position() {
            println!("notch position settled x={} y={}", position.x, position.y);
        }
        #[cfg(target_os = "macos")]
        if let Some(rect) = notch_screen_rect(&notch_clone) {
            println!(
                "notch hover target rect x={} y={} w={} h={}",
                rect.x, rect.y, rect.width, rect.height
            );
        }
    });

    #[cfg(target_os = "macos")]
    start_notch_hover_watch(app.handle(), &app.state::<NotchHoverState>());

    println!("mahoquot-monitor-ready windows={MAIN_WINDOW_LABEL},{NOTCH_WINDOW_LABEL}");
    Ok(())
}

struct Config {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

#[tauri::command]
async fn load_stats(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    let raw = fetch_stats(&state.client, &state.base_url, &state.api_key).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(build_view(&raw, now_ms))
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
    load_stats(state).await
}

fn main() {
    let base_url = std::env::var("MAHOQUOT_URL").unwrap_or_else(|_| LOCAL_GATEWAY_URL.to_string());
    let gateway = GatewayProcess::default();
    let _ = spawn_gateway(&gateway, &base_url);
    let api_key = std::env::var("MAHOQUOT_API_KEY").unwrap_or_default();
    let init_script = bootstrap::console_initialization_script(&base_url, &api_key);

    let app = tauri::Builder::default()
        .manage(gateway)
        .manage(NotchHoverState {
            expanded: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            collapse_pending: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
            reset_account,
            warm_account,
            warm_all,
            refresh_usage,
            expand_notch,
            collapse_notch
        ])
        .setup(initialize_native_ui)
        .on_window_event(|window, event| {
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
                    eprintln!("failed to hide Mahoquot window {}: {error}", window.label());
                }
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
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if let tauri::RunEvent::ExitRequested { .. } = event {
            #[cfg(target_os = "macos")]
            {
                use objc::{class, msg_send, sel, sel_impl};
                let monitors = app.state::<NotchHoverMonitors>();
                if let Ok(tokens) = monitors.0.lock() {
                    unsafe {
                        for token in tokens.iter().copied() {
                            if !token.is_null() {
                                let _: () = msg_send![class!(NSEvent), removeMonitor: token];
                            }
                        }
                    }
                };
            }
            let gateway = app.state::<GatewayProcess>();
            match stop_owned_gateway(&gateway) {
                Ok(true) => println!("mahoquot-gateway terminated"),
                Ok(false) => {}
                Err(error) => eprintln!("failed to stop mahoquot-gateway on exit: {error}"),
            }
        }
    });
}
