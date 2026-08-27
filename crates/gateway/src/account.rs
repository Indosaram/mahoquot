use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use quotio_providers::{derive_identity_slug, list_codex_auth_files, CodexAccount};
use quotio_types::{Health, PoolMember};

pub struct AccountMember {
    pub id: String,
    pub inner: CodexAccount,
    pub health: RwLock<Health>,
    pub upstream_override: Option<String>,
    pub ok_count: AtomicU64,
    pub fail_count: AtomicU64,
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
        None
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

    pub fn set_health(&self, health: Health) {
        let mut guard = self
            .health
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = health;
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
            inner,
            health: RwLock::new(Health::Available),
            upstream_override,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
        }));
    }

    Ok(members)
}
