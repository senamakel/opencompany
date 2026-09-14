#!/usr/bin/env bash
#
# Assert that CI listens for GitHub merge-queue checks and does not silently
# skip its conditional lanes for the queue's synthetic merge commit.
#
# Issue #793. A `merge_group` trigger alone is not enough in this workflow:
# its path filter is designed around pull-request metadata, which a merge-group
# event does not carry. If that filter answered false, every conditional Rust,
# console, and desktop check would be skipped and the queue could treat a
# no-op run as evidence that a batched merge is safe. The workflow therefore
# forces all three outputs true for `merge_group` and skips the inapplicable
# filter step. These textual assertions make that wiring fail loudly if a later
# cleanup removes one half of it.
#
# `workflow_dispatch` rides the same wiring: `promote-main-to-release.yml`
# dispatches CI on a fresh `release` snapshot, whose diff against the default
# branch is empty, so an unforced filter would skip every lane there too.
set -euo pipefail

cd "$(dirname "$0")/../.."

workflow=.github/workflows/ci.yml

if [ ! -f "$workflow" ]; then
  echo "assert-merge-group-workflow: $workflow is missing" >&2
  exit 1
fi

require_line() {
  local description=$1
  local line=$2

  if ! grep -qF "$line" "$workflow"; then
    echo "assert-merge-group-workflow: missing $description:" >&2
    echo "  $line" >&2
    exit 1
  fi
}

require_line "merge_group trigger" "  merge_group:"
require_line "checks-requested merge-group activity" "    types: [checks_requested]"
require_line "dispatch trigger for the promotion run" "  workflow_dispatch: {}"
require_line "queue-safe path-filter guard" "        if: github.event_name != 'merge_group' && github.event_name != 'workflow_dispatch'"

for area in rust frontend desktop; do
  require_line "queue-safe $area output" "      $area: \${{ (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch') && 'true' || steps.filter.outputs.$area }}"
done

echo "CI listens for merge-group checks and selects every conditional lane for them."
