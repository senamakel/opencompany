//! Boots the host in-process over one data root.
//!
//! A port of the desktop shell's `embedded::start_with`
//! (`crates/opencompany-app/src/embedded.rs`): resolve and lock the root,
//! migrate, prove the journal writable, build the host state, seed or adopt
//! the companies, bind loopback. The two differ in exactly one thing — the
//! desktop hands the host an `AcpAgentFactory` for local ACP harnesses, which
//! only it has — and must not drift in any other, so the comments there apply
//! here too and are not repeated.

use std::path::{Path, PathBuf};

use opencompany::app::config::AuthMode;
use opencompany::{AppConfig, AppState};

/// A running host, listening on loopback, over a locked data root.
///
/// Dropping it aborts the server task and releases the root's lock (through
/// the `EmbeddedInstance` it holds).
pub struct EmbeddedHost {
    address: std::net::SocketAddr,
    state: AppState,
    _instance: opencompany::app::EmbeddedInstance,
    server: tokio::task::JoinHandle<()>,
    sweeper: tokio::task::JoinHandle<()>,
}

impl EmbeddedHost {
    /// `http://127.0.0.1:<port>` — the operator API, for the console or curl.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// The host's own durable identity.
    pub fn instance_id(&self) -> &str {
        self.state.instance_id()
    }

    /// The data root the host runs over.
    pub fn home(&self) -> &Path {
        self.state.home()
    }

    /// The host state: the registry the screen reads its companies from.
    pub fn state(&self) -> &AppState {
        &self.state
    }
}

impl Drop for EmbeddedHost {
    fn drop(&mut self) {
        self.sweeper.abort();
        self.server.abort();
    }
}

/// Boots a host over `data_dir` (`None` resolves the default the way
/// `opencompany serve` does), seeding the starter company on an empty root.
pub async fn start(data_dir: Option<PathBuf>) -> opencompany::Result<EmbeddedHost> {
    let instance = opencompany::app::prepare_instance(data_dir).await?;

    // Both must run before any company runtime or agent harness exists, and
    // both name `openhuman`-gated items, so they exist only in a build that
    // compiled the harness in. A default build has no harness to register
    // with and nothing here to run.
    #[cfg(feature = "harness")]
    {
        tracing::info!(
            "{}",
            opencompany::app::journal::pin_keyring(instance.journal()).summary()
        );
        opencompany::product::install_into_embedded_core();
    }

    let config = AppConfig {
        bind: "127.0.0.1:0".to_string(),
        workspace_quota: instance.workspace().quota,
        workspace_git_enabled: instance.workspace().git_enabled,
        // One machine, one person, loopback only: no sign-in, unless the root's
        // own `config.toml` names a mode.
        auth_mode_override: Some(instance.auth_mode().unwrap_or(AuthMode::None)),
        ..AppConfig::default()
    };
    let state = AppState::new(config)
        .with_home(instance.home().to_path_buf())
        .with_rebuilder(std::sync::Arc::new(opencompany::desktop::DesktopRebuilder));

    // Before the listener: a screen that read an empty registry would show the
    // "no companies" dead end the seed exists to remove.
    let companies =
        opencompany::desktop::bootstrap_companies(&state, opencompany::desktop::DEFAULT_PRESET_ID)
            .await?;

    let sweeper = state.spawn_acp_session_sweeper(std::sync::Arc::new(tokio::sync::Notify::new()));
    let (address, serving) = match opencompany::server::bind("127.0.0.1:0", state.clone()).await {
        Ok(bound) => bound,
        Err(error) => {
            sweeper.abort();
            return Err(error);
        }
    };
    let server = tokio::spawn(async move {
        if let Err(error) = serving.run().await {
            tracing::error!(%error, "the embedded host stopped");
        }
    });

    tracing::info!(
        %address,
        instance_id = state.instance_id(),
        companies = companies.len(),
        home = %instance.home().display(),
        "embedded host listening"
    );
    Ok(EmbeddedHost {
        address,
        state,
        _instance: instance,
        server,
        sweeper,
    })
}
