//! Crate-wide test support: the process-wide environment lock.
//!
//! `std::env::set_var` mutates state shared by the whole process, and libtest
//! runs a binary's tests on a thread pool — so an env-mutating test races every
//! other test in the same binary that reads env, whether or not they touch the
//! same key. That is why the calls are `unsafe` in Rust 2024; a comment saying
//! "single-threaded test" does not make it so.
//!
//! A lock that lives in one module only serialises that module. All of this
//! crate's unit tests link into a single test binary, so the lock has to be a
//! single crate-level static — [`EnvVarGuard`] is that lock, and holding its
//! guard is the sanctioned way to mutate env in this crate's tests.
//!
//! # What this is not
//!
//! It is **not** a soundness proof, and no `unsafe` block here should be read
//! as discharged by it. A mutex only excludes participants that take it, and
//! the environment has participants that cannot: every `std::env::var` call in
//! the crate, `getenv` inside libc (`getaddrinfo`, locale lookups) on some
//! other thread, and the mutating tests in `server::ops::connections` and
//! `harness::composio` that do not use this guard. What the lock buys is
//! narrower and still worth having — it serialises the tests that *do* take
//! it, and it makes restoration total, including on unwind.
//!
//! The end state is no process-environment mutation in tests at all, reading
//! configuration through the injected [`EnvSource`](crate::app::config::EnvSource)
//! seam this crate already has (`ProcessEnv` in production, `MapEnv` in tests)
//! so nothing has to be excluded from anything. Tracked separately; this guard
//! is the floor under the tests until then, not the destination.
//!
//! Integration targets under `tests/` are separate processes with their own
//! environment, so they are outside this lock's scope and do not need it.

use std::sync::{Mutex, MutexGuard};

/// The one lock every env-touching unit test in this crate serialises on.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Exclusive access to the process environment, with the touched keys restored
/// when it drops.
///
/// [`capture`](EnvVarGuard::capture) takes the crate-wide lock *and* records the
/// current value of every key it is given. On drop it puts each key back the way
/// it found it — set to its old value, or removed if it was unset — and then
/// releases the lock.
///
/// Restoration runs on unwind too, which is the half a hand-rolled
/// save/mutate/restore body loses: a test that panics part-way through leaves
/// its variables set for every test that runs after it, and the failure surfaces
/// somewhere else entirely.
pub(crate) struct EnvVarGuard {
    saved: Vec<(String, Option<String>)>,
    // Declared last so it is released after the values are restored: a waiter
    // must never observe the environment mid-restore.
    _lock: MutexGuard<'static, ()>,
}

impl EnvVarGuard {
    /// Locks the environment and snapshots `keys`.
    ///
    /// A test that panicked while holding the lock poisons it, but it also ran
    /// this guard's `Drop` on the way out, so the environment is already back to
    /// what it was. The poison therefore carries no information here and is
    /// stepped over rather than turned into a cascade of unrelated failures.
    pub(crate) fn capture<K: AsRef<str>>(keys: &[K]) -> Self {
        let lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self {
            saved: keys
                .iter()
                .map(|key| {
                    let key = key.as_ref().to_string();
                    let value = std::env::var(&key).ok();
                    (key, value)
                })
                .collect(),
            _lock: lock,
        }
    }

    /// Sets one of the captured keys.
    ///
    /// Holding the guard is what makes this *restorable* and what keeps the
    /// other guarded tests off the environment while it is set. It is not what
    /// makes the write sound — see the module docs; the unguarded readers are
    /// still out there.
    pub(crate) fn set(&self, key: &str, value: &str) {
        debug_assert!(
            self.saved.iter().any(|(k, _)| k == key),
            "{key} was not captured, so it would not be restored"
        );
        unsafe { std::env::set_var(key, value) };
    }

    /// Removes one of the captured keys. Same caveat as [`set`](Self::set).
    pub(crate) fn remove(&self, key: &str) {
        debug_assert!(
            self.saved.iter().any(|(k, _)| k == key),
            "{key} was not captured, so it would not be restored"
        );
        unsafe { std::env::remove_var(key) };
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }
}
