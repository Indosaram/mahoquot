use std::fmt;

#[cfg(not(feature = "isolated-secret-tests"))]
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

#[cfg(not(feature = "isolated-secret-tests"))]
#[allow(dead_code)]
const SECRET_SERVICE: &str = "mahoquot.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    ManagementKey,
    Totp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRef {
    pub endpoint: String,
    pub profile: String,
    pub kind: SecretKind,
}

impl SecretRef {
    pub fn new(endpoint: &str, profile: &str, kind: SecretKind) -> Self {
        Self {
            endpoint: normalize_endpoint(endpoint),
            profile: normalize_profile(profile),
            kind,
        }
    }

    fn account(&self) -> String {
        let kind = match self.kind {
            SecretKind::ManagementKey => "management-key",
            SecretKind::Totp => "totp",
        };
        format!("{kind}|{}|{}", self.endpoint, self.profile)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum SecretStoreError {
    #[allow(dead_code)]
    Locked,
    #[allow(dead_code)]
    Unavailable,
    VerificationFailed,
    Backend(String),
}

impl SecretStoreError {
    #[cfg(any(test, feature = "isolated-secret-tests"))]
    pub fn action(&self) -> SecretRecoveryAction {
        match self {
            Self::Locked | Self::Unavailable => SecretRecoveryAction::Retry,
            Self::VerificationFailed | Self::Backend(_) => SecretRecoveryAction::Reenter,
        }
    }
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Locked => write!(formatter, "desktop secret store is locked"),
            Self::Unavailable => write!(formatter, "desktop secret store is unavailable"),
            Self::VerificationFailed => {
                write!(formatter, "desktop secret write could not be verified")
            }
            Self::Backend(message) => write!(formatter, "desktop secret store failed: {message}"),
        }
    }
}

impl std::error::Error for SecretStoreError {}

#[cfg(any(test, feature = "isolated-secret-tests"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(feature = "isolated-secret-tests"), derive(Serialize))]
#[cfg_attr(
    not(feature = "isolated-secret-tests"),
    serde(rename_all = "snake_case")
)]
pub enum SecretRecoveryAction {
    Retry,
    Reenter,
}

pub trait SecretBackend {
    fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError>;
    fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError>;
    fn delete(&self, account: &str) -> Result<(), SecretStoreError>;
}

/// Plain filesystem secret backend that stores secrets under `~/.mahoquot/secrets.json`
/// without popping OS Keychain / Windows Credential Manager authentication dialogs.
#[derive(Debug, Clone)]
pub struct PlainFileBackend {
    path: std::path::PathBuf,
}

impl PlainFileBackend {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            path: crate::tray::current_home()?.join(".mahoquot/secrets.json"),
        })
    }

    #[cfg(test)]
    pub fn for_path(path: std::path::PathBuf) -> Self {
        Self { path }
    }

    fn load_from(
        path: &std::path::Path,
    ) -> Result<std::collections::HashMap<String, String>, SecretStoreError> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| SecretStoreError::Backend(format!("parse secrets: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(SecretStoreError::Backend(format!("read secrets: {e}"))),
        }
    }

    fn lock(&self) -> Result<std::fs::File, SecretStoreError> {
        let parent = self.path.parent().expect("secret path has parent");
        std::fs::create_dir_all(parent).map_err(Self::io_error)?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Keep the sidecar inode stable across replacement and process lifetimes.
        let file = options
            .open(self.path.with_extension("lock"))
            .map_err(Self::io_error)?;
        file.lock().map_err(Self::io_error)?;
        Ok(file)
    }

    fn io_error(error: std::io::Error) -> SecretStoreError {
        SecretStoreError::Backend(error.to_string())
    }

    fn save_to(
        path: &std::path::Path,
        map: &std::collections::HashMap<String, String>,
        before_replace: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
    ) -> Result<(), SecretStoreError> {
        use std::io::Write;
        let bytes = serde_json::to_vec_pretty(map)
            .map_err(|e| SecretStoreError::Backend(format!("serialize: {e}")))?;
        let parent = path.parent().expect("secret path has parent");
        let stage = parent.join(format!(".secrets-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&stage).map_err(Self::io_error)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            before_replace(&stage)?;
            std::fs::rename(&stage, path)
        })();
        if let Err(error) = result {
            if let Err(cleanup) = std::fs::remove_file(&stage) {
                return Err(SecretStoreError::Backend(format!(
                    "{error}; temporary file cleanup: {cleanup}"
                )));
            }
            return Err(Self::io_error(error));
        }
        Ok(())
    }
}

impl SecretBackend for PlainFileBackend {
    fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
        let _lock = self.lock()?;
        Ok(Self::load_from(&self.path)?.get(account).cloned())
    }

    fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
        let _lock = self.lock()?;
        let mut map = Self::load_from(&self.path)?;
        map.insert(account.to_string(), value.to_string());
        Self::save_to(&self.path, &map, |_| Ok(()))
    }

    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        let _lock = self.lock()?;
        let mut map = Self::load_from(&self.path)?;
        if map.remove(account).is_some() {
            Self::save_to(&self.path, &map, |_| Ok(()))?;
        }
        Ok(())
    }
}

#[cfg(not(feature = "isolated-secret-tests"))]
#[derive(Debug, Clone, Copy, Default)]
#[allow(dead_code)]
pub struct KeyringBackend;

#[cfg(not(feature = "isolated-secret-tests"))]
#[allow(dead_code)]
impl KeyringBackend {
    fn entry(account: &str) -> Result<Entry, SecretStoreError> {
        Entry::new(SECRET_SERVICE, account).map_err(map_keyring_error)
    }
}

#[cfg(not(feature = "isolated-secret-tests"))]
impl SecretBackend for KeyringBackend {
    fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
        Self::entry(account)?
            .set_password(value)
            .map_err(map_keyring_error)
    }

    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

pub struct SecretStore<B> {
    backend: B,
}

impl<B: SecretBackend> SecretStore<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn read(&self, secret: &SecretRef) -> Result<Option<String>, SecretStoreError> {
        self.backend.read(&secret.account())
    }

    pub fn write(&self, secret: &SecretRef, value: &str) -> Result<(), SecretStoreError> {
        self.backend.write(&secret.account(), value)
    }

    pub fn delete(&self, secret: &SecretRef) -> Result<(), SecretStoreError> {
        self.backend.delete(&secret.account())
    }

    pub fn migrate_legacy(
        &self,
        secret: &SecretRef,
        legacy_value: Option<&str>,
    ) -> Result<MigrationOutcome, SecretStoreError> {
        if let Some(value) = self.read(secret)? {
            return Ok(MigrationOutcome {
                reconnect: false,
                value: Some(value),
                remove_legacy: legacy_value.is_some(),
            });
        }

        let Some(legacy_value) = legacy_value.filter(|value| !value.is_empty()) else {
            return Ok(MigrationOutcome {
                value: None,
                remove_legacy: false,
                reconnect: false,
            });
        };

        self.write(secret, legacy_value)?;
        match self.read(secret) {
            Ok(Some(value)) if value == legacy_value => Ok(MigrationOutcome {
                value: Some(value),
                remove_legacy: true,
                reconnect: true,
            }),
            Ok(_) => {
                let _ = self.delete(secret);
                Err(SecretStoreError::VerificationFailed)
            }
            Err(error) => {
                let _ = self.delete(secret);
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MigrationOutcome {
    pub value: Option<String>,
    pub remove_legacy: bool,
    pub reconnect: bool,
}

pub fn normalize_endpoint(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn normalize_profile(profile: &str) -> String {
    profile.trim().to_ascii_lowercase()
}

#[cfg(not(feature = "isolated-secret-tests"))]
#[allow(dead_code)]
fn map_keyring_error(error: KeyringError) -> SecretStoreError {
    match error {
        KeyringError::NoStorageAccess(reason) => {
            let message = reason.to_string();
            if message.to_ascii_lowercase().contains("lock") {
                SecretStoreError::Locked
            } else {
                SecretStoreError::Unavailable
            }
        }
        KeyringError::PlatformFailure(reason) => {
            let message = reason.to_string();
            if message.to_ascii_lowercase().contains("lock") {
                SecretStoreError::Locked
            } else {
                SecretStoreError::Backend(message)
            }
        }
        other => SecretStoreError::Backend(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

    #[test]
    fn plain_file_rejects_corrupt_and_unreadable_instead_of_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        assert!(PlainFileBackend::load_from(&path).unwrap().is_empty());
        std::fs::write(&path, b"{broken").unwrap();
        assert!(
            PlainFileBackend::load_from(&path).is_err(),
            "corrupt bytes must not become an empty vault"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
        assert!(
            PlainFileBackend::load_from(dir.path()).is_err(),
            "non-NotFound read errors must propagate"
        );
        let backend = PlainFileBackend { path: path.clone() };
        assert!(backend.read("a").is_err());
        assert!(backend.write("b", "B").is_err());
        assert!(backend.delete("a").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
    }

    #[test]
    fn plain_file_failed_replacement_preserves_bytes_and_cleans_private_stage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let original = br#"{"a":"A"}"#;
        std::fs::write(&path, original).unwrap();
        let map = [("b".to_string(), "B".to_string())].into_iter().collect();
        let result = PlainFileBackend::save_to(&path, &map, |stage| {
            assert_eq!(stage.parent(), path.parent());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(stage)?.permissions().mode() & 0o777,
                    0o600
                );
            }
            Err(std::io::Error::other("injected replacement failure"))
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn plain_file_lock_excludes_independent_handles() {
        let dir = tempfile::tempdir().unwrap();
        let backend = PlainFileBackend {
            path: dir.path().join("secrets.json"),
        };
        let held = backend.lock().unwrap();
        let other = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(backend.path.with_extension("lock"))
            .unwrap();
        assert!(matches!(
            other.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(held);
        other.try_lock().unwrap();
    }

    #[test]
    fn plain_file_subprocess_writer() {
        let Some(path) = std::env::var_os("MAHOQUOT_SECRET_TEST_PATH") else {
            return;
        };
        let account = std::env::var("MAHOQUOT_SECRET_TEST_ACCOUNT").unwrap();
        use std::io::{Read, Write};
        println!("SECRET_WRITER_READY");
        std::io::stdout().flush().unwrap();
        let mut go = [0];
        std::io::stdin().read_exact(&mut go).unwrap();
        let backend = PlainFileBackend { path: path.into() };
        for index in 0..32 {
            backend
                .write(&format!("{account}-{index}"), &account)
                .unwrap();
        }
    }

    #[test]
    fn plain_file_concurrent_process_updates_survive_reopen() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let backend = PlainFileBackend { path: path.clone() };
        backend.write("a", "A").unwrap();
        let mut children = Vec::new();
        for account in ["b", "c"] {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "secrets::tests::plain_file_subprocess_writer",
                    "--nocapture",
                ])
                .env("MAHOQUOT_SECRET_TEST_PATH", &path)
                .env("MAHOQUOT_SECRET_TEST_ACCOUNT", account)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let output = child.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || {
                let mut ready = Some(tx);
                for line in BufReader::new(output).lines() {
                    let line = line.unwrap();
                    if line == "SECRET_WRITER_READY" {
                        ready.take().unwrap().send(()).unwrap();
                    }
                }
            });
            if let Err(error) = rx.recv_timeout(std::time::Duration::from_secs(20)) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("writer readiness: {error}");
            }
            children.push((child, reader));
        }
        for (child, _) in &mut children {
            child.stdin.take().unwrap().write_all(b"g").unwrap();
        }
        for (mut child, reader) in children {
            assert!(child.wait().unwrap().success());
            reader.join().unwrap();
        }
        let reopened = PlainFileBackend { path: path.clone() };
        assert_eq!(reopened.read("a").unwrap().as_deref(), Some("A"));
        for account in ["b", "c"] {
            for index in 0..32 {
                assert_eq!(
                    reopened
                        .read(&format!("{account}-{index}"))
                        .unwrap()
                        .as_deref(),
                    Some(account)
                );
            }
        }
        assert_eq!(PlainFileBackend::load_from(&path).unwrap().len(), 65);
        reopened.delete("b-0").unwrap();
        assert_eq!(reopened.read("b-0").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Failure {
        Locked,
        Unavailable,
        Write,
        ReadbackMismatch,
        ReadbackError,
    }

    #[derive(Clone, Default)]
    struct FakeBackend {
        values: Rc<RefCell<BTreeMap<String, String>>>,
        failure: Rc<RefCell<Option<Failure>>>,
    }

    impl FakeBackend {
        fn fail_with(&self, failure: Failure) {
            *self.failure.borrow_mut() = Some(failure);
        }
    }

    impl SecretBackend for FakeBackend {
        fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
            match *self.failure.borrow() {
                Some(Failure::Locked) => Err(SecretStoreError::Locked),
                Some(Failure::Unavailable) => Err(SecretStoreError::Unavailable),
                Some(Failure::ReadbackMismatch) if self.values.borrow().contains_key(account) => {
                    Ok(Some("different-value".to_string()))
                }
                Some(Failure::ReadbackError) if self.values.borrow().contains_key(account) => {
                    Err(SecretStoreError::Backend("readback failed".to_string()))
                }
                _ => Ok(self.values.borrow().get(account).cloned()),
            }
        }

        fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
            match *self.failure.borrow() {
                Some(Failure::Locked) => Err(SecretStoreError::Locked),
                Some(Failure::Unavailable) => Err(SecretStoreError::Unavailable),
                Some(Failure::Write) => Err(SecretStoreError::Backend("write failed".to_string())),
                _ => {
                    self.values
                        .borrow_mut()
                        .insert(account.to_string(), value.to_string());
                    Ok(())
                }
            }
        }

        fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
            self.values.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn management(endpoint: &str, profile: &str) -> SecretRef {
        SecretRef::new(endpoint, profile, SecretKind::ManagementKey)
    }

    #[test]
    fn create_read_update_delete_round_trip() {
        let store = SecretStore::new(FakeBackend::default());
        let secret = management("https://Gateway.Example.test/", " Primary ");

        store.write(&secret, "first").unwrap();
        assert_eq!(store.read(&secret).unwrap().as_deref(), Some("first"));
        store.write(&secret, "second").unwrap();
        assert_eq!(store.read(&secret).unwrap().as_deref(), Some("second"));
        store.delete(&secret).unwrap();
        assert_eq!(store.read(&secret).unwrap(), None);
    }

    #[test]
    fn endpoint_and_profile_separation() {
        let store = SecretStore::new(FakeBackend::default());
        let primary = management("https://one.example.test/", "primary");
        let secondary = management("https://one.example.test", "secondary");
        let remote = management("https://two.example.test", "primary");

        store.write(&primary, "one-primary").unwrap();
        store.write(&secondary, "one-secondary").unwrap();
        store.write(&remote, "two-primary").unwrap();

        assert_eq!(
            store.read(&primary).unwrap().as_deref(),
            Some("one-primary")
        );
        assert_eq!(
            store.read(&secondary).unwrap().as_deref(),
            Some("one-secondary")
        );
        assert_eq!(store.read(&remote).unwrap().as_deref(), Some("two-primary"));
    }

    #[test]
    fn management_keys_and_totp_material_are_separate() {
        let store = SecretStore::new(FakeBackend::default());
        let management = SecretRef::new(
            "https://gateway.example.test",
            "primary",
            SecretKind::ManagementKey,
        );
        let totp = SecretRef::new("https://gateway.example.test", "primary", SecretKind::Totp);

        store.write(&management, "management-secret").unwrap();
        store.write(&totp, "totp-material").unwrap();

        assert_eq!(
            store.read(&management).unwrap().as_deref(),
            Some("management-secret")
        );
        assert_eq!(store.read(&totp).unwrap().as_deref(), Some("totp-material"));
    }

    #[test]
    fn locked_store_is_actionable() {
        let backend = FakeBackend::default();
        backend.fail_with(Failure::Locked);
        let store = SecretStore::new(backend);

        let error = store
            .read(&management("https://gateway.example.test", "primary"))
            .unwrap_err();

        assert_eq!(error, SecretStoreError::Locked);
        assert_eq!(error.action(), SecretRecoveryAction::Retry);
    }

    #[test]
    fn unavailable_store_is_actionable() {
        let backend = FakeBackend::default();
        backend.fail_with(Failure::Unavailable);
        let store = SecretStore::new(backend);

        let error = store
            .write(
                &management("https://gateway.example.test", "primary"),
                "secret",
            )
            .unwrap_err();

        assert_eq!(error, SecretStoreError::Unavailable);
        assert_eq!(error.action(), SecretRecoveryAction::Retry);
    }

    #[test]
    fn migrates_legacy_key_and_reconnects() {
        let store = SecretStore::new(FakeBackend::default());
        let secret = management("HTTPS://Gateway.Example.test/", " Primary ");

        let outcome = store.migrate_legacy(&secret, Some("legacy-key")).unwrap();

        assert_eq!(outcome.value.as_deref(), Some("legacy-key"));
        assert!(outcome.remove_legacy);
        assert!(outcome.reconnect);
        assert_eq!(store.read(&secret).unwrap().as_deref(), Some("legacy-key"));
    }

    #[test]
    fn migration_is_one_time_when_keyring_already_has_a_value() {
        let store = SecretStore::new(FakeBackend::default());
        let secret = management("https://gateway.example.test", "primary");
        store.write(&secret, "keyring-key").unwrap();

        let outcome = store
            .migrate_legacy(&secret, Some("stale-browser-key"))
            .unwrap();

        assert_eq!(outcome.value.as_deref(), Some("keyring-key"));
        assert!(outcome.remove_legacy);
        assert!(!outcome.reconnect);
        assert_eq!(store.read(&secret).unwrap().as_deref(), Some("keyring-key"));
    }

    #[test]
    fn failed_write_preserves_legacy_value() {
        let backend = FakeBackend::default();
        backend.fail_with(Failure::Write);
        let store = SecretStore::new(backend);
        let legacy = "still-in-browser";

        let result = store.migrate_legacy(
            &management("https://gateway.example.test", "primary"),
            Some(legacy),
        );

        assert!(result.is_err());
        assert_eq!(legacy, "still-in-browser");
    }

    #[test]
    fn verification_failure_preserves_legacy_value() {
        let backend = FakeBackend::default();
        backend.fail_with(Failure::ReadbackMismatch);
        let store = SecretStore::new(backend.clone());
        let legacy = "still-in-browser";

        let error = store
            .migrate_legacy(
                &management("https://gateway.example.test", "primary"),
                Some(legacy),
            )
            .unwrap_err();

        assert_eq!(error, SecretStoreError::VerificationFailed);
        assert_eq!(error.action(), SecretRecoveryAction::Reenter);
        assert_eq!(legacy, "still-in-browser");
        assert!(backend.values.borrow().is_empty());
    }

    #[test]
    fn a_readback_failure_rolls_the_migration_back_instead_of_half_storing_it() {
        // given a store whose readback fails after the write lands
        let backend = FakeBackend::default();
        backend.fail_with(Failure::ReadbackError);
        let store = SecretStore::new(backend.clone());
        let secret = management("https://gateway.example.test", "primary");

        // when a legacy value is migrated
        let error = store
            .migrate_legacy(&secret, Some("still-in-browser"))
            .unwrap_err();

        // then the caller is told to re-enter and nothing is left behind
        assert_eq!(
            error,
            SecretStoreError::Backend("readback failed".to_string())
        );
        assert_eq!(error.action(), SecretRecoveryAction::Reenter);
        assert!(backend.values.borrow().is_empty());
    }

    #[test]
    fn nothing_to_migrate_leaves_the_store_untouched_and_asks_for_no_reconnect() {
        // given an empty store
        let backend = FakeBackend::default();
        let store = SecretStore::new(backend.clone());
        let secret = management("https://gateway.example.test", "primary");

        // when there is no legacy value, or only an empty one
        for legacy in [None, Some(""), Some("")] {
            let outcome = store.migrate_legacy(&secret, legacy).unwrap();

            // then no secret is invented and the session is left alone
            assert_eq!(
                outcome,
                MigrationOutcome {
                    value: None,
                    remove_legacy: false,
                    reconnect: false,
                }
            );
        }
        assert!(backend.values.borrow().is_empty());
    }

    #[test]
    fn a_stage_cleanup_failure_still_reports_the_original_cause() {
        // given a replacement that fails after the staged file is already gone
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let original = br#"{"a":"A"}"#;
        std::fs::write(&path, original).unwrap();
        let map = [("b".to_string(), "B".to_string())].into_iter().collect();

        // when the save cannot clean its own stage up either
        let result = PlainFileBackend::save_to(&path, &map, |stage| {
            std::fs::remove_file(stage)?;
            Err(std::io::Error::other("injected replacement failure"))
        });

        // then both causes survive in one error and the vault is untouched
        let SecretStoreError::Backend(message) = result.unwrap_err() else {
            panic!("a failed replacement must surface as a backend error");
        };
        assert!(
            message.contains("injected replacement failure"),
            "{message}"
        );
        assert!(
            message.len() > "injected replacement failure".len(),
            "the cleanup cause must survive too: {message}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn every_store_failure_is_distinct_and_keeps_its_backend_detail() {
        let messages = [
            SecretStoreError::Locked,
            SecretStoreError::Unavailable,
            SecretStoreError::VerificationFailed,
            SecretStoreError::Backend("disk is on fire".to_string()),
        ]
        .map(|error| error.to_string());

        assert!(messages.iter().all(|message| !message.is_empty()));
        assert_eq!(
            messages
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            messages.len(),
            "{messages:?}"
        );
        assert!(messages[3].contains("disk is on fire"), "{messages:?}");
    }

    #[cfg(not(feature = "isolated-secret-tests"))]
    #[test]
    fn keyring_failures_map_to_the_action_the_user_can_actually_take() {
        let mapped = |error| map_keyring_error(error);
        let locked = mapped(KeyringError::NoStorageAccess(Box::new(
            std::io::Error::other("the keychain is locked"),
        )));
        let unavailable = mapped(KeyringError::NoStorageAccess(Box::new(
            std::io::Error::other("no secret service is running"),
        )));
        let platform_locked = mapped(KeyringError::PlatformFailure(Box::new(
            std::io::Error::other("Keychain Locked"),
        )));
        let platform_other = mapped(KeyringError::PlatformFailure(Box::new(
            std::io::Error::other("errSecInternal"),
        )));

        assert_eq!(locked, SecretStoreError::Locked);
        assert_eq!(unavailable, SecretStoreError::Unavailable);
        assert_eq!(platform_locked, SecretStoreError::Locked);
        assert!(
            matches!(platform_other, SecretStoreError::Backend(ref detail) if detail.contains("errSecInternal"))
        );

        assert_eq!(locked.action(), SecretRecoveryAction::Retry);
        assert_eq!(unavailable.action(), SecretRecoveryAction::Retry);
        assert_eq!(platform_locked.action(), SecretRecoveryAction::Retry);
        assert_eq!(platform_other.action(), SecretRecoveryAction::Reenter);
        assert_eq!(
            mapped(KeyringError::NoEntry).action(),
            SecretRecoveryAction::Reenter
        );
    }
}
