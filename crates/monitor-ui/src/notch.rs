#![allow(dead_code)]

pub const COMPACT: Size = Size {
    width: 8.0,
    height: 180.0,
};
pub const EXPANDED: Size = Size {
    width: 420.0,
    height: 560.0,
};
pub const VERTICAL_OFFSET: f64 = 0.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformTarget {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopSession {
    AppKit,
    Win32,
    X11,
    GnomeWayland,
    KdeWayland,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerTracking {
    None,
    Global,
    Surface,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlatformContract {
    pub compact: Size,
    pub expanded: Size,
    pub right_anchored: bool,
    pub vertically_centered: bool,
    pub hover_expands: bool,
    pub immediate_visual_collapse: bool,
    pub native_frame_cleanup: bool,
    pub focus_preserving: bool,
    pub topmost: bool,
    pub active_workspace: bool,
    pub dpi_aware: bool,
    pub monitor_fallback: bool,
    pub requires_layer_shell: bool,
    pub pointer_tracking: PointerTracking,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedSession {
    pub code: &'static str,
    pub message: &'static str,
    pub tray_only_fallback: bool,
}

const FULL_NATIVE_CONTRACT: PlatformContract = PlatformContract {
    compact: COMPACT,
    expanded: EXPANDED,
    right_anchored: true,
    vertically_centered: true,
    hover_expands: true,
    immediate_visual_collapse: true,
    native_frame_cleanup: true,
    focus_preserving: true,
    topmost: true,
    active_workspace: true,
    dpi_aware: true,
    monitor_fallback: true,
    requires_layer_shell: false,
    pointer_tracking: PointerTracking::Global,
};

pub fn platform_contract(
    target: PlatformTarget,
    session: DesktopSession,
) -> Result<PlatformContract, UnsupportedSession> {
    match (target, session) {
        (PlatformTarget::Macos, DesktopSession::AppKit) => Ok(FULL_NATIVE_CONTRACT),
        (PlatformTarget::Windows, DesktopSession::Win32)
        | (PlatformTarget::Linux, DesktopSession::X11) => Ok(FULL_NATIVE_CONTRACT),
        (PlatformTarget::Linux, DesktopSession::KdeWayland) => Ok(PlatformContract {
            requires_layer_shell: true,
            pointer_tracking: PointerTracking::Surface,
            ..FULL_NATIVE_CONTRACT
        }),
        (PlatformTarget::Linux, DesktopSession::GnomeWayland) => Err(UnsupportedSession {
            code: "parity_unsupported",
            message: "GNOME Wayland does not expose the layer-shell and global pointer contracts required by the notch",
            tray_only_fallback: false,
        }),
        _ => Err(UnsupportedSession {
            code: "parity_unsupported",
            message: "desktop target and session combination cannot satisfy native notch parity",
            tray_only_fallback: false,
        }),
    }
}

/// Which native mechanism drives notch hover expand/collapse for a session.
/// KDE Wayland maps the layer surface through gtk-layer-shell, so the GTK
/// toplevel must be resized directly with a geometry-hints minimum clamp;
/// WebKitGTK's natural minimum width (99px) otherwise pins the compact
/// collapse and the surface never returns to 8x180.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeBackend {
    /// The compositor maps a normal toplevel: set_position + set_size suffice.
    MappedWindow,
    /// The surface is a layer-shell overlay: clamp the toplevel minimum with
    /// geometry hints, then resize the GTK window and webview child together.
    GtkLayerSurface,
    /// The session cannot honor the notch contract at all.
    Unsupported,
}

pub fn resize_backend(session: DesktopSession) -> ResizeBackend {
    match session {
        DesktopSession::AppKit | DesktopSession::Win32 | DesktopSession::X11 => {
            ResizeBackend::MappedWindow
        }
        DesktopSession::KdeWayland => ResizeBackend::GtkLayerSurface,
        DesktopSession::GnomeWayland | DesktopSession::Unknown => ResizeBackend::Unsupported,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

pub fn frame_for_size(frame: Rect, size: Size) -> Rect {
    Rect {
        x: frame.x + frame.width - size.width,
        y: frame.y + (frame.height - size.height) / 2.0,
        width: size.width,
        height: size.height,
    }
}

pub fn frame_on_display(display: Rect, size: Size) -> Rect {
    let frame = frame_for_size(display, size);
    Rect {
        x: frame.x.max(display.x),
        y: frame.y.clamp(
            display.y,
            (display.y + display.height - size.height).max(display.y),
        ),
        ..frame
    }
}

pub fn physical_origin(display: Rect, size: Size, scale_factor: f64) -> (f64, f64) {
    let frame = frame_on_display(display, size);
    (frame.x * scale_factor, frame.y * scale_factor)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorId(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Monitor {
    pub id: MonitorId,
    pub primary: bool,
}

pub fn choose_monitor(configured: Option<&MonitorId>, monitors: &[Monitor]) -> Option<usize> {
    configured
        .and_then(|configured| {
            monitors
                .iter()
                .position(|monitor| &monitor.id == configured)
        })
        .or_else(|| monitors.iter().position(|monitor| monitor.primary))
        .or_else(|| (!monitors.is_empty()).then_some(0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollapseState {
    pub expanded: bool,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupToken {
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerExit {
    pub visual: CollapseState,
    pub cleanup: CleanupToken,
}

pub fn pointer_exit(state: CollapseState) -> PointerExit {
    let generation = state.generation.wrapping_add(1);
    PointerExit {
        visual: CollapseState {
            expanded: false,
            generation,
        },
        cleanup: CleanupToken { generation },
    }
}

pub fn pointer_enter(state: CollapseState) -> CollapseState {
    CollapseState {
        expanded: true,
        generation: state.generation.wrapping_add(1),
    }
}

pub fn cleanup_is_current(token: CleanupToken, state: CollapseState) -> bool {
    token.generation == state.generation && !state.expanded
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct LocalPoint {
    pub x: f64,
    pub y: f64,
}

pub fn rects_overlap(rect: &Rect, display: &Rect) -> bool {
    rect.x < display.x + display.width
        && rect.x + rect.width > display.x
        && rect.y < display.y + display.height
        && rect.y + rect.height > display.y
}

pub fn screen_rect_touches_display(rect: &Rect, displays: &[Rect]) -> bool {
    displays.iter().any(|display| rects_overlap(rect, display))
}

pub const EDGE_CORRIDOR_WIDTH: f64 = 480.0;
pub const EDGE_CORRIDOR_VERTICAL_SLACK: f64 = 48.0;

pub fn cursor_within_edge_corridor(display: &Rect, cursor: &CursorPoint, panel: &Rect) -> bool {
    let top = (panel.y - EDGE_CORRIDOR_VERTICAL_SLACK).max(display.y);
    let bottom =
        (panel.y + panel.height + EDGE_CORRIDOR_VERTICAL_SLACK).min(display.y + display.height);
    cursor.x >= display.x + display.width - EDGE_CORRIDOR_WIDTH
        && cursor.x <= display.x + display.width
        && cursor.y >= top
        && cursor.y <= bottom
}

pub fn cursor_within(rect: &Rect, cursor: &CursorPoint) -> bool {
    cursor.x >= rect.x
        && cursor.x <= rect.x + rect.width
        && cursor.y >= rect.y
        && cursor.y <= rect.y + rect.height
}

pub fn hover_cursor_inside(
    panel: &Rect,
    panel_display: Option<&Rect>,
    cursor: &CursorPoint,
    panel_open: bool,
) -> bool {
    cursor_within(panel, cursor)
        || panel_open
            && panel_display
                .is_some_and(|display| cursor_within_edge_corridor(display, cursor, panel))
}

pub fn cursor_to_window_local(window: &Rect, cursor: &CursorPoint) -> Option<LocalPoint> {
    cursor_within(window, cursor).then_some(LocalPoint {
        x: cursor.x - window.x,
        y: window.y + window.height - cursor.y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_matrix() {
        let frames = [
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            Rect {
                x: 1920.0,
                y: -200.0,
                width: 1728.0,
                height: 1117.0,
            },
        ];
        assert_eq!(
            COMPACT,
            Size {
                width: 8.0,
                height: 180.0
            }
        );
        assert_eq!(
            EXPANDED,
            Size {
                width: 420.0,
                height: 560.0
            }
        );
        for frame in frames {
            for size in [COMPACT, EXPANDED] {
                let resized = frame_for_size(frame, size);
                assert_eq!(resized.x + resized.width, frame.x + frame.width);
                assert_eq!(
                    resized.y + resized.height / 2.0,
                    frame.y + frame.height / 2.0
                );
            }
        }
    }

    #[test]
    fn removed_monitor_falls_back_to_primary() {
        let monitors = [
            Monitor {
                id: MonitorId("primary".into()),
                primary: true,
            },
            Monitor {
                id: MonitorId("projector".into()),
                primary: false,
            },
        ];
        assert_eq!(
            choose_monitor(Some(&MonitorId("removed".into())), &monitors),
            Some(0)
        );
        assert_eq!(
            choose_monitor(Some(&MonitorId("projector".into())), &monitors),
            Some(1)
        );
    }

    #[test]
    fn pointer_exit_collapses_before_native_cleanup() {
        let exit = pointer_exit(CollapseState {
            expanded: true,
            generation: 4,
        });
        assert_eq!(
            exit.visual,
            CollapseState {
                expanded: false,
                generation: 5
            }
        );
        assert_eq!(exit.cleanup, CleanupToken { generation: 5 });
        assert!(cleanup_is_current(exit.cleanup, exit.visual));
        assert!(!cleanup_is_current(
            exit.cleanup,
            pointer_enter(exit.visual)
        ));
    }

    #[test]
    fn certified_target_session_matrix_requires_full_notch_parity() {
        let certified = [
            (PlatformTarget::Macos, DesktopSession::AppKit),
            (PlatformTarget::Windows, DesktopSession::Win32),
            (PlatformTarget::Linux, DesktopSession::X11),
            (PlatformTarget::Linux, DesktopSession::KdeWayland),
        ];

        for (target, session) in certified {
            let contract = platform_contract(target, session).expect("certified session contract");
            assert_eq!(contract.compact, COMPACT);
            assert_eq!(contract.expanded, EXPANDED);
            assert!(contract.right_anchored);
            assert!(contract.vertically_centered);
            assert!(contract.hover_expands);
            assert!(contract.immediate_visual_collapse);
            assert!(contract.native_frame_cleanup);
            assert!(contract.focus_preserving);
            assert!(contract.topmost);
            assert!(contract.active_workspace);
            assert!(contract.dpi_aware);
            assert!(contract.monitor_fallback);
            assert_ne!(contract.pointer_tracking, PointerTracking::None);
        }
    }

    #[test]
    fn unsupported_or_mismatched_sessions_fail_with_parity_unsupported() {
        for (target, session) in [
            (PlatformTarget::Macos, DesktopSession::Win32),
            (PlatformTarget::Windows, DesktopSession::X11),
            (PlatformTarget::Linux, DesktopSession::Unknown),
        ] {
            let error = platform_contract(target, session).expect_err("session must be rejected");
            assert_eq!(error.code, "parity_unsupported");
            assert!(!error.tray_only_fallback);
            assert!(!error.message.is_empty());
        }
    }

    #[test]
    fn gnome_wayland_is_explicitly_unsupported_without_a_tray_fallback() {
        let error = platform_contract(PlatformTarget::Linux, DesktopSession::GnomeWayland)
            .expect_err("GNOME Wayland cannot satisfy layer-shell and global pointer parity");
        assert_eq!(error.code, "parity_unsupported");
        assert!(!error.tray_only_fallback);
    }

    #[test]
    fn kde_wayland_requires_layer_shell_and_surface_pointer_tracking() {
        let contract = platform_contract(PlatformTarget::Linux, DesktopSession::KdeWayland)
            .expect("KDE Wayland adapter contract");
        assert!(contract.requires_layer_shell);
        assert_eq!(contract.pointer_tracking, PointerTracking::Surface);
    }

    #[test]
    fn kde_wayland_uses_native_layer_surface_resize() {
        assert_eq!(
            resize_backend(DesktopSession::KdeWayland),
            ResizeBackend::GtkLayerSurface
        );
        assert_eq!(
            resize_backend(DesktopSession::X11),
            ResizeBackend::MappedWindow
        );
        assert_eq!(
            resize_backend(DesktopSession::GnomeWayland),
            ResizeBackend::Unsupported
        );
    }
}
