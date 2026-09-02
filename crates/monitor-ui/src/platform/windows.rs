use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW,
        SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    },
};

use crate::notch::{CursorPoint, Rect, Size};

const HOVER_SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

pub fn ensure_session_supported(
) -> Result<crate::notch::DesktopSession, crate::notch::UnsupportedSession> {
    crate::notch::platform_contract(
        crate::notch::PlatformTarget::Windows,
        crate::notch::DesktopSession::Win32,
    )?;
    Ok(crate::notch::DesktopSession::Win32)
}

fn hwnd<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<HWND> {
    window.hwnd().map(|raw| HWND(raw.0))
}

pub fn set_notch_window_frame<R: Runtime>(
    _app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    _window_label: &'static str,
    size: Size,
) -> tauri::Result<()> {
    let handle = hwnd(window)?;
    let scale = window.scale_factor()?;
    // Enforce the toolwindow/no-activate styles on every resize: other
    // components (tao flag rewrites, webview init) can clear these bits
    // after apply_menu_bar_level, and the notch must stay non-activating.
    unsafe {
        let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
        let _ = SetWindowLongPtrW(
            handle,
            GWL_EXSTYLE,
            style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(handle, &mut rect) }.map_err(|_| tauri::Error::WindowNotFound)?;
    let current_width = rect.right - rect.left;
    let current_height = rect.bottom - rect.top;
    let width = (size.width * scale).round() as i32;
    let height = (size.height * scale).round() as i32;
    let x = rect.left - (width - current_width);
    let y = rect.top - (height - current_height) / 2;
    unsafe {
        SetWindowPos(
            handle,
            Some(HWND_TOPMOST),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE,
        )
    }
    .map_err(|_| tauri::Error::WindowNotFound)
}

pub fn apply_menu_bar_level<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(handle) = hwnd(window) else { return };
    // tao rewrites the extended style from its cached window flags whenever
    // one of the setters below runs, so our toolwindow/no-activate bits must
    // be applied AFTER every tao setter, not before.
    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_skip_taskbar(true);
    unsafe {
        let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
        let _ = SetWindowLongPtrW(
            handle,
            GWL_EXSTYLE,
            style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
        let _ = SetWindowPos(
            handle,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE,
        );
    }
}

pub fn notch_screen_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    let handle = hwnd(window).ok()?;
    let scale = window.scale_factor().ok()?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(handle, &mut rect) }.ok()?;
    Some(Rect {
        x: f64::from(rect.left) / scale,
        y: f64::from(rect.top) / scale,
        width: f64::from(rect.right - rect.left) / scale,
        height: f64::from(rect.bottom - rect.top) / scale,
    })
}

pub fn native_notch_attributes<R: Runtime>(window: &WebviewWindow<R>) -> Option<(i64, bool)> {
    let handle = hwnd(window).ok()?;
    let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
    let no_activate = style & WS_EX_NOACTIVATE.0 as isize != 0;
    let tool_window = style & WS_EX_TOOLWINDOW.0 as isize != 0;
    Some((i64::from(no_activate && tool_window), true))
}

pub fn notch_style_debug<R: Runtime>(window: &WebviewWindow<R>) -> String {
    let Ok(handle) = hwnd(window) else {
        return "no-hwnd".to_string();
    };
    let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
    format!("{style:#x}")
}

pub fn foreground_process_id() -> Option<i32> {
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    Some(window.0 as isize as i32)
}

fn cursor_location(scale: f64) -> Option<CursorPoint> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some(CursorPoint {
        x: f64::from(point.x) / scale,
        y: f64::from(point.y) / scale,
    })
}

pub fn start_notch_hover_watch(app: &AppHandle, state: &crate::NotchHoverState) {
    let handle = app.clone();
    let expanded = state.expanded.clone();
    let generation = state.generation.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(HOVER_SAMPLE_INTERVAL);
        let Some(window) = handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) else {
            break;
        };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let Some(rect) = notch_screen_rect(&window) else {
            continue;
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let Some(cursor) = cursor_location(scale) else {
            continue;
        };
        let was_open = expanded.load(Ordering::Relaxed);
        let inside = crate::notch::hover_cursor_inside(&rect, None, &cursor, was_open);
        if inside == was_open {
            continue;
        }
        let foreground_before = unsafe { GetForegroundWindow() };
        generation.fetch_add(1, Ordering::Relaxed);
        expanded.store(inside, Ordering::Relaxed);
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{{detail:{inside}}}));"
        ));
        let target = if inside {
            crate::notch::EXPANDED
        } else {
            crate::notch::COMPACT
        };
        let _ = set_notch_window_frame(&handle, &window, crate::NOTCH_WINDOW_LABEL, target);
        debug_assert_eq!(foreground_before, unsafe { GetForegroundWindow() });
    });
}

pub fn cleanup_notch_hover_watch(_app: &AppHandle) {}

pub fn notch_right_anchored<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> bool {
    false
}
