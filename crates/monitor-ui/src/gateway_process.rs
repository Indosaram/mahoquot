use std::time::Duration;

#[allow(dead_code)]
pub fn provision_management_key<B: crate::secrets::SecretBackend>(
    store: &crate::secrets::SecretStore<B>,
    config_path: &std::path::Path,
    endpoint: &str,
) -> Result<String, String> {
    provision_management_key_from_profiles(store, store, config_path, endpoint)
}

pub fn provision_management_key_from_profiles<
    B: crate::secrets::SecretBackend,
    L: crate::secrets::SecretBackend,
>(
    store: &crate::secrets::SecretStore<B>,
    general_store: &crate::secrets::SecretStore<L>,
    config_path: &std::path::Path,
    endpoint: &str,
) -> Result<String, String> {
    use crate::secrets::{SecretKind, SecretRef};
    use std::io::Write;
    let reference = SecretRef::new(endpoint, "owned-gateway", SecretKind::ManagementKey);
    let existing = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Cannot read owned gateway configuration: {error}")),
    };
    let document: serde_yaml::Value = serde_yaml::from_str(&existing)
        .map_err(|error| format!("Repair gateway YAML before management key migration: {error}"))?;
    let configured = document
        .get("remote-management")
        .and_then(|value| value.get("secret-key"))
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("");
    let stored = store.read(&reference).map_err(|error| error.to_string())?;
    if !configured.is_empty() {
        let key = if configured.starts_with("$2") {
            let valid = |key: &str| {
                bcrypt::verify(key, configured)
                    .map_err(|_| "Invalid management secret hash".to_string())
            };
            let dedicated = match stored {
                Some(key) if valid(&key)? => Some(key),
                _ => None,
            };
            if let Some(key) = dedicated {
                key
            } else {
                let general = SecretRef::new(endpoint, "default", SecretKind::ManagementKey);
                let candidate = general_store.read(&general).map_err(|error| error.to_string())?
                    .ok_or("Enter the existing management key in the UI profile, then retry starting the owned gateway")?;
                if !valid(&candidate)? {
                    return Err("Saved UI management key does not match the owned gateway configuration; re-enter the working key and retry".into());
                }
                candidate
            }
        } else {
            configured.to_owned()
        };
        if store
            .read(&reference)
            .map_err(|error| error.to_string())?
            .as_deref()
            != Some(key.as_str())
        {
            store
                .write_verified(&reference, &key)
                .map_err(|error| error.to_string())?;
        }
        return Ok(key);
    }
    let key = stored.filter(|value| !value.is_empty()).unwrap_or_else(|| {
        format!(
            "mq-management-{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    });
    store
        .write_verified(&reference, &key)
        .map_err(|error| error.to_string())?;
    let digest = bcrypt::hash(&key, bcrypt::DEFAULT_COST).map_err(|error| error.to_string())?;
    let quoted = serde_json::to_string(&digest).map_err(|error| error.to_string())?;
    let updated = config_with_management_key(&existing, &quoted)?;
    let parent = config_path
        .parent()
        .ok_or("Owned gateway configuration has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let stage = parent.join(format!(".management-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&stage)?;
        file.write_all(updated.as_bytes())?;
        file.sync_all()?;
        let current = match std::fs::read_to_string(config_path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        if current != existing {
            return Err(std::io::Error::other(
                "Gateway configuration changed during management migration",
            ));
        }
        std::fs::rename(&stage, config_path)
    })();
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(&stage) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%cleanup, "management migration staging cleanup failed");
            }
        }
        return Err(format!(
            "Cannot provision dedicated management key: {error}"
        ));
    }
    Ok(key)
}

fn config_with_management_key(existing: &str, quoted: &str) -> Result<String, String> {
    let mut lines: Vec<String> = existing.lines().map(str::to_owned).collect();
    if let Some(start) = lines
        .iter()
        .position(|line| line.starts_with("remote-management:"))
    {
        let tail = lines[start]
            .strip_prefix("remote-management:")
            .unwrap_or("")
            .trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            let document: serde_yaml::Value =
                serde_yaml::from_str(existing).map_err(|error| error.to_string())?;
            let mut management = document
                .get("remote-management")
                .cloned()
                .unwrap_or(serde_yaml::Value::Null);
            if management.is_null() {
                management = serde_yaml::Value::Mapping(Default::default());
            }
            let map = management
                .as_mapping_mut()
                .ok_or("remote-management must be a YAML mapping")?;
            let value: serde_yaml::Value =
                serde_yaml::from_str(quoted).map_err(|error| error.to_string())?;
            map.insert(serde_yaml::Value::String("secret-key".into()), value);
            let block = serde_yaml::to_string(&management).map_err(|error| error.to_string())?;
            let suffix = lines[start]
                .split_once(':')
                .map(|(_, tail)| tail)
                .unwrap_or("");
            let mut single = false;
            let mut double = false;
            let mut escaped = false;
            let comment = suffix
                .char_indices()
                .find_map(|(index, ch)| {
                    if escaped {
                        escaped = false;
                        return None;
                    }
                    if double && ch == '\\' {
                        escaped = true;
                        return None;
                    }
                    if ch == '\'' && !double {
                        single = !single;
                    }
                    if ch == '"' && !single {
                        double = !double;
                    }
                    if ch == '#' && !single && !double {
                        Some(&suffix[index..])
                    } else {
                        None
                    }
                })
                .unwrap_or("");
            lines[start] = if comment.is_empty() {
                "remote-management:".into()
            } else {
                format!("remote-management: {comment}")
            };
            for (offset, line) in block.lines().enumerate() {
                lines.insert(start + 1 + offset, format!("  {line}"));
            }
        } else {
            let end = (start + 1..lines.len())
                .find(|index| {
                    !lines[*index].starts_with(char::is_whitespace)
                        && !lines[*index].is_empty()
                        && !lines[*index].starts_with('#')
                })
                .unwrap_or(lines.len());
            if let Some(index) =
                (start + 1..end).find(|index| lines[*index].trim_start().starts_with("secret-key:"))
            {
                let indent = lines[index].len() - lines[index].trim_start().len();
                lines[index] = format!("{}secret-key: {quoted}", " ".repeat(indent));
            } else {
                lines.insert(start + 1, format!("  secret-key: {quoted}"));
            }
        }
    } else {
        lines.push("remote-management:".into());
        lines.push(format!("  secret-key: {quoted}"));
    }
    let updated = lines.join("\n") + "\n";
    serde_yaml::from_str::<serde_yaml::Value>(&updated).map_err(|error| error.to_string())?;
    Ok(updated)
}

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
    fn general_ui_bcrypt_key_is_copied_idempotently_without_losing_original() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        let digest = bcrypt::hash("working-key", 4).unwrap();
        let yaml = format!("remote-management: {{allow-remote: false, secret-key: '{digest}'}}\n");
        std::fs::write(&config, &yaml).unwrap();
        let general = crate::secrets::SecretStore::new(crate::secrets::PlainFileBackend::for_path(
            dir.path().join("general.json"),
        ));
        let dedicated = crate::secrets::SecretStore::new(
            crate::secrets::PlainFileBackend::for_path(dir.path().join("dedicated.json")),
        );
        let reference = crate::secrets::SecretRef::new(
            "http://127.0.0.1:18840",
            "default",
            crate::secrets::SecretKind::ManagementKey,
        );
        general.write_verified(&reference, "working-key").unwrap();
        for _ in 0..2 {
            assert_eq!(
                provision_management_key_from_profiles(
                    &dedicated,
                    &general,
                    &config,
                    "http://127.0.0.1:18840"
                )
                .unwrap(),
                "working-key"
            );
            assert_eq!(
                general.read(&reference).unwrap().as_deref(),
                Some("working-key")
            );
            assert_eq!(std::fs::read_to_string(&config).unwrap(), yaml);
        }
    }

    #[test]
    fn inline_yaml_migration_preserves_explicit_values_without_inventing_defaults() {
        let yaml = "# retained\nremote-management: {allow-remote: false, disable-control-panel: true, panel-github-repository: '', custom: {enabled: false}} # operator\nrouting: {strategy: fill-first}\n";
        let updated = config_with_management_key(yaml, "\"digest\"").unwrap();
        let before: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap();
        let mut after: serde_yaml::Value = serde_yaml::from_str(&updated).unwrap();
        assert_eq!(
            after["remote-management"]
                .as_mapping_mut()
                .unwrap()
                .remove(serde_yaml::Value::String("secret-key".into())),
            Some(serde_yaml::Value::String("digest".into()))
        );
        assert_eq!(after, before);
        assert!(updated.contains("# operator"));
        assert!(updated.ends_with("routing: {strategy: fill-first}\n"));
    }

    #[cfg(not(feature = "isolated-secret-tests"))]
    #[test]
    fn task26_native_management_qa_driver() {
        use crate::secrets::{SecretBackend, SecretKind, SecretRef, SecretStoreError};
        let Some(root) = std::env::var_os("MAHOQUOT_TASK26_NATIVE_QA_DIR") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let endpoint = std::env::var("MAHOQUOT_TASK26_NATIVE_ENDPOINT").unwrap();
        struct NamespacedKeychain(String);
        impl SecretBackend for NamespacedKeychain {
            fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
                crate::secrets::KeyringBackend.read(&format!("{}|{account}", self.0))
            }
            fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
                crate::secrets::KeyringBackend.write(&format!("{}|{account}", self.0), value)
            }
            fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
                crate::secrets::KeyringBackend.delete(&format!("{}|{account}", self.0))
            }
        }
        let native = crate::secrets::SecretStore::new(NamespacedKeychain(format!(
            "task26-{}",
            uuid::Uuid::new_v4()
        )));
        let general = crate::secrets::SecretStore::new(crate::secrets::PlainFileBackend::for_path(
            root.join("general.json"),
        ));
        let config = root.join("native-config.yaml");
        let reference = SecretRef::new(&endpoint, "owned-gateway", SecretKind::ManagementKey);
        let outcome = std::panic::catch_unwind(|| {
            std::fs::write(
                &config,
                "remote-management: {allow-remote: false}\nrouting: {strategy: fill-first}\n",
            )
            .unwrap();
            let key = provision_management_key_from_profiles(&native, &general, &config, &endpoint)
                .unwrap();
            assert_eq!(
                native.read(&reference).unwrap().as_deref(),
                Some(key.as_str())
            );
            let bytes = std::fs::read(&config).unwrap();
            assert_eq!(
                provision_management_key_from_profiles(&native, &general, &config, &endpoint)
                    .unwrap(),
                key
            );
            assert_eq!(std::fs::read(&config).unwrap(), bytes);
            let script = crate::bootstrap::management_initialization_script(&endpoint, &key);
            let payload: serde_json::Value = serde_json::from_str(
                script
                    .strip_prefix("window.__MAHOQUOT_MANAGEMENT__=")
                    .unwrap()
                    .strip_suffix(';')
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(payload["key"], key);
            native.delete(&reference).unwrap();
            let general_ref = SecretRef::new(&endpoint, "default", SecretKind::ManagementKey);
            general.write_verified(&general_ref, &key).unwrap();
            assert_eq!(
                provision_management_key_from_profiles(&native, &general, &config, &endpoint)
                    .unwrap(),
                key
            );
            assert_eq!(
                general.read(&general_ref).unwrap().as_deref(),
                Some(key.as_str())
            );
            assert_eq!(std::fs::read(&config).unwrap(), bytes);
            struct Locked;
            impl SecretBackend for Locked {
                fn read(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
                    Ok(None)
                }
                fn write(&self, _: &str, _: &str) -> Result<(), SecretStoreError> {
                    Err(SecretStoreError::Locked)
                }
                fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
                    Ok(())
                }
            }
            let locked = crate::secrets::SecretStore::new(Locked);
            assert!(
                provision_management_key_from_profiles(&locked, &general, &config, &endpoint)
                    .is_err()
            );
            assert_eq!(
                general.read(&general_ref).unwrap().as_deref(),
                Some(key.as_str())
            );
            assert_eq!(std::fs::read(&config).unwrap(), bytes);
            let remote_ref = SecretRef::new(
                "https://remote.fixture.invalid",
                "default",
                SecretKind::ManagementKey,
            );
            general
                .write_verified(&remote_ref, "saved-remote-key")
                .unwrap();
            let remote_before = std::fs::read(root.join("general.json")).unwrap();
            assert_eq!(
                provision_management_key_from_profiles(&native, &general, &config, &endpoint)
                    .unwrap(),
                key
            );
            assert_eq!(
                std::fs::read(root.join("general.json")).unwrap(),
                remote_before
            );
            let result = serde_json::json!({"key": key, "bootstrap": payload, "keychain_verified": true, "restart_retained": true, "general_recovery_retained": true, "keychain_failure_preserved": true, "saved_remote_preserved": true});
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(root.join("native-result.json"))
                .unwrap()
                .write_all(serde_json::to_string(&result).unwrap().as_bytes())
                .unwrap();
        });
        native.delete(&reference).unwrap();
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn hashed_operator_secret_is_verified_and_adopted_without_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let digest = bcrypt::hash("operator-key", 4).unwrap();
        let yaml = format!("remote-management:\n  secret-key: {digest}\n");
        std::fs::write(&path, &yaml).unwrap();
        let store = crate::secrets::SecretStore::new(crate::secrets::PlainFileBackend::for_path(
            dir.path().join("secrets.json"),
        ));
        let reference = crate::secrets::SecretRef::new(
            "http://127.0.0.1:18840",
            "owned-gateway",
            crate::secrets::SecretKind::ManagementKey,
        );
        store.write_verified(&reference, "operator-key").unwrap();
        assert_eq!(
            provision_management_key(&store, &path, "http://127.0.0.1:18840").unwrap(),
            "operator-key"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), yaml);
    }

    #[test]
    fn management_first_launch_reuses_verified_secret_and_preserves_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(
            &path,
            "# retained\napi-keys: [inference]\nrouting:\n  strategy: fill-first\n",
        )
        .unwrap();
        let store = crate::secrets::SecretStore::new(crate::secrets::PlainFileBackend::for_path(
            dir.path().join("secrets.json"),
        ));
        let key = provision_management_key(&store, &path, "http://127.0.0.1:18840").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            provision_management_key(&store, &path, "http://127.0.0.1:18840").unwrap(),
            key
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(String::from_utf8(bytes)
            .unwrap()
            .contains("# retained\napi-keys: [inference]\nrouting:\n  strategy: fill-first"));
    }

    #[test]
    fn operator_management_secret_is_adopted_without_config_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let yaml = "remote-management:\n  secret-key: operator-key\n";
        std::fs::write(&path, yaml).unwrap();
        let store = crate::secrets::SecretStore::new(crate::secrets::PlainFileBackend::for_path(
            dir.path().join("secrets.json"),
        ));
        assert_eq!(
            provision_management_key(&store, &path, "http://127.0.0.1:18840").unwrap(),
            "operator-key"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), yaml);
    }

    #[test]
    fn keychain_failure_leaves_owned_configuration_unchanged() {
        struct Locked;
        impl crate::secrets::SecretBackend for Locked {
            fn read(&self, _: &str) -> Result<Option<String>, crate::secrets::SecretStoreError> {
                Ok(None)
            }
            fn write(&self, _: &str, _: &str) -> Result<(), crate::secrets::SecretStoreError> {
                Err(crate::secrets::SecretStoreError::Locked)
            }
            fn delete(&self, _: &str) -> Result<(), crate::secrets::SecretStoreError> {
                Ok(())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(&path, "api-keys: [inference]\n").unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(provision_management_key(
            &crate::secrets::SecretStore::new(Locked),
            &path,
            "http://127.0.0.1:18840"
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

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
