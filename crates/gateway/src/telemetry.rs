use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const RETENTION_MINUTES: i64 = 30 * 24 * 60;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTelemetry {
    pub provider: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountTelemetry {
    pub account: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelemetryBucket {
    pub minute_unix: i64,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    pub providers: Vec<ProviderTelemetry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<AccountTelemetry>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TelemetryDocument {
    buckets: Vec<TelemetryBucket>,
}

#[derive(Debug)]
pub struct TelemetryStore {
    path: PathBuf,
    buckets: Mutex<Vec<TelemetryBucket>>,
    flush_requested: tokio::sync::Notify,
}

impl TelemetryStore {
    pub fn load(path: PathBuf) -> Self {
        let buckets = load_buckets(&path);
        Self {
            path,
            buckets: Mutex::new(buckets),
            flush_requested: tokio::sync::Notify::new(),
        }
    }

    /// Historical entry point: callers without an account context.
    pub fn record(&self, unix_secs: i64, provider: &str, success: bool) {
        self.record_with_account(unix_secs, provider, None, success);
    }

    pub fn record_with_account(
        &self,
        unix_secs: i64,
        provider: &str,
        account: Option<&str>,
        success: bool,
    ) {
        let minute_unix = unix_secs.div_euclid(60) * 60;
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bucket_index = match buckets.last() {
            Some(bucket) if bucket.minute_unix == minute_unix => buckets.len() - 1,
            _ => {
                buckets.push(TelemetryBucket {
                    minute_unix,
                    ..TelemetryBucket::default()
                });
                buckets.len() - 1
            }
        };
        let bucket = &mut buckets[bucket_index];
        bucket.requests += 1;
        if success {
            bucket.successes += 1;
        } else {
            bucket.failures += 1;
        }
        let provider_index = match bucket
            .providers
            .iter()
            .position(|item| item.provider == provider)
        {
            Some(provider_index) => provider_index,
            None => {
                bucket.providers.push(ProviderTelemetry {
                    provider: provider.to_string(),
                    ..ProviderTelemetry::default()
                });
                bucket.providers.len() - 1
            }
        };
        let provider_bucket = &mut bucket.providers[provider_index];
        provider_bucket.requests += 1;
        if success {
            provider_bucket.successes += 1;
        } else {
            provider_bucket.failures += 1;
        }
        if let Some(account) = account {
            let account_index = match bucket
                .accounts
                .iter()
                .position(|item| item.account == account)
            {
                Some(account_index) => account_index,
                None => {
                    bucket.accounts.push(AccountTelemetry {
                        account: account.to_string(),
                        ..AccountTelemetry::default()
                    });
                    bucket.accounts.len() - 1
                }
            };
            let account_bucket = &mut bucket.accounts[account_index];
            account_bucket.requests += 1;
            if success {
                account_bucket.successes += 1;
            } else {
                account_bucket.failures += 1;
            }
        }
        let earliest = minute_unix - RETENTION_MINUTES * 60;
        buckets.retain(|item| item.minute_unix >= earliest);
        self.flush_requested.notify_one();
    }

    pub fn snapshot(&self) -> Vec<TelemetryBucket> {
        self.buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn record_tokens(
        &self,
        unix_secs: i64,
        provider: &str,
        account: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) {
        let minute_unix = unix_secs.div_euclid(60) * 60;
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bucket_index = match buckets.last() {
            Some(bucket) if bucket.minute_unix == minute_unix => buckets.len() - 1,
            _ => {
                buckets.push(TelemetryBucket {
                    minute_unix,
                    ..TelemetryBucket::default()
                });
                buckets.len() - 1
            }
        };
        let bucket = &mut buckets[bucket_index];
        bucket.input_tokens = bucket.input_tokens.saturating_add(input_tokens);
        bucket.output_tokens = bucket.output_tokens.saturating_add(output_tokens);

        let provider_bucket = match bucket
            .providers
            .iter_mut()
            .find(|item| item.provider == provider)
        {
            Some(provider_bucket) => provider_bucket,
            None => {
                bucket.providers.push(ProviderTelemetry {
                    provider: provider.to_string(),
                    ..ProviderTelemetry::default()
                });
                bucket
                    .providers
                    .last_mut()
                    .expect("provider bucket inserted")
            }
        };
        provider_bucket.input_tokens = provider_bucket.input_tokens.saturating_add(input_tokens);
        provider_bucket.output_tokens = provider_bucket.output_tokens.saturating_add(output_tokens);

        let account_bucket = match bucket
            .accounts
            .iter_mut()
            .find(|item| item.account == account)
        {
            Some(account_bucket) => account_bucket,
            None => {
                bucket.accounts.push(AccountTelemetry {
                    account: account.to_string(),
                    ..AccountTelemetry::default()
                });
                bucket.accounts.last_mut().expect("account bucket inserted")
            }
        };
        account_bucket.input_tokens = account_bucket.input_tokens.saturating_add(input_tokens);
        account_bucket.output_tokens = account_bucket.output_tokens.saturating_add(output_tokens);
        self.flush_requested.notify_one();
    }

    pub fn account_tokens(&self, account: &str) -> (u64, u64) {
        self.buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .flat_map(|bucket| bucket.accounts.iter())
            .filter(|item| item.account == account)
            .fold((0_u64, 0_u64), |(input, output), item| {
                (
                    input.saturating_add(item.input_tokens),
                    output.saturating_add(item.output_tokens),
                )
            })
    }

    pub fn flush(&self) -> std::io::Result<()> {
        let document = TelemetryDocument {
            buckets: self.snapshot(),
        };
        let rendered = serde_json::to_vec(&document)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = self
            .path
            .with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&temporary, rendered)?;
        std::fs::rename(temporary, &self.path)
    }

    pub fn spawn_flush_worker(self: &std::sync::Arc<Self>, interval: std::time::Duration) {
        let store = std::sync::Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = ticker.tick() => {}
                    _ = store.flush_requested.notified() => {}
                }
                let flush_store = std::sync::Arc::clone(&store);
                let result = tokio::task::spawn_blocking(move || flush_store.flush()).await;
                if let Ok(Err(error)) = result {
                    tracing::warn!(%error, "failed to flush telemetry history");
                }
            }
        });
    }
}

fn load_buckets(path: &Path) -> Vec<TelemetryBucket> {
    std::fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<TelemetryDocument>(&raw).ok())
        .map(|document| document.buckets)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_buckets_survive_store_recreation() {
        let dir = std::env::temp_dir().join(format!("mahoquot-telemetry-{}", std::process::id()));
        let path = dir.join("telemetry.json");
        let store = TelemetryStore::load(path.clone());
        store.record_with_account(1_800, "codex", None, true);
        store.record_with_account(1_801, "codex", None, false);
        store.record_tokens(1_801, "codex", "codex-1", 120, 45);
        store.flush().expect("flush telemetry");

        let restored = TelemetryStore::load(path);

        assert_eq!(restored.snapshot()[0].requests, 2);
        assert_eq!(restored.snapshot()[0].successes, 1);
        assert_eq!(restored.snapshot()[0].failures, 1);
        assert_eq!(restored.snapshot()[0].providers[0].provider, "codex");
        assert_eq!(restored.account_tokens("codex-1"), (120, 45));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn token_usage_accumulates_without_incrementing_requests() {
        let store = TelemetryStore::load(PathBuf::from("unused.json"));
        store.record_with_account(1_800, "codex", Some("codex-1"), true);
        store.record_tokens(1_800, "codex", "codex-1", 50, 20);
        store.record_tokens(1_801, "codex", "codex-1", 25, 10);

        let bucket = &store.snapshot()[0];
        assert_eq!(bucket.requests, 1);
        assert_eq!(bucket.input_tokens, 75);
        assert_eq!(bucket.output_tokens, 30);
        assert_eq!(store.account_tokens("codex-1"), (75, 30));
    }

    #[test]
    fn retention_drops_buckets_older_than_thirty_days() {
        let store = TelemetryStore::load(PathBuf::from("unused.json"));
        store.record_with_account(0, "codex", None, true);
        store.record_with_account((RETENTION_MINUTES + 1) * 60, "claude", None, true);

        assert_eq!(store.snapshot().len(), 1);
        assert_eq!(store.snapshot()[0].providers[0].provider, "claude");
    }
}
