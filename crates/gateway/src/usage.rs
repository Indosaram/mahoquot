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
    /// Cumulative relay counters (claude relay deployments).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals: Option<crate::usage::RelayUsageTotals>,
    /// Rolling 3h/24h deltas derived from locally sampled counters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<crate::usage::UsageWindowDelta>,
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
    for g in body
        .get("groups")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let buckets: Vec<QuotaBucket> = g
            .get("buckets")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .map(|b| QuotaBucket {
                bucket_id: b
                    .get("bucketId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
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
    let mut candidates = vec![win("x-codex-", "primary"), win("x-codex-", "secondary")];
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

    let observed =
        if primary.is_empty() && secondary.is_empty() && !lower.contains_key("x-codex-plan-type") {
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
        ..Default::default()
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
        used_percent: num(
            &lower,
            &format!("anthropic-ratelimit-unified-{slug}-utilization"),
        )
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
        ..Default::default()
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
        ..Default::default()
    }
}

fn usage_bucket(
    limit_name: &str,
    used_percent: f64,
    reset_at_unix: Option<i64>,
    _now_unix: i64,
) -> QuotaBucket {
    QuotaBucket {
        bucket_id: None,
        display_name: Some(limit_name.to_string()),
        window: None,
        used_percent: Some((used_percent.clamp(0.0, 100.0) * 100.0).round() / 100.0),
        reset_at_unix,
    }
}

pub fn parse_cursor_usage_summary(body: &serde_json::Value, now_unix: i64) -> AccountUsage {
    let mut buckets = Vec::new();
    let usage = body
        .get("individualUsage")
        .or_else(|| body.get("individual_usage"));
    for (key, label) in [("plan", "Plan"), ("onDemand", "On-Demand")] {
        let value = usage.and_then(|usage| usage.get(key));
        if !value
            .and_then(|value| value.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let limit = value
            .and_then(|value| value.get("limit"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let remaining = value
            .and_then(|value| value.get("remaining"))
            .and_then(|v| v.as_f64())
            .unwrap_or(limit);
        let used = if limit > 0.0 {
            (1.0 - remaining / limit) * 100.0
        } else {
            0.0
        };
        buckets.push(usage_bucket(label, used, None, now_unix));
    }
    AccountUsage {
        plan_type: body
            .get("membershipType")
            .or_else(|| body.get("membership_type"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        groups: if buckets.is_empty() {
            Vec::new()
        } else {
            vec![QuotaGroup {
                display_name: Some("Cursor".to_string()),
                buckets,
                models: None,
            }]
        },
        ..AccountUsage::default()
    }
}

pub fn parse_kiro_usage_summary(body: &serde_json::Value, now_unix: i64) -> AccountUsage {
    let buckets = body
        .get("usageBreakdownList")
        .or_else(|| body.get("usage_breakdown_list"))
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .map(|item| {
            let limit = item
                .get("usageLimit")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let used = item
                .get("currentUsage")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let percent = if limit > 0.0 {
                used / limit * 100.0
            } else {
                0.0
            };
            usage_bucket(
                item.get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Usage"),
                percent,
                item.get("nextDateReset").and_then(|v| v.as_i64()),
                now_unix,
            )
        })
        .collect::<Vec<_>>();
    AccountUsage {
        groups: if buckets.is_empty() {
            Vec::new()
        } else {
            vec![QuotaGroup {
                display_name: Some("Kiro".to_string()),
                buckets,
                models: None,
            }]
        },
        ..AccountUsage::default()
    }
}

pub fn parse_zcode_usage_summary(body: &serde_json::Value, now_unix: i64) -> AccountUsage {
    let mut groups = Vec::new();
    for limit in body
        .get("data")
        .and_then(|v| v.get("limits"))
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let Some(label) = limit
            .get("type")
            .and_then(|v| v.as_str())
            .and_then(|kind| match kind {
                "TOKENS_LIMIT" => Some("Tokens"),
                "TIME_LIMIT" => Some("MCP Usage"),
                _ => None,
            })
        else {
            continue;
        };
        let bucket = usage_bucket(
            label,
            limit
                .get("percentage")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
            limit.get("nextResetTime").and_then(|v| v.as_i64()),
            now_unix,
        );
        groups.push(QuotaGroup {
            display_name: Some(label.to_string()),
            buckets: vec![bucket],
            models: None,
        });
    }
    AccountUsage {
        groups,
        ..AccountUsage::default()
    }
}

/// Seconds until the window resets, preferring the absolute timestamp because
/// the relative value ages as the snapshot sits in memory.
pub fn seconds_until_reset(
    window: &QuotaWindow,
    observed_at: Option<i64>,
    now: i64,
) -> Option<i64> {
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
            ..Default::default()
        }
    }
}

/// Bounded head/tail capture of a streamed body: the first `cap` bytes and
/// the last `cap` bytes, enough to locate usage objects without ever holding
/// the whole stream in memory.
#[derive(Debug, Default)]
pub struct HeadTailCapture {
    head: Vec<u8>,
    tail: Vec<u8>,
    cap: usize,
}

const CAPTURE_WINDOW: usize = 8 * 1024;

impl HeadTailCapture {
    pub fn new() -> Self {
        Self {
            head: Vec::new(),
            tail: Vec::new(),
            cap: CAPTURE_WINDOW,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        let head_room = self.cap.saturating_sub(self.head.len());
        if head_room > 0 {
            let take = head_room.min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
        }
        self.tail.extend_from_slice(chunk);
        let overflow = self.tail.len().saturating_sub(self.cap);
        if overflow > 0 {
            self.tail.drain(..overflow);
        }
    }

    pub fn parts(&self) -> (&[u8], &[u8]) {
        (&self.head, &self.tail)
    }
}

/// Extract a total token count from the captured head/tail windows of a
/// response body. Handles the three wire shapes the gateway relays:
/// OpenAI-style `"usage":{...}` (JSON or SSE frame), Gemini
/// `"usageMetadata":{...}`, and Claude SSE where `input_tokens` appears in
/// `message_start` (stream head) and `output_tokens` in `message_delta`
/// (stream tail). Returns `None` when nothing usable is present.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResponseTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl ResponseTokenUsage {
    pub fn total_tokens(self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

pub fn extract_response_token_usage(head: &[u8], tail: &[u8]) -> Option<ResponseTokenUsage> {
    if let Some(usage) = last_balanced_object(tail, b"\"usage\"") {
        let prompt = object_number(&usage, &["prompt_tokens"]);
        let completion = object_number(&usage, &["completion_tokens"]);
        if prompt.is_some() || completion.is_some() {
            return Some(ResponseTokenUsage {
                input_tokens: prompt.unwrap_or(0),
                output_tokens: completion.unwrap_or(0),
            });
        }
    }
    if let Some(usage) = last_balanced_object(tail, b"\"usageMetadata\"") {
        let prompt = object_number(&usage, &["promptTokenCount"]);
        let completion = object_number(&usage, &["candidatesTokenCount"]);
        if prompt.is_some() || completion.is_some() {
            return Some(ResponseTokenUsage {
                input_tokens: prompt.unwrap_or(0),
                output_tokens: completion.unwrap_or(0),
            });
        }
    }
    let input = last_number_after(head, b"\"input_tokens\"");
    let output = last_number_after(tail, b"\"output_tokens\"");
    if input.is_some() || output.is_some() {
        return Some(ResponseTokenUsage {
            input_tokens: input.unwrap_or(0),
            output_tokens: output.unwrap_or(0),
        });
    }
    None
}

pub fn extract_total_tokens(head: &[u8], tail: &[u8]) -> Option<u64> {
    extract_response_token_usage(head, tail).map(ResponseTokenUsage::total_tokens)
}

fn last_balanced_object(haystack: &[u8], key: &[u8]) -> Option<String> {
    let mut start = 0;
    let mut found = None;
    while let Some(pos) = find_sub(&haystack[start..], key) {
        let after = &haystack[start + pos + key.len()..];
        let colon = after.iter().position(|b| *b != b' ').map_or(0, |p| p);
        let after = &after[colon..];
        if after.first() == Some(&b':') {
            let after = &after[1..];
            let brace = after.iter().position(|b| *b != b' ').map_or(0, |p| p);
            let after = &after[brace..];
            if after.first() == Some(&b'{') {
                if let Some(end) = balanced_end(after) {
                    found = Some(String::from_utf8_lossy(&after[..=end]).into_owned());
                }
            }
        }
        start += pos + key.len();
    }
    found
}

fn balanced_end(bytes: &[u8]) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn object_number(json: &str, keys: &[&str]) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    keys.iter().find_map(|key| value.get(key)?.as_u64())
}

fn last_number_after(haystack: &[u8], key: &[u8]) -> Option<u64> {
    let mut start = 0;
    let mut found = None;
    while let Some(pos) = find_sub(&haystack[start..], key) {
        let after = &haystack[start + pos + key.len()..];
        let digits: Vec<u8> = after
            .iter()
            .skip_while(|b| **b != b':')
            .skip(1)
            .skip_while(|b| b.is_ascii_whitespace())
            .take_while(|b| b.is_ascii_digit())
            .copied()
            .collect();
        if !digits.is_empty() {
            let text = std::str::from_utf8(&digits).unwrap_or("");
            if let Ok(value) = text.parse::<u64>() {
                found = Some(value);
            }
        }
        start += pos + key.len();
    }
    found
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Cumulative counters reported by relay deployments' `/v1/usage/self`.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct RelayUsageTotals {
    #[serde(default, alias = "request_count")]
    pub requests: u64,
    #[serde(default, alias = "total_tokens")]
    pub tokens: u64,
    #[serde(default, alias = "cached_input_tokens")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default, alias = "total_cost_usd")]
    pub total_cost_usd: Option<f64>,
}

/// One point-in-time snapshot of the cumulative counters, kept so rolling
/// window deltas (3h/24h) can be derived locally when the relay publishes no
/// windows of its own.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct UsageSample {
    pub unix: i64,
    pub requests: u64,
    pub tokens: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct UsageWindowDelta {
    pub label: String,
    pub requests: u64,
    pub tokens: u64,
}

const WINDOW_LABELS: [(&str, i64); 2] = [("3h", 3 * 3600), ("24h", 24 * 3600)];

/// Deltas over rolling windows from monotone counter samples. Counter resets
/// (relay restarts) treat the last sample as the new baseline.
pub fn window_deltas(samples: &[UsageSample], now_unix: i64) -> Vec<UsageWindowDelta> {
    let last = samples.last().copied();
    let Some(last) = last else {
        return Vec::new();
    };
    WINDOW_LABELS
        .iter()
        .map(|(label, span)| {
            let cutoff = now_unix - span;
            let baseline = samples
                .iter()
                .take_while(|sample| sample.unix <= cutoff)
                .last()
                .copied()
                .unwrap_or(UsageSample {
                    unix: cutoff,
                    requests: 0,
                    tokens: 0,
                });
            // a collapsing counter means the relay restarted; the new counter
            // value is already the fresh usage, never a negative delta
            let delta = |baseline: u64, last: u64| {
                if last >= baseline {
                    last - baseline
                } else {
                    last
                }
            };
            UsageWindowDelta {
                label: (*label).to_string(),
                requests: delta(baseline.requests, last.requests),
                tokens: delta(baseline.tokens, last.tokens),
            }
        })
        .collect()
}

/// In-memory sample ring persisted next to the gateway config so the 24h
/// window survives restarts.
#[derive(Debug, Default)]
pub struct UsageSampleStore {
    path: std::path::PathBuf,
    entries: std::sync::Mutex<std::collections::BTreeMap<String, Vec<UsageSample>>>,
}

impl UsageSampleStore {
    pub fn load(path: std::path::PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: std::sync::Mutex::new(entries),
        }
    }

    /// Appends a sample, prunes anything older than 25 hours, persists, and
    /// returns the retained window for delta computation.
    pub fn push(&self, account_id: &str, sample: UsageSample) -> Vec<UsageSample> {
        const SPAN_SECS: i64 = 25 * 3600;
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let window = entries.entry(account_id.to_string()).or_default();
        window.push(sample);
        let cutoff = window
            .last()
            .map(|last| last.unix - SPAN_SECS)
            .unwrap_or(i64::MIN);
        window.retain(|sample| sample.unix >= cutoff);
        window.truncate(600);
        let retained = window.clone();
        if let Ok(raw) = serde_json::to_string_pretty(&*entries) {
            let _ = std::fs::write(&self.path, raw);
        }
        retained
    }
}

/// Maps the relay usage/self payload onto the cumulative totals.
pub fn parse_relay_usage(payload: &serde_json::Value) -> Option<RelayUsageTotals> {
    Some(RelayUsageTotals {
        requests: payload.get("request_count")?.as_u64()?,
        tokens: payload.get("total_tokens")?.as_u64()?,
        cached_input_tokens: payload
            .get("cached_input_tokens")
            .and_then(serde_json::Value::as_u64),
        total_cost_usd: payload
            .get("total_cost_usd")
            .and_then(serde_json::Value::as_f64),
    })
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_reads_openai_usage_from_tail_json() {
        let body = br#"{"id":"x","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#;
        assert_eq!(extract_total_tokens(body, body), Some(15));
    }

    #[test]
    fn extract_sums_openai_tokens_without_total() {
        let body = br#"data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}

"#;
        assert_eq!(extract_total_tokens(body, body), Some(10));
    }

    #[test]
    fn extract_prefers_the_last_usage_frame_in_sse_tail() {
        let mut body =
            b"data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":50}}\n\n".to_vec();
        body.extend_from_slice(
            b"data: {\"usage\":{\"prompt_tokens\":200,\"completion_tokens\":50}}\n\n",
        );
        assert_eq!(extract_total_tokens(&body, &body), Some(250));
    }

    #[test]
    fn extract_reads_gemini_usage_metadata() {
        let body = br#"{"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"totalTokenCount":20}}"#;
        assert_eq!(extract_total_tokens(body, body), Some(20));
    }

    #[test]
    fn extract_combines_claude_message_start_and_delta() {
        let head =
            b"event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":21}}}\n\n";
        let tail = b"event: message_delta\ndata: {\"usage\":{\"output_tokens\":9}}\n\n";
        assert_eq!(extract_total_tokens(head, tail), Some(30));
    }

    #[test]
    fn extract_returns_none_without_usage() {
        let body = br#"data: {"choices":[{"delta":{"content":"hi"}}]}"#;
        assert_eq!(extract_total_tokens(body, body), None);
    }

    #[test]
    fn capture_keeps_head_and_tail_within_capacity() {
        let mut capture = HeadTailCapture::new();
        let chunk = vec![b'x'; 4096];
        for _ in 0..5 {
            capture.push(&chunk);
        }
        let (head, tail) = capture.parts();
        assert_eq!(head.len(), 8192);
        assert_eq!(head[0], b'x');
        assert_eq!(tail.len(), 8192);
        assert_eq!(tail[tail.len() - 1], b'x');
    }

    #[test]
    fn capture_windows_preserve_usage_across_large_streams() {
        let mut capture = HeadTailCapture::new();
        capture.push(
            b"event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":4}}}\n\n",
        );
        capture.push(&vec![b'.'; 20_000]);
        let tail_frame = b"data: {\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":3}}\n\n";
        capture.push(tail_frame);
        let (head, tail) = capture.parts();
        assert_eq!(extract_total_tokens(head, tail), Some(33));
    }

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
        assert_eq!(
            seconds_until_reset(&w, Some(1_000_000), 1_000_000),
            Some(100)
        );
    }

    #[test]
    fn reset_ages_relative_value_when_no_timestamp() {
        let w = QuotaWindow {
            reset_after_seconds: Some(300),
            ..Default::default()
        };
        // Observed 120s ago, so 180s remain.
        assert_eq!(
            seconds_until_reset(&w, Some(1_000_000), 1_000_120),
            Some(180)
        );
        assert_eq!(seconds_until_reset(&w, Some(1_000_000), 1_099_999), Some(0));
    }

    #[test]
    fn reset_is_unknown_without_any_signal() {
        assert_eq!(
            seconds_until_reset(&QuotaWindow::default(), Some(5), 10),
            None
        );
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
        let five_h = gemini
            .buckets
            .iter()
            .find(|b| b.window.as_deref() == Some("5h"))
            .unwrap();
        assert!((five_h.used_percent.unwrap() - 50.0).abs() < 1e-6);
        // 0.99998575 remaining is ~0% consumed.
        let weekly = gemini
            .buckets
            .iter()
            .find(|b| b.window.as_deref() == Some("weekly"))
            .unwrap();
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
        assert_eq!(
            parse_rfc3339_unix("2024-02-29T00:00:00Z"),
            Some(1_709_164_800)
        );
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

    #[test]
    fn window_deltas_cover_three_and_twenty_four_hour_spans() {
        // given samples spread across a day: counters at t0, t+2h, t+5h, t+20h
        let now = 1_800_000;
        let samples = vec![
            UsageSample { unix: now - 30 * 3600, requests: 100, tokens: 1_000 },
            UsageSample { unix: now - 5 * 3600, requests: 300, tokens: 3_000 },
            UsageSample { unix: now - 2 * 3600, requests: 500, tokens: 5_000 },
            UsageSample { unix: now - 60, requests: 650, tokens: 6_000 },
        ];
        // when the rolling deltas are computed
        let deltas = window_deltas(&samples, now);
        // then 3h counts everything after the 2h-old sample and 24h spans all
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0].label, "3h");
        assert_eq!(deltas[0].requests, 350);
        assert_eq!(deltas[0].tokens, 3_000);
        assert_eq!(deltas[1].label, "24h");
        assert_eq!(deltas[1].requests, 550);
        assert_eq!(deltas[1].tokens, 5_000);
    }

    #[test]
    fn counter_resets_do_not_underflow_and_restart_the_baseline() {
        // given counters that collapsed (relay restarted)
        let now = 1_800_000;
        let samples = vec![
            UsageSample { unix: now - 5 * 3600, requests: 7_000, tokens: 900_000 },
            UsageSample { unix: now - 60, requests: 5, tokens: 800 },
        ];
        // when deltas are computed
        let deltas = window_deltas(&samples, now);
        // then the new baseline is treated as fresh usage, never negative
        assert_eq!(deltas[0].requests, 5);
        assert_eq!(deltas[0].tokens, 800);
    }

    #[test]
    fn the_relay_usage_payload_maps_to_cumulative_totals() {
        // given the payload captured from claude.nekos.me /v1/usage/self
        let payload: serde_json::Value = serde_json::from_str(
            r#"{"request_count":7005,"total_tokens":1184368836,"cached_input_tokens":1177706909,"total_cost_usd":3990.364061}"#,
        )
        .unwrap();
        // when it is parsed
        let totals = parse_relay_usage(&payload).expect("totals");
        // then every cumulative counter survives
        assert_eq!(totals.requests, 7005);
        assert_eq!(totals.tokens, 1_184_368_836);
        assert_eq!(totals.cached_input_tokens, Some(1_177_706_909));
        assert_eq!(totals.total_cost_usd, Some(3990.364061));
    }

    #[test]
    fn the_sample_store_round_trips_across_restart() {
        // given a store with one recorded sample
        let dir = std::env::temp_dir().join(format!("quotio-samples-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("usage-samples.json");
        {
            let store = UsageSampleStore::load(path.clone());
            store.push(
                "claude-relay",
                UsageSample { unix: 1_800_000, requests: 7005, tokens: 1_184_368_836 },
            );
        }
        // when a fresh store loads the same file
        let store = UsageSampleStore::load(path.clone());
        let sample = store.push("claude-relay", UsageSample { unix: 1_800_060, requests: 7010, tokens: 1_184_400_000 });
        // then the pre-restart sample survives inside the window
        assert_eq!(sample.first().map(|s| s.requests), Some(7005));
        std::fs::remove_dir_all(dir).ok();
    }
}

