use std::sync::atomic::Ordering;

use gtk::glib::prelude::Cast;
use gtk::prelude::{BinExt, GtkWindowExt, WidgetExt};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ClientMessageData, ClientMessageEvent, ConnectionExt, EventMask},
    rust_connection::RustConnection,
};

use crate::notch::{
    resize_backend, CursorPoint, DesktopSession, PlatformTarget, Rect, ResizeBackend, Size,
};

const HOVER_SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

fn session() -> DesktopSession {
    let session_type = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if session_type == "x11" || std::env::var_os("DISPLAY").is_some() && session_type != "wayland" {
        DesktopSession::X11
    } else if session_type == "wayland" && desktop.contains("kde") {
        DesktopSession::KdeWayland
    } else if session_type == "wayland" && desktop.contains("gnome") {
        DesktopSession::GnomeWayland
    } else {
        DesktopSession::Unknown
    }
}

pub fn ensure_session_supported() -> Result<DesktopSession, crate::notch::UnsupportedSession> {
    let session = session();
    crate::notch::platform_contract(PlatformTarget::Linux, session)?;
    Ok(session)
}

pub fn set_notch_window_frame<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    _window_label: &'static str,
    size: Size,
) -> tauri::Result<()> {
    let session = session();
    if session == DesktopSession::X11 {
        if let Ok(gtk_window) = window.gtk_window() {
            gtk_window.resize(size.width as i32, size.height as i32);
        }
    }
    if resize_backend(session) == ResizeBackend::GtkLayerSurface {
        apply_kde_layer_surface_size(app, window, size);
    }
    crate::position_notch_window_sized(app, window, size)?;
    if session == DesktopSession::X11 {
        let _ = apply_x11_window_type(window);
    }
    Ok(())
}

/// Layer-shell surfaces ignore plain `window.set_size` when WebKitGTK's
/// natural minimum (99px wide) exceeds the request, so the compact collapse
/// would stick at 99x180. GDK geometry hints replace the requisition-derived
/// minimum with the target size, letting the compositor shrink the surface to
/// the 8px sliver; the webview child request keeps the allocation in sync.
/// GTK calls must run on the main thread, so they are dispatched through the
/// app handle when invoked from the certification or hover threads.
fn apply_kde_layer_surface_size<R: Runtime>(
    app: &AppHandle<R>,
    _window: &WebviewWindow<R>,
    size: Size,
) {
    let handle = app.clone();
    let apply = move || {
        use gtk::gdk;
        use gtk::prelude::GtkWindowExt;
        let Some(window) = handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) else {
            return;
        };
        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        let geometry = gdk::Geometry::new(
            size.width as i32,
            0,
            0,
            size.height as i32,
            0,
            0,
            0,
            0,
            0.0,
            0.0,
            gdk::Gravity::NorthWest,
        );
        gtk_window.set_geometry_hints(
            None::<&gtk::Widget>,
            Some(&geometry),
            gdk::WindowHints::MIN_SIZE,
        );
        if let Some(child) = gtk_window.child() {
            child.set_size_request(size.width as i32, size.height as i32);
        }
        gtk_window.resize(size.width as i32, size.height as i32);
        gtk_window.queue_resize();
    };
    let thread_name = std::thread::current().name().map(str::to_owned);
    if thread_name
        .as_deref()
        .is_some_and(|name| name.starts_with("main"))
    {
        apply();
    } else {
        let _ = app.run_on_main_thread(apply);
    }
}

pub fn apply_menu_bar_level<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_skip_taskbar(true);
    if let Ok(gtk_window) = window.gtk_window() {
        if let Some(child) = gtk_window.child() {
            child.set_size_request(1, 1);
        }
        if session() == DesktopSession::X11 {
            gtk_window.stick();
        }
    }
    match session() {
        DesktopSession::X11 => {
            let _ = apply_x11_window_type(window);
        }
        DesktopSession::KdeWayland => {
            let _ = apply_kde_layer_shell(window);
            // Clamp the initial mapped geometry too: without hints the layer
            // surface first appears at WebKitGTK's 99px natural minimum
            // instead of the 8px compact sliver.
            let app = window.app_handle();
            apply_kde_layer_surface_size(app, window, crate::notch::COMPACT);
        }
        _ => {}
    }
}

fn apply_kde_layer_shell<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use gtk_layer_shell::{Edge, Layer, LayerShell};

    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    gtk_window.init_layer_shell();
    gtk_window.set_layer(Layer::Overlay);
    gtk_window.set_keyboard_interactivity(false);
    gtk_window.set_anchor(Edge::Right, true);
    gtk_window.set_anchor(Edge::Top, false);
    gtk_window.set_anchor(Edge::Bottom, false);
    gtk_window.set_exclusive_zone(-1);
    Ok(())
}

fn apply_x11_window_type<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let (connection, screen) = RustConnection::connect(None).map_err(|error| error.to_string())?;
    let id = x11_window_id(window).ok_or("notch X11 window ID unavailable")?;
    let above = connection
        .intern_atom(false, b"_NET_WM_STATE_ABOVE")
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?
        .atom;
    let sticky = connection
        .intern_atom(false, b"_NET_WM_STATE_STICKY")
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?
        .atom;
    let state = connection
        .intern_atom(false, b"_NET_WM_STATE")
        .map_err(|error| error.to_string())?
        .reply()
        .map_err(|error| error.to_string())?
        .atom;
    let event = ClientMessageEvent::new(
        32,
        id,
        state,
        ClientMessageData::from([1, above, sticky, 1, 0]),
    );
    connection
        .send_event(
            false,
            connection.setup().roots[screen].root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|error| error.to_string())?;
    connection.flush().map_err(|error| error.to_string())
}

fn kde_layer_attributes<R: Runtime>(window: &WebviewWindow<R>) -> Option<(i64, bool)> {
    use gtk_layer_shell::LayerShell;
    // Layer-shell overlays carry no X11 WM_STATE; their topmost,
    // active-workspace visibility is granted by the compositor layer
    // itself. Report the layer rank and workspace independence directly.
    // GTK reads must run on the main thread, so marshal from whichever
    // thread (certification or hover) is asking.
    let probe = window.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let dispatched = window.run_on_main_thread(move || {
        let level = match probe.gtk_window() {
            Ok(gtk_window) => match gtk_window.layer() {
                gtk_layer_shell::Layer::Overlay => 2,
                gtk_layer_shell::Layer::Top => 1,
                _ => 0,
            },
            Err(_) => 0,
        };
        let _ = sender.send((level, true));
    });
    if dispatched.is_err() {
        return None;
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .ok()
}

/// Wayland clients cannot observe their global position, so right-edge
/// invariance is certified through the layer-shell anchor contract instead:
/// an anchored right edge keeps the surface glued to the output edge for any
/// size the compositor grants.
pub fn notch_right_anchored<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    if session() != DesktopSession::KdeWayland {
        return false;
    }
    let probe = window.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let dispatched = window.run_on_main_thread(move || {
        use gtk_layer_shell::{Edge, LayerShell};
        let anchored = probe
            .gtk_window()
            .map(|gtk_window| gtk_window.is_anchor(Edge::Right))
            .unwrap_or(false);
        let _ = sender.send(anchored);
    });
    if dispatched.is_err() {
        return false;
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or(false)
}

fn x11_window_id<R: Runtime>(window: &WebviewWindow<R>) -> Option<u32> {
    let gdk_window = window.gtk_window().ok()?.window()?;
    let x11_window = gdk_window.dynamic_cast::<gdkx11::X11Window>().ok()?;
    u32::try_from(x11_window.xid()).ok()
}

pub fn native_notch_attributes<R: Runtime>(window: &WebviewWindow<R>) -> Option<(i64, bool)> {
    if session() == DesktopSession::KdeWayland {
        return kde_layer_attributes(window);
    }
    if session() != DesktopSession::X11 {
        return None;
    }
    let (connection, _) = RustConnection::connect(None).ok()?;
    let id = x11_window_id(window)?;
    let state = connection
        .intern_atom(false, b"_NET_WM_STATE")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let above = connection
        .intern_atom(false, b"_NET_WM_STATE_ABOVE")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let sticky = connection
        .intern_atom(false, b"_NET_WM_STATE_STICKY")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let desktop = connection
        .intern_atom(false, b"_NET_WM_DESKTOP")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = connection
        .get_property(false, id, state, AtomEnum::ATOM, 0, u32::MAX)
        .ok()?
        .reply()
        .ok()?;
    let states: Vec<u32> = reply.value32()?.collect();
    let desktop_reply = connection
        .get_property(false, id, desktop, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let all_desktops = desktop_reply.value32()?.next() == Some(u32::MAX);
    Some((
        i64::from(states.contains(&above)),
        states.contains(&sticky) || all_desktops,
    ))
}

pub fn foreground_process_id() -> Option<i32> {
    if session() != DesktopSession::X11 {
        return None;
    }
    let (connection, screen) = RustConnection::connect(None).ok()?;
    let active = connection
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let root = connection.setup().roots[screen].root;
    let reply = connection
        .get_property(false, root, active, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let active_window = reply.value32()?.next()?;
    i32::try_from(active_window).ok()
}

pub fn notch_screen_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

fn x11_cursor_location() -> Option<CursorPoint> {
    let (connection, screen) = RustConnection::connect(None).ok()?;
    let root = connection.setup().roots[screen].root;
    let reply = connection.query_pointer(root).ok()?.reply().ok()?;
    Some(CursorPoint {
        x: f64::from(reply.root_x),
        y: f64::from(reply.root_y),
    })
}

pub fn start_notch_hover_watch(app: &AppHandle, state: &crate::NotchHoverState) {
    let Ok(active_session) = ensure_session_supported() else {
        return;
    };
    if active_session == DesktopSession::KdeWayland {
        start_kde_surface_hover_watch(app, state);
        return;
    }
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
        let Some(cursor) = x11_cursor_location() else {
            continue;
        };
        let was_open = expanded.load(Ordering::Relaxed);
        let inside = crate::notch::hover_cursor_inside(&rect, None, &cursor, was_open);
        if inside == was_open {
            continue;
        }
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
    });
}

fn start_kde_surface_hover_watch(app: &AppHandle, state: &crate::NotchHoverState) {
    let Some(window) = app.get_webview_window(crate::NOTCH_WINDOW_LABEL) else {
        return;
    };
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let enter_handle = app.clone();
    let enter_expanded = state.expanded.clone();
    let enter_generation = state.generation.clone();
    gtk_window.connect_enter_notify_event(move |_, _| {
        enter_generation.fetch_add(1, Ordering::Relaxed);
        enter_expanded.store(true, Ordering::Relaxed);
        crate::resize_notch(
            &enter_handle,
            crate::notch::EXPANDED.width,
            crate::notch::EXPANDED.height,
        );
        if let Some(window) = enter_handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) {
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:true}));",
            );
        }
        gtk::glib::Propagation::Proceed
    });
    let leave_handle = app.clone();
    let leave_expanded = state.expanded.clone();
    let leave_generation = state.generation.clone();
    gtk_window.connect_leave_notify_event(move |_, _| {
        leave_generation.fetch_add(1, Ordering::Relaxed);
        leave_expanded.store(false, Ordering::Relaxed);
        if let Some(window) = leave_handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) {
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('mahoquot:notch-hover',{detail:false}));",
            );
        }
        crate::resize_notch(
            &leave_handle,
            crate::notch::COMPACT.width,
            crate::notch::COMPACT.height,
        );
        gtk::glib::Propagation::Proceed
    });
}

pub fn cleanup_notch_hover_watch(_app: &AppHandle) {}
