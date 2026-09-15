use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Ttft {
    #[serde(default)]
    pub p50_ms: f64,
    #[serde(default)]
    pub p90_ms: f64,
    #[serde(default)]
    pub p99_ms: f64,
    #[serde(default)]
    pub samples: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct LastError {
    #[serde(default)]
    pub unix_ms: i64,
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AccountStats {
    pub id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub usage: Usage,
    #[serde(default)]
    pub health: serde_json::Value,
    #[serde(default)]
    pub ok: u64,
    #[serde(default)]
    pub fails: u64,
    #[serde(default)]
    pub reset_at_unix_ms: Option<i64>,
    #[serde(default)]
    pub last_error: Option<LastError>,
    // An account that has served no request reports ttft as null, which
    // `default` alone does not cover: serde still parses the null and fails.
    #[serde(default, deserialize_with = "null_as_default")]
    pub ttft: Ttft,
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AdminStats {
    #[serde(default)]
    pub uptime_secs: i64,
    #[serde(default)]
    pub in_flight: u64,
    #[serde(default)]
    pub served: u64,
    #[serde(default)]
    pub failed_over: u64,
    #[serde(default)]
    pub refreshed: u64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub ttft: Ttft,
    #[serde(default)]
    pub accounts: Vec<AccountStats>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct QuotaWindow {
    pub used_percent: Option<f64>,
    pub window_minutes: Option<i64>,
    pub reset_after_seconds: Option<i64>,
    pub reset_at_unix: Option<i64>,
    pub limit_name: Option<String>,
}

/// Model-family quota group the gateway forwards for providers that report
/// per-model-bucket usage (e.g. Antigravity). Native views surface these so
/// grouped providers do not collapse to a single misleading pair of windows.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct QuotaGroup {
    #[serde(default, deserialize_with = "null_as_default")]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub models: Option<String>,
    #[serde(default)]
    pub buckets: Vec<QuotaBucket>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct QuotaBucket {
    #[serde(default, deserialize_with = "null_as_default")]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub window: Option<String>,
    pub used_percent: Option<f64>,
    pub reset_at_unix: Option<i64>,
    pub reset_after_seconds: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct Usage {
    pub plan_type: Option<String>,
    pub active_limit: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub primary: QuotaWindow,
    #[serde(default, deserialize_with = "null_as_default")]
    pub secondary: QuotaWindow,
    #[serde(default)]
    pub groups: Vec<QuotaGroup>,
    pub credits_balance: Option<f64>,
    pub credits_unlimited: Option<bool>,
    pub has_credits: Option<bool>,
    pub reset_credits_available: Option<i64>,
    #[serde(default)]
    pub reset_credits: Vec<ResetCredit>,
    pub observed_at_unix: Option<i64>,
}

/// One banked rate-limit reset credit as the gateway reports it.
///
/// Codex credits lapse (~30 days after they are granted), so the count alone
/// cannot tell the operator whether a reset is safe to save or about to be
/// lost. Every field is optional because a gateway that predates this detail
/// simply omits the list.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct ResetCredit {
    pub granted_at_unix: Option<i64>,
    pub expires_at_unix: Option<i64>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WindowView {
    pub used_percent: Option<f64>,
    pub window_minutes: Option<i64>,
    pub reset_in_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct GroupView {
    pub name: Option<String>,
    pub models: Option<String>,
    pub buckets: Vec<BucketView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct BucketView {
    pub name: Option<String>,
    pub window: Option<String>,
    pub used_percent: Option<f64>,
    pub reset_in_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AccountView {
    pub id: String,
    pub provider: String,
    pub status: String,
    pub usage_known: bool,
    pub plan_type: Option<String>,
    pub credits_balance: Option<f64>,
    pub credits_unlimited: Option<bool>,
    pub reset_credits_available: Option<i64>,
    #[serde(default)]
    pub reset_credits: Vec<ResetCredit>,
    pub can_reset: bool,
    pub primary: WindowView,
    pub secondary: WindowView,
    #[serde(default)]
    pub groups: Vec<GroupView>,
    pub ok: u64,
    pub fails: u64,
    pub failure_rate: f64,
    pub p50_ms: f64,
    pub p99_ms: f64,
    pub samples: u64,
    pub cooldown_remaining_secs: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MonitorView {
    pub uptime_secs: i64,
    pub in_flight: u64,
    pub served: u64,
    pub failed_over: u64,
    pub refreshed: u64,
    pub failover_rate: f64,
    pub p50_ms: f64,
    pub p99_ms: f64,
    pub accounts: Vec<AccountView>,
    pub degraded: Vec<String>,
}

fn resolve_cooldown_deadline(
    health: &serde_json::Value,
    reset_at_unix_ms: Option<i64>,
) -> Option<i64> {
    reset_at_unix_ms
        .or_else(|| health.get("until_unix_ms").and_then(|v| v.as_i64()))
        .or_else(|| health.get("reset_at_unix_ms").and_then(|v| v.as_i64()))
        .filter(|&v| v > 0)
}

fn status_of(
    health: &serde_json::Value,
    reset_at_unix_ms: Option<i64>,
    now_unix_ms: i64,
) -> String {
    let raw = health
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or_else(|| health.as_str().unwrap_or("unknown"));

    if raw.eq_ignore_ascii_case("cooldown") {
        if let Some(until) = resolve_cooldown_deadline(health, reset_at_unix_ms) {
            if until <= now_unix_ms {
                return "available".to_string();
            }
        }
        return "cooldown".to_string();
    }

    raw.to_string()
}

/// Health strings the gateway may add over time must not silently read as
/// degraded, so only states that actually mean trouble are listed. A
/// whitelist of "available" would flag every future healthy state instead.
fn status_is_degraded(status: &str) -> bool {
    matches!(status, "cooldown" | "error" | "failed" | "unavailable")
}

/// Resolve a window to a countdown, preferring the absolute reset timestamp
/// because the relative one ages while the snapshot sits in gateway memory.
fn reset_countdown(
    reset_at_unix: Option<i64>,
    reset_after_seconds: Option<i64>,
    observed_at: Option<i64>,
    now_secs: i64,
) -> Option<i64> {
    if let Some(at) = reset_at_unix.filter(|v| *v > 0) {
        Some((at - now_secs).max(0))
    } else {
        reset_after_seconds
            .filter(|v| *v > 0)
            .zip(observed_at)
            .map(|(after, obs)| (after - (now_secs - obs)).max(0))
    }
}

fn window_view(w: &QuotaWindow, observed_at: Option<i64>, now_secs: i64) -> WindowView {
    WindowView {
        used_percent: w.used_percent,
        window_minutes: w.window_minutes,
        reset_in_secs: reset_countdown(
            w.reset_at_unix,
            w.reset_after_seconds,
            observed_at,
            now_secs,
        ),
    }
}

fn rate(fails: u64, ok: u64) -> f64 {
    let total = ok + fails;
    if total == 0 {
        return 0.0;
    }
    (fails as f64) / (total as f64)
}

pub fn build_view(stats: &AdminStats, now_unix_ms: i64) -> MonitorView {
    let accounts: Vec<AccountView> = stats
        .accounts
        .iter()
        .map(|a| AccountView {
            id: a.id.clone(),
            provider: if a.provider.is_empty() {
                "unknown".to_string()
            } else {
                a.provider.clone()
            },
            status: status_of(&a.health, a.reset_at_unix_ms, now_unix_ms),
            ok: a.ok,
            fails: a.fails,
            failure_rate: rate(a.fails, a.ok),
            usage_known: a.usage.observed_at_unix.is_some(),
            plan_type: a.usage.plan_type.clone(),
            credits_balance: a.usage.credits_balance,
            credits_unlimited: a.usage.credits_unlimited,
            reset_credits_available: a.usage.reset_credits_available,
            reset_credits: a.usage.reset_credits.clone(),
            can_reset: a.usage.reset_credits_available.unwrap_or(0) > 0,
            primary: window_view(
                &a.usage.primary,
                a.usage.observed_at_unix,
                now_unix_ms / 1000,
            ),
            secondary: window_view(
                &a.usage.secondary,
                a.usage.observed_at_unix,
                now_unix_ms / 1000,
            ),
            groups: a
                .usage
                .groups
                .iter()
                .map(|group| GroupView {
                    name: group.display_name.clone(),
                    models: group.models.clone(),
                    buckets: group
                        .buckets
                        .iter()
                        .map(|bucket| BucketView {
                            name: bucket.display_name.clone(),
                            window: bucket.window.clone(),
                            used_percent: bucket.used_percent,
                            reset_in_secs: reset_countdown(
                                bucket.reset_at_unix,
                                bucket.reset_after_seconds,
                                a.usage.observed_at_unix,
                                now_unix_ms / 1000,
                            ),
                        })
                        .collect(),
                })
                .collect(),
            p50_ms: a.ttft.p50_ms,
            p99_ms: a.ttft.p99_ms,
            samples: a.ttft.samples,
            cooldown_remaining_secs: resolve_cooldown_deadline(&a.health, a.reset_at_unix_ms)
                .map(|until| ((until - now_unix_ms).max(0)) / 1000),
            last_error: a
                .last_error
                .as_ref()
                .filter(|e| !e.message.is_empty())
                .map(|e| format!("{} {}", e.status, e.message)),
        })
        .collect();

    let degraded: Vec<String> = accounts
        .iter()
        .filter(|a| status_is_degraded(&a.status) || (a.failure_rate > 0.5 && a.ok + a.fails >= 2))
        .map(|a| a.id.clone())
        .collect();

    MonitorView {
        uptime_secs: stats.uptime_secs,
        in_flight: stats.in_flight,
        served: stats.served,
        failed_over: stats.failed_over,
        refreshed: stats.refreshed,
        failover_rate: rate(stats.failed_over, stats.served),
        p50_ms: stats.ttft.p50_ms,
        p99_ms: stats.ttft.p99_ms,
        accounts,
        degraded,
    }
}

pub async fn fetch_stats(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> Result<AdminStats, String> {
    let url = format!("{}/admin/stats", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("gateway returned {}: {}", status.as_u16(), body));
    }
    serde_json::from_str(&body).map_err(|e| format!("parse failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats_json() -> AdminStats {
        serde_json::from_str(
            r#"{"uptime_secs":31,"in_flight":0,"served":10,"failed_over":4,"refreshed":1,
                "ttft":{"p50_ms":100.0,"p90_ms":200.0,"p99_ms":300.0,"samples":10},
                "accounts":[
                  {"id":"565c2911-account-f@example.com","health":{"status":"available"},
                   "ok":0,"fails":1,"reset_at_unix_ms":null,
                   "last_error":{"unix_ms":1,"status":400,"message":"model not supported by account"},
                   "ttft":{"p50_ms":426.0,"p90_ms":426.0,"p99_ms":426.0,"samples":1}},
                  {"id":"account-owner@gmail.com","health":{"status":"available"},
                   "ok":5,"fails":0,"reset_at_unix_ms":null,"last_error":null,
                   "ttft":{"p50_ms":50.0,"p90_ms":60.0,"p99_ms":70.0,"samples":5}},
                  {"id":"cooling@x.io","health":{"status":"cooldown"},
                   "ok":1,"fails":3,"reset_at_unix_ms":10000,"last_error":null,
                   "ttft":{"p50_ms":0.0,"p90_ms":0.0,"p99_ms":0.0,"samples":0}}
                ]}"#,
        )
        .expect("parse live-shaped stats")
    }

    #[test]
    fn null_ttft_from_idle_account_parses() {
        let s: AdminStats = serde_json::from_str(
            r#"{"uptime_secs":1,"served":0,"failed_over":0,"ttft":null,
                "accounts":[{"id":"idle@x.io","health":{"status":"available"},
                "ok":0,"fails":0,"reset_at_unix_ms":null,"last_error":null,"ttft":null}]}"#,
        )
        .expect("idle accounts report ttft as null and must still parse");
        assert_eq!(s.accounts.len(), 1);
        assert_eq!(s.accounts[0].ttft.samples, 0);
        let v = build_view(&s, 0);
        assert_eq!(v.accounts[0].p50_ms, 0.0);
    }

    #[test]
    fn surfaces_quota_windows_and_marks_unknown_providers() {
        let s: AdminStats = serde_json::from_str(
            r#"{"accounts":[
              {"id":"cx@x.io","provider":"codex","health":{"status":"available"},
               "ok":1,"fails":0,"ttft":null,
               "usage":{"plan_type":"plus","credits_unlimited":false,
                 "primary":{"used_percent":3.0,"window_minutes":300,"reset_at_unix":2000},
                 "secondary":{"used_percent":25.0,"window_minutes":10080,"reset_at_unix":9000},
                 "observed_at_unix":1000}},
              {"id":"ag@x.io","provider":"antigravity","health":{"status":"available"},
               "ok":1,"fails":0,"ttft":null,"usage":null}]}"#,
        )
        .expect("parse");
        let v = build_view(&s, 1_500_000);

        let cx = &v.accounts[0];
        assert!(cx.usage_known);
        assert_eq!(cx.plan_type.as_deref(), Some("plus"));
        assert_eq!(cx.primary.used_percent, Some(3.0));
        assert_eq!(cx.primary.window_minutes, Some(300));
        assert_eq!(cx.primary.reset_in_secs, Some(500));
        assert_eq!(cx.secondary.used_percent, Some(25.0));

        // A provider with no quota headers must read as unknown, never as 0%.
        let ag = &v.accounts[1];
        assert!(!ag.usage_known);
        assert_eq!(ag.primary.used_percent, None);
    }

    #[test]
    fn expired_reset_clamps_to_zero_not_negative() {
        let w = QuotaWindow {
            reset_at_unix: Some(100),
            ..Default::default()
        };
        assert_eq!(window_view(&w, Some(0), 9_999).reset_in_secs, Some(0));
    }

    #[test]
    fn parses_live_shaped_admin_stats() {
        let s = stats_json();
        assert_eq!(s.accounts.len(), 3);
        assert_eq!(s.served, 10);
        assert_eq!(s.accounts[0].last_error.as_ref().unwrap().status, 400);
    }

    #[test]
    fn derives_failure_and_failover_rates() {
        let v = build_view(&stats_json(), 4000);
        // served counts delivered responses and failed_over counts discarded
        // upstream attempts, so the rate is over total attempts (4 of 14).
        assert!(
            (v.failover_rate - 4.0 / 14.0).abs() < 1e-9,
            "{}",
            v.failover_rate
        );
        assert_eq!(v.accounts[0].failure_rate, 1.0);
        assert_eq!(v.accounts[1].failure_rate, 0.0);
        assert_eq!(v.accounts[2].failure_rate, 0.75);
    }

    #[test]
    fn zero_traffic_never_divides_by_zero() {
        let mut s = stats_json();
        s.served = 0;
        s.failed_over = 0;
        for a in &mut s.accounts {
            a.ok = 0;
            a.fails = 0;
        }
        let v = build_view(&s, 0);
        assert_eq!(v.failover_rate, 0.0);
        assert!(v.accounts.iter().all(|a| a.failure_rate == 0.0));
    }

    #[test]
    fn cooldown_remaining_is_clamped_and_relative() {
        let v = build_view(&stats_json(), 4000);
        assert_eq!(v.accounts[2].cooldown_remaining_secs, Some(6));
        let past = build_view(&stats_json(), 999_999);
        assert_eq!(past.accounts[2].cooldown_remaining_secs, Some(0));
    }

    #[test]
    fn degraded_flags_cooldown_and_high_failure_accounts() {
        let v = build_view(&stats_json(), 4000);
        assert!(v.degraded.contains(&"cooling@x.io".to_string()));
        assert!(!v.degraded.contains(&"account-owner@gmail.com".to_string()));
    }

    #[test]
    fn unrecognized_health_states_are_not_reported_as_degraded() {
        // A gateway that starts reporting a new healthy state ("warming",
        // "idle") must not turn the whole pool red in the console.
        let s: AdminStats = serde_json::from_str(
            r#"{"accounts":[
                {"id":"warming@x.io","provider":"codex","health":{"status":"warming"},
                 "ok":3,"fails":0,"ttft":null},
                {"id":"broken@x.io","provider":"codex","health":{"status":"unavailable"},
                 "ok":3,"fails":0,"ttft":null}]}"#,
        )
        .expect("parse");
        let v = build_view(&s, 0);
        assert!(!v.degraded.contains(&"warming@x.io".to_string()));
        assert!(v.degraded.contains(&"broken@x.io".to_string()));
    }

    #[test]
    fn provider_comes_from_the_gateway_not_a_name_heuristic() {
        // A codex account whose slug is a bare gmail address would be
        // misclassified by any id-shape guess; the gateway reports the truth.
        let s: AdminStats = serde_json::from_str(
            r#"{"accounts":[
                {"id":"account-g@example.com","provider":"codex",
                 "health":{"status":"available"},"ok":1,"fails":0,"ttft":null},
                {"id":"account-owner@gmail.com","provider":"antigravity",
                 "health":{"status":"available"},"ok":1,"fails":0,"ttft":null}]}"#,
        )
        .expect("parse");
        let v = build_view(&s, 0);
        assert_eq!(v.accounts[0].provider, "codex");
        assert_eq!(v.accounts[1].provider, "antigravity");
    }

    #[test]
    fn account_ttft_is_surfaced_per_account() {
        let v = build_view(&stats_json(), 0);
        assert_eq!(v.accounts[1].p50_ms, 50.0);
        assert_eq!(v.accounts[1].p99_ms, 70.0);
        assert_eq!(v.accounts[1].samples, 5);
    }

    #[test]
    fn group_relative_reset_uses_observation_and_preserves_unknown() {
        for provider in ["gemini", "antigravity"] {
            for (absolute, relative, observed, now_ms, expected) in [
                (None, Some(3600), Some(1000), 1_060_000, Some(3540)),
                (None, Some(3600), None, 1_060_000, None),
                (None, Some(3600), Some(1000), 5_000_000, Some(0)),
                (Some(2000), Some(3600), Some(1000), 1_060_000, Some(940)),
                (Some(2000), Some(3600), None, 1_060_000, Some(940)),
                (Some(100), Some(3600), Some(1000), 1_060_000, Some(0)),
                (Some(0), Some(3600), Some(1000), 1_060_000, Some(3540)),
                (None, None, Some(1000), 1_060_000, None),
                (None, Some(0), Some(1000), 1_060_000, None),
                (None, Some(-1), Some(1000), 1_060_000, None),
            ] {
                let reset = serde_json::json!({
                    "reset_at_unix": absolute, "reset_after_seconds": relative
                });
                let credits = serde_json::json!([
                    {"granted_at_unix": 900, "expires_at_unix": 9000, "status": "available"}
                ]);
                let stats: AdminStats = serde_json::from_value(serde_json::json!({
                    "accounts": [{"id": "fixture", "provider": provider, "usage": {
                        "observed_at_unix": observed,
                        "primary": reset, "secondary": reset,
                        "reset_credits_available": 1, "reset_credits": credits,
                        "groups": [{"display_name": null, "models": null, "buckets": [reset]}]
                    }}]
                }))
                .expect("loader-valid grouped quota fixture");
                let view = build_view(&stats, now_ms);
                let account = &view.accounts[0];
                assert_eq!(account.primary.reset_in_secs, expected);
                assert_eq!(account.secondary.reset_in_secs, expected);
                assert_eq!(account.groups[0].buckets[0].reset_in_secs, expected,
                    "provider={provider} absolute={absolute:?} relative={relative:?} observed={observed:?} now_ms={now_ms}");
                let wire = serde_json::to_value(&view).expect("serialize native view");
                assert_eq!(
                    wire["accounts"][0]["groups"][0]["buckets"][0]["reset_in_secs"],
                    serde_json::json!(expected)
                );
                assert_eq!(wire["accounts"][0]["reset_credits"], credits);
                assert!(account.can_reset);
            }
        }
    }

    #[test]
    fn quota_groups_reach_the_native_view() {
        // Live shape: an Antigravity account whose usage carries per-model
        // quota groups alongside the primary/secondary pair.
        let s: AdminStats = serde_json::from_str(
            r#"{"accounts":[{"id":"ag","provider":"antigravity",
                "health":{"status":"available"},"ok":1,"fails":0,
                "usage":{"observed_at_unix":1000,
                  "primary":{"used_percent":10.0,"window_minutes":300},
                  "secondary":{"used_percent":40.0,"window_minutes":10080},
                  "groups":[{"display_name":"GLM Coding Plan","models":null,
                    "buckets":[{"display_name":"GLM-5.3","window":null,
                                "used_percent":55.0,"reset_at_unix":4000}]}]}}]}"#,
        )
        .expect("parse");
        let v = build_view(&s, 2_000_000);
        let account = &v.accounts[0];
        assert_eq!(account.groups.len(), 1);
        assert_eq!(account.groups[0].name.as_deref(), Some("GLM Coding Plan"));
        assert!(account.groups[0].models.is_none());
        let bucket = &account.groups[0].buckets[0];
        assert_eq!(bucket.name.as_deref(), Some("GLM-5.3"));
        assert_eq!(bucket.used_percent, Some(55.0));
        assert_eq!(bucket.reset_in_secs, Some(2000));
    }

    #[test]
    fn expired_cooldown_normalizes_to_available_at_boundary_and_clears_degraded() {
        let s: AdminStats = serde_json::from_value(serde_json::json!({
            "accounts": [
                {
                    "id": "expiring@x.io",
                    "provider": "codex",
                    "health": {"status": "cooldown"},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": 10_000,
                    "ttft": null
                },
                {
                    "id": "wire-health-expiring@x.io",
                    "provider": "codex",
                    "health": {"status": "cooldown", "until_unix_ms": 10_000},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": null,
                    "ttft": null
                }
            ]
        }))
        .expect("parse test stats");

        // 1 ms before deadline: strictly in cooldown, degraded flags both.
        let before = build_view(&s, 9_999);
        assert_eq!(before.accounts[0].status, "cooldown");
        assert_eq!(before.accounts[0].cooldown_remaining_secs, Some(0));
        assert_eq!(before.accounts[1].status, "cooldown");
        assert!(before.degraded.contains(&"expiring@x.io".to_string()));
        assert!(before.degraded.contains(&"wire-health-expiring@x.io".to_string()));

        // Exact deadline boundary (now == deadline): normalized to available, not degraded.
        let exact = build_view(&s, 10_000);
        assert_eq!(exact.accounts[0].status, "available");
        assert_eq!(exact.accounts[0].cooldown_remaining_secs, Some(0));
        assert_eq!(exact.accounts[1].status, "available");
        assert!(!exact.degraded.contains(&"expiring@x.io".to_string()));
        assert!(!exact.degraded.contains(&"wire-health-expiring@x.io".to_string()));

        // 1 ms after deadline: available, not degraded.
        let after = build_view(&s, 10_001);
        assert_eq!(after.accounts[0].status, "available");
        assert_eq!(after.accounts[0].cooldown_remaining_secs, Some(0));
        assert_eq!(after.accounts[1].status, "available");
        assert!(!after.degraded.contains(&"expiring@x.io".to_string()));
        assert!(!after.degraded.contains(&"wire-health-expiring@x.io".to_string()));
    }

    #[test]
    fn cooldown_lifecycle_preserves_future_missing_disabled_error_and_high_failure() {
        let s: AdminStats = serde_json::from_value(serde_json::json!({
            "accounts": [
                {
                    "id": "future@x.io",
                    "provider": "codex",
                    "health": {"status": "cooldown"},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": 20_000,
                    "ttft": null
                },
                {
                    "id": "missing-deadline@x.io",
                    "provider": "codex",
                    "health": {"status": "cooldown"},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": null,
                    "ttft": null
                },
                {
                    "id": "disabled@x.io",
                    "provider": "codex",
                    "health": {"status": "disabled"},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": 10_000,
                    "ttft": null
                },
                {
                    "id": "error@x.io",
                    "provider": "codex",
                    "health": {"status": "error"},
                    "ok": 10,
                    "fails": 0,
                    "reset_at_unix_ms": 10_000,
                    "last_error": {"unix_ms": 1, "status": 500, "message": "internal error"},
                    "ttft": null
                },
                {
                    "id": "expired-but-failing@x.io",
                    "provider": "codex",
                    "health": {"status": "cooldown"},
                    "ok": 1,
                    "fails": 3,
                    "reset_at_unix_ms": 10_000,
                    "ttft": null
                }
            ]
        }))
        .expect("parse lifecycle test stats");

        let v = build_view(&s, 15_000);

        // Future cooldown preserved
        assert_eq!(v.accounts[0].status, "cooldown");
        assert_eq!(v.accounts[0].cooldown_remaining_secs, Some(5));
        assert!(v.degraded.contains(&"future@x.io".to_string()));

        // Missing deadline policy: keep cooldown
        assert_eq!(v.accounts[1].status, "cooldown");
        assert_eq!(v.accounts[1].cooldown_remaining_secs, None);
        assert!(v.degraded.contains(&"missing-deadline@x.io".to_string()));

        // Disabled state preserved and not degraded
        assert_eq!(v.accounts[2].status, "disabled");
        assert!(!v.degraded.contains(&"disabled@x.io".to_string()));

        // Error state preserved and remains degraded
        assert_eq!(v.accounts[3].status, "error");
        assert!(v.degraded.contains(&"error@x.io".to_string()));

        // Expired cooldown normalizes to available, but high failure rate preserves degraded
        assert_eq!(v.accounts[4].status, "available");
        assert_eq!(v.accounts[4].cooldown_remaining_secs, Some(0));
        assert!(v.degraded.contains(&"expired-but-failing@x.io".to_string()));
    }

    #[test]
    fn antigravity_model_group_semantics_preserved_with_expired_cooldown() {
        let s: AdminStats = serde_json::from_value(serde_json::json!({
            "accounts": [{
                "id": "ag-expired",
                "provider": "antigravity",
                "health": {"status": "cooldown"},
                "ok": 10,
                "fails": 0,
                "reset_at_unix_ms": 5_000,
                "usage": {
                    "observed_at_unix": 1000,
                    "primary": {"used_percent": 10.0, "window_minutes": 300},
                    "secondary": {"used_percent": 40.0, "window_minutes": 10080},
                    "groups": [{
                        "display_name": "Claude Model Family",
                        "models": "claude-sonnet-3-5",
                        "buckets": [{
                            "display_name": "Claude 3.5 Sonnet",
                            "window": "daily",
                            "used_percent": 80.0,
                            "reset_at_unix": 9000
                        }]
                    }]
                }
            }]
        }))
        .expect("parse antigravity test stats");

        let v = build_view(&s, 6_000);
        let ag = &v.accounts[0];
        assert_eq!(ag.status, "available");
        assert_eq!(ag.cooldown_remaining_secs, Some(0));
        assert!(!v.degraded.contains(&"ag-expired".to_string()));
        assert_eq!(ag.groups.len(), 1);
        assert_eq!(ag.groups[0].name.as_deref(), Some("Claude Model Family"));
        assert_eq!(ag.groups[0].models.as_deref(), Some("claude-sonnet-3-5"));
        assert_eq!(ag.groups[0].buckets[0].name.as_deref(), Some("Claude 3.5 Sonnet"));
        assert_eq!(ag.groups[0].buckets[0].used_percent, Some(80.0));
        assert_eq!(ag.groups[0].buckets[0].reset_in_secs, Some(8994)); // 9000 - 6
    }
}
