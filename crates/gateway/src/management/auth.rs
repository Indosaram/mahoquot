//! Management-API authentication, mirroring CLIProxyAPI's decision table.
//!
//! Upstream splits the answer across two layers and the distinction is
//! observable, so we reproduce both:
//!
//! * availability (`managementAvailabilityMiddleware`) answers **404** when the
//!   management surface is switched off, so a disabled server is
//!   indistinguishable from one that never had the routes.
//! * authentication (`Handler.Middleware`) answers **403** when the caller is
//!   remote and remote access is off, or no key is configured at all, and
//!   **401** when a key is configured but the caller presented none or a wrong
//!   one.
//!
//! Reference: `.omo/upstream/internal__api__handlers__management__handler.go`
//! (`AuthenticateManagementKey`) and `internal__api__server_management.go`
//! (`managementAvailable`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Upstream bans an IP for 30 minutes after 5 failed attempts.
const MAX_FAILURES: u32 = 5;
const BAN_DURATION: Duration = Duration::from_secs(30 * 60);

/// The outcome of an authentication attempt.
///
/// `Allow` carries no data; every rejection carries the exact status and
/// message upstream emits, because a client distinguishes them.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthOutcome {
    Allow,
    /// 401 - a key is configured, the caller failed to present a valid one.
    Unauthorized(&'static str),
    /// 403 - the caller may not use this surface at all.
    Forbidden(String),
}

/// Everything the decision needs, resolved from config + environment.
#[derive(Debug, Clone, Default)]
pub struct ManagementAuth {
    /// `remote-management.allow-remote`.
    pub allow_remote: bool,
    /// `remote-management.secret-key`; plaintext or a bcrypt hash.
    pub secret_key: String,
    /// `MANAGEMENT_PASSWORD`; compared verbatim.
    pub env_secret: String,
    /// A local-only password (TUI mode); accepted from loopback callers.
    pub local_password: String,
}

impl ManagementAuth {
    /// Upstream registers the management routes only when some secret exists.
    /// Without one the surface is absent, which is a 404, not a 401.
    pub fn is_enabled(&self) -> bool {
        !self.secret_key.is_empty()
            || !self.env_secret.is_empty()
            || !self.local_password.is_empty()
    }
}

#[derive(Debug, Default)]
struct AttemptInfo {
    count: u32,
    blocked_until: Option<Instant>,
}

/// Per-IP failed-attempt ledger enforcing the ban.
///
/// This is deliberately a plain `Mutex`: it is touched once per *management*
/// request, never by the relay hot path, so it cannot affect proxy latency.
#[derive(Debug, Default)]
pub struct AttemptLedger {
    attempts: Mutex<HashMap<String, AttemptInfo>>,
}

impl AttemptLedger {
    /// Authenticate one request, mirroring upstream's ordering exactly. The
    /// order matters: the ban is checked before the remote-access rule, which
    /// is checked before the "no key configured" rule, which precedes the
    /// missing-key check.
    pub fn authenticate(
        &self,
        auth: &ManagementAuth,
        client_ip: &str,
        local_client: bool,
        provided: &str,
    ) -> AuthOutcome {
        if let Some(remaining) = self.banned_for(client_ip) {
            return AuthOutcome::Forbidden(format!(
                "IP banned due to too many failed attempts. Try again in {}",
                format_duration(remaining)
            ));
        }

        if !local_client && !auth.allow_remote {
            return AuthOutcome::Forbidden("remote management disabled".to_string());
        }

        if auth.secret_key.is_empty() && auth.env_secret.is_empty() {
            return AuthOutcome::Forbidden("remote management key not set".to_string());
        }

        if provided.is_empty() {
            self.record_failure(client_ip);
            return AuthOutcome::Unauthorized("missing management key");
        }

        if local_client && !auth.local_password.is_empty() && provided == auth.local_password {
            self.reset(client_ip);
            return AuthOutcome::Allow;
        }

        if !auth.env_secret.is_empty() && provided == auth.env_secret {
            self.reset(client_ip);
            return AuthOutcome::Allow;
        }

        if !auth.secret_key.is_empty() && secret_matches(&auth.secret_key, provided) {
            self.reset(client_ip);
            return AuthOutcome::Allow;
        }

        self.record_failure(client_ip);
        AuthOutcome::Unauthorized("invalid management key")
    }

    fn banned_for(&self, client_ip: &str) -> Option<Duration> {
        let mut attempts = self.attempts.lock().expect("attempt ledger poisoned");
        let info = attempts.get_mut(client_ip)?;
        let blocked_until = info.blocked_until?;
        match blocked_until.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => Some(remaining),
            // The ban expired: clear it so the caller gets a fresh budget.
            _ => {
                info.blocked_until = None;
                info.count = 0;
                None
            }
        }
    }

    fn record_failure(&self, client_ip: &str) {
        let mut attempts = self.attempts.lock().expect("attempt ledger poisoned");
        let info = attempts.entry(client_ip.to_string()).or_default();
        info.count += 1;
        if info.count >= MAX_FAILURES {
            info.blocked_until = Some(Instant::now() + BAN_DURATION);
            info.count = 0;
        }
    }

    fn reset(&self, client_ip: &str) {
        let mut attempts = self.attempts.lock().expect("attempt ledger poisoned");
        if let Some(info) = attempts.get_mut(client_ip) {
            info.count = 0;
            info.blocked_until = None;
        }
    }
}

/// Upstream stores the secret either as a bcrypt hash or as plaintext. We
/// support the plaintext form (constant-time) and recognise a bcrypt hash by
/// its prefix so a hashed config is never silently compared as plaintext.
fn secret_matches(configured: &str, provided: &str) -> bool {
    if is_bcrypt_hash(configured) {
        // Verifying bcrypt requires the hashing crate; until that is wired a
        // hashed secret must never fall back to a plaintext comparison, which
        // would accept the hash string itself as the password.
        return false;
    }
    constant_time_eq(configured.as_bytes(), provided.as_bytes())
}

fn is_bcrypt_hash(value: &str) -> bool {
    value.starts_with("$2a$") || value.starts_with("$2b$") || value.starts_with("$2y$")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn format_duration(d: Duration) -> String {
    // Upstream rounds to the second before formatting (Go's Duration.String).
    let secs = d.as_secs();
    let (m, s) = (secs / 60, secs % 60);
    if m > 0 {
        format!("{m}m{s}s")
    } else {
        format!("{s}s")
    }
}

/// Extract the presented key, accepting both header forms upstream accepts:
/// `Authorization: Bearer <key>`, a bare `Authorization: <key>`, or
/// `X-Management-Key: <key>`.
pub fn presented_key(headers: &axum::http::HeaderMap) -> String {
    if let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if !value.is_empty() {
            let mut parts = value.splitn(2, ' ');
            let scheme = parts.next().unwrap_or_default();
            return match parts.next() {
                Some(token) if scheme.eq_ignore_ascii_case("bearer") => token.to_string(),
                _ => value.to_string(),
            };
        }
    }
    headers
        .get("X-Management-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_with_secret() -> ManagementAuth {
        ManagementAuth {
            secret_key: "s3cret".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn surface_is_disabled_when_no_secret_is_configured() {
        // given a config with no secret of any kind
        let auth = ManagementAuth::default();
        // then the routes must not be served at all (upstream answers 404)
        assert!(!auth.is_enabled());
    }

    #[test]
    fn any_configured_secret_enables_the_surface() {
        // given each secret source in turn
        for auth in [
            ManagementAuth {
                secret_key: "a".into(),
                ..Default::default()
            },
            ManagementAuth {
                env_secret: "b".into(),
                ..Default::default()
            },
            ManagementAuth {
                local_password: "c".into(),
                ..Default::default()
            },
        ] {
            // then the surface is available
            assert!(auth.is_enabled());
        }
    }

    #[test]
    fn missing_key_is_unauthorized_not_forbidden() {
        // given a configured secret and a local caller presenting nothing
        let ledger = AttemptLedger::default();
        // when authenticating
        let outcome = ledger.authenticate(&auth_with_secret(), "127.0.0.1", true, "");
        // then upstream's 401 message is returned
        assert_eq!(outcome, AuthOutcome::Unauthorized("missing management key"));
    }

    #[test]
    fn wrong_key_is_unauthorized() {
        // given a configured secret and a local caller presenting a wrong key
        let ledger = AttemptLedger::default();
        // when authenticating
        let outcome = ledger.authenticate(&auth_with_secret(), "127.0.0.1", true, "nope");
        // then it is rejected as invalid
        assert_eq!(outcome, AuthOutcome::Unauthorized("invalid management key"));
    }

    #[test]
    fn correct_key_is_allowed() {
        // given a configured secret and the matching key
        let ledger = AttemptLedger::default();
        // when authenticating
        let outcome = ledger.authenticate(&auth_with_secret(), "127.0.0.1", true, "s3cret");
        // then access is granted
        assert_eq!(outcome, AuthOutcome::Allow);
    }

    #[test]
    fn remote_caller_is_forbidden_unless_allow_remote() {
        // given a secret but remote access disabled
        let ledger = AttemptLedger::default();
        // when a non-loopback caller presents the correct key
        let outcome = ledger.authenticate(&auth_with_secret(), "10.0.0.9", false, "s3cret");
        // then it is refused as forbidden, not merely unauthorized
        assert_eq!(
            outcome,
            AuthOutcome::Forbidden("remote management disabled".to_string())
        );
    }

    #[test]
    fn remote_caller_is_allowed_when_allow_remote_is_set() {
        // given remote access enabled
        let ledger = AttemptLedger::default();
        let auth = ManagementAuth {
            allow_remote: true,
            secret_key: "s3cret".to_string(),
            ..Default::default()
        };
        // when a non-loopback caller presents the correct key
        let outcome = ledger.authenticate(&auth, "10.0.0.9", false, "s3cret");
        // then access is granted
        assert_eq!(outcome, AuthOutcome::Allow);
    }

    #[test]
    fn env_secret_is_accepted_verbatim() {
        // given only MANAGEMENT_PASSWORD configured
        let ledger = AttemptLedger::default();
        let auth = ManagementAuth {
            env_secret: "envpass".to_string(),
            ..Default::default()
        };
        // when the caller presents it
        let outcome = ledger.authenticate(&auth, "127.0.0.1", true, "envpass");
        // then access is granted
        assert_eq!(outcome, AuthOutcome::Allow);
    }

    #[test]
    fn local_password_is_only_honoured_for_loopback_callers() {
        // given a local password and remote access enabled so the remote path
        // reaches the key comparison rather than the remote guard
        let ledger = AttemptLedger::default();
        let auth = ManagementAuth {
            allow_remote: true,
            secret_key: "s3cret".to_string(),
            local_password: "localonly".to_string(),
            ..Default::default()
        };
        // when a loopback caller presents it, it is accepted
        assert_eq!(
            ledger.authenticate(&auth, "127.0.0.1", true, "localonly"),
            AuthOutcome::Allow
        );
        // but a remote caller presenting the same value is rejected
        assert_eq!(
            ledger.authenticate(&auth, "10.0.0.9", false, "localonly"),
            AuthOutcome::Unauthorized("invalid management key")
        );
    }

    #[test]
    fn ip_is_banned_after_five_failures() {
        // given five consecutive failures from one IP
        let ledger = AttemptLedger::default();
        let auth = auth_with_secret();
        for _ in 0..MAX_FAILURES {
            assert_eq!(
                ledger.authenticate(&auth, "127.0.0.1", true, "wrong"),
                AuthOutcome::Unauthorized("invalid management key")
            );
        }
        // when the correct key is finally presented
        let outcome = ledger.authenticate(&auth, "127.0.0.1", true, "s3cret");
        // then the ban outranks it
        assert!(matches!(outcome, AuthOutcome::Forbidden(msg) if msg.starts_with("IP banned")));
    }

    #[test]
    fn a_success_clears_the_failure_count() {
        // given four failures followed by a success
        let ledger = AttemptLedger::default();
        let auth = auth_with_secret();
        for _ in 0..(MAX_FAILURES - 1) {
            ledger.authenticate(&auth, "127.0.0.1", true, "wrong");
        }
        assert_eq!(
            ledger.authenticate(&auth, "127.0.0.1", true, "s3cret"),
            AuthOutcome::Allow
        );
        // when four more failures occur, the budget must have restarted
        for _ in 0..(MAX_FAILURES - 1) {
            assert_eq!(
                ledger.authenticate(&auth, "127.0.0.1", true, "wrong"),
                AuthOutcome::Unauthorized("invalid management key")
            );
        }
        // then the caller is still not banned
        assert_eq!(
            ledger.authenticate(&auth, "127.0.0.1", true, "s3cret"),
            AuthOutcome::Allow
        );
    }

    #[test]
    fn a_bcrypt_hashed_secret_never_accepts_the_hash_as_the_password() {
        // given a bcrypt-hashed secret in config
        let ledger = AttemptLedger::default();
        let auth = ManagementAuth {
            secret_key: "$2a$10$abcdefghijklmnopqrstuv".to_string(),
            ..Default::default()
        };
        // when a caller presents the hash string itself
        let outcome = ledger.authenticate(&auth, "127.0.0.1", true, "$2a$10$abcdefghijklmnopqrstuv");
        // then it is rejected rather than compared as plaintext
        assert_eq!(outcome, AuthOutcome::Unauthorized("invalid management key"));
    }

    #[test]
    fn presented_key_accepts_every_upstream_header_form() {
        use axum::http::HeaderMap;

        // given each accepted header form
        let mut bearer = HeaderMap::new();
        bearer.insert(axum::http::header::AUTHORIZATION, "Bearer tok".parse().unwrap());
        let mut bare = HeaderMap::new();
        bare.insert(axum::http::header::AUTHORIZATION, "tok".parse().unwrap());
        let mut custom = HeaderMap::new();
        custom.insert("X-Management-Key", "tok".parse().unwrap());

        // then each yields the same key
        assert_eq!(presented_key(&bearer), "tok");
        assert_eq!(presented_key(&bare), "tok");
        assert_eq!(presented_key(&custom), "tok");
        assert_eq!(presented_key(&HeaderMap::new()), "");
    }
}
