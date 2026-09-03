use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::notch::{CursorPoint, Rect, Size};

const NS_STATUS_WINDOW_LEVEL: i64 = 25;
const NS_WINDOW_BEHAVIOR_ALL_SPACES_STATIONARY: i64 = (1 << 0) | (1 << 8);

pub fn native_notch_attributes<R: Runtime>(window: &WebviewWindow<R>) -> Option<(i64, bool)> {
    use objc::{msg_send, sel, sel_impl};

    let ns_window = window.ns_window().ok()? as *mut objc::runtime::Object;
    let level: i64 = unsafe { msg_send![ns_window, level] };
    let behavior: u64 = unsafe { msg_send![ns_window, collectionBehavior] };
    Some((
        level,
        behavior & NS_WINDOW_BEHAVIOR_ALL_SPACES_STATIONARY as u64
            == NS_WINDOW_BEHAVIOR_ALL_SPACES_STATIONARY as u64,
    ))
}

pub fn foreground_process_id() -> Option<i32> {
    use objc::{class, msg_send, sel, sel_impl};

    let workspace: *mut objc::runtime::Object =
        unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
    let application: *mut objc::runtime::Object =
        unsafe { msg_send![workspace, frontmostApplication] };
    if application.is_null() {
        return None;
    }
    Some(unsafe { msg_send![application, processIdentifier] })
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

pub struct NotchHoverMonitors(pub std::sync::Mutex<[*mut objc::runtime::Object; 3]>);

unsafe impl Send for NotchHoverMonitors {}
unsafe impl Sync for NotchHoverMonitors {}

pub fn set_notch_window_frame<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    window_label: &'static str,
    size: Size,
) -> tauri::Result<()> {
    use objc::{class, msg_send, sel, sel_impl};

    let is_main: bool = unsafe { msg_send![class!(NSThread), isMainThread] };
    if !is_main {
        let app_handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = app_handle.get_webview_window(window_label) else {
                return;
            };
            let _ = set_notch_window_frame(&app_handle, &window, window_label, size);
        });
        return Ok(());
    }

    let Ok(ns_window) = window.ns_window() else {
        return Err(tauri::Error::WindowNotFound);
    };
    let ns_window = ns_window as *mut objc::runtime::Object;
    unsafe {
        let frame: CgRect = msg_send![ns_window, frame];
        let dw = size.width - frame.size.width;
        let dh = size.height - frame.size.height;
        let new_frame = CgRect {
            origin: CgPoint {
                x: frame.origin.x - dw,
                y: frame.origin.y - dh / 2.0,
            },
            size: CgSize {
                width: size.width,
                height: size.height,
            },
        };
        let _: () = msg_send![ns_window, setFrame: new_frame display: false];
    }
    Ok(())
}

pub fn ensure_session_supported(
) -> Result<crate::notch::DesktopSession, crate::notch::UnsupportedSession> {
    crate::notch::platform_contract(
        crate::notch::PlatformTarget::Macos,
        crate::notch::DesktopSession::AppKit,
    )?;
    Ok(crate::notch::DesktopSession::AppKit)
}

pub fn apply_menu_bar_level<R: Runtime>(window: &WebviewWindow<R>) {
    use objc::{msg_send, sel, sel_impl};

    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_skip_taskbar(true);
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
        let _: () = msg_send![ns_window, setHidesOnDeactivate: false];
        let _: () = msg_send![ns_window, setAcceptsMouseMovedEvents: true];
    }
}

pub fn notch_screen_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    use objc::{msg_send, sel, sel_impl};

    let ns_window = window.ns_window().ok()? as *mut objc::runtime::Object;
    let frame: CgRect = unsafe { msg_send![ns_window, frame] };
    Some(Rect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    })
}

pub fn cursor_location() -> CursorPoint {
    use objc::{class, msg_send, sel, sel_impl};

    let point: CgPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    CursorPoint {
        x: point.x,
        y: point.y,
    }
}

pub fn apply_dock_icon() {
    use objc::{class, msg_send, sel, sel_impl};

    let bytes = include_bytes!("../../icons/icon.png");
    unsafe {
        let data: *mut objc::runtime::Object =
            msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
        let image: *mut objc::runtime::Object = msg_send![class!(NSImage), alloc];
        let image: *mut objc::runtime::Object = msg_send![image, initWithData: data];
        if image.is_null() {
            tracing::error!("failed to decode mahoquot dock icon");
            return;
        }
        let app: *mut objc::runtime::Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage: image];
    }
}

pub fn start_notch_hover_watch(app: &AppHandle, state: &crate::NotchHoverState) {
    use block::ConcreteBlock;
    use objc::{class, msg_send, sel, sel_impl};

    let global_handle = app.clone();
    let global_state = state.expanded.clone();
    let global_pending = state.collapse_pending.clone();
    let global_generation = state.generation.clone();
    let global_last_hit_test_ms = state.last_hit_test_ms.clone();
    let global_handler = ConcreteBlock::new(move |_event: *mut objc::runtime::Object| {
        crate::sync_notch_hover(
            &global_handle,
            &global_state,
            &global_pending,
            &global_generation,
            &global_last_hit_test_ms,
        );
    })
    .copy();

    let local_handle = app.clone();
    let local_state = state.expanded.clone();
    let local_pending = state.collapse_pending.clone();
    let local_generation = state.generation.clone();
    let local_last_hit_test_ms = state.last_hit_test_ms.clone();
    let local_handler = ConcreteBlock::new(
        move |event: *mut objc::runtime::Object| -> *mut objc::runtime::Object {
            crate::sync_notch_hover(
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

    let observer_handle = app.clone();
    let observer_handler = ConcreteBlock::new(move |_notification: *mut objc::runtime::Object| {
        let handle = observer_handle.clone();
        let target_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let Some(window) = target_handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) else {
                return;
            };
            if let Err(error) = crate::position_notch_window(&target_handle, &window) {
                tracing::warn!(%error, "failed to reposition notch after screen parameters change");
            } else {
                tracing::info!("notch repositioned after screen parameters change");
            }
        });
    })
    .copy();

    unsafe {
        let mouse_moved_mask: u64 = 1 << 5;
        let global_token: *mut objc::runtime::Object = msg_send![
            class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: mouse_moved_mask
            handler: &*global_handler
        ];
        let local_token: *mut objc::runtime::Object = msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: mouse_moved_mask
            handler: &*local_handler
        ];

        // Observe screen configuration/resolution/arrangement changes
        let center: *mut objc::runtime::Object =
            msg_send![class!(NSNotificationCenter), defaultCenter];
        let notif_name: *mut objc::runtime::Object = msg_send![
            class!(NSString),
            stringWithUTF8String: c"NSApplicationDidChangeScreenParametersNotification".as_ptr()
        ];
        let screen_observer_token: *mut objc::runtime::Object = msg_send![
            center,
            addObserverForName: notif_name
            object: std::ptr::null::<objc::runtime::Object>()
            queue: std::ptr::null::<objc::runtime::Object>()
            usingBlock: &*observer_handler
        ];

        app.manage(NotchHoverMonitors(std::sync::Mutex::new([
            global_token,
            local_token,
            screen_observer_token,
        ])));
    }
    tracing::info!("notch hover watch and screen parameter observer armed");
    std::mem::forget(global_handler);
    std::mem::forget(local_handler);
    std::mem::forget(observer_handler);
}

pub fn cleanup_notch_hover_watch(app: &AppHandle) {
    use objc::{class, msg_send, sel, sel_impl};

    let monitors = app.state::<NotchHoverMonitors>();
    if let Ok(tokens) = monitors.0.lock() {
        unsafe {
            if !tokens[0].is_null() {
                let _: () = msg_send![class!(NSEvent), removeMonitor: tokens[0]];
            }
            if !tokens[1].is_null() {
                let _: () = msg_send![class!(NSEvent), removeMonitor: tokens[1]];
            }
            if !tokens[2].is_null() {
                let center: *mut objc::runtime::Object =
                    msg_send![class!(NSNotificationCenter), defaultCenter];
                let _: () = msg_send![center, removeObserver: tokens[2]];
            }
        }
    };
}

pub fn notch_right_anchored<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> bool {
    false
}
