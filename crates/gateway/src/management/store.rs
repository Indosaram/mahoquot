use std::path::{Path, PathBuf};
use std::sync::Arc;

use arc_swap::ArcSwap;

use super::settings::{Settings, SettingsError};

/// Holds the live settings document and swaps it atomically.
///
/// The relay hot path reads settings on every request under a p50 latency
/// gate, so readers must never contend: `current()` is a lock-free atomic load
/// and mutation publishes a whole new `Arc` rather than editing in place. A
/// `RwLock` here would put every proxied request behind a writer.
#[derive(Debug)]
pub struct SettingsStore {
    current: ArcSwap<Settings>,
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(settings: Settings, path: PathBuf) -> Self {
        Self {
            current: ArcSwap::from_pointee(settings),
            path,
        }
    }

    /// Load from `path`, falling back to the supplied environment-derived
    /// document when the file is absent. A file that exists but does not parse
    /// is an error rather than a silent fallback, so a typo in config.yaml can
    /// never be mistaken for "no config" and quietly revert live settings.
    pub fn load_or(path: PathBuf, fallback: Settings) -> Result<Self, SettingsError> {
        if path.exists() {
            let settings = Settings::load(&path)?;
            return Ok(Self::new(settings, path));
        }
        // Upstream always has a config file, so `GET /config.yaml` never 404s
        // there. Materialise the boot document once so the served surface
        // matches instead of depending on a write having happened first.
        //
        // An empty path means no config file was requested at all (embedding
        // and tests construct the gateway this way), and writing to it would
        // fail; such a store stays purely in memory.
        let store = Self::new(fallback, path);
        if !store.path.as_os_str().is_empty() {
            store.mutate(|_| {})?;
        }
        Ok(store)
    }

    pub fn current(&self) -> Arc<Settings> {
        self.current.load_full()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Re-read the document from disk and publish it.
    pub fn reload(&self) -> Result<Arc<Settings>, SettingsError> {
        let settings = Settings::load(&self.path)?;
        let published = Arc::new(settings);
        self.current.store(published.clone());
        Ok(published)
    }

    /// Apply `edit` to a copy of the live document, persist it, then publish.
    ///
    /// Persisting before publishing means a failed write leaves the in-memory
    /// document untouched, so the API never reports a change it did not manage
    /// to save.
    pub fn mutate<F>(&self, edit: F) -> Result<Arc<Settings>, SettingsError>
    where
        F: FnOnce(&mut Settings),
    {
        let mut next = Settings::clone(&self.current());
        edit(&mut next);
        next.persist(&self.path)?;
        let published = Arc::new(next);
        self.current.store(published.clone());
        Ok(published)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mahoquot-store-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_present_file_wins_over_the_env_fallback() {
        // given a config.yaml on disk and a different env-derived fallback
        let dir = temp_dir("precedence");
        let path = dir.join("config.yaml");
        std::fs::write(&path, "port: 19001\n").expect("write");
        let fallback = Settings {
            port: 18801,
            ..Settings::default()
        };
        // when the store loads
        let store = SettingsStore::load_or(path, fallback).expect("loads");
        // then the file's value is live
        assert_eq!(store.current().port, 19001);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_env_fallback_is_used_when_no_file_exists() {
        // given no config.yaml
        let dir = temp_dir("fallback");
        let path = dir.join("config.yaml");
        let fallback = Settings {
            port: 18842,
            ..Settings::default()
        };
        // when the store loads
        let store = SettingsStore::load_or(path, fallback).expect("loads");
        // then the environment-derived document is live
        assert_eq!(store.current().port, 18842);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unparsable_file_is_an_error_not_a_silent_fallback() {
        // given a corrupt config.yaml
        let dir = temp_dir("corrupt");
        let path = dir.join("config.yaml");
        std::fs::write(&path, "port: [this is not a number\n").expect("write");
        // when the store loads
        let result = SettingsStore::load_or(path, Settings::default());
        // then it refuses rather than reverting to defaults
        assert!(result.is_err(), "corrupt config must not load silently");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mutate_persists_and_publishes() {
        // given a store backed by a file
        let dir = temp_dir("mutate");
        let path = dir.join("config.yaml");
        let store = SettingsStore::load_or(path.clone(), Settings::default()).expect("loads");
        // when a field is mutated
        store.mutate(|s| s.request_retry = 9).expect("mutates");
        // then the live document reflects it
        assert_eq!(store.current().request_retry, 9);
        // and so does the file on disk
        let on_disk = Settings::load(&path).expect("reloads");
        assert_eq!(on_disk.request_retry, 9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reload_picks_up_an_external_edit() {
        // given a store whose file is changed behind its back
        let dir = temp_dir("reload");
        let path = dir.join("config.yaml");
        let store = SettingsStore::load_or(path.clone(), Settings::default()).expect("loads");
        assert_eq!(store.current().request_retry, 0);
        std::fs::write(&path, "request-retry: 4\n").expect("write");
        // when reload runs
        store.reload().expect("reloads");
        // then the new value is live without a restart
        assert_eq!(store.current().request_retry, 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_persist_leaves_the_live_document_unchanged() {
        // given a store whose path is not writable (parent is a file)
        let dir = temp_dir("failwrite");
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").expect("write");
        let path = blocker.join("config.yaml");
        let store = SettingsStore::new(Settings::default(), path);
        // when a mutation cannot be saved
        let result = store.mutate(|s| s.request_retry = 5);
        // then it reports the failure and does not publish the change
        assert!(result.is_err(), "write into a file-as-directory must fail");
        assert_eq!(store.current().request_retry, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn readers_observe_a_consistent_document_across_concurrent_mutations() {
        // given a store under concurrent readers and writers
        let dir = temp_dir("concurrent");
        let path = dir.join("config.yaml");
        let store = Arc::new(SettingsStore::load_or(path, Settings::default()).expect("loads"));
        let writer = {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                for i in 1..=25 {
                    store
                        .mutate(|s| {
                            // both fields move together; a reader must never
                            // see one updated without the other
                            s.request_retry = i;
                            s.max_retry_interval = i * 2;
                        })
                        .expect("mutates");
                }
            })
        };
        let reader = {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                for _ in 0..500 {
                    let snapshot = store.current();
                    assert_eq!(
                        snapshot.max_retry_interval,
                        snapshot.request_retry * 2,
                        "torn read: fields from different generations"
                    );
                }
            })
        };
        // then no reader ever observes a torn document
        writer.join().expect("writer");
        reader.join().expect("reader");
        std::fs::remove_dir_all(&dir).ok();
    }
}
