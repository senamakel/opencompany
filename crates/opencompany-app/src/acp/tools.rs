//! The ACP adapters this app installs and owns.
//!
//! ## Why the app installs them at all
//!
//! An operator installs *Claude Code*. They do not install
//! `@agentclientprotocol/claude-agent-acp`, have no reason to know it exists,
//! and reasonably read "not found" as this app failing to see software they
//! use daily. The adapter is our dependency — the thing that makes a CLI
//! speak the protocol this client speaks — so it is ours to provide.
//!
//! ## Why a private directory and not `npm -g`
//!
//! A global install writes into the operator's own npm prefix, needs `npm` on
//! `PATH` at the right prefix, can need `sudo`, and leaves packages behind that
//! this app put there without saying so. It also couples us to whatever
//! versions they already have. Everything here goes under [`tools_dir`], which
//! this app created and can delete.
//!
//! Version coherence is a concrete reason, not a tidiness one: `codex-acp@1.6.2`
//! requires `@openai/codex ^0.148.0`, and a machine can easily be carrying an
//! older global `codex`. A private install pins a pair known to work together
//! and leaves the operator's own copy alone.
//!
//! ## What is still required of the machine
//!
//! **Node.** Both adapters are `#!/usr/bin/env node` scripts, so installing
//! them does not make them runnable — `node` must be findable. This is exactly
//! where `block/buzz` shipped a bug worth not repeating (their issue #2342): a
//! private tools directory whose contents could not run, reported to the
//! operator as "adapter outdated — reinstall required". Reinstalling was never
//! going to help. So [`node`] is checked on its own and gets its own state,
//! and every lookup here goes through the **login shell's** `PATH`
//! ([`shell_env`](super::shell_env)) rather than whatever a GUI process
//! inherited.
//!
//! ## What the two adapters do *not* have in common
//!
//! `codex-acp` depends on `@openai/codex`, so installing it brings the CLI
//! too — that harness is self-contained. `claude-agent-acp` depends on
//! `@anthropic-ai/claude-agent-sdk`, which declares no binary and resolves the
//! operator's own `claude` off `PATH` (it depends on `node-which`). So Claude
//! Code stays a genuine prerequisite, and the shell `PATH` matters twice over:
//! once for us to find the adapter, and again for the adapter to find its CLI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::discovery::{Harness, Probe, SystemProbe};

/// How long an install gets before it is called failed.
///
/// A package fetch over a slow connection, not a local operation. Measured at
/// ~3.5s for `codex-acp` and its dependencies on a warm cache; this is sized
/// for a cold one on hotel wifi.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Where this app keeps the adapters it installed.
///
/// Beside the rest of the app's data rather than in the operator's npm prefix,
/// so uninstalling the app takes them with it.
pub fn tools_dir() -> PathBuf {
    crate::default_data_dir().join("acp-tools")
}

/// The `node` this machine would run an adapter with, if any.
///
/// Its own lookup, and its own failure, because "no Node" is not "no adapter":
/// installing would succeed and produce something that still cannot start.
pub fn node() -> Option<PathBuf> {
    SystemProbe.locate("node")
}

/// The `npm` an install would be performed with.
///
/// Separate from [`node`] though they almost always travel together — a
/// Node built without npm, or a `PATH` carrying only one of them, should
/// report the thing that is actually missing.
pub fn npm() -> Option<PathBuf> {
    SystemProbe.locate("npm")
}

/// The adapter this app installed for `harness`, if it is there.
///
/// `npm --prefix <root>` links executables into `<root>/node_modules/.bin`,
/// verified against the real registry rather than assumed.
pub fn installed_adapter_in(root: &Path, harness: &Harness) -> Option<PathBuf> {
    // Platform-aware for the same reason `SystemProbe` is, and this half was
    // missed when that one was fixed. On Windows npm writes *two* files into
    // `.bin`: `<command>.cmd`, which Windows can run, and an extensionless
    // POSIX shell shim beside it, which it cannot. Returning the extensionless
    // one handed `Command::new` a shell script — and because an app-owned
    // adapter takes precedence over `PATH`, a failed Install would shadow a
    // perfectly good global adapter rather than simply not helping.
    let bin = root.join("node_modules/.bin");
    crate::acp::discovery::executable_names(harness.command)
        .map(|name| bin.join(name))
        .find(|candidate| candidate.is_file())
}

/// [`installed_adapter_in`] against the real [`tools_dir`].
pub fn installed_adapter(harness: &Harness) -> Option<PathBuf> {
    installed_adapter_in(&tools_dir(), harness)
}

/// What version of `harness`'s adapter this app has installed.
///
/// Read from the package's own `package.json` rather than by running it with
/// `--version`. Running it is what `buzz` does, and it is why a working
/// adapter there reports as outdated: the probe ran under a `PATH` with no
/// `node`, the shim failed, and a failed *execution* was read as a failed
/// *version*. A file cannot fail that way.
pub fn installed_version_in(root: &Path, harness: &Harness) -> Option<String> {
    let manifest = root
        .join("node_modules")
        .join(harness.package)
        .join("package.json");
    let raw = std::fs::read_to_string(manifest).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed["version"].as_str().map(str::to_string)
}

/// [`installed_version_in`] against the real [`tools_dir`].
pub fn installed_version(harness: &Harness) -> Option<String> {
    installed_version_in(&tools_dir(), harness)
}

/// Whether what is installed matches what this build pins.
///
/// Only ever asked about an adapter *this app* installed. An adapter the
/// operator installed globally is theirs, and telling them it is the wrong
/// version is both presumptuous and — going by `buzz`'s bug tracker — usually
/// wrong.
pub fn is_pinned_version_in(root: &Path, harness: &Harness) -> bool {
    installed_version_in(root, harness).as_deref() == Some(harness.version)
}

/// Installs `harness`'s adapter at the pinned version into `root`.
///
/// `root` is a parameter so a test can install somewhere disposable instead of
/// over the operator's real tools directory.
pub async fn install_into(root: &Path, harness: &Harness) -> Result<(), String> {
    // Named separately so the message says which one is missing rather than
    // "installation failed", which is what an operator cannot act on.
    let npm = npm().ok_or_else(|| {
        "npm was not found on your PATH. Node.js 18 or newer is needed to run coding harnesses."
            .to_string()
    })?;
    if node().is_none() {
        return Err(
            "node was not found on your PATH. Node.js 18 or newer is needed to run coding harnesses."
                .to_string(),
        );
    }

    std::fs::create_dir_all(root).map_err(|error| format!("could not create {root:?}: {error}"))?;

    let spec = format!("{}@{}", harness.package, harness.version);
    let mut command = tokio::process::Command::new(&npm);
    command
        .arg("install")
        .arg("--prefix")
        .arg(root)
        // Quiet the parts that only make sense in a terminal. `--no-audit`
        // also drops a second network round trip that cannot change the
        // outcome.
        .args(["--no-audit", "--no-fund", "--loglevel", "error"])
        .arg(&spec)
        .kill_on_drop(true);
    // The shell's PATH, for the same reason as everywhere else here: an app
    // started from Finder inherits one with no `node` in it, and npm needs to
    // find its own runtime.
    if let Some(path) = super::shell_env::effective_path() {
        command.env("PATH", path);
    }

    let finished = tokio::time::timeout(INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("installing {spec} took longer than {INSTALL_TIMEOUT:?}"))?
        .map_err(|error| format!("could not run npm: {error}"))?;

    if !finished.status.success() {
        // npm's own words. Anything this layer wrote instead would be a guess
        // about a failure it did not diagnose — a 404 for a yanked version, a
        // proxy refusing, a read-only home — and each has a different fix.
        let complaint = String::from_utf8_lossy(&finished.stderr);
        let complaint = complaint.trim();
        return Err(if complaint.is_empty() {
            format!(
                "npm exited with {} while installing {spec}",
                finished.status
            )
        } else {
            complaint.to_string()
        });
    }

    // npm can exit 0 having installed nothing useful. Checking for the binary
    // is what makes success mean "there is something to spawn".
    if installed_adapter_in(root, harness).is_none() {
        return Err(format!(
            "npm reported success but {} is not in {}",
            harness.command,
            root.join("node_modules/.bin").display()
        ));
    }
    Ok(())
}

/// [`install_into`] against the real [`tools_dir`].
pub async fn install(harness: &Harness) -> Result<(), String> {
    install_into(&tools_dir(), harness).await
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::acp::discovery::HARNESSES;

    fn claude() -> &'static Harness {
        HARNESSES.iter().find(|h| h.id == "claude").unwrap()
    }

    #[test]
    fn the_tools_directory_sits_under_this_app_and_not_the_users_npm_prefix() {
        let dir = tools_dir();
        assert!(dir.ends_with("acp-tools"));
        assert!(
            dir.starts_with(crate::default_data_dir()),
            "adapters this app installed must be removable with this app"
        );
    }

    #[test]
    fn nothing_is_reported_installed_in_an_empty_root() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(installed_adapter_in(root.path(), claude()), None);
        assert_eq!(installed_version_in(root.path(), claude()), None);
        assert!(!is_pinned_version_in(root.path(), claude()));
    }

    /// The layout is read the way `npm --prefix` really writes it, confirmed
    /// against the registry rather than assumed: the executable is linked into
    /// `node_modules/.bin`, and the version lives in the package's own
    /// manifest.
    #[test]
    fn an_installed_adapter_is_found_by_its_binary_and_dated_by_its_manifest() {
        let root = tempfile::tempdir().unwrap();
        let harness = claude();

        let bin = root.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(harness.command), "#!/usr/bin/env node\n").unwrap();

        let pkg = root.path().join("node_modules").join(harness.package);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            format!(
                r#"{{"name":"{}","version":"{}"}}"#,
                harness.package, harness.version
            ),
        )
        .unwrap();

        assert_eq!(
            installed_adapter_in(root.path(), harness),
            Some(bin.join(harness.command))
        );
        assert_eq!(
            installed_version_in(root.path(), harness).as_deref(),
            Some(harness.version)
        );
        assert!(is_pinned_version_in(root.path(), harness));
    }

    /// An older install is a different state from no install: one needs an
    /// update, the other needs an install, and the operator is told which.
    #[test]
    fn an_install_behind_the_pin_is_not_mistaken_for_the_pinned_one() {
        let root = tempfile::tempdir().unwrap();
        let harness = claude();
        let pkg = root.path().join("node_modules").join(harness.package);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"version":"0.0.1-ancient"}"#).unwrap();

        assert_eq!(
            installed_version_in(root.path(), harness).as_deref(),
            Some("0.0.1-ancient")
        );
        assert!(!is_pinned_version_in(root.path(), harness));
    }

    /// A manifest that is present but unreadable must not read as a version.
    /// Answering `Some(garbage)` would compare unequal to the pin and put the
    /// row into a permanent "update available" that updating cannot clear.
    #[test]
    fn an_unparseable_manifest_reads_as_no_version_at_all() {
        let root = tempfile::tempdir().unwrap();
        let harness = claude();
        let pkg = root.path().join("node_modules").join(harness.package);
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), "{ truncated").unwrap();
        assert_eq!(installed_version_in(root.path(), harness), None);
    }
}
