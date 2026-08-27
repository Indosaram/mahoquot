use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use quotio_providers::refresh_exec::{apply_refresh_to_file, execute_refresh, RefreshError};
use quotio_providers::{derive_identity_slug, list_codex_auth_files, CodexAccount, LoadError};
use quotio_types::{Health, PoolMember};

pub struct AccountMember {
    pub id: String,
    pub file_path: PathBuf,
    pub inner: RwLock<CodexAccount>,
    pub health: RwLock<Health>,
    pub upstream_override: Option<String>,
    pub ok_count: AtomicU64,
    pub fail_count: AtomicU64,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub unsupported_models: RwLock<Vec<String>>,
}

impl PoolMember for AccountMember {
    fn id(&self) -> &str {
        &self.id
    }

    fn health(&self) -> Health {
        *self
            .health
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reset_at_unix(&self) -> Option<i64> {
        match self.health() {
            Health::Cooldown { until_unix_ms } => Some(until_unix_ms / 1000),
            _ => None,
        }
    }

    fn weight(&self) -> u32 {
        1
    }
}

impl AccountMember {
    pub fn record_ok(&self) {
        self.ok_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_fail(&self) {
        self.fail_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn supports_model(&self, model: &str) -> bool {
        let guard = self
            .unsupported_models
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        !guard.iter().any(|m| m == model)
    }

    pub fn mark_model_unsupported(&self, model: &str) {
        let mut guard = self
            .unsupported_models
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.iter().any(|m| m == model) {
            guard.push(model.to_string());
        }
    }

    pub fn set_health(&self, health: Health) {
        let mut guard = self
            .health
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = health;
    }

    pub fn is_expired(&self, now_unix: i64) -> bool {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.is_expired(now_unix)
    }

    pub fn build_upstream_headers(&self) -> Vec<(String, String)> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.build_upstream_headers()
    }

    pub fn access_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.access_token.clone()
    }

    pub fn refresh_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.refresh_token.clone()
    }

    pub fn reload_from_file(&self) -> Result<(), LoadError> {
        let mut reloaded = quotio_providers::load_codex_account(&self.file_path)?;
        if reloaded.identity_slug.is_empty() {
            reloaded.identity_slug = self.id.clone();
        }
        let mut guard = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = reloaded;
        Ok(())
    }

    pub async fn refresh(
        &self,
        client: &reqwest::Client,
        refresh_url: &str,
        presented_token: Option<&str>,
    ) -> Result<bool, RefreshError> {
        let _guard = self.refresh_lock.lock().await;

        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        if let Some(stale_token) = presented_token {
            if self.access_token() != stale_token {
                return Ok(false);
            }
        } else if !self.is_expired(now_unix) {
            return Ok(false);
        }

        let rt = self.refresh_token();
        let tokens = execute_refresh(client, refresh_url, &rt).await?;
        apply_refresh_to_file(&self.file_path, &tokens, now_unix)?;
        if let Err(e) = self.reload_from_file() {
            return Err(RefreshError::Parse(e.to_string()));
        }
        Ok(true)
    }
}

pub fn load_account_members(auth_dir: &Path) -> anyhow::Result<Vec<Arc<AccountMember>>> {
    let files = list_codex_auth_files(auth_dir)
        .map_err(|e| anyhow::anyhow!("failed to list auth files in {:?}: {}", auth_dir, e))?;

    let mut members = Vec::with_capacity(files.len());
    for file_path in files {
        let content = std::fs::read_to_string(&file_path)
            .map_err(|e| anyhow::anyhow!("failed to read {:?}: {}", file_path, e))?;

        let value: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| anyhow::anyhow!("failed to parse JSON from {:?}: {}", file_path, e))?;

        let upstream_override = value
            .get("upstream_override")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut inner: CodexAccount = serde_json::from_value(value).map_err(|e| {
            anyhow::anyhow!(
                "failed to deserialize CodexAccount from {:?}: {}",
                file_path,
                e
            )
        })?;

        if inner.identity_slug.is_empty() {
            inner.identity_slug = derive_identity_slug(&file_path);
        }

        let id = if !inner.identity_slug.is_empty() {
            inner.identity_slug.clone()
        } else {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("account")
                .to_string()
        };

        members.push(Arc::new(AccountMember {
            id,
            file_path,
            inner: RwLock::new(inner),
            health: RwLock::new(Health::Available),
            upstream_override,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
            refresh_lock: tokio::sync::Mutex::new(()),
            unsupported_models: RwLock::new(Vec::new()),
        }));
    }

    Ok(members)
}
