//! The `PATH` the operator's *shell* has, rather than the one this process
//! happened to inherit.
//!
//! ## Why this exists
//!
//! Everything in [`discovery`](super::discovery) resolves a harness by walking
//! `PATH`, and [`AcpClient::spawn`](super::client::AcpClient::spawn) starts it
//! with this process's environment. Both are correct only if this process has
//! the `PATH` the operator does — and a macOS app launched from Finder, the
//! Dock or Spotlight does not. `launchd` hands it a minimal
//! `/usr/bin:/bin:/usr/sbin:/sbin`, because `~/.zshrc` is a *shell* thing and
//! nothing sources it for a GUI process.
//!
//! The result on a machine with everything correctly installed:
//!
//! ```text
//! from a terminal:   /opt/homebrew/bin/claude-agent-acp     ✓ found
//! from the Dock:     (not on PATH)                          ✗ "Not installed"
//! ```
//!
//! Which is a lie the operator cannot debug — the CLI is right there, and
//! typing `claude-agent-acp` in their terminal proves it.
//!
//! ## Why the whole `PATH`, and not one lookup per harness
//!
//! Asking the shell `command -v claude-agent-acp` answers the *question* but
//! not the *problem*, because finding the adapter is not enough to run it.
//! `claude-agent-acp` is not a binary — it is a Node script:
//!
//! ```text
//! #!/usr/bin/env node
//! import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
//! ```
//!
//! so spawning it runs `/usr/bin/env node`, and `node` has to be findable too
//! — under `nvm`, Volta or a Homebrew `node@24` keg it lives somewhere only
//! the shell's `PATH` names. A per-harness lookup would find the adapter,
//! report `Ready`, and then fail at spawn. Resolving the `PATH` once fixes the
//! lookup and the spawn together, since both read the same answer.
//!
//! ## Cost
//!
//! One interactive login shell, once per process, cached. Measured at ~25 ms
//! on the development machine; the timeout below is set for a pathological
//! `~/.zshrc`, not a typical one.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

/// How long the operator's shell gets to finish sourcing its rc files.
///
/// Generous by two orders of magnitude against the measured cost, because the
/// downside is asymmetric: too short silently degrades to the inherited `PATH`
/// and reports installed harnesses as missing, while too long only delays a
/// pane that is already loading.
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// Wraps the answer so rc-file chatter can be discarded.
///
/// A login shell is entitled to print things — version managers announce
/// themselves, `motd` banners, a stray `echo` someone added years ago — and all
/// of it lands on the same stdout. ASCII RS (0x1e) is the delimiter because it
/// cannot occur in a pathname on any platform this runs on.
const DELIM: char = '\u{1e}';

/// The `PATH` to use for locating and spawning harnesses.
///
/// The operator's login shell when it could be asked, else this process's own
/// `PATH` — never nothing, so a failure here degrades to today's behaviour
/// rather than reporting every harness as missing.
pub fn effective_path() -> Option<OsString> {
    static RESOLVED: OnceLock<Option<OsString>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| login_shell_path().or_else(|| std::env::var_os("PATH")))
        .clone()
}

/// Asks the operator's login shell what its `PATH` is.
///
/// `None` when there is no shell to ask, it could not be started, it did not
/// answer in time, or it answered with nothing usable.
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
    // `-i` as well as `-l` deliberately: on macOS `~/.zshrc` is the interactive
    // file, and it is where `nvm`, Volta, `pyenv` and most installer scripts
    // write their `PATH` line. A login-only shell reads `~/.zprofile` and
    // misses exactly the entries this is here to recover.
    let script = format!("printf '{DELIM}%s{DELIM}' \"$PATH\"");
    let mut child = Command::new(&shell)
        .args([OsStr::new("-ilc"), OsStr::new(script.as_str())])
        // No stdin: an rc file that prompts must hit EOF and give up rather
        // than block until the timeout.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Discarded, not inherited: a noisy rc file writing to a GUI app's
        // stderr helps nobody, and this is a routine call.
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    // Read on a thread so a shell that never exits cannot wedge this one. The
    // read ends naturally at EOF when the shell closes the pipe.
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let answer = rx.recv_timeout(SHELL_TIMEOUT).ok();
    // Unconditional: on the timeout path this is what stops a hung rc file
    // from outliving the app, and on the success path the shell has already
    // exited and it is a no-op.
    let _ = child.kill();
    let _ = child.wait();

    parse_path(&answer?).map(OsString::from)
}

/// Pulls the delimited `PATH` out of whatever else the shell printed.
///
/// Split out from the spawn so the parsing rules are testable without a shell,
/// which is the half that has interesting cases.
fn parse_path(stdout: &str) -> Option<String> {
    let (_, after) = stdout.split_once(DELIM)?;
    let (path, _) = after.split_once(DELIM)?;
    // An empty or single-entry answer means the shell was not asked what this
    // thinks it was asked. Falling back beats trusting it.
    (!path.is_empty() && path.contains(std::path::MAIN_SEPARATOR)).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case this module exists for: a version manager greeting the user on
    /// every shell start, interleaved with the answer.
    #[test]
    fn a_chatty_rc_file_does_not_corrupt_the_answer() {
        let noisy = format!("Now using node v24.0.0\n{DELIM}/opt/homebrew/bin:/usr/bin{DELIM}\n");
        assert_eq!(
            parse_path(&noisy).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn output_with_no_delimiters_is_refused() {
        // A shell that failed before reaching the `printf` still exits 0 and
        // still prints its complaint. Reading that as a `PATH` would produce a
        // lookup against nonsense directories.
        assert_eq!(parse_path("zsh: command not found: nvm\n"), None);
    }

    #[test]
    fn a_half_written_answer_is_refused() {
        // Killed mid-write on the timeout path: the opening delimiter arrived
        // and the closing one never did, so the tail is a truncated `PATH`.
        assert_eq!(parse_path(&format!("{DELIM}/opt/homebrew/b")), None);
    }

    #[test]
    fn an_empty_path_is_refused_rather_than_used() {
        // `$PATH` unset inside the rc file. An empty answer would resolve every
        // harness to "not installed" — the exact failure being fixed here.
        assert_eq!(parse_path(&format!("{DELIM}{DELIM}")), None);
    }

    #[test]
    fn an_answer_that_names_no_directory_is_refused() {
        // Guards against a shell echoing the literal word rather than expanding
        // it, which is otherwise a plausible-looking non-empty string.
        assert_eq!(parse_path(&format!("{DELIM}$PATH{DELIM}")), None);
    }

    /// There is always an answer, so a harness is never reported missing merely
    /// because the shell could not be consulted.
    #[test]
    fn there_is_always_a_path_to_fall_back_on() {
        assert!(effective_path().is_some_and(|p| !p.is_empty()));
    }
}
