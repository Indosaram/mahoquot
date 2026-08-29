use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Per-account quota snapshot modelled on the windows Codex reports.
///
/// `primary` and `secondary` are the two rolling windows the upstream tracks
/// (typically weekly and 5-hourly). Providers that expose no quota headers leave
/// every field `None`, which the UI renders as "unknown" rather than as zero.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct QuotaWindow {
    pub used_percent: Option<f64>,
    pub window_minutes: Option<i64>,
    pub reset_after_seconds: Option<i64>,
    pub reset_at_unix: Option<i64>,
    pub limit_name: Option<String>,
}

impl QuotaWindow {
    pub fn is_empty(&self) -> bool {
        self.used_percent.is_none()
            && self.window_minutes.is_none()
            && self.reset_after_seconds.is_none()
            && self.reset_at_unix.is_none()
    }
}

/// One rolling window inside a model group, as Antigravity's quota summary
/// reports it.
///
/// Antigravity returns `remainingFraction` (1.0 == untouched) whereas Codex
/// reports consumption, so the conversion to `used_percent` happens at parse
/// time to keep a single orientation across providers.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct QuotaBucket {
    pub bucket_id: Option<String>,
    pub display_name: Option<String>,
    pub window: Option<String>,
    pub used_percent: Option<f64>,
    pub reset_at_unix: Option<i64>,
}

/// A set of models that share one quota pool.
///
/// Antigravity groups models ("Gemini Models", "Claude and GPT models") and
/// meters the group, not the individual model, so the group is the smallest
/// unit that can be reported truthfully.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct QuotaGroup {
    pub display_name: Option<String>,
    pub models: Option<String>,
    pub buckets: Vec<QuotaBucket>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AccountUsage {
    pub plan_type: Option<String>,
    pub active_limit: Option<String>,
    pub primary: QuotaWindow,
    pub secondary: QuotaWindow,
    /// Per-model-group quota. Empty for providers that only report flat windows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<QuotaGroup>,
    pub credits_balance: Option<f64>,
    pub credits_unlimited: Option<bool>,
    pub has_credits: Option<bool>,
    /// Reset credits left; spending one force-resets the 5h window.
    pub reset_credits_available: Option<i64>,
    /// Unix seconds when these headers were observed; `None` means never seen.
    pub observed_at_unix: Option<i64>,
}

impl AccountUsage {
    pub fn is_known(&self) -> bool {
        self.observed_at_unix.is_some()
    }
}

/// Parse Antigravity's `v1internal:retrieveUserQuotaSummary` payload.
///
/// Captured live from cloudcode-pa: `groups[].buckets[]` carry
/// `remainingFraction` (0..1) and an RFC3339 `resetTime`. The flat
/// `primary`/`secondary` windows are filled from the *most consumed* bucket so
/// existing rotation logic, which only understands flat windows, still sees a
/// truthful worst case.
pub fn parse_antigravity_quota_summary(body: &serde_json::Value, now_unix: i64) -> AccountUsage {
    let mut groups = Vec::new();
    for g in body.get("groups").and_then(|v| v.as_array()).into_iter().flatten() {
        let buckets: Vec<QuotaBucket> = g
            .get("buckets")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .map(|b| QuotaBucket {
                bucket_id: b.get("bucketId").and_then(|v| v.as_str()).map(str::to_string),
                display_name: b
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                window: b.get("window").and_then(|v| v.as_str()).map(str::to_string),
                used_percent: b
                    .get("remainingFraction")
                    .and_then(|v| v.as_f64())
                    .map(|f| ((1.0 - f) * 100.0).clamp(0.0, 100.0)),
                reset_at_unix: b
                    .get("resetTime")
                    .and_then(|v| v.as_str())
                    .and_then(parse_rfc3339_unix),
            })
            .collect();
        groups.push(QuotaGroup {
            display_name: g
                .get("displayName")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            models: g
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            buckets,
        });
    }

    let worst = |window: &str| -> QuotaWindow {
        groups
            .iter()
            .flat_map(|g| g.buckets.iter())
            .filter(|b| b.window.as_deref() == Some(window))
            .max_by(|a, b| {
                a.used_percent
                    .unwrap_or(0.0)
                    .total_cmp(&b.used_percent.unwrap_or(0.0))
            })
            .map(|b| QuotaWindow {
                used_percent: b.used_percent,
                window_minutes: Some(if window == "weekly" { 10_080 } else { 300 }),
                reset_after_seconds: None,
                reset_at_unix: b.reset_at_unix,
                limit_name: b.bucket_id.clone(),
            })
            .unwrap_or_default()
    };

    AccountUsage {
        primary: worst("weekly"),
        secondary: worst("5h"),
        groups,
        observed_at_unix: Some(now_unix),
        ..Default::default()
    }
}

/// Parse the `YYYY-MM-DDTHH:MM:SSZ` form cloudcode-pa emits for `resetTime`.
///
/// Hand-rolled because the gateway carries no date dependency and this field
/// is always UTC with a `Z` suffix; anything else is rejected rather than
/// guessed at.
/// `2026-08-30T03:50:00.351899+00:00` — fractional seconds plus a numeric UTC
/// offset, neither of which the `Z`-only parser above accepts.
fn parse_offset_datetime_unix(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    let base = trimmed
        .strip_suffix("+00:00")
        .or_else(|| trimmed.strip_suffix("-00:00"))
        .or_else(|| trimmed.strip_suffix('Z'))
        .unwrap_or(trimmed);
    let base = base.split_once('.').map_or(base, |(head, _)| head);
    parse_rfc3339_unix(&format!("{base}Z"))
}

fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let mut t = time.split(':');
    let (h, mi): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sec: i64 = t.next()?.split('.').next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }

    // Days from civil epoch (Howard Hinnant's algorithm).
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some(days * 86_400 + h * 3_600 + mi * 60 + sec)
}

fn num(map: &HashMap<String, String>, key: &str) -> Option<f64> {
    map.get(key)?.trim().parse::<f64>().ok()
}

fn int(map: &HashMap<String, String>, key: &str) -> Option<i64> {
    map.get(key)?.trim().parse::<i64>().ok()
}

fn text(map: &HashMap<String, String>, key: &str) -> Option<String> {
    let v = map.get(key)?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn flag(map: &HashMap<String, String>, key: &str) -> Option<bool> {
    let v = map.get(key)?.trim().to_ascii_lowercase();
    match v.as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// Parse Codex's `x-codex-*` quota headers.
///
/// Codex reports two header families: the plain `x-codex-primary-*` set and a
/// per-limit-name set such as `x-codex-bengalfox-primary-*` carrying the short
/// 5h window. Both were captured live; the named family wins for the secondary
/// window when present because the plain one reports a zero-width window.
pub fn parse_codex_headers(headers: &HashMap<String, String>, now_unix: i64) -> AccountUsage {
    let lower: HashMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect();

    let named_prefix = lower.keys().find_map(|k| {
        let rest = k.strip_prefix("x-codex-")?;
        let name = rest.strip_suffix("-limit-name")?;
        if name.is_empty() {
            None
        } else {
            Some(format!("x-codex-{name}-"))
        }
    });

    let win = |prefix: &str, which: &str| QuotaWindow {
        used_percent: num(&lower, &format!("{prefix}{which}-used-percent")),
        window_minutes: int(&lower, &format!("{prefix}{which}-window-minutes")),
        reset_after_seconds: int(&lower, &format!("{prefix}{which}-reset-after-seconds")),
        reset_at_unix: int(&lower, &format!("{prefix}{which}-reset-at")),
        limit_name: text(&lower, &format!("{prefix}limit-name")),
    };

    // Collect every window both families report, then classify by duration
    // rather than by header name: which family carries the 5h vs the weekly
    // window varies per account, so trusting `primary`/`secondary` positionally
    // mislabels them.
    let mut candidates = vec![
        win("x-codex-", "primary"),
        win("x-codex-", "secondary"),
    ];
    if let Some(p) = named_prefix.as_deref() {
        candidates.push(win(p, "primary"));
        candidates.push(win(p, "secondary"));
    }
    candidates.retain(|w| !w.is_empty() && w.window_minutes.unwrap_or(0) > 0);
    candidates.sort_by_key(|w| w.window_minutes.unwrap_or(i64::MAX));
    candidates.dedup_by_key(|w| w.window_minutes.unwrap_or(0));

    // Shortest window is the session (5h) window, longest is the weekly one.
    let primary = candidates.first().cloned().unwrap_or_default();
    let secondary = candidates
        .into_iter()
        .rev()
        .find(|w| w.window_minutes != primary.window_minutes)
        .unwrap_or_default();

    let observed = if primary.is_empty() && secondary.is_empty() && !lower.contains_key("x-codex-plan-type")
    {
        None
    } else {
        Some(now_unix)
    };

    AccountUsage {
        plan_type: text(&lower, "x-codex-plan-type"),
        active_limit: text(&lower, "x-codex-active-limit"),
        primary,
        secondary,
        credits_balance: num(&lower, "x-codex-credits-balance"),
        credits_unlimited: flag(&lower, "x-codex-credits-unlimited"),
        has_credits: flag(&lower, "x-codex-credits-has-credits"),
        reset_credits_available: None,
        groups: Vec::new(),
        observed_at_unix: observed,
    }
}

/// Quota state from Anthropic's OAuth subscription responses.
///
/// The subscription path reports `anthropic-ratelimit-unified-*`, which is a
/// different family from the API-key `anthropic-ratelimit-tokens-*` headers and
/// expresses consumption as a 0.0-1.0 utilization fraction rather than a
/// remaining count, so it is scaled to the percent orientation used everywhere
/// else here.
pub fn parse_claude_headers(headers: &HashMap<String, String>, now_unix: i64) -> AccountUsage {
    let lower: HashMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect();

    let window = |slug: &str, minutes: i64, name: &str| QuotaWindow {
        used_percent: num(&lower, &format!("anthropic-ratelimit-unified-{slug}-utilization"))
            .map(|fraction| (fraction * 100.0).clamp(0.0, 100.0)),
        window_minutes: Some(minutes),
        reset_after_seconds: None,
        reset_at_unix: int(&lower, &format!("anthropic-ratelimit-unified-{slug}-reset")),
        limit_name: Some(name.to_string()),
    };

    let primary = window("5h", 300, "Session");
    let secondary = window("7d", 10_080, "Weekly");
    let observed = if primary.used_percent.is_none() && secondary.used_percent.is_none() {
        None
    } else {
        Some(now_unix)
    };

    AccountUsage {
        plan_type: None,
        active_limit: text(&lower, "anthropic-ratelimit-unified-representative-claim"),
        primary: if primary.used_percent.is_none() {
            QuotaWindow::default()
        } else {
            primary
        },
        secondary: if secondary.used_percent.is_none() {
            QuotaWindow::default()
        } else {
            secondary
        },
        credits_balance: None,
        credits_unlimited: None,
        has_credits: None,
        reset_credits_available: None,
        groups: Vec::new(),
        observed_at_unix: observed,
    }
}

/// Quota state from Anthropic's OAuth usage endpoint.
///
/// `GET /api/oauth/usage` answers `{five_hour,seven_day}{utilization,resets_at}`,
/// so a Claude account can report quota without waiting for traffic to flow
/// through the gateway.
///
/// Unlike the relay's `unified-*` headers, this endpoint's `utilization` is
/// ALREADY a percent (live capture: `80.0` for an 80% session window), and its
/// `resets_at` carries a numeric offset rather than `Z`.
pub fn parse_claude_usage_summary(body: &serde_json::Value, now_unix: i64) -> AccountUsage {
    let window = |key: &str, minutes: i64, name: &str| {
        let node = &body[key];
        QuotaWindow {
            used_percent: node
                .get("utilization")
                .and_then(serde_json::Value::as_f64)
                .map(|percent| percent.clamp(0.0, 100.0)),
            window_minutes: Some(minutes),
            reset_after_seconds: None,
            reset_at_unix: node
                .get("resets_at")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_offset_datetime_unix),
            limit_name: Some(name.to_string()),
        }
    };

    let primary = window("five_hour", 300, "Session");
    let secondary = window("seven_day", 10_080, "Weekly");
    let observed = if primary.used_percent.is_none() && secondary.used_percent.is_none() {
        None
    } else {
        Some(now_unix)
    };

    AccountUsage {
        plan_type: None,
        active_limit: None,
        primary: if primary.used_percent.is_none() {
            QuotaWindow::default()
        } else {
            primary
        },
        secondary: if secondary.used_percent.is_none() {
            QuotaWindow::default()
        } else {
            secondary
        },
        credits_balance: None,
        credits_unlimited: None,
        has_credits: None,
        reset_credits_available: None,
        groups: Vec::new(),
        observed_at_unix: observed,
    }
}

/// Seconds until the window resets, preferring the absolute timestamp because
/// the relative value ages as the snapshot sits in memory.
pub fn seconds_until_reset(window: &QuotaWindow, observed_at: Option<i64>, now: i64) -> Option<i64> {
    if let Some(at) = window.reset_at_unix.filter(|v| *v > 0) {
        return Some((at - now).max(0));
    }
    let after = window.reset_after_seconds.filter(|v| *v > 0)?;
    let observed = observed_at?;
    Some((after - (now - observed)).max(0))
}

/// Wire shape of `GET https://chatgpt.com/backend-api/wham/usage`.
///
/// Preferred over scraping response headers: it needs no traffic through the
/// account, states each window's length explicitly, and is the only source for
/// the reset-credit balance that one-click reset spends.
#[derive(Debug, Clone, Deserialize)]
pub struct WhamUsage {
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub rate_limit: Option<WhamRateLimit>,
    #[serde(default)]
    pub credits: Option<WhamCredits>,
    #[serde(default)]
    pub rate_limit_reset_credits: Option<WhamResetCredits>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WhamRateLimit {
    #[serde(default)]
    pub primary_window: Option<WhamWindow>,
    #[serde(default)]
    pub secondary_window: Option<WhamWindow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WhamWindow {
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub limit_window_seconds: Option<i64>,
    #[serde(default)]
    pub reset_after_seconds: Option<i64>,
    #[serde(default)]
    pub reset_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WhamCredits {
    #[serde(default)]
    pub has_credits: Option<bool>,
    #[serde(default)]
    pub unlimited: Option<bool>,
    /// Sent as a JSON string (e.g. "0"), not a number.
    #[serde(default)]
    pub balance: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WhamResetCredits {
    #[serde(default)]
    pub available_count: Option<i64>,
}

impl WhamUsage {
    pub fn into_account_usage(self, now_unix: i64) -> AccountUsage {
        let to_window = |w: WhamWindow| QuotaWindow {
            used_percent: w.used_percent,
            window_minutes: w.limit_window_seconds.map(|s| s / 60),
            reset_after_seconds: w.reset_after_seconds,
            reset_at_unix: w.reset_at,
            limit_name: None,
        };
        let rl = self.rate_limit.unwrap_or(WhamRateLimit {
            primary_window: None,
            secondary_window: None,
        });
        let mut windows: Vec<QuotaWindow> = [rl.primary_window, rl.secondary_window]
            .into_iter()
            .flatten()
            .map(to_window)
            .filter(|w| !w.is_empty())
            .collect();
        // Order by length so the short session window is always `primary`,
        // matching the header path regardless of upstream field order.
        windows.sort_by_key(|w| w.window_minutes.unwrap_or(i64::MAX));
        let credits = self.credits;
        AccountUsage {
            plan_type: self.plan_type,
            active_limit: None,
            primary: windows.first().cloned().unwrap_or_default(),
            secondary: windows.get(1).cloned().unwrap_or_default(),
            credits_balance: credits
                .as_ref()
                .and_then(|c| c.balance.as_ref())
                .and_then(|b| b.trim().parse::<f64>().ok()),
            credits_unlimited: credits.as_ref().and_then(|c| c.unlimited),
            has_credits: credits.as_ref().and_then(|c| c.has_credits),
            reset_credits_available: self
                .rate_limit_reset_credits
                .and_then(|r| r.available_count),
            groups: Vec::new(),
            observed_at_unix: Some(now_unix),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured verbatim from a live GET /backend-api/wham/usage response.
    const LIVE_WHAM: &str = r#"{
      "plan_type": "plus",
      "rate_limit": {
        "primary_window": {"used_percent": 15, "limit_window_seconds": 18000,
          "reset_after_seconds": 15215, "reset_at": 1787907992},
        "secondary_window": {"used_percent": 27, "limit_window_seconds": 604800,
          "reset_after_seconds": 565632, "reset_at": 1788458408}
      },
      "credits": {"has_credits": false, "unlimited": false, "balance": "0"},
      "rate_limit_reset_credits": {"available_count": 0, "applicable_available_count": 0}
    }"#;

    #[test]
    fn maps_live_wham_usage_windows() {
        let u: WhamUsage = serde_json::from_str(LIVE_WHAM).expect("parse");
        let a = u.into_account_usage(1_787_900_000);
        assert_eq!(a.plan_type.as_deref(), Some("plus"));
        assert_eq!(a.primary.used_percent, Some(15.0));
        assert_eq!(a.primary.window_minutes, Some(300));
        assert_eq!(a.secondary.used_percent, Some(27.0));
        assert_eq!(a.secondary.window_minutes, Some(10080));
        assert!(a.is_known());
    }

    #[test]
    fn parses_string_credit_balance_and_reset_credits() {
        let u: WhamUsage = serde_json::from_str(LIVE_WHAM).expect("parse");
        let a = u.into_account_usage(1);
        assert_eq!(a.credits_balance, Some(0.0));
        assert_eq!(a.credits_unlimited, Some(false));
        assert_eq!(a.reset_credits_available, Some(0));
    }

    #[test]
    fn orders_windows_by_length_regardless_of_field_order() {
        // Weekly arriving in `primary_window` must still land in `secondary`.
        let swapped = r#"{"rate_limit":{
          "primary_window":{"used_percent":9,"limit_window_seconds":604800},
          "secondary_window":{"used_percent":4,"limit_window_seconds":18000}}}"#;
        let a: AccountUsage = serde_json::from_str::<WhamUsage>(swapped)
            .expect("parse")
            .into_account_usage(1);
        assert_eq!(a.primary.window_minutes, Some(300));
        assert_eq!(a.primary.used_percent, Some(4.0));
        assert_eq!(a.secondary.used_percent, Some(9.0));
    }

    #[test]
    fn missing_rate_limit_yields_empty_windows() {
        let a = serde_json::from_str::<WhamUsage>(r#"{"plan_type":"pro"}"#)
            .expect("parse")
            .into_account_usage(7);
        assert!(a.primary.is_empty());
        assert!(a.secondary.is_empty());
        assert_eq!(a.plan_type.as_deref(), Some("pro"));
    }

    fn live_headers() -> HashMap<String, String> {
        // Captured verbatim from chatgpt.com/backend-api/codex/responses.
        [
            ("x-codex-active-limit", "premium"),
            ("x-codex-plan-type", "prolite"),
            ("x-codex-primary-used-percent", "16"),
            ("x-codex-secondary-used-percent", "0"),
            ("x-codex-primary-window-minutes", "10080"),
            ("x-codex-secondary-window-minutes", "0"),
            ("x-codex-primary-reset-after-seconds", "585335"),
            ("x-codex-secondary-reset-after-seconds", "0"),
            ("x-codex-primary-reset-at", "1788477152"),
            ("x-codex-secondary-reset-at", ""),
            ("x-codex-credits-has-credits", "false"),
            ("x-codex-credits-balance", "0"),
            ("x-codex-credits-unlimited", "false"),
            ("x-codex-bengalfox-primary-used-percent", "0"),
            ("x-codex-bengalfox-secondary-used-percent", "0"),
            ("x-codex-bengalfox-primary-window-minutes", "300"),
            ("x-codex-bengalfox-secondary-window-minutes", "10080"),
            ("x-codex-bengalfox-primary-reset-after-seconds", "18000"),
            ("x-codex-bengalfox-secondary-reset-after-seconds", "604800"),
            ("x-codex-bengalfox-primary-reset-at", "1787909818"),
            ("x-codex-bengalfox-secondary-reset-at", "1788496618"),
            ("x-codex-bengalfox-limit-name", "GPT-5.3-Codex-Spark"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn parses_plan_and_credits_from_live_headers() {
        let u = parse_codex_headers(&live_headers(), 1_787_900_000);
        assert_eq!(u.plan_type.as_deref(), Some("prolite"));
        assert_eq!(u.active_limit.as_deref(), Some("premium"));
        assert_eq!(u.credits_balance, Some(0.0));
        assert_eq!(u.credits_unlimited, Some(false));
        assert_eq!(u.has_credits, Some(false));
        assert!(u.is_known());
    }

    #[test]
    fn session_window_carries_its_own_reset_time() {
        let u = parse_codex_headers(&live_headers(), 1_787_900_000);
        assert_eq!(u.primary.used_percent, Some(0.0));
        assert_eq!(u.primary.reset_at_unix, Some(1_787_909_818));
    }

    #[test]
    fn classifies_windows_by_duration_not_header_family() {
        // This live account carries the 5h window only under the named family
        // while the plain family holds the weekly one; primary must still be
        // the 300-minute session window.
        let u = parse_codex_headers(&live_headers(), 1_787_900_000);
        assert_eq!(u.primary.window_minutes, Some(300));
        assert_eq!(u.secondary.window_minutes, Some(10080));
        assert_eq!(u.secondary.used_percent, Some(16.0));
    }

    #[test]
    fn empty_headers_are_unknown_not_zero() {
        let u = parse_codex_headers(&HashMap::new(), 1_787_900_000);
        assert!(!u.is_known());
        assert_eq!(u.primary.used_percent, None);
        assert_eq!(u.plan_type, None);
    }

    #[test]
    fn reset_prefers_absolute_timestamp_over_stale_relative() {
        let w = QuotaWindow {
            reset_at_unix: Some(1_000_100),
            reset_after_seconds: Some(999_999),
            ..Default::default()
        };
        assert_eq!(seconds_until_reset(&w, Some(1_000_000), 1_000_000), Some(100));
    }

    #[test]
    fn reset_ages_relative_value_when_no_timestamp() {
        let w = QuotaWindow {
            reset_after_seconds: Some(300),
            ..Default::default()
        };
        // Observed 120s ago, so 180s remain.
        assert_eq!(seconds_until_reset(&w, Some(1_000_000), 1_000_120), Some(180));
        assert_eq!(seconds_until_reset(&w, Some(1_000_000), 1_099_999), Some(0));
    }

    #[test]
    fn reset_is_unknown_without_any_signal() {
        assert_eq!(seconds_until_reset(&QuotaWindow::default(), Some(5), 10), None);
    }

    /// Verbatim shape of a live cloudcode-pa `retrieveUserQuotaSummary` 200.
    fn antigravity_fixture() -> serde_json::Value {
        serde_json::json!({
            "groups": [
                {
                    "displayName": "Gemini Models",
                    "description": "Models within this group: Gemini Flash, Gemini Pro",
                    "buckets": [
                        {
                            "bucketId": "gemini-weekly",
                            "displayName": "Weekly Limit Remaining",
                            "window": "weekly",
                            "resetTime": "2026-09-04T01:27:21Z",
                            "remainingFraction": 0.99998575
                        },
                        {
                            "bucketId": "gemini-5h",
                            "displayName": "Five Hour Limit Remaining",
                            "window": "5h",
                            "resetTime": "2026-08-28T11:27:21Z",
                            "remainingFraction": 0.5
                        }
                    ]
                },
                {
                    "displayName": "Claude and GPT models",
                    "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                    "buckets": [
                        {"bucketId": "3p-weekly", "window": "weekly", "resetTime": "2026-09-04T10:01:23Z", "remainingFraction": 0.25},
                        {"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-08-28T15:01:23Z", "remainingFraction": 1}
                    ]
                }
            ]
        })
    }

    #[test]
    fn antigravity_summary_maps_remaining_fraction_to_used_percent() {
        let u = parse_antigravity_quota_summary(&antigravity_fixture(), 1_700_000_000);
        assert_eq!(u.groups.len(), 2);
        let gemini = &u.groups[0];
        assert_eq!(gemini.display_name.as_deref(), Some("Gemini Models"));
        // remainingFraction 0.5 -> 50% consumed, not 50% remaining.
        let five_h = gemini.buckets.iter().find(|b| b.window.as_deref() == Some("5h")).unwrap();
        assert!((five_h.used_percent.unwrap() - 50.0).abs() < 1e-6);
        // 0.99998575 remaining is ~0% consumed.
        let weekly = gemini.buckets.iter().find(|b| b.window.as_deref() == Some("weekly")).unwrap();
        assert!(weekly.used_percent.unwrap() < 0.01);
    }

    #[test]
    fn antigravity_summary_parses_reset_time() {
        let u = parse_antigravity_quota_summary(&antigravity_fixture(), 1_700_000_000);
        let b = &u.groups[0].buckets[0];
        // 2026-09-04T01:27:21Z
        assert_eq!(b.reset_at_unix, Some(1_788_485_241));
    }

    #[test]
    fn antigravity_flat_windows_take_worst_bucket() {
        let u = parse_antigravity_quota_summary(&antigravity_fixture(), 1_700_000_000);
        // weekly: gemini ~0% vs 3p 75% -> worst is 75%
        assert!((u.primary.used_percent.unwrap() - 75.0).abs() < 1e-6);
        assert_eq!(u.primary.window_minutes, Some(10_080));
        // 5h: gemini 50% vs 3p 0% -> worst is 50%
        assert!((u.secondary.used_percent.unwrap() - 50.0).abs() < 1e-6);
        assert_eq!(u.secondary.window_minutes, Some(300));
    }

    #[test]
    fn rfc3339_parser_rejects_non_utc_and_malformed() {
        assert_eq!(parse_rfc3339_unix("2026-09-04T01:27:21+09:00"), None);
        assert_eq!(parse_rfc3339_unix("2026-13-04T01:27:21Z"), None);
        assert_eq!(parse_rfc3339_unix("garbage"), None);
        // Leap day must round-trip.
        assert_eq!(parse_rfc3339_unix("2024-02-29T00:00:00Z"), Some(1_709_164_800));
    }

    #[test]
    fn antigravity_summary_tolerates_empty_payload() {
        let u = parse_antigravity_quota_summary(&serde_json::json!({}), 42);
        assert!(u.groups.is_empty());
        assert_eq!(u.primary.used_percent, None);
        assert_eq!(u.observed_at_unix, Some(42));
    }

    #[test]
    fn claude_subscription_headers_become_session_and_weekly_windows() {
        let headers: HashMap<String, String> = [
            ("anthropic-ratelimit-unified-status", "allowed"),
            ("anthropic-ratelimit-unified-5h-utilization", "0.03"),
            ("anthropic-ratelimit-unified-5h-reset", "1765944000"),
            ("anthropic-ratelimit-unified-7d-utilization", "0.12"),
            ("anthropic-ratelimit-unified-7d-reset", "1766030400"),
            (
                "anthropic-ratelimit-unified-representative-claim",
                "five_hour",
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

        let usage = parse_claude_headers(&headers, 99);

        assert_eq!(usage.primary.used_percent, Some(3.0));
        assert_eq!(usage.primary.window_minutes, Some(300));
        assert_eq!(usage.primary.reset_at_unix, Some(1765944000));
        assert_eq!(usage.primary.limit_name.as_deref(), Some("Session"));
        assert_eq!(usage.secondary.used_percent, Some(12.0));
        assert_eq!(usage.secondary.window_minutes, Some(10_080));
        assert_eq!(usage.secondary.limit_name.as_deref(), Some("Weekly"));
        assert_eq!(usage.active_limit.as_deref(), Some("five_hour"));
        assert_eq!(usage.observed_at_unix, Some(99));
    }

    #[test]
    fn claude_api_key_headers_report_no_subscription_window() {
        let headers: HashMap<String, String> = [
            ("anthropic-ratelimit-tokens-limit", "20000"),
            ("anthropic-ratelimit-tokens-remaining", "19000"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

        let usage = parse_claude_headers(&headers, 99);

        assert_eq!(usage.observed_at_unix, None);
        assert!(usage.primary.is_empty());
        assert!(usage.secondary.is_empty());
    }
}
