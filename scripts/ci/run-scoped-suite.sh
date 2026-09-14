#!/bin/sh
#
# Run one feature-gated `--lib` suite and assert it actually executed something.
# Issue #770.
#
# The trap this closes: `cargo test --lib some::filter` that matches NOTHING
# prints `0 passed; 0 failed` and EXITS 0. A lane added to run a gated suite can
# therefore report success having run none of it — which is the same defect the
# lane was added to fix, one level up. It is not hypothetical here: it is why
# the MongoDB job (#555) asserts a count inline, and why
# `assert-integration-targets-run.sh` (#475) exists for the `tests/` targets.
#
# Both of those are per-site answers. This is the shared one, so that the six
# lanes added for #770 do not each carry their own copy of the parse-and-check
# boilerplate — copies drift, and a lane whose copy was pasted slightly wrong is
# exactly the #592 shape (one lane quietly not doing what its siblings do).
#
# Usage:
#   scripts/ci/run-scoped-suite.sh <label> <features> <filter> [--ignored]
#
#   label     what to call this suite in the log and in a failure message
#   features  the exact --features string (comma-separated, no spaces)
#   filter    ONE test-name filter
#   --ignored run only ignored tests selected by that filter
#
# EXACTLY ONE FILTER, and that is a hard interface rather than an oversight.
# `cargo test --lib a b` reads `a` as the filter and `b` as ANOTHER filter only
# in recent cargo; historically the second bare argument lands in the test
# binary's argument list where it silently narrows the selection to nothing.
# ci.yml already documents this trap at the ACP step ("Two invocations, not
# one"). Taking a single filter makes the safe shape the only shape: to cover
# two modules, call this script twice and get two asserted counts instead of one
# ambiguous run.
#
# `--lib` is fixed, not a parameter. Integration targets under `tests/` have
# their own assertion with its own failure text
# (`assert-integration-targets-run.sh`), and folding both into one script would
# make each failure message describe the other's situation half the time.
#
# `--locked` is passed for every invocation, per issue #251's rule: each feature
# set here is a distinct dependency resolution, and without it these lanes would
# be the place CI silently re-resolves the graph.

set -eu

if [ "$#" -ne 3 ] && { [ "$#" -ne 4 ] || [ "$4" != "--ignored" ]; }; then
  echo "usage: $0 <label> <features> <filter> [--ignored]" >&2
  echo "  one filter, with an optional ignored-test mode; see the header" >&2
  exit 2
fi

LABEL="$1"
FEATURES="$2"
FILTER="$3"
IGNORED="${4:-}"

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)
cd "${REPO_ROOT}"

LOG="${RUNNER_TEMP:-/tmp}/scoped-suite-$(echo "${LABEL}" | tr -c 'A-Za-z0-9' '-').log"

echo "==> ${LABEL}: cargo test --locked -p opencompany-core --features ${FEATURES} --lib ${FILTER} ${IGNORED}"

if [ "${IGNORED}" = "--ignored" ]; then
  cargo test --locked -p opencompany-core --features "${FEATURES}" --lib "${FILTER}" -- --ignored 2>&1 | tee "${LOG}"
else
  cargo test --locked -p opencompany-core --features "${FEATURES}" --lib "${FILTER}" 2>&1 | tee "${LOG}"
fi

# The pipeline's first command, not `tee`'s status. A compile error or a failing
# test must fail this script, and without this check `set -e` would only see the
# exit code of `tee`, which is 0 whatever cargo did.
#
# `$?` after a pipeline is the LAST command's status in POSIX sh, so the status
# is recovered by re-reading cargo's own summary below rather than by
# ${PIPESTATUS[@]} (a bashism this `#!/bin/sh` script cannot use). A run that
# failed to compile prints no `test result:` line at all and is caught by the
# empty-count branch; a run with failing tests prints `test result: FAILED`,
# which the `ok\.` pattern deliberately does not match.
passed=$(sed -n 's/^test result: ok\. \([0-9][0-9]*\) passed.*/\1/p' "${LOG}" | head -n 1)

if [ -z "${passed}" ]; then
  echo "::error title=${LABEL} did not report a passing run::cargo printed no \`test result: ok.\` line for --features ${FEATURES} --lib ${FILTER}. The suite failed to build, or a test failed — read the log above." >&2
  exit 1
fi

if [ "${passed}" -eq 0 ]; then
  echo "::error title=${LABEL} ran nothing::cargo reported 0 passing tests for --features ${FEATURES} --lib ${FILTER}, so this step is green while asserting nothing. The filter selects no test — it was renamed, moved, or gated away. See issue #770." >&2
  exit 1
fi

echo "${LABEL}: ${passed} passed."
