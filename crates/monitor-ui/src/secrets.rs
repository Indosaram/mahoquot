use std::fmt;

#[cfg(not(feature = "isolated-secret-tests"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(not(feature = "isolated-secret-tests"))]
use serde::{Deserialize, Serialize};

#[cfg(not(feature = "isolated-secret-tests"))]
#[allow(dead_code)]
const SECRET_SERVICE: &str = "mahoquot.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(feature = "isolated-secret-tests"), derive(Deserialize))]
#[cfg_attr(
    not(feature = "isolated-secret-tests"),
    serde(rename_all = "snake_case")
)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(feature = "isolated-secret-tests"), derive(Serialize))]
#[cfg_attr(
    not(feature = "isolated-secret-tests"),
    serde(tag = "kind", content = "detail", rename_all = "snake_case")
)]
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
#[derive(Debug, Clone, Default)]
pub struct PlainFileBackend;

impl PlainFileBackend {
    fn path() -> std::path::PathBuf {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(home)
            .join(".mahoquot")
            .join("secrets.json")
    }

    fn load() -> std::collections::HashMap<String, String> {
        let path = Self::path();
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(map) = serde_json::from_slice(&bytes) {
                return map;
            }
        }
        std::collections::HashMap::new()
    }

    fn save(map: &std::collections::HashMap<String, String>) -> Result<(), SecretStoreError> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let bytes = serde_json::to_vec_pretty(map)
            .map_err(|e| SecretStoreError::Backend(format!("serialize: {e}")))?;
        std::fs::write(&path, bytes)
            .map_err(|e| SecretStoreError::Backend(format!("write: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

impl SecretBackend for PlainFileBackend {
    fn read(&self, account: &str) -> Result<Option<String>, SecretStoreError> {
        let map = Self::load();
        Ok(map.get(account).cloned())
    }

    fn write(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
        let mut map = Self::load();
        map.insert(account.to_string(), value.to_string());
        Self::save(&map)
    }

    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        let mut map = Self::load();
        if map.remove(account).is_some() {
            Self::save(&map)?;
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

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(feature = "isolated-secret-tests"), derive(Serialize))]
pub struct MigrationOutcome {
    pub value: Option<String>,
    pub remove_legacy: bool,
    pub reconnect: bool,
}

fn normalize_endpoint(endpoint: &str) -> String {
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

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Failure {
        Locked,
        Unavailable,
        Write,
        ReadbackMismatch,
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
}
