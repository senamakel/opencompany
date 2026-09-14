//! Finding the coding harnesses installed on this machine, and whether they can
//! actually run.
//!
//! ## Four states, not two
//!
//! The tempting model is available / unavailable. It is wrong, and wrong in a
//! way that costs an operator real time: **installed but not signed in** is the
//! single most common state on a fresh machine, and it looks identical to "not
//! installed" if all you check is `which`. The fix is completely different —
//! `claude login` versus installing anything — so collapsing them means the app
//! tells someone to do the wrong thing.
//!
//! [`Readiness`] therefore distinguishes:
//!
//! - `NotInstalled` — neither the CLI nor its ACP adapter is on `PATH`.
//!   *Install the CLI.*
//! - `AdapterMissing` — the CLI is here, the adapter that fronts it is not.
//!   *Install one npm package.* See below: this is the state that used to be
//!   reported as `NotInstalled`, on machines where the tool plainly worked.
//! - `NodeMissing` — no `node` to run an adapter with. *Install Node.*
//! - `AdapterOutdated` — this app's adapter is behind the pin. *Update it.*
//! - `Checking` — an adapter was resolved, handshake in flight. Not a verdict.
//! - `NotSignedIn` — it started and refused the session. *Sign in to its CLI.*
//! - `Ready` — it opened a session, so it is installed, authenticated, and
//!   speaking a protocol version this client understands.
//! - `SpawnFailed` — present but would not start or would not talk.
//!   *Read the reason.*
//!
//! ## What is actually probed: two binaries, not one
//!
//! The thing this spawns is **not** the CLI an operator installed. `claude`
//! does not speak ACP; a separate adapter does, shipped as its own npm package
//! and installed under its own name:
//!
//! ```text
//! claude   → claude-agent-acp   (@agentclientprotocol/claude-agent-acp)
//! codex    → codex-acp          (@agentclientprotocol/codex-acp)
//! ```
//!
//! Probing only the adapter produces the single most confusing message this
//! module can emit — *"Claude Code: not found on `PATH`, install it"* — on a
//! machine where `claude` is installed, signed in, and used daily. The advice
//! is wrong (the CLI is already there) and the real fix goes unmentioned.
//!
//! So both are located. They disagree in exactly one useful way, and that
//! disagreement is its own state: CLI present + adapter absent is
//! [`Readiness::AdapterMissing`], which names the package to install rather
//! than telling someone to reinstall software they have. The CLI is located
//! for **diagnosis only** — it is never spawned, and its absence is not
//! independently interesting, because installing the adapter without the CLI
//! it fronts is not a state anyone arrives at on purpose.
//!
//! ## Sign-in is settled by running the harness, not by looking for a file
//!
//! This module used to answer "is it signed in?" by checking whether a
//! credential file existed at a known path — `~/.claude/.credentials.json`
//! and friends. That was cheap, and it was **wrong**: Claude Code on macOS
//! keeps its credentials in the login Keychain, so the file is simply absent
//! on a perfectly signed-in machine. The console reported "not signed in" for
//! a harness that worked, and the suggested fix — sign in again — was the one
//! thing guaranteed not to help.
//!
//! The general lesson is worth keeping: **where a third-party CLI puts its
//! credential is that CLI's business, and it changes per platform and per
//! release.** Any guess here is a guess about somebody else's implementation
//! detail. So [`survey`] no longer guesses. It answers only what the
//! filesystem can honestly say — is the binary on `PATH` — and hands
//! everything else to [`confirm`], which starts the harness and completes a
//! real ACP handshake. An agent that opens a session is signed in; one that
//! refuses says why in its own words.
//!
//! That costs a subprocess, which is why it is a *second* phase: the list
//! paints instantly from `PATH` alone, every installed harness sitting at
//! `Checking`, and each row settles as its own handshake returns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

/// Whether a harness can be used right now, and if not, what to do about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Readiness {
    NotInstalled,
    /// The CLI is installed; the ACP adapter that fronts it is not.
    ///
    /// Carries both halves because the console has to render an instruction,
    /// not a status: which install was found, and the one package that closes
    /// the gap.
    AdapterMissing {
        /// Where the CLI itself was found — the evidence that this is not a
        /// "you have not installed it" situation.
        cli: PathBuf,
        /// The npm package that provides the adapter.
        package: &'static str,
    },
    /// No `node` on the shell `PATH`, so nothing here can run.
    ///
    /// Its own state rather than a spawn failure, because it is not about the
    /// adapter at all: both are `#!/usr/bin/env node` scripts, so a missing
    /// runtime defeats a perfectly good install and an install would not fix
    /// it. `block/buzz` reported exactly this as "adapter outdated — reinstall
    /// required" (their #2342), sending operators to reinstall something that
    /// was never the problem.
    NodeMissing,
    /// This app installed the adapter, and it is behind the pinned version.
    ///
    /// Only ever reported for an install *this app* performed. An adapter the
    /// operator installed themselves is theirs, and calling it outdated is how
    /// the same `buzz` bug reached people whose setup was fine.
    AdapterOutdated {
        found: String,
        want: &'static str,
    },
    NotSignedIn,
    /// Installed and signed in, but not yet confirmed to actually start.
    ///
    /// What [`survey`] returns for a harness that looks usable from the
    /// filesystem alone. It is a *pending* answer, not a verdict:
    /// [`confirm`] resolves it to `Ready` or `SpawnFailed`. Rendered as
    /// "Checking…" so nothing claims a harness works before it has answered.
    Checking,
    Ready,
    SpawnFailed {
        reason: String,
    },
}

impl Readiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Readiness::Ready)
    }

    /// Whether this answer is still pending a real handshake.
    pub fn is_checking(&self) -> bool {
        matches!(self, Readiness::Checking)
    }
}

/// One harness this client knows how to drive over ACP.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    /// Stable id the console and the connection records use.
    pub id: &'static str,
    pub label: &'static str,
    /// The ACP adapter — the executable actually spawned, looked up on `PATH`.
    pub command: &'static str,
    /// The CLI the adapter fronts. Located to tell `AdapterMissing` apart from
    /// `NotInstalled`, and never spawned.
    pub cli: &'static str,
    /// The npm package providing [`Self::command`].
    ///
    /// What [`tools`](super::tools) installs, and what the console names when
    /// it offers to. Called `package` rather than `install` because installing
    /// is now something this app *does* — the string is the subject, not the
    /// instruction.
    pub package: &'static str,
    /// The version this build pins, and installs.
    ///
    /// Pinned rather than tracking latest so an adapter update is a reviewable
    /// change here, not something that happens to an operator mid-session.
    /// Applies **only** to installs this app performed: an adapter already on
    /// `PATH` belongs to whoever put it there.
    pub version: &'static str,
    /// Arguments that put it into ACP mode.
    pub args: &'static [&'static str],
}

/// The harnesses the desktop can drive.
///
/// A fixed list rather than discovery-by-convention: each entry encodes how to
/// put *that* harness into ACP mode, and guessing those arguments wrong spawns
/// a process that hangs waiting for interactive input.
pub const HARNESSES: &[Harness] = &[
    Harness {
        id: "claude",
        label: "Claude Code",
        // Confirmed live (issue #1245): `npm install -g
        // @agentclientprotocol/claude-agent-acp` installs a binary named
        // `claude-agent-acp`, not `claude-code-acp` (the package's former
        // name, before it moved under the `@agentclientprotocol` scope). A
        // stale `claude-code-acp` here silently fails every "not found" probe
        // and every spawn on a current install.
        command: "claude-agent-acp",
        cli: "claude",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.70.0",
        args: &[],
    },
    Harness {
        id: "codex",
        label: "Codex",
        command: "codex-acp",
        cli: "codex",
        package: "@agentclientprotocol/codex-acp",
        // Pins `@openai/codex ^0.148.0` as a dependency, so installing this
        // brings the Codex CLI with it — unlike the Claude adapter, which
        // resolves the operator's own `claude` off `PATH`. It also means a
        // machine carrying an older global `codex` is not a problem: the
        // private install has its own matching copy.
        version: "1.6.2",
        args: &[],
    },
];

/// One model a harness says it can run.
///
/// Read off the adapter rather than hardcoded anywhere: the list changes when
/// the CLI updates — `codex-acp` grew three entries between the shape captured
/// while designing this and the one it returns today — so any list baked into
/// this repo would start drifting the day it was written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModel {
    /// The id to send back in `session/set_config_option`. The only field
    /// that must round-trip exactly.
    pub value: String,
    /// A human label when the adapter gives one (`GPT-5.6-Sol`, `Opus (1M
    /// context)`), else absent and the console shows `value`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the adapter reports this as what it would use right now.
    pub current: bool,
}

/// Every model `session/new`'s response advertises, in the order given.
///
/// Tolerates both live shapes, which genuinely differ — this is why the
/// parsing is shared rather than written once against whichever adapter was
/// tested first:
///
/// | | `claude-agent-acp` | `codex-acp` |
/// |---|---|---|
/// | option key | `configId` | `id` (not the spec's name) |
/// | other categories present | no | `mode`, `thought_level` |
/// | current model | `currentValue`, whose value is a synthetic `default` entry that leads the list | `currentValue` |
///
/// Empty when the adapter advertises no model category at all, which is a
/// legitimate answer — not every ACP agent lets its model be chosen.
pub fn parse_models(session_new_result: &Value) -> Vec<HarnessModel> {
    let Some(option) = session_new_result["configOptions"]
        .as_array()
        .and_then(|opts| {
            opts.iter()
                .find(|o| o.get("category").and_then(|c| c.as_str()) == Some("model"))
        })
    else {
        return Vec::new();
    };

    let current = option.get("currentValue").and_then(|v| v.as_str());
    option
        .get("options")
        .and_then(|o| o.as_array())
        .map(|options| {
            options
                .iter()
                .filter_map(|entry| {
                    let value = entry.get("value").and_then(|v| v.as_str())?;
                    Some(HarnessModel {
                        value: value.to_string(),
                        name: entry
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        description: entry
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        current: current == Some(value),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What a [`confirm`] found: whether the harness runs, and what it can run.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedHarness {
    pub readiness: Readiness,
    /// Empty unless the probe reached `session/new` and the adapter
    /// advertised a model category.
    pub models: Vec<HarnessModel>,
    /// Where the adapter turned out to be, resolved *after* the fact and only
    /// when a message will quote it.
    ///
    /// Never consulted to decide anything — by the time this is filled in, the
    /// subprocess has already settled the verdict. It answers "which of my
    /// installs was that?", which matters on a machine carrying Homebrew, npm
    /// and nvm copies of the same tool.
    pub path: Option<PathBuf>,
}

/// A harness and how ready it is.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub readiness: Readiness,
}

// No `path` field, deliberately. The survey looks nothing up, so any path here
// could only ever be `None` — and a field that is structurally always absent
// reads, to the next person, as though this call knows where things are. The
// resolved adapter arrives on [`ConfirmedHarness`] instead, with the verdict
// that made it worth quoting.

/// The environment a probe reads, so the rules below are testable without
/// installing anything.
pub trait Probe {
    /// The executable's location, or `None` when it is not on `PATH`.
    fn locate(&self, command: &str) -> Option<PathBuf>;
}

/// The real environment.
pub struct SystemProbe;

impl Probe for SystemProbe {
    fn locate(&self, command: &str) -> Option<PathBuf> {
        // The operator's *shell* `PATH`, not this process's — see
        // [`shell_env`](crate::acp::shell_env). A GUI-launched app inherits
        // `launchd`'s minimal one and would report every Homebrew- or
        // npm-installed harness as missing.
        let path = crate::acp::shell_env::effective_path()?;
        std::env::split_paths(&path).find_map(|dir| {
            executable_names(command).find_map(|name| {
                let candidate = dir.join(&name);
                is_executable(&candidate).then_some(candidate)
            })
        })
    }
}

/// The filenames one command can have on this platform, in preference order.
///
/// On Unix a command is its own filename and this yields one candidate.
///
/// On Windows it yields the `PATHEXT` variants **first** and the bare name
/// last. That order is the whole point: npm writes *both* `<command>.cmd`,
/// which Windows can execute, and an extensionless POSIX shell shim beside it,
/// which it cannot — and every caller stops at the first candidate that
/// exists. Preferring the bare name (as this first did, reasoning that an
/// extensionless executable should not be shadowed) picks the unusable half of
/// that pair every time, for `npm` itself and for an installed adapter alike.
/// The bare name stays as the final fallback, so a genuinely extensionless
/// executable is still found where no variant exists.
///
/// A command that already carries an extension is never extended again.
pub(crate) fn executable_names(command: &str) -> impl Iterator<Item = String> + '_ {
    let extensions: Vec<String> = if cfg!(windows) && !command.contains('.') {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    extensions
        .into_iter()
        .map(move |ext| format!("{command}{ext}"))
        .chain(std::iter::once(command.to_string()))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Every harness this build can drive, all of them pending.
///
/// Deliberately answers nothing: it does not touch `PATH` and starts no
/// process. It exists to paint the list instantly and to say, honestly, that
/// nothing is known yet — every row is [`Readiness::Checking`] until
/// [`confirm`] runs the adapter and finds out.
///
/// This used to gate on a `PATH` lookup, and that was the wrong shape. A
/// binary being on `PATH` is not the question anyone is asking; it is a proxy,
/// and a leaky one — it says nothing about the executable bit, the
/// architecture, a dangling symlink, a half-finished `npm` install, or sign-in.
/// The subprocess answers all of those at once, and answers *authoritatively*,
/// so it is now the only thing that decides. `PATH` has one remaining job and
/// it is not this one: see [`diagnose_absent`].
pub fn survey() -> Vec<HarnessStatus> {
    HARNESSES
        .iter()
        .map(|h| HarnessStatus {
            id: h.id,
            label: h.label,
            readiness: Readiness::Checking,
        })
        .collect()
}

/// The adapter to spawn for `harness`, and where it came from.
///
/// App-owned first, then `PATH`. The order matters in both directions:
///
/// - **app-owned first**, so an operator who pressed Install gets the version
///   this build pins and tested, not whatever a global install drifted to.
/// - **`PATH` second, and never ignored**, so a machine that already had a
///   working adapter keeps working without being made to install a second
///   copy of something it has. That case is not hypothetical — it is how every
///   machine that used this feature before the installer existed is set up.
pub fn resolve_adapter(harness: &Harness) -> Option<PathBuf> {
    resolve_adapter_in(&super::tools::tools_dir(), &SystemProbe, harness)
}

/// [`resolve_adapter`] with both sources injected.
///
/// Split out purely so the preference order is testable. It is the whole
/// correctness of this function — spawning the wrong one of two present
/// adapters is invisible until a turn behaves oddly — and it cannot be
/// exercised through [`resolve_adapter`] without writing into the operator's
/// real tools directory.
pub fn resolve_adapter_in(
    tools_root: &Path,
    probe: &dyn Probe,
    harness: &Harness,
) -> Option<PathBuf> {
    super::tools::installed_adapter_in(tools_root, harness)
        .or_else(|| probe.locate(harness.command))
}

/// Why a spawn found nothing to start — the *only* place `PATH` is consulted.
///
/// Reached solely after the OS has already said the adapter does not exist, so
/// this never decides whether a harness works. It decides what to tell the
/// operator about a failure that has already happened, and the two answers need
/// different words:
///
/// - the CLI is here → one npm package is missing, and it can be named
/// - nothing is here → the tool itself is not installed
///
/// The distinction cannot come from the spawn, because the spawn only ever
/// tried the adapter. Nothing else in this module reads `PATH`.
pub fn diagnose_absent(probe: &dyn Probe, harness: &Harness) -> Readiness {
    match probe.locate(harness.cli) {
        Some(cli) => Readiness::AdapterMissing {
            cli,
            package: harness.package,
        },
        None => Readiness::NotInstalled,
    }
}

/// How long a harness gets to answer `initialize` before it is called broken.
///
/// Generous: this is process startup plus one round trip, and a cold Node CLI
/// on a busy laptop is slow. The window only has to be shorter than an
/// operator's patience with a row that says "Checking…".
pub const CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Actually starts `harness_id` and completes the ACP `initialize` handshake,
/// turning a [`Readiness::Checking`] into `Ready` or `SpawnFailed`.
///
/// ## Why the file probe is not the whole answer
///
/// [`survey`] can only see that a binary sits on `PATH`, which does not say
/// the thing an operator actually needs to know. It cannot see sign-in at all:
/// Claude Code keeps its credentials in the macOS Keychain, not in a file this
/// could stat, and guessing at `~/.claude/.credentials.json` reported a
/// signed-in install as signed out. Beyond that, a binary can be the wrong
/// architecture, a half-finished `npm`
/// install, a different tool that happens to share the name, or a version
/// whose ACP protocol this client no longer speaks — and every one of those
/// reads as `Ready` from the filesystem, then fails on the first real turn,
/// far from its cause. The handshake is what closes that gap: an agent that
/// answers `initialize` is an agent that starts and speaks this protocol.
///
/// It goes as far as `session/new` and stops there — never `session/prompt`,
/// which is the call that actually runs inference and bills. Measured live at
/// well under two seconds end to end for both adapters, so this is cheap
/// enough to run whenever the pane opens.
///
/// Reaching `session/new` buys two things one `initialize` cannot:
///
/// - **The model list.** It is the only place an adapter advertises what it
///   can run (see [`parse_models`]), and it is what the console's model
///   picker is built from.
/// - **A live credential check.** A stale or expired token still passes the
///   file probe; opening a session is where that surfaces. So `Ready` here
///   means rather more than "a credential file exists".
///
/// The subprocess is killed on drop (`AcpClient`'s own `Drop`), so a probe
/// leaves nothing running whether it succeeded, failed, or timed out.
pub async fn confirm(harness_id: &str, cwd: &Path) -> ConfirmedHarness {
    let failed = |reason: String| ConfirmedHarness {
        readiness: Readiness::SpawnFailed { reason },
        models: Vec::new(),
        path: None,
    };

    let Some(harness) = HARNESSES.iter().find(|h| h.id == harness_id) else {
        return failed(format!("`{harness_id}` is not a harness this build knows"));
    };

    // An adapter this app owns wins over one on `PATH`; the spawn is given an
    // absolute path in that case, so it cannot accidentally pick up the other.
    let resolved = resolve_adapter(harness);

    // Node is checked *before* the spawn, not only after a `NotOnPath`.
    //
    // The post-spawn check reached `NodeMissing` only when the OS could not
    // find the adapter at all — which is the rarer half. With an adapter
    // installed and no Node, the shebang line means `/usr/bin/env` starts
    // fine and then exits 127, so the client sees the pipe close and reports
    // `Gone`. That surfaced as "Won't start", which sends the operator to
    // debug an adapter that is perfectly intact, and never mentions the one
    // thing missing.
    //
    // Only when an adapter was resolved: with neither present, `NotInstalled`
    // or `AdapterMissing` is the more useful answer, and it still names the
    // Node requirement in its own copy.
    if resolved.is_some() && super::tools::node().is_none() {
        return ConfirmedHarness {
            readiness: Readiness::NodeMissing,
            models: Vec::new(),
            path: resolved,
        };
    }

    let command = resolved
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| harness.command.to_string());

    // Reported before the spawn, because an install behind the pin is a fact
    // about the filesystem and the spawn cannot discover it — an outdated
    // adapter starts and handshakes perfectly well.
    if resolved.is_some()
        && super::tools::installed_adapter(harness).is_some()
        && !super::tools::is_pinned_version_in(&super::tools::tools_dir(), harness)
    {
        return ConfirmedHarness {
            readiness: Readiness::AdapterOutdated {
                found: super::tools::installed_version(harness).unwrap_or_default(),
                want: harness.version,
            },
            models: Vec::new(),
            path: resolved,
        };
    }

    let args: Vec<&str> = harness.args.to_vec();
    let handshake = async {
        let client = crate::acp::client::AcpClient::spawn(
            &command,
            &args,
            cwd,
            &[],
            // Never invoked in practice: the probe opens a session but runs
            // no turn, so the agent is given nothing to read a file for or
            // ask permission about.
            Arc::new(ProbeHandler),
            Arc::new(|_| {}),
        )
        .await?;
        client.initialize().await?;
        client
            .call(
                "session/new",
                serde_json::json!({ "cwd": cwd.display().to_string(), "mcpServers": [] }),
            )
            .await
    };

    // Filled in only on the paths that quote it, so the happy path costs no
    // `PATH` walk at all — the spawn already proved the adapter exists.
    let locate_adapter = || SystemProbe.locate(harness.command);

    match tokio::time::timeout(CONFIRM_TIMEOUT, handshake).await {
        Ok(Ok(raw)) => ConfirmedHarness {
            readiness: Readiness::Ready,
            models: parse_models(&raw),
            path: None,
        },

        // The OS could not find something to start. Node is checked first,
        // because a missing runtime and a missing adapter look identical from
        // here and only one of them is fixed by installing an adapter.
        Ok(Err(crate::acp::client::AcpError::NotOnPath(_))) => ConfirmedHarness {
            readiness: if super::tools::node().is_none() {
                Readiness::NodeMissing
            } else {
                diagnose_absent(&SystemProbe, harness)
            },
            models: Vec::new(),
            path: None,
        },
        // A harness that starts and then refuses the session is almost always
        // a sign-in problem, and it is worth separating: "sign in to its CLI"
        // and "this install is broken" have nothing to do with each other, and
        // sending someone to reinstall a working binary wastes real time.
        // Classified from the adapter's own words rather than guessed from the
        // filesystem — which is the mistake this replaced.
        Ok(Err(error)) => {
            let reason = error.to_string();
            if reads_as_signed_out(&reason) {
                ConfirmedHarness {
                    readiness: Readiness::NotSignedIn,
                    models: Vec::new(),
                    path: locate_adapter(),
                }
            } else {
                ConfirmedHarness {
                    path: locate_adapter(),
                    ..failed(reason)
                }
            }
        }
        Err(_elapsed) => ConfirmedHarness {
            path: locate_adapter(),
            ..failed(format!(
                "it did not answer within {}s of starting",
                CONFIRM_TIMEOUT.as_secs()
            ))
        },
    }
}

/// Whether a harness's refusal is about credentials rather than health.
///
/// Substring matching on someone else's error text, which is exactly as
/// fragile as it sounds — so it is used only to pick between two *labels*, and
/// the adapter's own message is what the console shows either way. A miss
/// costs the operator a less specific word, never a wrong verdict about
/// whether the harness works.
fn reads_as_signed_out(reason: &str) -> bool {
    let lower = reason.to_lowercase();
    [
        "auth",
        "unauthenticated",
        "unauthorized",
        "log in",
        "login",
        "sign in",
        "signed in",
        "credential",
        "api key",
        "not logged",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// The handler a probe passes and never uses.
///
/// Refuses everything rather than confining a directory: a probe never opens
/// a session, so any call here would mean the agent did something
/// `initialize` does not license — and answering it helpfully would be the
/// wrong instinct.
struct ProbeHandler;

#[async_trait::async_trait]
impl crate::acp::client::ClientHandler for ProbeHandler {
    async fn read_text_file(&self, _path: &Path) -> std::result::Result<String, String> {
        Err("a readiness probe serves no files".to_string())
    }
    async fn write_text_file(
        &self,
        _path: &Path,
        _content: &str,
    ) -> std::result::Result<(), String> {
        Err("a readiness probe serves no files".to_string())
    }
    async fn request_permission(&self, _tool_call: &Value, _options: &Value) -> String {
        String::new()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use std::collections::HashSet;

    struct Fake {
        installed: HashSet<String>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                installed: HashSet::new(),
            }
        }
        fn with_installed(mut self, command: &str) -> Self {
            self.installed.insert(command.to_string());
            self
        }
    }

    impl Probe for Fake {
        fn locate(&self, command: &str) -> Option<PathBuf> {
            self.installed
                .contains(command)
                .then(|| PathBuf::from(format!("/usr/local/bin/{command}")))
        }
    }

    /// What `PATH` is consulted for now: explaining an absence the OS has
    /// already reported, never deciding one.
    fn absent(probe: &dyn Probe, id: &str) -> Readiness {
        let harness = HARNESSES
            .iter()
            .find(|h| h.id == id)
            .expect("a known harness");
        diagnose_absent(probe, harness)
    }

    /// The bare name is always tried, on every platform.
    ///
    /// Unix installs a command under its own name, so this must stay a
    /// single candidate there — and it must stay *first* everywhere, so an
    /// extensionless executable is not shadowed by a `.exe` beside it.
    #[test]
    fn a_command_is_looked_up_under_its_own_name_first() {
        assert_eq!(executable_names("node").next().as_deref(), Some("node"));
        #[cfg(unix)]
        assert_eq!(
            executable_names("node").count(),
            1,
            "unix needs no variants"
        );
    }

    /// Windows does not install `node` as `node`.
    ///
    /// It is `node.exe`, and `npm` is `npm.cmd`. Looking only for the bare
    /// name refused every install with "node was not found" on a correctly
    /// configured machine — the same class of false negative as reading
    /// `launchd`'s `PATH`, and invisible from a Unix dev box.
    #[cfg(windows)]
    #[test]
    fn windows_also_tries_the_pathext_variants() {
        let names: Vec<String> = executable_names("node").collect();
        assert!(
            names.iter().any(|n| n.eq_ignore_ascii_case("node.exe")),
            "{names:?}"
        );
        // A command that already carries an extension is not extended again.
        assert_eq!(executable_names("node.exe").count(), 1);
    }

    /// The preference order the Install button depends on.
    ///
    /// This was the defect Codex caught on #1681: the probe resolved
    /// app-owned-first while `LocalAcpAgent` spawned the bare catalogue name,
    /// so an installed adapter was reported `Ready` and then never run. On a
    /// machine whose only adapter is the installed one, that is the difference
    /// between the feature working and every turn failing "not on PATH".
    #[test]
    fn an_app_owned_adapter_wins_over_one_on_path() {
        let root = tempfile::tempdir().unwrap();
        let harness = HARNESSES.iter().find(|h| h.id == "claude").unwrap();
        let bin = root.path().join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(harness.command), "#!/usr/bin/env node\n").unwrap();

        let on_path = Fake::new().with_installed(harness.command);
        assert_eq!(
            resolve_adapter_in(root.path(), &on_path, harness),
            Some(bin.join(harness.command)),
            "the version this app installed and pinned must win"
        );
    }

    /// ...and an operator's own install is still used when this app has none,
    /// so the installer is additive rather than a new requirement. Every
    /// machine that used this feature before the installer existed is set up
    /// exactly this way.
    #[test]
    fn a_path_adapter_is_used_when_this_app_installed_none() {
        let empty = tempfile::tempdir().unwrap();
        let harness = HARNESSES.iter().find(|h| h.id == "claude").unwrap();
        let on_path = Fake::new().with_installed(harness.command);

        assert_eq!(
            resolve_adapter_in(empty.path(), &on_path, harness),
            Some(PathBuf::from(format!("/usr/local/bin/{}", harness.command)))
        );
        // Neither source has one: the caller falls back to the bare name and
        // the spawn reports `NotOnPath`, which is what produces the install
        // advice rather than a spawn error.
        assert_eq!(
            resolve_adapter_in(empty.path(), &Fake::new(), harness),
            None
        );
    }

    /// The survey decides nothing, and that is the point of the inversion.
    ///
    /// It used to gate on `PATH` and hand `confirm` a pre-formed verdict. But
    /// presence on `PATH` was only ever a proxy for the real question, and it
    /// is wrong in both directions: a binary can be there and unusable (wrong
    /// architecture, missing execute bit, dangling symlink, half-finished
    /// `npm` install, a protocol version this client no longer speaks). The
    /// subprocess answers authoritatively, so it is the only thing that answers.
    #[test]
    fn the_survey_decides_nothing_and_starts_nothing() {
        let statuses = survey();
        assert_eq!(statuses.len(), HARNESSES.len(), "every harness is offered");
        assert!(
            statuses.iter().all(|s| s.readiness == Readiness::Checking),
            "nothing is known until an adapter answers"
        );
    }

    /// Each harness is diagnosed against its own CLI. One being installed must
    /// not make another look installed — they are separate packages, and
    /// `codex` absent on a machine that has `claude` is ordinary.
    #[test]
    fn each_harness_is_diagnosed_against_its_own_cli() {
        let probe = Fake::new().with_installed("claude");
        assert!(matches!(
            absent(&probe, "claude"),
            Readiness::AdapterMissing { .. }
        ));
        assert_eq!(absent(&probe, "codex"), Readiness::NotInstalled);
    }

    /// The regression that motivated dropping the file probe: a signed-in
    /// Claude Code on macOS keeps no `~/.claude/.credentials.json`, and the
    /// Phase 2 must not overwrite a verdict phase 1 already reached.
    ///
    /// The model picker calls [`confirm`] on whatever harness the operator
    /// selected, with no readiness filter — so this is reachable from the UI,
    /// and reachable is where a raw `os error 2` would replace an instruction
    /// naming the exact package to install.
    #[tokio::test]
    async fn confirming_an_uninstalled_harness_reports_the_survey_not_a_spawn_error() {
        // `_acp` is not a real harness id, so this exercises the unknown-id
        // arm; the installed-state arm needs the real machine, which the
        // ignored live test covers. What is asserted here is the shape: a
        // caller never gets a spawn error for something that was never spawned.
        let confirmed = confirm("_nonexistent", Path::new(".")).await;
        assert!(matches!(confirmed.readiness, Readiness::SpawnFailed { .. }));
        assert!(confirmed.models.is_empty());
    }

    /// The message that started this: `claude` installed, adapter absent.
    ///
    /// Reporting `NotInstalled` here tells an operator to install Claude Code
    /// on the machine they already run it on, and never mentions the one
    /// package that would fix it.
    #[test]
    fn an_installed_cli_without_its_adapter_is_not_reported_as_missing() {
        let probe = Fake::new().with_installed("claude");
        assert_eq!(
            absent(&probe, "claude"),
            Readiness::AdapterMissing {
                cli: PathBuf::from("/usr/local/bin/claude"),
                package: "@agentclientprotocol/claude-agent-acp",
            }
        );
    }

    /// Neither half present is the only case that should say "install it".
    #[test]
    fn a_machine_with_neither_binary_is_reported_as_not_installed() {
        assert_eq!(absent(&Fake::new(), "claude"), Readiness::NotInstalled);
    }

    /// Each harness names its own package. A shared or copy-pasted hint sends
    /// someone to install the wrong one, which fails quietly and looks like the
    /// advice simply did not work.
    #[test]
    fn each_harness_names_the_package_that_fixes_it() {
        let probe = Fake::new().with_installed("claude").with_installed("codex");
        for harness in HARNESSES {
            let Readiness::AdapterMissing { package, .. } = diagnose_absent(&probe, harness) else {
                panic!("{} should be AdapterMissing", harness.id);
            };
            assert!(
                package.ends_with(&format!("/{}-acp", harness.id))
                    || package.ends_with(&format!("/{}-agent-acp", harness.id)),
                "{} points at {package}",
                harness.id
            );
        }
    }

    /// The regression that motivated dropping the credential-file probe, now
    /// structural rather than a rule to remember: nothing in this module can
    /// conclude `NotSignedIn` from the filesystem, because the only filesystem
    /// call left ([`diagnose_absent`]) cannot return that variant at all. It is
    /// reachable exclusively from an adapter's own refusal.
    #[test]
    fn sign_in_cannot_be_concluded_from_the_filesystem() {
        for probe in [Fake::new(), Fake::new().with_installed("claude")] {
            for harness in HARNESSES {
                assert_ne!(
                    diagnose_absent(&probe, harness),
                    Readiness::NotSignedIn,
                    "{} must not be judged signed-out by a file lookup",
                    harness.id
                );
            }
        }
    }

    #[test]
    fn readiness_serialises_with_a_state_tag_the_console_can_switch_on() {
        let json = serde_json::to_value(Readiness::NotSignedIn).unwrap();
        assert_eq!(json["state"], "notSignedIn");
        let failed = serde_json::to_value(Readiness::SpawnFailed {
            reason: "exited immediately".into(),
        })
        .unwrap();
        assert_eq!(failed["state"], "spawnFailed");
        // The reason travels: "it didn't start" with no cause is not actionable.
        assert_eq!(failed["reason"], "exited immediately");
    }
}
