#!/bin/sh
# Print the system prompt each of a company's agents would be built with.
#
# A thin wrapper over `opencompany prompt` whose only job is the feature flag:
# the harness owns the workspace, ledger, deliverable and delegation briefs and
# lives behind `--features openhuman`, so a default build renders the persona
# and the checked-in briefs and reports the rest as deferred. Forgetting the
# flag therefore produces a shorter prompt that looks complete, which is the one
# failure this surface exists to prevent.
#
# Usage:
#   ./scripts/dump-prompt.sh --company companies/product_team
#   ./scripts/dump-prompt.sh --company companies/product_team --agent bug_triager
#   ./scripts/dump-prompt.sh --company <dir> --agent <id> --raw     # bytes only
#   ./scripts/dump-prompt.sh --company <dir> --out /tmp/prompts     # one file per agent
#   ./scripts/dump-prompt.sh --company <dir> --json
#
# Set OPENCOMPANY_DUMP_FEATURES to override the feature set (e.g. "openhuman,mcp").
# Every argument is passed through to the subcommand unchanged.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)
FEATURES=${OPENCOMPANY_DUMP_FEATURES:-openhuman}

cd "$REPO_ROOT"
exec cargo run --quiet -p opencompany-core --features "$FEATURES" --bin opencompany -- prompt "$@"
