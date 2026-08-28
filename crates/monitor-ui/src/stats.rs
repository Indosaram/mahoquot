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


#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AccountView {
    pub id: String,
    pub provider: String,
    pub status: String,
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

fn status_of(health: &serde_json::Value) -> String {
    health
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown")
        .to_string()
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
            status: status_of(&a.health),
            ok: a.ok,
            fails: a.fails,
            failure_rate: rate(a.fails, a.ok),
            p50_ms: a.ttft.p50_ms,
            p99_ms: a.ttft.p99_ms,
            samples: a.ttft.samples,
            cooldown_remaining_secs: a
                .reset_at_unix_ms
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
        .filter(|a| a.status != "available" || (a.failure_rate > 0.5 && a.ok + a.fails >= 2))
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
                  {"id":"account-e@gmail.com","health":{"status":"available"},
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
        assert!((v.failover_rate - 4.0 / 14.0).abs() < 1e-9, "{}", v.failover_rate);
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
        assert!(!v.degraded.contains(&"account-e@gmail.com".to_string()));
    }

    #[test]
    fn provider_comes_from_the_gateway_not_a_name_heuristic() {
        // A codex account whose slug is a bare gmail address would be
        // misclassified by any id-shape guess; the gateway reports the truth.
        let s: AdminStats = serde_json::from_str(
            r#"{"accounts":[
                {"id":"account-g@example.com","provider":"codex",
                 "health":{"status":"available"},"ok":1,"fails":0,"ttft":null},
                {"id":"account-e@gmail.com","provider":"antigravity",
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
}
