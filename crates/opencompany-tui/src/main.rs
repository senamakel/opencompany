//! The `opencompany-tui` binary.
//!
//! Deliberately almost empty: everything testable lives in the library so it
//! can be driven without a terminal.

use clap::Parser;

fn main() -> anyhow::Result<()> {
    let cli = opencompany_tui::Cli::parse();
    opencompany_tui::run(cli)
}
