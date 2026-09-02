#![allow(dead_code)]

use crate::notch::PlatformTarget;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotchStartup {
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleStartup {
    HiddenUnfocused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSource {
    Rust,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginStartupPlan {
    pub desktop: bool,
    pub owned_gateway: bool,
    pub tray: bool,
    pub notch: NotchStartup,
    pub console: ConsoleStartup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginStartPlan {
    pub start_desktop: bool,
    pub start_owned_gateway: bool,
    pub show_tray: bool,
    pub show_compact_notch: bool,
    pub focus_console: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationCategory {
    AuthIsolated,
    SchedulerAllExhausted,
    DegradedHistory,
    UpdateReady,
    UpdateFailed,
    TunnelFailed,
}

impl NotificationCategory {
    pub const ALL: [Self; 6] = [
        Self::AuthIsolated,
        Self::SchedulerAllExhausted,
        Self::DegradedHistory,
        Self::UpdateReady,
        Self::UpdateFailed,
        Self::TunnelFailed,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthIsolated => "auth_isolated",
            Self::SchedulerAllExhausted => "scheduler_all_exhausted",
            Self::DegradedHistory => "degraded_history",
            Self::UpdateReady => "update_ready",
            Self::UpdateFailed => "update_failed",
            Self::TunnelFailed => "tunnel_failed",
        }
    }

    const fn default_title(self) -> &'static str {
        match self {
            Self::AuthIsolated => "Account isolated",
            Self::SchedulerAllExhausted => "All accounts exhausted",
            Self::DegradedHistory => "Request history degraded",
            Self::UpdateReady => "Update ready",
            Self::UpdateFailed => "Update failed",
            Self::TunnelFailed => "Public tunnel failed",
        }
    }

    const fn default_body(self) -> &'static str {
        match self {
            Self::AuthIsolated => "An account was isolated after an authentication failure.",
            Self::SchedulerAllExhausted => {
                "No configured account currently has capacity to serve requests."
            }
            Self::DegradedHistory => "Durable request history is not recording reliably.",
            Self::UpdateReady => "A verified Mahoquot update is ready to install.",
            Self::UpdateFailed => "Mahoquot could not complete the update check or download.",
            Self::TunnelFailed => "The public tunnel stopped unexpectedly.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationEvent {
    pub category: NotificationCategory,
    pub title: String,
    pub body: String,
}

impl NotificationEvent {
    pub fn new(category: NotificationCategory, title: &str, body: &str) -> Self {
        Self {
            category,
            title: title.to_string(),
            body: body.to_string(),
        }
    }

    pub fn category(category: NotificationCategory) -> Self {
        Self::new(category, category.default_title(), category.default_body())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObservedState {
    AuthIsolated { account: String },
    SchedulerAllExhausted,
    HistoryDegraded { detail: String },
    UpdateReady { version: String },
    UpdateFailed { detail: String },
    TunnelFailed { detail: String },
}

#[derive(Default)]
pub struct StateObserver {
    observed: HashSet<ObservedState>,
}

impl StateObserver {
    /// Emits once for each distinct native state. State transitions are pushed
    /// into this Rust observer by the owning service; no webview polling is
    /// involved in notification delivery.
    pub fn observe(&mut self, state: ObservedState) -> Option<NotificationEvent> {
        if self
            .observed
            .iter()
            .any(|observed| observed.same_kind(&state))
        {
            return None;
        }
        self.observed.insert(state.clone());
        Some(match state {
            ObservedState::AuthIsolated { account } => NotificationEvent::new(
                NotificationCategory::AuthIsolated,
                "Account isolated",
                &format!("{account} was isolated after an authentication failure."),
            ),
            ObservedState::SchedulerAllExhausted => {
                NotificationEvent::category(NotificationCategory::SchedulerAllExhausted)
            }
            ObservedState::HistoryDegraded { .. } => {
                NotificationEvent::category(NotificationCategory::DegradedHistory)
            }
            ObservedState::UpdateReady { .. } => {
                NotificationEvent::category(NotificationCategory::UpdateReady)
            }
            ObservedState::UpdateFailed { .. } => {
                NotificationEvent::category(NotificationCategory::UpdateFailed)
            }
            ObservedState::TunnelFailed { .. } => {
                NotificationEvent::category(NotificationCategory::TunnelFailed)
            }
        })
    }

    pub fn clear(&mut self, state: &ObservedState) {
        self.observed.retain(|observed| !observed.same_kind(state));
    }
}

impl ObservedState {
    fn same_kind(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (Self::AuthIsolated { .. }, Self::AuthIsolated { .. })
                | (Self::SchedulerAllExhausted, Self::SchedulerAllExhausted)
                | (Self::HistoryDegraded { .. }, Self::HistoryDegraded { .. })
                | (Self::UpdateReady { .. }, Self::UpdateReady { .. })
                | (Self::UpdateFailed { .. }, Self::UpdateFailed { .. })
                | (Self::TunnelFailed { .. }, Self::TunnelFailed { .. })
        )
    }
}

pub struct OsIntegrationPolicy {
    target: PlatformTarget,
}

impl OsIntegrationPolicy {
    pub fn for_target(target: PlatformTarget) -> Self {
        Self { target }
    }

    pub fn login_startup(&self, enabled: bool) -> LoginStartupPlan {
        let _ = self.target;
        login_startup_plan(enabled)
    }

    pub fn notification_categories(&self) -> Vec<NotificationCategory> {
        NotificationCategory::ALL.to_vec()
    }

    pub fn observation_source(&self) -> ObservationSource {
        ObservationSource::Rust
    }
}

pub fn login_startup_plan(enabled: bool) -> LoginStartupPlan {
    LoginStartupPlan {
        desktop: enabled,
        owned_gateway: enabled,
        tray: enabled,
        notch: NotchStartup::Compact,
        console: ConsoleStartup::HiddenUnfocused,
    }
}

pub fn login_start_plan(enabled: bool) -> LoginStartPlan {
    let plan = login_startup_plan(enabled);
    LoginStartPlan {
        start_desktop: plan.desktop,
        start_owned_gateway: plan.owned_gateway,
        show_tray: plan.tray,
        show_compact_notch: plan.notch == NotchStartup::Compact,
        focus_console: plan.console != ConsoleStartup::HiddenUnfocused,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationServiceStatus {
    Available,
    PermissionDenied,
    ServiceUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationServiceState {
    Available,
    PermissionDenied,
    Unavailable,
}

impl From<NotificationServiceState> for NotificationServiceStatus {
    fn from(value: NotificationServiceState) -> Self {
        match value {
            NotificationServiceState::Available => Self::Available,
            NotificationServiceState::PermissionDenied => Self::PermissionDenied,
            NotificationServiceState::Unavailable => Self::ServiceUnavailable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeSettingsState {
    pub login_start_enabled: bool,
    pub notifications: NotificationServiceStatus,
    pub action: Option<String>,
    pub gateway_running: bool,
    pub notch: NotchStartup,
}

impl NativeSettingsState {
    pub fn new(gateway_running: bool, status: NotificationServiceStatus) -> Self {
        let action = match status {
            NotificationServiceStatus::Available => None,
            NotificationServiceStatus::PermissionDenied => {
                Some("Enable notifications in system settings, then retry.".to_string())
            }
            NotificationServiceStatus::ServiceUnavailable => {
                Some("Retry when the system notification service is available.".to_string())
            }
        };
        Self {
            login_start_enabled: false,
            notifications: status,
            action,
            gateway_running,
            notch: NotchStartup::Compact,
        }
    }

    pub fn with_login_start(mut self, enabled: bool) -> Self {
        self.login_start_enabled = enabled;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimpleNotification {
    pub category: &'static str,
    pub title: String,
    pub body: String,
}

pub fn notification_for(
    category: NotificationCategory,
    status: NotificationServiceState,
) -> Result<SimpleNotification, String> {
    match NotificationServiceStatus::from(status) {
        NotificationServiceStatus::PermissionDenied => {
            Err("notification permission denied; enable it in system settings".to_string())
        }
        NotificationServiceStatus::ServiceUnavailable => {
            Err("notification service unavailable; retry when the service is running".to_string())
        }
        NotificationServiceStatus::Available => {
            let event = NotificationEvent::category(category);
            Ok(SimpleNotification {
                category: category.as_str(),
                title: event.title,
                body: event.body,
            })
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn login_start_and_auth_isolation_notification() {
        let expected_startup = LoginStartupPlan {
            desktop: true,
            owned_gateway: true,
            tray: true,
            notch: NotchStartup::Compact,
            console: ConsoleStartup::HiddenUnfocused,
        };
        let expected_categories = vec![
            NotificationCategory::AuthIsolated,
            NotificationCategory::SchedulerAllExhausted,
            NotificationCategory::DegradedHistory,
            NotificationCategory::UpdateReady,
            NotificationCategory::UpdateFailed,
            NotificationCategory::TunnelFailed,
        ];

        for target in [
            PlatformTarget::Macos,
            PlatformTarget::Windows,
            PlatformTarget::Linux,
        ] {
            let policy = OsIntegrationPolicy::for_target(target);
            assert_eq!(policy.login_startup(true), expected_startup);
            assert_eq!(policy.notification_categories(), expected_categories);
            assert_eq!(policy.observation_source(), ObservationSource::Rust);

            let mut observer = StateObserver::default();
            assert_eq!(
                observer.observe(ObservedState::AuthIsolated {
                    account: "codex-work".into(),
                }),
                Some(NotificationEvent::new(
                    NotificationCategory::AuthIsolated,
                    "Account isolated",
                    "codex-work was isolated after an authentication failure.",
                ))
            );
            assert_eq!(
                observer.observe(ObservedState::SchedulerAllExhausted),
                Some(NotificationEvent::category(
                    NotificationCategory::SchedulerAllExhausted
                ))
            );
            assert_eq!(
                observer.observe(ObservedState::HistoryDegraded {
                    detail: "SQLite writer unavailable".into(),
                }),
                Some(NotificationEvent::category(
                    NotificationCategory::DegradedHistory
                ))
            );
            assert_eq!(
                observer.observe(ObservedState::UpdateReady {
                    version: "0.2.0".into(),
                }),
                Some(NotificationEvent::category(
                    NotificationCategory::UpdateReady
                ))
            );
            assert_eq!(
                observer.observe(ObservedState::UpdateFailed {
                    detail: "signature rejected".into(),
                }),
                Some(NotificationEvent::category(
                    NotificationCategory::UpdateFailed
                ))
            );
            assert_eq!(
                observer.observe(ObservedState::TunnelFailed {
                    detail: "cloudflared exited".into(),
                }),
                Some(NotificationEvent::category(
                    NotificationCategory::TunnelFailed
                ))
            );
        }

        for status in [
            NotificationServiceStatus::PermissionDenied,
            NotificationServiceStatus::ServiceUnavailable,
        ] {
            let state = NativeSettingsState::new(true, status);
            assert!(state.action.is_some(), "failure state must be actionable");
            assert!(
                state.gateway_running,
                "notification failures cannot stop the gateway"
            );
            assert_eq!(state.notch, NotchStartup::Compact);
        }
    }
}
