use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::account::{AccountMember, ProviderKind};
use crate::state::AppState;
use crate::usage::{
    parse_cursor_usage_summary, parse_kiro_usage_summary, parse_zcode_usage_summary, WhamUsage,
};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
/// The reset endpoint is a write and rejects clients that don't look like the
/// official CLI, so requests mirror the Codex CLI user agent.
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
const CLAUDE_API_BASE: &str = "https://api.anthropic.com";
const CLAUDE_USAGE_PATH: &str = "/api/oauth/usage";
const CURSOR_USAGE_URL: &str = "https://api2.cursor.sh/auth/usage-summary";
const KIRO_USAGE_URL: &str = "https://q.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST";
const ZCODE_USAGE_URL: &str = "https://bigmodel.cn/api/monitor/usage/quota/limit";
/// Undocumented and version-dated: the endpoint is gated on this exact beta
/// header, and a new date means the payload can change without notice.
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
pub enum QuotaError {
    Unsupported,
    Unauthorized,
    Upstream(String),
}

impl std::fmt::Display for QuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuotaError::Unsupported => write!(f, "provider does not expose quota"),
            QuotaError::Unauthorized => write!(f, "account rejected the credentials"),
            QuotaError::Upstream(m) => write!(f, "{m}"),
        }
    }
}

fn codex_account_id(member: &AccountMember) -> String {
    let guard = member
        .inner
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*guard {
        crate::account::ProviderAccount::Codex(a) => a.account_id.clone(),
        _ => String::new(),
    }
}

/// Poll one account's quota and store it. Returns `Unsupported` only for
/// providers that genuinely publish no quota API.
pub async fn refresh_account_usage(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    match member.kind() {
        ProviderKind::Codex => refresh_codex_usage(state, member).await,
        ProviderKind::Antigravity => refresh_antigravity_usage(state, member).await,
        ProviderKind::Claude => refresh_claude_usage(state, member).await,
        ProviderKind::Cursor => {
            let url = member
                .upstream_override
                .as_deref()
                .map(|base| format!("{}/auth/usage-summary", base.trim_end_matches('/')))
                .unwrap_or_else(|| CURSOR_USAGE_URL.to_string());
            refresh_json_usage(member, &state.http_client, &url, parse_cursor_usage_summary).await
        }
        ProviderKind::Kiro => {
            let url = member
                .upstream_override
                .as_deref()
                .map(|base| format!("{}/getUsageLimits", base.trim_end_matches('/')))
                .unwrap_or_else(|| KIRO_USAGE_URL.to_string());
            refresh_json_usage(member, &state.http_client, &url, parse_kiro_usage_summary).await
        }
        ProviderKind::Zcode => {
            let url = member
                .upstream_override
                .as_deref()
                .map(|base| {
                    format!(
                        "{}/api/monitor/usage/quota/limit",
                        base.trim_end_matches('/')
                    )
                })
                .unwrap_or_else(|| ZCODE_USAGE_URL.to_string());
            refresh_json_usage(member, &state.http_client, &url, parse_zcode_usage_summary).await
        }
        ProviderKind::Vertex => Err(QuotaError::Unsupported),
        ProviderKind::Generic => Err(QuotaError::Unsupported),
    }
}

async fn refresh_json_usage(
    member: &Arc<AccountMember>,
    client: &reqwest::Client,
    url: &str,
    parser: fn(&serde_json::Value, i64) -> crate::usage::AccountUsage,
) -> Result<(), QuotaError> {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let mut request = client.get(url);
    for (name, value) in member.build_upstream_headers() {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| QuotaError::Upstream(error.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    if !status.is_success() {
        return Err(QuotaError::Upstream(format!(
            "quota endpoint returned {status}"
        )));
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| QuotaError::Upstream(error.to_string()))?;
    let usage = parser(&body, now_unix);
    member.set_usage(usage.clone());
    Ok(())
}

/// Claude subscription quota, polled rather than scraped off relayed responses.
///
/// The relay only sees `anthropic-ratelimit-unified-*` when traffic actually
/// flows through this gateway, which leaves an idle account permanently blank;
/// this endpoint is what Claude Code's own usage display reads.
async fn refresh_claude_usage(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    if state.auth_refresh_enabled && member.is_expired(now_unix()) {
        let _ = state.refresh_member(member, None).await;
    }
    let used = member.access_token();
    match try_claude_usage(state, member).await {
        Err(QuotaError::Unauthorized) if state.auth_refresh_enabled => {
            state
                .refresh_member(member, Some(&used))
                .await
                .map_err(|e| QuotaError::Upstream(format!("refresh failed: {e}")))?;
            try_claude_usage(state, member).await
        }
        other => other,
    }
}

async fn try_claude_usage(state: &AppState, member: &Arc<AccountMember>) -> Result<(), QuotaError> {
    // Relay deployments authenticate with a static key and publish cumulative
    // counters from /v1/usage/self instead of subscription windows.
    if let Some(key) = member.relay_api_key() {
        let base = member
            .upstream_override
            .as_deref()
            .unwrap_or_default()
            .trim_end_matches('/');
        if base.is_empty() {
            return Err(QuotaError::Upstream("relay account has no upstream_override".into()));
        }
        let resp = state
            .http_client
            .get(format!("{base}/v1/usage/self"))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| QuotaError::Upstream(e.to_string()))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(QuotaError::Unauthorized);
        }
        if !status.is_success() {
            return Err(QuotaError::Upstream(format!("usage http {status}")));
        }
        let payload: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| QuotaError::Upstream(e.to_string()))?;
        let totals = crate::usage::parse_relay_usage(&payload).ok_or_else(|| {
            QuotaError::Upstream("usage payload had no cumulative counters".into())
        })?;
        let now = now_unix();
        let samples = state.usage_samples.push(
            &member.id,
            crate::usage::UsageSample { unix: now, requests: totals.requests, tokens: totals.tokens },
        );
        member.set_usage(crate::usage::AccountUsage {
            plan_type: Some("relay".into()),
            totals: Some(totals),
            windows: crate::usage::window_deltas(&samples, now),
            ..crate::usage::AccountUsage::default()
        });
        return Ok(());
    }
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let base = member
        .upstream_override
        .as_deref()
        .unwrap_or(CLAUDE_API_BASE)
        .trim_end_matches('/');

    let resp = state
        .http_client
        .get(format!("{base}{CLAUDE_USAGE_PATH}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    // Anthropic throttles this endpoint hard and gives no Retry-After. A 429 is
    // a stale read, not a quota fact, so the previous snapshot is left alone.
    if !status.is_success() {
        return Err(QuotaError::Upstream(format!("usage http {status}")));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    let parsed = crate::usage::parse_claude_usage_summary(&body, now_unix());
    if parsed.observed_at_unix.is_none() {
        return Err(QuotaError::Upstream("usage payload had no windows".into()));
    }
    member.set_usage(parsed);
    Ok(())
}

/// Antigravity's per-model-group quota.
///
/// Body is `{"project": <project_id>}`; the response carries a
/// `remainingFraction` per bucket which `parse_antigravity_quota_summary`
/// converts to the consumed orientation used everywhere else.
async fn refresh_antigravity_usage(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    // Mirrors the relay's auth handling: refresh a known-expired token up
    // front, then retry once if the quota verb still answers 401.
    if state.auth_refresh_enabled && member.is_expired(now_unix()) {
        let _ = state.refresh_member(member, None).await;
    }
    // Capture the token actually used, so a 401 retry can present it and force
    // a refresh; `refresh_member(_, None)` is a no-op unless the clock already
    // says expired, which is exactly the case a 401 contradicts.
    let used = member.access_token();
    match try_antigravity_quota(state, member).await {
        Err(QuotaError::Unauthorized) if state.auth_refresh_enabled => {
            let refreshed = state
                .refresh_member(member, Some(&used))
                .await
                .map_err(|e| QuotaError::Upstream(format!("refresh failed: {e}")))?;
            tracing::debug!(account = %member.id, refreshed, "quota 401 retry");
            try_antigravity_quota(state, member).await
        }
        other => other,
    }
}

async fn try_antigravity_quota(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let project = {
        let guard = member
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            crate::account::ProviderAccount::Antigravity(a) => a.project_id.clone(),
            _ => return Err(QuotaError::Unsupported),
        }
    };

    let url = mahoquot_providers::antigravity_quota_summary_url(
        mahoquot_providers::ANTIGRAVITY_UPSTREAM_BASE,
    );
    let resp = state
        .http_client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", mahoquot_providers::ANTIGRAVITY_USER_AGENT)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "project": project }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        // Carry the upstream message: Antigravity distinguishes a throttle from
        // an unlicensed project only in the body, and both arrive as 4xx.
        let detail = resp.text().await.unwrap_or_default();
        let detail = detail.replace('\n', " ");
        let detail = detail.trim();
        // cloudcode-pa gates this verb on the Antigravity client User-Agent and
        // answers 403 "You do not have a valid license of this product" when it
        // is absent. That is a client-identification failure, not a credential
        // or licensing one, so it is surfaced separately from Unauthorized.
        if status == reqwest::StatusCode::FORBIDDEN && detail.contains("valid license") {
            return Err(QuotaError::Upstream("quota rejected client (403)".into()));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            tracing::debug!(%status, detail = %&detail[..detail.len().min(240)], "antigravity quota rejected");
            return Err(QuotaError::Unauthorized);
        }
        return Err(QuotaError::Upstream(format!(
            "quota http {status}: {}",
            &detail[..detail.len().min(160)]
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    member.set_usage(crate::usage::parse_antigravity_quota_summary(
        &body,
        now_unix(),
    ));
    Ok(())
}

async fn refresh_codex_usage(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let account_id = codex_account_id(member);

    let mut req = state
        .http_client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", CODEX_USER_AGENT)
        .timeout(Duration::from_secs(20));
    if !account_id.is_empty() {
        req = req.header("ChatGPT-Account-Id", &account_id);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    if !status.is_success() {
        return Err(QuotaError::Upstream(format!("usage http {status}")));
    }
    let parsed: WhamUsage = resp
        .json()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    member.set_usage(parsed.into_account_usage(now_unix()));
    Ok(())
}

/// Spend one reset credit to force-clear the account's 5h window.
pub async fn consume_reset_credit(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    if member.kind() != ProviderKind::Codex {
        return Err(QuotaError::Unsupported);
    }
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let account_id = codex_account_id(member);
    let redeem_id = uuid_v4();

    let mut req = state
        .http_client
        .post(CODEX_RESET_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", CODEX_USER_AGENT)
        .timeout(Duration::from_secs(20));
    if !account_id.is_empty() {
        req = req.header("Chatgpt-Account-Id", &account_id);
    }

    let resp = req
        .json(&serde_json::json!({ "redeem_request_id": redeem_id }))
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Surface the upstream reason (e.g. no credits left) instead of a
        // generic failure, truncated on a char boundary so multibyte is safe.
        let snippet: String = body.trim().chars().take(200).collect();
        return Err(QuotaError::Upstream(if snippet.is_empty() {
            format!("reset http {status}")
        } else {
            format!("reset http {status}: {snippet}")
        }));
    }
    let _ = refresh_account_usage(state, member).await;
    Ok(())
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn getrandom(buf: &mut [u8]) {
    // Nanosecond-seeded xorshift: the redeem id only needs to be unique per
    // request, not cryptographically strong.
    let mut s = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        | 1;
    for byte in buf.iter_mut() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        *byte = (s >> 24) as u8;
    }
}

pub async fn refresh_all_usage(state: &Arc<AppState>) {
    let mut tasks = Vec::new();
    for m in state.pool.load().members.clone() {
        let state = Arc::clone(state);
        tasks.push(tokio::spawn(async move {
            // Logged rather than discarded: a silently failing quota poll is
            // indistinguishable from a provider that reports no quota.
            match refresh_account_usage(&state, &m).await {
                Ok(()) | Err(QuotaError::Unsupported) => {}
                Err(e) => tracing::warn!(
                    account = %m.id,
                    provider = ?m.kind(),
                    error = %e,
                    "quota refresh failed"
                ),
            }
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}

pub fn spawn_usage_poller(state: Arc<AppState>, every: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            refresh_all_usage(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redeem_ids_are_v4_shaped_and_unique() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_eq!(a.len(), 36);
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(a, b);
    }
}
