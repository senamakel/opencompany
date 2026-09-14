#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

# Naming the target explicitly makes a missing/disabled integration target an
# error instead of Cargo's successful "zero tests selected" failure mode.
cargo test --locked -p opencompany-core --features openhuman --test auth_matrix
