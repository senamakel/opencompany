//! Speaking the Agent Client Protocol to locally-installed coding harnesses.
//!
//! The desktop is an ACP **client**: it spawns `claude-agent-acp` or
//! `codex-acp` as a subprocess and drives it over stdio. That direction matters
//! for what lives here — an ACP *client* is the side that serves
//! `fs/read_text_file`, `fs/write_text_file`, `terminal/*` and
//! `session/request_permission`. The agent asks; this process answers, on the
//! operator's real machine, against their real files.
//!
//! Which is why [`confine`] exists and why it is enforced below the UI.

pub mod client;
pub mod codec;
pub mod confine;
pub mod discovery;
pub mod local_agent;
pub mod shell_env;
pub mod tools;
pub mod worktree;

pub use client::{AcpClient, AcpError, ClientHandler, ConfinedFiles};
pub use codec::{Message, RequestId};
pub use confine::{ConfineError, Confinement};
pub use discovery::{Harness, HarnessStatus, Readiness, SystemProbe, survey};
pub use local_agent::{LocalAcpAgent, LocalAcpAgentFactory};
pub use worktree::{Isolation, TaskWorkspace, WorktreeError};
