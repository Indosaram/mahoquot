use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayOwnership {
    OwnedLocal,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownStep {
    RequestGraceful,
    FlushHistory,
    WaitForExit,
    ForceTerminate,
}

pub fn shutdown_plan(ownership: GatewayOwnership, graceful_exit: bool) -> Vec<ShutdownStep> {
    match ownership {
        GatewayOwnership::Remote => Vec::new(),
        GatewayOwnership::OwnedLocal if graceful_exit => vec![
            ShutdownStep::RequestGraceful,
            ShutdownStep::FlushHistory,
            ShutdownStep::WaitForExit,
        ],
        GatewayOwnership::OwnedLocal => vec![
            ShutdownStep::RequestGraceful,
            ShutdownStep::FlushHistory,
            ShutdownStep::WaitForExit,
            ShutdownStep::ForceTerminate,
        ],
    }
}

/// Picks the one line the console shows as a failed start's headline.
///
/// A gateway that rejects its configuration dies with an anyhow report:
/// `Error: <cause>` followed by an indented `Caused by:` block. That first
/// line is the actionable sentence, so it wins; anything else (a panic, a
/// dynamic loader error) is reported through its last content line instead of
/// being thrown away.
pub fn failure_headline(stderr_tail: &str) -> Option<String> {
    let lines: Vec<&str> = stderr_tail
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines
        .iter()
        .find(|line| line.starts_with("Error:"))
        .or_else(|| lines.last())
        .map(|line| (*line).to_string())
}

// ---------------------------------------------------------------------------
// Respawn policy: exponential backoff with jitter to prevent thundering herds
// when the gateway keeps crashing.
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF: Duration = Duration::from_millis(200);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const HEALTHY_THRESHOLD: Duration = Duration::from_secs(10);
const MAX_RAPID_FAILURES: u32 = 5;

/// Pure policy deciding whether and when to respawn after an unexpected exit.
#[derive(Debug, Clone)]
pub struct RespawnPolicy {
    consecutive_failures: u32,
    current_backoff: Duration,
}

/// What the watchdog should do after the gateway exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RespawnDecision {
    /// Wait the given duration, then respawn.
    Respawn { delay: Duration },
    /// Too many rapid failures; give up until manual intervention.
    GiveUp,
}

impl RespawnPolicy {
    pub fn new() -> Self {
        Self {
            consecutive_failures: 0,
            current_backoff: INITIAL_BACKOFF,
        }
    }

    /// Record that the gateway exited after running for `uptime`. Returns what
    /// the watchdog should do next.
    pub fn record_exit(&mut self, uptime: Duration) -> RespawnDecision {
        if uptime >= HEALTHY_THRESHOLD {
            // It ran long enough; reset the backoff.
            self.consecutive_failures = 0;
            self.current_backoff = INITIAL_BACKOFF;
            return RespawnDecision::Respawn {
                delay: INITIAL_BACKOFF,
            };
        }

        self.consecutive_failures += 1;
        if self.consecutive_failures >= MAX_RAPID_FAILURES {
            return RespawnDecision::GiveUp;
        }

        let delay = self.current_backoff;
        self.current_backoff = (self.current_backoff * 2).min(MAX_BACKOFF);
        RespawnDecision::Respawn { delay }
    }

    /// Reset the backoff state (e.g. after a manual start).
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.consecutive_failures = 0;
        self.current_backoff = INITIAL_BACKOFF;
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }
}

impl Default for RespawnPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_sidecar_graceful_shutdown_flushes_and_reaps() {
        assert_eq!(
            shutdown_plan(GatewayOwnership::OwnedLocal, true),
            [
                ShutdownStep::RequestGraceful,
                ShutdownStep::FlushHistory,
                ShutdownStep::WaitForExit,
            ]
        );
    }

    #[test]
    fn hung_owned_sidecar_escalates_once() {
        let plan = shutdown_plan(GatewayOwnership::OwnedLocal, false);
        assert_eq!(
            plan.iter()
                .filter(|step| **step == ShutdownStep::ForceTerminate)
                .count(),
            1
        );
        assert_eq!(plan.last(), Some(&ShutdownStep::ForceTerminate));
    }

    #[test]
    fn remote_gateway_is_never_signaled() {
        assert!(shutdown_plan(GatewayOwnership::Remote, false).is_empty());
    }

    #[test]
    fn healthy_uptime_resets_backoff() {
        let mut policy = RespawnPolicy::new();
        // Simulate a few rapid failures first
        policy.record_exit(Duration::from_millis(100));
        policy.record_exit(Duration::from_millis(50));
        assert_eq!(policy.consecutive_failures(), 2);

        // Then a healthy run
        let decision = policy.record_exit(Duration::from_secs(60));
        assert_eq!(
            decision,
            RespawnDecision::Respawn {
                delay: INITIAL_BACKOFF
            }
        );
        assert_eq!(policy.consecutive_failures(), 0);
    }

    #[test]
    fn rapid_failures_escalate_backoff_then_give_up() {
        let mut policy = RespawnPolicy::new();
        let short = Duration::from_millis(50);

        // First failure: initial backoff
        assert_eq!(
            policy.record_exit(short),
            RespawnDecision::Respawn {
                delay: Duration::from_millis(200)
            }
        );
        // Second: doubled
        assert_eq!(
            policy.record_exit(short),
            RespawnDecision::Respawn {
                delay: Duration::from_millis(400)
            }
        );
        // Third: doubled again
        assert_eq!(
            policy.record_exit(short),
            RespawnDecision::Respawn {
                delay: Duration::from_millis(800)
            }
        );
        // Fourth: doubled
        assert_eq!(
            policy.record_exit(short),
            RespawnDecision::Respawn {
                delay: Duration::from_millis(1600)
            }
        );
        // Fifth: give up
        assert_eq!(policy.record_exit(short), RespawnDecision::GiveUp);
    }

    #[test]
    fn backoff_caps_at_maximum() {
        let mut policy = RespawnPolicy::new();
        let short = Duration::from_millis(50);
        // Push backoff beyond max
        policy.record_exit(short); // 200ms
        policy.record_exit(short); // 400ms
        policy.record_exit(short); // 800ms
                                   // Before the 5th failure, reset and push again to test cap
        policy.reset();
        for _ in 0..4 {
            policy.record_exit(short);
        }
        // After 4 rapid failures: 200, 400, 800, 1600 — next would be 3200
        // but we gave up at 5. Reset and verify the cap path.
        policy.reset();
        policy.current_backoff = Duration::from_secs(20);
        let decision = policy.record_exit(short);
        assert_eq!(
            decision,
            RespawnDecision::Respawn {
                delay: Duration::from_secs(20)
            }
        );
        // Next doubles but caps at 30s
        let decision = policy.record_exit(short);
        assert_eq!(
            decision,
            RespawnDecision::Respawn {
                delay: Duration::from_secs(30)
            }
        );
    }

    #[test]
    fn config_rejection_headline_is_the_error_line() {
        let tail = concat!(
            "2026-09-18T05:15:48Z  INFO mahoquot_gateway: starting mahoquot-gateway port=18801\n",
            "2026-09-18T05:15:48Z  WARN mahoquot_gateway::account: skipping credential\n",
            "Error: registry validation error: alias 'glm-5.3-flash' points to unknown target 'z-ai/glm-5.3'\n",
            "\n",
            "Caused by:\n",
            "    alias 'glm-5.3-flash' points to unknown target 'z-ai/glm-5.3'\n",
        );
        assert_eq!(
            failure_headline(tail).as_deref(),
            Some(
                "Error: registry validation error: alias 'glm-5.3-flash' points to unknown target 'z-ai/glm-5.3'"
            )
        );
    }

    #[test]
    fn headline_falls_back_to_the_last_content_line() {
        let tail =
            "dyld[1]: Library not loaded: @rpath/libssl.3.dylib\n  Reason: image not found\n\n";
        assert_eq!(
            failure_headline(tail).as_deref(),
            Some("Reason: image not found")
        );
    }

    #[test]
    fn silent_death_has_no_headline() {
        assert_eq!(failure_headline(""), None);
        assert_eq!(failure_headline("   \n\n\t\n"), None);
    }

    #[test]
    fn manual_reset_clears_failure_state() {
        let mut policy = RespawnPolicy::new();
        for _ in 0..4 {
            policy.record_exit(Duration::from_millis(50));
        }
        assert_eq!(policy.consecutive_failures(), 4);
        policy.reset();
        assert_eq!(policy.consecutive_failures(), 0);
        // Should respawn immediately, not give up
        let decision = policy.record_exit(Duration::from_millis(50));
        assert!(matches!(decision, RespawnDecision::Respawn { .. }));
    }
}
