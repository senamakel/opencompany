//! The OpenCompany terminal client.
//!
//! Three parts, kept apart so each can be tested on its own:
//!
//! - [`host`] boots the host in-process over a data root — the same sequence
//!   the desktop shell runs, minus the local ACP harness factory only the
//!   desktop has.
//! - [`app`] is a pure reducer: an [`app::App`] and the [`app::Event`]s that
//!   change it. No I/O, no terminal, no host handle — which is what makes it
//!   unit-testable.
//! - [`ui`] draws an [`app::App`] into a ratatui frame.
//!
//! [`run`] wires them together: a terminal guard, a tokio runtime, the host
//! booting on a task, a blocking thread reading key events, and one loop that
//! folds events into the app and redraws.

pub mod app;
pub mod host;
pub mod ui;

use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use crossterm::event::{self, Event as TermEvent};
use tokio::sync::mpsc;

use crate::app::{App, CompanyRow, Event};

/// Command-line surface. Small on purpose: the instance data root is the one
/// thing a terminal user has to be able to say, and everything else the host
/// reads from that root's `config.toml`.
#[derive(Debug, Parser)]
#[command(name = "opencompany-tui", version, about)]
pub struct Cli {
    /// Instance data root. Defaults to the same resolution `opencompany serve`
    /// uses (`OPENCOMPANY_DATA_DIR`, then the platform default).
    #[arg(long, value_name = "DIR")]
    pub data_dir: Option<PathBuf>,

    /// Where to write the log. The terminal is the screen, so logs can never
    /// go to stdout; by default they go beside the OS temp dir.
    #[arg(long, value_name = "FILE")]
    pub log: Option<PathBuf>,
}

/// How often the screen refreshes its view of the host when nothing else
/// happens. Company busy-ness is polled, not pushed, at this granularity.
const TICK: Duration = Duration::from_millis(250);

/// Runs the client until the operator quits. Restores the terminal on every
/// exit path, including a panic in the draw loop.
pub fn run(cli: Cli) -> anyhow::Result<()> {
    configure_journal_workspace(cli.data_dir.as_deref());
    install_logging(cli.log.clone())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(drive(cli));
    // Abort the host's server task and anything else still running rather than
    // waiting for it: the operator asked to leave.
    runtime.shutdown_timeout(Duration::from_secs(2));
    result
}

/// Set the OpenHuman journal root before Tokio (and therefore any host task)
/// exists. An explicit `--data-dir` is authoritative; otherwise an operator's
/// existing `OPENHUMAN_WORKSPACE` remains authoritative just as it is for
/// `opencompany serve`.
fn configure_journal_workspace(data_dir: Option<&std::path::Path>) {
    let root = data_dir.map(|path| path.join("openhuman")).or_else(|| {
        std::env::var_os("OPENHUMAN_WORKSPACE")
            .is_none()
            .then(|| opencompany::app::config::data_dir_from_env().join("openhuman"))
    });

    if let Some(root) = root {
        // Rust 2024 makes process-environment mutation explicitly unsafe.
        // This is before any threads or Tokio runtime are started.
        unsafe { std::env::set_var("OPENHUMAN_WORKSPACE", root) };
    }
}

fn install_logging(path: Option<PathBuf>) -> anyhow::Result<()> {
    let path = path.unwrap_or_else(|| std::env::temp_dir().join("opencompany-tui.log"));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "opencompany_tui=info,opencompany=info".into()),
        )
        .with_writer(file)
        .with_ansi(false)
        .init();
    tracing::info!(log = %path.display(), "opencompany-tui starting");
    Ok(())
}

async fn drive(cli: Cli) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

    // The host boots on its own task so the screen is up — and quittable —
    // while the lock, the migration and the first-run seed run.
    let boot_tx = tx.clone();
    tokio::spawn(async move {
        match host::start(cli.data_dir).await {
            Ok(host) => {
                let _ = boot_tx.send(Event::HostReady {
                    address: host.base_url(),
                    instance_id: host.instance_id().to_string(),
                    home: host.home().display().to_string(),
                    companies: rows_of(&host),
                });
                // Keep the host alive for the life of the loop, and answer
                // every tick with a fresh view of its companies.
                let mut interval = tokio::time::interval(TICK);
                loop {
                    interval.tick().await;
                    if boot_tx.send(Event::Companies(rows_of(&host))).is_err() {
                        break;
                    }
                }
            }
            Err(error) => {
                let _ = boot_tx.send(Event::HostFailed(error.to_string()));
            }
        }
    });

    // Key events come off a blocking thread: crossterm's reader is synchronous
    // and must not sit on a runtime worker.
    let key_tx = tx.clone();
    std::thread::spawn(move || {
        loop {
            match event::poll(TICK) {
                Ok(true) => match event::read() {
                    Ok(TermEvent::Key(key)) => {
                        if key_tx.send(Event::Key(key)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                },
                Ok(false) => {
                    if key_tx.send(Event::Tick).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    drop(tx);

    let mut terminal = TerminalGuard::enter();
    let mut app = App::default();
    terminal.draw(|frame| ui::draw(frame, &app))?;
    while let Some(event) = rx.recv().await {
        app.update(event);
        if app.should_quit {
            break;
        }
        terminal.draw(|frame| ui::draw(frame, &app))?;
    }
    Ok(())
}

fn rows_of(host: &host::EmbeddedHost) -> Vec<CompanyRow> {
    let registry = host.state().registry();
    let mut ids = registry.list();
    ids.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));
    ids.into_iter()
        .map(|id| {
            let busy = registry
                .get(&id)
                .map(|runtime| runtime.is_busy())
                .unwrap_or(false);
            CompanyRow {
                id: id.as_ref().to_string(),
                busy,
            }
        })
        .collect()
}

/// Raw mode + alternate screen for as long as this lives; the terminal is
/// restored in `Drop`, so an early `?` or a panic still leaves the shell usable.
struct TerminalGuard {
    terminal: ratatui::DefaultTerminal,
}

impl TerminalGuard {
    fn enter() -> Self {
        Self {
            terminal: ratatui::init(),
        }
    }

    fn draw(&mut self, render: impl FnOnce(&mut ratatui::Frame<'_>)) -> std::io::Result<()> {
        self.terminal.draw(render).map(|_| ())
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        ratatui::restore();
    }
}
