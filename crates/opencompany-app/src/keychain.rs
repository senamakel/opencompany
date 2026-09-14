//! Where a device session token actually lives.
//!
//! Every layer above this one has been written as though it already existed:
//! `users::devices` says the client "stores it in the OS keychain", the proxy's
//! module docs say the token "lives in the OS keychain and is read by this
//! process", and the console's `Credential` type carries a `ref` documented as
//! "a handle into the OS keychain, **never the secret**". Nothing implemented
//! it, so `oc_connect` took the raw token as an argument — from the webview,
//! which is the one place the design says it must never be.
//!
//! This is that missing floor. The console holds a `ref`; the token is
//! resolved here, in Rust, and put on the wire by
//! [`proxy::apply_credential`](crate::proxy). A `ref` is worth nothing on its
//! own: it names an entry in a store the webview cannot reach.
//!
//! ## Shape borrowed from openhuman
//!
//! `vendor/openhuman/src/openhuman/security/keyring/` solves the same problem
//! and has had the corners knocked off it. Three of its decisions are taken
//! wholesale, and they are the ones that matter:
//!
//! 1. **A trait with a test backend.** A unit test must never touch the
//!    operator's real keychain — on macOS that is a modal prompt per run, and
//!    on a headless CI runner there is no Secret Service at all. The backend is
//!    chosen once and frozen.
//! 2. **Namespaced keys.** Entries are `device-session:{connection}`, so two
//!    hosts cannot collide in one keychain — the same reason openhuman scopes
//!    by user id.
//! 3. **Unavailability is not an error.** A Linux box with no Secret Service,
//!    or a locked keychain, degrades to an in-memory store for the session
//!    rather than taking the app down. The operator re-pairs next launch, which
//!    is annoying; a desktop that refuses to start is worse. It is logged
//!    rather than hidden, because "my devices keep forgetting" needs a cause an
//!    operator can find.
//!
//! What is deliberately **not** borrowed is openhuman's encrypted-file backend.
//! That exists for staging and production servers where no OS keychain is
//! reachable; a desktop application always has one, and a plaintext-adjacent
//! fallback would quietly become the thing everyone ships.
//!
//! ## The Linux caveat, stated rather than discovered
//!
//! `keyring`'s `linux-native` feature is the kernel's keyutils, which is pure
//! Rust — no `libdbus`, no `libsecret`, so the desktop CI lane needs no extra
//! system packages. The cost is that a keyutils entry lives in the **session**
//! keyring: it survives for as long as the login session does and is gone after
//! a logout or reboot. A Linux operator will therefore re-pair more often than a
//! macOS or Windows one.
//!
//! That is a real limitation and it is written down rather than left to be
//! found, because the symptom — "my desktop forgets it is paired, but only on
//! this machine" — is otherwise a long way from its cause. Making it persistent
//! means `linux-native-sync-persistent`, which pulls Secret Service and its
//! system libraries back in; worth doing when a Linux desktop is actually
//! shipped, and not before.
//!
//! Nothing breaks when an entry vanishes: the connection registers
//! unauthenticated, the host answers 401, and the console shows its sign-in —
//! the same path an expired pairing takes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The service name every entry is filed under.
///
/// The bundle identifier rather than a friendly name: it is what macOS shows in
/// Keychain Access and what a person needs to recognise when deciding whether
/// to trust a prompt.
const SERVICE: &str = "ai.tinyhumans.opencompany";

/// The key prefix for a paired device's session token.
///
/// Prefixed so this crate can keep other secrets here later without a migration
/// — and so an entry's purpose is legible to someone reading their keychain.
const DEVICE_PREFIX: &str = "device-session";

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("the keychain refused the operation: {0}")]
    Backend(String),
}

/// A place to keep secrets, so tests need not use the operator's.
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, KeychainError>;
    fn set(&self, key: &str, value: &str) -> Result<(), KeychainError>;
    /// Idempotent: deleting an absent entry is not an error.
    fn delete(&self, key: &str) -> Result<(), KeychainError>;
    fn name(&self) -> &'static str;
}

/// The native credential store: macOS Keychain, Windows Credential Manager,
/// Linux Secret Service.
pub struct OsKeychain;

impl SecretStore for OsKeychain {
    fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| KeychainError::Backend(e.to_string()))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            // Absent and unreadable are both "no credential here". A locked or
            // missing store must read as unpaired rather than as a failure the
            // console has to render.
            Err(keyring::Error::NoEntry) | Err(keyring::Error::NoStorageAccess(_)) => Ok(None),
            Err(error) => Err(KeychainError::Backend(error.to_string())),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| KeychainError::Backend(e.to_string()))?;
        entry
            .set_password(value)
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }

    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        let entry =
            keyring::Entry::new(SERVICE, key).map_err(|e| KeychainError::Backend(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(KeychainError::Backend(error.to_string())),
        }
    }

    fn name(&self) -> &'static str {
        "os"
    }
}

/// An in-process store: tests, and the degraded path when no OS store answers.
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>, KeychainError> {
        Ok(self
            .entries
            .lock()
            .expect("keychain poisoned")
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), KeychainError> {
        self.entries
            .lock()
            .expect("keychain poisoned")
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        self.entries.lock().expect("keychain poisoned").remove(key);
        Ok(())
    }

    fn name(&self) -> &'static str {
        "memory"
    }
}

static BACKEND: OnceLock<Box<dyn SecretStore>> = OnceLock::new();

/// The process's secret store, chosen once.
///
/// Selection order:
///
/// 1. `OPENCOMPANY_KEYCHAIN_BACKEND=memory` — an explicit opt-out, for a
///    developer who does not want a keychain prompt on every launch.
/// 2. `cfg(test)` — never the operator's real store. A unit test that prompted
///    for a keychain password would be a test nobody runs twice.
/// 3. The OS store, if it answers a probe.
/// 4. Memory, with a warning naming the consequence.
pub fn store() -> &'static dyn SecretStore {
    BACKEND.get_or_init(select).as_ref()
}

fn select() -> Box<dyn SecretStore> {
    if cfg!(test) {
        return Box::new(MemoryStore::default());
    }
    if std::env::var("OPENCOMPANY_KEYCHAIN_BACKEND").as_deref() == Ok("memory") {
        tracing::warn!("keychain backend forced to memory; device pairings last one session");
        return Box::new(MemoryStore::default());
    }
    if os_store_answers() {
        return Box::new(OsKeychain);
    }
    tracing::warn!(
        "no OS keychain is reachable (no Secret Service, or it is locked); device pairings \
         will be forgotten when this application exits"
    );
    Box::new(MemoryStore::default())
}

/// Whether the OS store is *reachable*, as opposed to merely empty.
///
/// Deliberately not `OsKeychain::get(..).is_ok()`. That method folds
/// `NoStorageAccess` into `Ok(None)` on purpose — for a *read*, a locked store
/// and an absent entry both mean "no credential here", and neither should
/// surface to the console as an error. Reusing it as a probe collapses the one
/// distinction the probe exists to make: a locked keychain answers `Ok(None)`,
/// the probe reads that as "reachable", `select` commits to `OsKeychain`, and
/// every later `remember_device` then fails on write — the exact opposite of
/// the documented degrade-to-memory.
///
/// So this looks at the raw error instead. `NoEntry` means reachable and empty,
/// which is what a fresh install looks like. Anything else means do not commit
/// to this backend.
///
/// Probed once, because on macOS a failed access can prompt.
fn os_store_answers() -> bool {
    let Ok(entry) = keyring::Entry::new(SERVICE, "probe:availability") else {
        return false;
    };
    match entry.get_password() {
        // Reachable, and something is there (a stale probe entry from an older
        // build would land here too — harmless either way).
        Ok(_) => true,
        // Reachable and empty: the ordinary first-run answer.
        Err(keyring::Error::NoEntry) => true,
        // The store itself is not answering. This is the case the read path
        // hides and the probe must not.
        Err(_) => false,
    }
}

/// The keychain key holding `connection`'s device session.
fn device_key(connection: &str) -> String {
    format!("{DEVICE_PREFIX}:{connection}")
}

/// Records a paired device's session for `connection`.
///
/// `value` is the fully-rendered header value (`<company>.<token>`), which is
/// the only form the proxy needs — the same reasoning as
/// [`Credential::Device`](crate::proxy::Credential::Device). Storing the parts
/// separately would invite something to reassemble them wrongly.
pub fn remember_device(connection: &str, value: &str) -> Result<(), KeychainError> {
    store().set(&device_key(connection), value)
}

/// The stored session for `connection`, if it has one.
pub fn device_session(connection: &str) -> Option<String> {
    match store().get(&device_key(connection)) {
        Ok(found) => found,
        Err(error) => {
            // Not fatal: the connection registers unauthenticated, the host
            // answers 401, and the console renders its sign-in — which is
            // exactly what an expired pairing does too.
            tracing::warn!(%error, connection, "could not read the device session");
            None
        }
    }
}

/// Forgets `connection`'s device session.
///
/// Called when a connection is removed. The session record on the host outlives
/// this — revoking it there is the operator's action from the devices list, and
/// conflating the two would mean removing a row silently revoked a credential
/// another machine might be using.
pub fn forget_device(connection: &str) -> Result<(), KeychainError> {
    store().delete(&device_key(connection))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_remembered_session_comes_back() {
        remember_device("conn-a", "acme.token-a").unwrap();
        assert_eq!(device_session("conn-a").as_deref(), Some("acme.token-a"));
    }

    #[test]
    fn connections_do_not_share_an_entry() {
        // The namespacing property. Two hosts in one keychain must not collide,
        // and a desktop holding several is the entire point.
        remember_device("conn-b", "acme.token-b").unwrap();
        remember_device("conn-c", "other.token-c").unwrap();
        assert_eq!(device_session("conn-b").as_deref(), Some("acme.token-b"));
        assert_eq!(device_session("conn-c").as_deref(), Some("other.token-c"));
    }

    #[test]
    fn an_unpaired_connection_has_no_session() {
        assert_eq!(device_session("conn-never-paired"), None);
    }

    #[test]
    fn forgetting_is_idempotent() {
        // Removing a connection twice, or removing one that never paired, must
        // not surface an error to a console that is only tidying up.
        remember_device("conn-d", "acme.token-d").unwrap();
        forget_device("conn-d").unwrap();
        assert_eq!(device_session("conn-d"), None);
        forget_device("conn-d").expect("deleting an absent entry is not an error");
    }

    #[test]
    fn tests_never_reach_the_operators_keychain() {
        // The property that makes this module testable at all. If this ever
        // reported `os`, every test above would be writing to a real keychain —
        // a modal prompt on macOS, and nothing at all on a headless runner.
        assert_eq!(store().name(), "memory");
    }

    /// A store that is reachable for reads but refuses every write.
    ///
    /// What a locked keychain looks like from here, and the shape the old probe
    /// could not see: `get` answers `Ok(None)` either way, so a probe built on
    /// the read path called this backend healthy and then failed on the first
    /// `remember_device`.
    struct LockedStore;

    impl SecretStore for LockedStore {
        fn get(&self, _key: &str) -> Result<Option<String>, KeychainError> {
            Ok(None)
        }
        fn set(&self, _key: &str, _value: &str) -> Result<(), KeychainError> {
            Err(KeychainError::Backend("the keychain is locked".into()))
        }
        fn delete(&self, _key: &str) -> Result<(), KeychainError> {
            Err(KeychainError::Backend("the keychain is locked".into()))
        }
        fn name(&self) -> &'static str {
            "locked"
        }
    }

    #[test]
    fn a_read_cannot_tell_a_locked_store_from_an_empty_one() {
        // The property that makes the probe's own error inspection necessary:
        // no amount of reading distinguishes these, so a probe built on `get`
        // is a probe that always says yes.
        assert_eq!(LockedStore.get("device-session:x").unwrap(), None);
        assert_eq!(
            MemoryStore::default().get("device-session:x").unwrap(),
            None
        );
        // And the difference only shows on write, which is too late to choose a
        // backend by.
        assert!(LockedStore.set("device-session:x", "acme.tok").is_err());
        assert!(
            MemoryStore::default()
                .set("device-session:x", "acme.tok")
                .is_ok()
        );
    }

    #[test]
    fn a_key_names_its_purpose_and_its_connection() {
        // Someone reading their own keychain should be able to tell what an
        // entry is for and delete the right one.
        assert_eq!(device_key("abc123"), "device-session:abc123");
    }
}
