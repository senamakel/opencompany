//! Updating the desktop shell itself.
//!
//! Three pieces, none of which needs a webview to exercise:
//!
//! - [`is_configured`] — whether this build carries a real signing key, so a
//!   build that shipped the placeholder stays *silent* instead of offering an
//!   update every client would then refuse.
//! - [`PendingUpdate`] — the slot the downloaded bytes sit in between the
//!   background download and the restart the operator asked for.
//! - [`classify`] / [`backoff_for`] — the bounded retry the download is wrapped
//!   in, factored out here because a `tauri_plugin_updater::Error` cannot be
//!   constructed in a test and a `reqwest::Error` has no public constructor.
//!
//! The commands over all three are in [`crate::commands`], where every other
//! `#[tauri::command]` in this crate lives.
//!
//! ## Why the bytes are staged rather than installed
//!
//! `Update::download_and_install` is one call, and it restarts the application
//! at a moment nobody chose. The console is a place where somebody is halfway
//! through a sentence to an agent, so the download runs in the background and
//! the *install* waits behind a button. That split is the whole reason this
//! module holds state at all: [`PendingUpdate`] is what the download hands to
//! the install, so pressing "Restart now" does not re-fetch ~100 MB.

use std::time::Duration;

/// A downloaded update, verified and waiting for the operator to say when.
pub struct StagedUpdate {
    /// The handle `install` is called on. Carries the target and the
    /// signature the bytes were already checked against.
    pub update: tauri_plugin_updater::Update,
    /// The bundle itself, in memory. ~100 MB for the macOS `.app`, which is
    /// cheap next to asking the operator to download it twice.
    pub bytes: Vec<u8>,
    /// What version those bytes are, for the prompt.
    pub version: String,
}

/// The one staging slot, managed by Tauri.
///
/// `None` means nothing has been downloaded since launch. A second download
/// overwrites it, which is correct: the newest staged bytes are the ones a
/// restart should apply.
#[derive(Default)]
pub struct PendingUpdate(pub tokio::sync::Mutex<Option<StagedUpdate>>);

/// The prefix every minisign public key carries, in Tauri's encoding.
///
/// Tauri stores `plugins.updater.pubkey` as base64 of the whole minisign
/// public-key *file*, whose first line is always `untrusted comment: …`, and
/// `dW50cnVzdGVkIGNvbW1lbnQ6` is the base64 of `untrusted comment:`. So a key
/// that starts with it is at least shaped like the real thing, and the
/// placeholder committed to `tauri.conf.json` cannot be.
const MINISIGN_PUBKEY_PREFIX: &str = "dW50cnVzdGVkIGNvbW1lbnQ6";

/// Whether this build was compiled against a real updater signing key.
///
/// `tauri.conf.json` ships an obvious placeholder, because the private half is
/// an operator secret that is not in this repository and must never be. The
/// plugin does not notice: it never parses `pubkey` until it verifies a
/// downloaded bundle, so a placeholder build checks the endpoint happily,
/// downloads 100 MB, and *then* fails the signature — an error banner in front
/// of every user, for a release that was misconfigured at build time.
///
/// So the check command asks this first and reports "no update" when it is
/// false. A placeholder build is inert and quiet; the loud half is in CI, where
/// `scripts/release/assert-updater-configured.sh` refuses to cut a release
/// while the placeholder is still in the config. See
/// `docs/spec/runtime/desktop-updates.md`.
pub fn is_configured(pubkey: &str) -> bool {
    pubkey.starts_with(MINISIGN_PUBKEY_PREFIX)
}

/// Total download attempts before giving up — one initial, two retries.
pub const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;

/// What to do with an attempt that just failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecision {
    /// Transient, and there is budget left: sleep [`backoff_for`] and go again.
    Retry,
    /// Fatal, or the budget is spent. Surface the error.
    GiveUp,
}

/// Decide whether a failed download attempt is worth repeating.
///
/// * `attempt` — 1-based index of the attempt that just failed.
/// * `max` — the budget, normally [`MAX_DOWNLOAD_ATTEMPTS`].
/// * `transient` — whether the error was a network error, per [`is_transient`].
///
/// Pure: no I/O and no error construction, which is what makes the policy
/// testable at all.
pub fn classify(attempt: u32, max: u32, transient: bool) -> RetryDecision {
    if transient && attempt < max {
        RetryDecision::Retry
    } else {
        RetryDecision::GiveUp
    }
}

/// How long to wait before the next attempt: 2s, then 4s.
///
/// Deliberately short. Nothing is blocked on this — the download is background
/// work the operator cannot see — but a long backoff on a laptop that is about
/// to sleep is a retry that never happens.
pub fn backoff_for(attempt: u32) -> Duration {
    Duration::from_secs(2 * attempt as u64)
}

/// Whether an updater error is a network failure worth repeating.
///
/// The line is *fetching* versus *what was fetched*. A transport failure and an
/// unsuccessful HTTP status are both the download not arriving, and asking
/// again is the whole remedy. A signature failure, a missing target or a
/// filesystem error cannot be fixed by fetching the same bytes again, and
/// looping on a failed *signature* check is the one retry that would turn a
/// tampered bundle into a denial-of-service against the user's battery.
///
/// Two variants sit on the transport side, and both matter. `Reqwest` is a
/// connection that dropped or never opened. `Network` is the one the plugin
/// raises for **every** non-2xx response to the download request — it carries
/// only a formatted string, so a 503 from GitHub's asset CDN cannot be told
/// apart from a 404 for an asset that was never uploaded. Treating the whole
/// variant as transient costs three attempts and six seconds against a 404, and
/// buys the retry for the failure it was written for: matching `Reqwest` alone
/// meant a release-day 503 gave up after one attempt.
pub fn is_transient(err: &tauri_plugin_updater::Error) -> bool {
    matches!(
        err,
        tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_)
    )
}

#[cfg(test)]
mod test {
    use super::*;

    /// The real key from the vendored OpenHuman config, which is a public key
    /// and published as one — it is in `vendor/openhuman/app/src-tauri/tauri.conf.json`.
    /// Used here only as a specimen of the *shape*; nothing verifies against it.
    const A_REAL_PUBKEY: &str =
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc0OTREMjkxREFCNUIzRTEK";

    #[test]
    fn a_real_looking_key_is_configured() {
        assert!(is_configured(A_REAL_PUBKEY));
    }

    /// The updater public key this repository ships, installed when desktop
    /// auto-update landed (`846913029`).
    ///
    /// Pinned here on purpose. A minisign **public** key is meant to be
    /// distributed — it is what a shipped binary verifies a release against,
    /// and it is inert without the private half, which stays an operator
    /// secret — so carrying it is not the leak the pre-auto-update version of
    /// this test was guarding against.
    const SHIPPED_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDcxMjNEREM2ODQ3NzA0MkMKUldRc0JIZUV4dDBqY1NnMnBmK21oc0xGdnBhNTl3djVGWWErWFJ0aG1IYkZJTWpVczJZUjBzcGIK";

    /// The config carries the key this repository intends, and no other.
    ///
    /// # Why this replaced `the_shipped_placeholder_is_not_configured`
    ///
    /// That test asserted `tauri.conf.json` never carries a usable key, back
    /// when the repository shipped a placeholder and the real key was injected
    /// at release time. `846913029` installed the key deliberately, and the two
    /// then contradicted each other: the `Desktop` lane went red on main and,
    /// because pull-request CI builds the merge commit, on every open PR at
    /// once — where it reads to each author as though their own branch broke
    /// the desktop build.
    ///
    /// The old test invited exactly this edit: *"If this fails because somebody
    /// pasted a real public key in, that is fine — but it has to be a
    /// deliberate edit to this test, not a silent one to the config."* This is
    /// that edit, and it keeps the half of the guarantee that still applies.
    /// The point was never "no key"; it was "no *silent* change to the key", so
    /// the assertion is now equality against a pinned constant. A rotation
    /// still has to come here and say so, which is what the original was
    /// protecting.
    #[test]
    fn the_shipped_updater_key_is_the_intended_one() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pubkey = config["plugins"]["updater"]["pubkey"].as_str().unwrap();

        assert!(
            is_configured(pubkey),
            "tauri.conf.json carries no usable updater pubkey ({pubkey}); \
             a shipped desktop build cannot verify an update without one",
        );
        assert_eq!(
            pubkey, SHIPPED_PUBKEY,
            "the updater pubkey in tauri.conf.json changed; rotating it is fine, \
             but update SHIPPED_PUBKEY in the same commit so the change is on \
             the record rather than silent",
        );
    }

    #[test]
    fn an_empty_or_nonsense_key_is_not_configured() {
        assert!(!is_configured(""));
        assert!(!is_configured("REPLACE-ME"));
        // Base64 of something else entirely — shaped like a key, isn't one.
        assert!(!is_configured("bm90IGEga2V5"));
    }

    #[test]
    fn a_transient_failure_with_budget_left_retries() {
        assert_eq!(
            classify(1, MAX_DOWNLOAD_ATTEMPTS, true),
            RetryDecision::Retry
        );
        assert_eq!(
            classify(2, MAX_DOWNLOAD_ATTEMPTS, true),
            RetryDecision::Retry
        );
    }

    #[test]
    fn the_last_attempt_gives_up_even_when_transient() {
        assert_eq!(
            classify(MAX_DOWNLOAD_ATTEMPTS, MAX_DOWNLOAD_ATTEMPTS, true),
            RetryDecision::GiveUp
        );
        assert_eq!(
            classify(MAX_DOWNLOAD_ATTEMPTS + 1, MAX_DOWNLOAD_ATTEMPTS, true),
            RetryDecision::GiveUp
        );
    }

    #[test]
    fn a_fatal_failure_never_retries() {
        // A bad signature on the first attempt is still a bad signature on the
        // third, and this is the assertion that says so.
        assert_eq!(
            classify(1, MAX_DOWNLOAD_ATTEMPTS, false),
            RetryDecision::GiveUp
        );
        assert_eq!(classify(1, 1, true), RetryDecision::GiveUp);
    }

    /// An unsuccessful HTTP status is a download that did not arrive.
    ///
    /// The plugin maps every non-2xx response to the download request onto
    /// `Error::Network`, so this is what a 503 from GitHub's asset CDN on
    /// release day looks like by the time it reaches us — the busiest minute
    /// this feature has, and the one the retry exists for. It is a formatted
    /// string and nothing else, so a 404 lands in the same variant and is
    /// retried too; three attempts and six seconds is the whole price of not
    /// being able to tell them apart.
    #[test]
    fn an_unsuccessful_http_status_is_worth_asking_again() {
        let unavailable = tauri_plugin_updater::Error::Network(
            "Download request failed with status: 503 Service Unavailable".into(),
        );
        assert!(is_transient(&unavailable));
        assert_eq!(
            classify(1, MAX_DOWNLOAD_ATTEMPTS, is_transient(&unavailable)),
            RetryDecision::Retry
        );
    }

    /// Everything that is not the transport stays fatal.
    ///
    /// The pairing matters more than either assertion: `TargetNotFound` is the
    /// answer a Windows client gets from a macOS-only manifest, and a signature
    /// failure is the answer a tampered bundle gets. Retrying either is work
    /// that cannot succeed, and on the second it is work an attacker chooses.
    #[test]
    fn a_manifest_or_signature_failure_is_still_fatal() {
        assert!(!is_transient(&tauri_plugin_updater::Error::TargetNotFound(
            "windows-x86_64".into()
        )));
        assert!(!is_transient(&tauri_plugin_updater::Error::SignatureUtf8(
            "not base64".into()
        )));
    }

    #[test]
    fn the_whole_budget_costs_seconds_not_minutes() {
        assert_eq!(backoff_for(1), Duration::from_secs(2));
        assert!(backoff_for(2) > backoff_for(1));
        let total: Duration = (1..MAX_DOWNLOAD_ATTEMPTS).map(backoff_for).sum();
        assert!(
            total <= Duration::from_secs(10),
            "total backoff stays small"
        );
    }
}
