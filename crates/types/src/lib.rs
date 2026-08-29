//! Shared domain model for mahoquot-rs.
//! M1 인터페이스는 잠김(LOCKED): 변경은 리드 승인 필요.

/// Affinity hint extracted from an inbound request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionHint {
    /// Stable key identifying a conversation/thread. None = one-shot request.
    pub affinity_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Available,
    /// Unavailable until the given unix-ms timestamp (rate-limit window).
    Cooldown {
        until_unix_ms: i64,
    },
    /// Needs re-authentication.
    AuthFailed,
    /// Manually disabled.
    Disabled,
}

impl Health {
    pub fn is_available(&self, now_unix_ms: i64) -> bool {
        match self {
            Health::Available => true,
            Health::Cooldown { until_unix_ms } => *until_unix_ms <= now_unix_ms,
            _ => false,
        }
    }
}

/// Result of serving one request through a member.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Success,
    RateLimited { retry_after_secs: Option<i64> },
    AuthFailed,
    ServerError,
    NetworkError,
}

/// A member of the routing pool as observed by the router.
pub trait PoolMember: Send + Sync {
    /// Stable unique id (identity must survive list reordering).
    fn id(&self) -> &str;
    fn health(&self) -> Health;
    /// Usage-window reset time (unix seconds), if known.
    fn reset_at_unix(&self) -> Option<i64> {
        None
    }
    /// Preference weight (higher = preferred). Equal by default.
    fn weight(&self) -> u32 {
        1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Strategy {
    /// Deterministic even rotation across currently-available members.
    #[default]
    StrictRoundRobin,
    /// Always the first available member in list order until it cools down.
    FillFirst,
}
