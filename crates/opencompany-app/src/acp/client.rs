//! Driving a locally-installed harness over ACP.
//!
//! Spawns the harness as a subprocess and speaks JSON-RPC over its stdio. The
//! shape is a *peer*, not a caller: both sides issue requests. This process
//! sends `initialize`, `session/new` and `session/prompt`; the harness sends
//! back `fs/read_text_file`, `fs/write_text_file` and
//! `session/request_permission`, and streams `session/update` notifications
//! throughout.
//!
//! ## One reader, and why
//!
//! A single task owns stdout and routes everything: responses to whoever is
//! waiting on that id, agent-initiated requests to the handler, notifications
//! to the session's update sink. The alternative — each caller reading until it
//! sees its own reply — loses every message that arrives in between, which for
//! ACP is *all of the streaming*: `session/prompt`'s answer comes last, after
//! every `session/update` it produced.
//!
//! ## What happens to a request whose reply never comes
//!
//! The pending map holds a `oneshot` per in-flight id. If the harness exits,
//! the reader task ends and drops the map, which cancels every sender — so
//! every waiter fails immediately rather than hanging. A harness that dies
//! mid-turn is an ordinary event (a crash, a `SIGKILL`, an OOM), and the caller
//! must hear about it in time to say so.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

use crate::acp::codec::{self, Message, RequestId};
use crate::acp::confine::Confinement;

/// The protocol version this client speaks. ACP v1 is the stable one.
pub const PROTOCOL_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    /// The executable is not on `PATH` — the OS refused to start anything.
    ///
    /// Split from [`Self::Spawn`] because it is the *only* spawn error that
    /// means "not installed", and the caller's response is completely
    /// different: install something, versus read a reason. Classifying it
    /// here, off `io::ErrorKind`, keeps that decision away from substring
    /// matching on `"os error 2"` — which is locale- and platform-dependent
    /// and silently stops matching when either changes.
    #[error("`{0}` is not on PATH")]
    NotOnPath(String),
    #[error("could not start the harness: {0}")]
    Spawn(String),
    #[error("the harness went away")]
    Gone,
    #[error("the harness refused: {0}")]
    Refused(String),
    #[error("input/output: {0}")]
    Io(String),
}

/// What the client does when the agent asks something of it.
///
/// A trait so the file and permission answers are injectable: the tests drive a
/// real subprocess without touching the operator's disk, and the desktop
/// supplies an implementation that prompts.
#[async_trait::async_trait]
pub trait ClientHandler: Send + Sync {
    async fn read_text_file(&self, path: &Path) -> Result<String, String>;
    async fn write_text_file(&self, path: &Path, content: &str) -> Result<(), String>;
    /// Answers a permission request with an option id the agent offered.
    async fn request_permission(&self, tool_call: &Value, options: &Value) -> String;
}

/// The default handler: files inside the session directory, nothing outside.
pub struct ConfinedFiles {
    confinement: Confinement,
    /// Which permission option to pick. `None` refuses everything.
    ///
    /// Deliberately explicit rather than defaulting to "allow": a client that
    /// silently approves is a client whose permission prompt is decoration.
    auto_option: Option<String>,
}

impl ConfinedFiles {
    pub fn new(confinement: Confinement, auto_option: Option<String>) -> Self {
        Self {
            confinement,
            auto_option,
        }
    }
}

#[async_trait::async_trait]
impl ClientHandler for ConfinedFiles {
    async fn read_text_file(&self, path: &Path) -> Result<String, String> {
        let resolved = self
            .confinement
            .resolve_read(path)
            .map_err(|e| e.to_string())?;
        tokio::fs::read_to_string(resolved)
            .await
            .map_err(|e| e.to_string())
    }

    async fn write_text_file(&self, path: &Path, content: &str) -> Result<(), String> {
        let resolved = self
            .confinement
            .resolve_write(path)
            .map_err(|e| e.to_string())?;
        tokio::fs::write(resolved, content)
            .await
            .map_err(|e| e.to_string())
    }

    async fn request_permission(&self, _tool_call: &Value, options: &Value) -> String {
        // Pick the configured option if the agent actually offered it. Echoing
        // back an id the agent never listed would be answering a question it
        // did not ask.
        let offered = |id: &str| {
            options
                .as_array()
                .is_some_and(|list| list.iter().any(|o| o["optionId"] == id))
        };
        match &self.auto_option {
            Some(id) if offered(id) => id.clone(),
            _ => options
                .as_array()
                .and_then(|list| {
                    list.iter().find(|o| {
                        matches!(
                            o["kind"].as_str(),
                            Some("reject_once") | Some("reject_always")
                        )
                    })
                })
                .and_then(|o| o["optionId"].as_str().map(str::to_string))
                // Nothing to refuse with: say so rather than inventing an id.
                .unwrap_or_else(|| "reject".to_string()),
        }
    }
}

/// Wraps another handler's file logic but answers every permission request
/// itself, picking by option `kind` rather than a caller-configured id.
///
/// Ported from how `buzz-agent` handles the same protocol gap
/// (`crates/buzz-acp/src/acp.rs::handle_permission_request`): finds the
/// option whose `kind` is `allow_once`, falling back to `reject_once` /
/// `reject_always` if the agent offered no allow option at all. Never a
/// hardcoded `optionId` — adapters name their ids however they like, and only
/// `kind` is part of the ACP spec's stable vocabulary.
///
/// This is `LocalAcpAgent`'s production handler: an ACP agent's own
/// permission-mode config option (the same `session/set_config_option` lever
/// already used for model steering) is meant to keep it from asking at all,
/// and this is the fallback for whatever still does — never a hang, never a
/// silent refusal that reads as the harness doing nothing.
pub struct AutoApprovingFiles<H> {
    inner: H,
}

impl<H: ClientHandler> AutoApprovingFiles<H> {
    pub fn new(inner: H) -> Self {
        Self { inner }
    }
}

#[async_trait::async_trait]
impl<H: ClientHandler> ClientHandler for AutoApprovingFiles<H> {
    async fn read_text_file(&self, path: &Path) -> Result<String, String> {
        self.inner.read_text_file(path).await
    }

    async fn write_text_file(&self, path: &Path, content: &str) -> Result<(), String> {
        self.inner.write_text_file(path, content).await
    }

    async fn request_permission(&self, _tool_call: &Value, options: &Value) -> String {
        let by_kind = |kind: &str| {
            options.as_array().and_then(|list| {
                list.iter()
                    .find(|o| o["kind"].as_str() == Some(kind))
                    .and_then(|o| o["optionId"].as_str())
            })
        };
        by_kind("allow_once")
            .or_else(|| by_kind("reject_once"))
            .or_else(|| by_kind("reject_always"))
            .map(str::to_string)
            // Nothing offered at all: say so rather than inventing an id.
            .unwrap_or_else(|| "reject".to_string())
    }
}

type Pending = Arc<Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, String>>>>>;

/// One spawned harness.
pub struct AcpClient {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicI64,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        // The reader holds the subprocess's stdout; without this a harness that
        // ignores EOF outlives the client that spawned it. Buzz needed a
        // dedicated orphan sweep for exactly this.
        self.reader.abort();
    }
}

/// Where `session/update` notifications go.
pub type UpdateSink = Arc<dyn Fn(Value) + Send + Sync>;

impl AcpClient {
    /// Spawns `command` and starts reading it.
    ///
    /// `env` is added on top of this process's own inherited environment —
    /// not a replacement for it — so a harness that also needs `PATH`, `HOME`,
    /// etc. keeps them. Callers that need no extra vars (every one before
    /// issue #1245) pass `&[]`.
    pub async fn spawn(
        command: &str,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
        handler: Arc<dyn ClientHandler>,
        updates: UpdateSink,
    ) -> Result<Self, AcpError> {
        let mut child = Command::new(command)
            .args(args)
            // Set before `envs` so an explicit caller override still wins.
            //
            // The same shell `PATH` the probe located the harness with, for
            // the same reason — and here it matters twice over: these adapters
            // are `#!/usr/bin/env node` scripts, so spawning one resolves
            // `node` afresh. Finding `claude-agent-acp` under `launchd`'s
            // `PATH` and then failing to find `node` is a spawn failure whose
            // message names neither.
            .envs(
                crate::acp::shell_env::effective_path()
                    .map(|path| ("PATH".into(), path))
                    .into_iter()
                    .collect::<Vec<(std::ffi::OsString, std::ffi::OsString)>>(),
            )
            .envs(env.iter().copied())
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, not captured: a harness writes diagnostics here, and
            // silently swallowing them is how "it just does nothing" becomes
            // unanswerable.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => AcpError::NotOnPath(command.to_string()),
                _ => AcpError::Spawn(error.to_string()),
            })?;

        let stdout = child.stdout.take().ok_or(AcpError::Gone)?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or(AcpError::Gone)?));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        let reader = tokio::spawn(read_loop(
            BufReader::new(stdout),
            Arc::clone(&pending),
            Arc::clone(&stdin),
            handler,
            updates,
        ));

        Ok(Self {
            child: Mutex::new(child),
            stdin,
            pending,
            next_id: AtomicI64::new(1),
            reader,
        })
    }

    /// Sends a request and waits for its reply.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        self.send(codec::encode_request(&id, method, params))
            .await?;

        // A cancelled sender means the reader task ended — the harness exited.
        // Reported as gone rather than left to hang.
        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(AcpError::Refused(message)),
            Err(_) => Err(AcpError::Gone),
        }
    }

    /// Sends a notification. Returns as soon as it is written.
    ///
    /// Never waits for a reply, because a notification does not get one.
    /// `session/cancel` is the case that matters: waiting would block the one
    /// operation whose whole purpose is to unblock something else.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), AcpError> {
        self.send(codec::encode_notification(method, params)).await
    }

    async fn send(&self, line: String) -> Result<(), AcpError> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| AcpError::Io(e.to_string()))?;
        stdin.flush().await.map_err(|e| AcpError::Io(e.to_string()))
    }

    /// The ACP handshake.
    pub async fn initialize(&self) -> Result<Value, AcpError> {
        self.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // Only what this client actually serves. Claiming `terminal`
                // here would have the agent send `terminal/create` to something
                // that answers "no such method" mid-turn.
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
                "clientInfo": { "name": "opencompany-desktop", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await
    }

    /// Opens a session rooted at `cwd`.
    pub async fn new_session(&self, cwd: &Path) -> Result<String, AcpError> {
        let result = self
            .call(
                "session/new",
                // ACP requires an absolute cwd, and `mcpServers` is mandatory
                // even when empty.
                json!({ "cwd": cwd.display().to_string(), "mcpServers": [] }),
            )
            .await?;
        result["sessionId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AcpError::Refused("session/new returned no sessionId".into()))
    }

    /// Runs one turn, returning its `stopReason`.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String, AcpError> {
        let result = self
            .call(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
            )
            .await?;
        Ok(result["stopReason"]
            .as_str()
            .unwrap_or("end_turn")
            .to_string())
    }

    /// Asks the agent to stop the current turn.
    ///
    /// A notification, per the protocol. Note this is not a kill: a harness
    /// finishes whatever tool call it is inside before it notices.
    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    /// Terminates the harness.
    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

/// Reads stdout forever, routing every message.
async fn read_loop(
    stdout: BufReader<tokio::process::ChildStdout>,
    pending: Pending,
    stdin: Arc<Mutex<ChildStdin>>,
    handler: Arc<dyn ClientHandler>,
    updates: UpdateSink,
) {
    let mut lines = stdout.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let message = match codec::decode(&line) {
            Ok(message) => message,
            Err(error) => {
                // One unparseable line is not a reason to tear down a session:
                // some harnesses interleave stray output on stdout.
                tracing::debug!(%error, line, "dropping an unparseable ACP line");
                continue;
            }
        };

        match message {
            Message::Response { id, result } => {
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let _ = tx.send(Ok(result));
                }
            }
            Message::Error { id, message, .. } => {
                if let Some(id) = id
                    && let Some(tx) = pending.lock().await.remove(&id)
                {
                    let _ = tx.send(Err(message));
                }
            }
            Message::Notification { method, params } => {
                if method == "session/update" {
                    updates(params);
                }
            }
            Message::Request { id, method, params } => {
                let reply = serve(&method, &params, handler.as_ref()).await;
                let line = match reply {
                    Ok(result) => codec::encode_response(&id, result),
                    // A refusal is answered as an error, not as an empty
                    // success: a model told it read an empty file will act on
                    // that, and a model told it was refused will not.
                    Err(message) => codec::encode_error(&id, -32000, &message),
                };
                let mut stdin = stdin.lock().await;
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
        }
    }
    // The harness closed stdout. Dropping the map cancels every waiter, so
    // in-flight calls fail with `Gone` instead of hanging forever.
    pending.lock().await.clear();
}

/// Answers one agent-initiated request.
async fn serve(method: &str, params: &Value, handler: &dyn ClientHandler) -> Result<Value, String> {
    match method {
        "fs/read_text_file" => {
            let path = PathBuf::from(params["path"].as_str().unwrap_or_default());
            handler
                .read_text_file(&path)
                .await
                .map(|content| json!({ "content": content }))
        }
        "fs/write_text_file" => {
            let path = PathBuf::from(params["path"].as_str().unwrap_or_default());
            let content = params["content"].as_str().unwrap_or_default();
            handler
                .write_text_file(&path, content)
                .await
                .map(|()| json!({}))
        }
        "session/request_permission" => {
            let option = handler
                .request_permission(&params["toolCall"], &params["options"])
                .await;
            Ok(json!({ "outcome": { "outcome": "selected", "optionId": option } }))
        }
        // Answering "unsupported" rather than silently succeeding: a client
        // that returns `{}` to `terminal/create` has told the agent it holds a
        // terminal it can then write to.
        other => Err(format!("unsupported client method: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::confine::Confinement;

    fn auto_approving(root: &std::path::Path) -> AutoApprovingFiles<ConfinedFiles> {
        AutoApprovingFiles::new(ConfinedFiles::new(Confinement::new(root).unwrap(), None))
    }

    #[tokio::test]
    async fn falls_back_to_reject_once_when_the_agent_offers_no_allow_option() {
        let dir = tempfile::tempdir().unwrap();
        let handler = auto_approving(dir.path());
        let options = json!([
            { "optionId": "n1", "name": "Reject", "kind": "reject_once" },
            { "optionId": "n2", "name": "Reject always", "kind": "reject_always" },
        ]);

        assert_eq!(
            handler.request_permission(&Value::Null, &options).await,
            "n1"
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_literal_reject_when_the_agent_offers_nothing_to_pick() {
        let dir = tempfile::tempdir().unwrap();
        let handler = auto_approving(dir.path());

        assert_eq!(
            handler.request_permission(&Value::Null, &json!([])).await,
            "reject"
        );
    }
}
