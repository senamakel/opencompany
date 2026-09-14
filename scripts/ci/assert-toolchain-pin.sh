#!/usr/bin/env bash
#
# Fail if any `dtolnay/rust-toolchain` call site in `.github/workflows/`
# installs a toolchain other than the one `rust-toolchain.toml` pins.
#
# Issue #1298. Both used to say `stable`, which is not a version but a promise
# to resolve one later. rustc 1.98.0 shipped on 2026-08-18 carrying a
# newly-enforced `clippy::result_large_err`, every lane picked it up on its next
# run, and every open PR in the repo went red — on diffs that touched no Rust.
# Local checkouts on 1.97.x stayed green, so the first read of it was "CI is
# broken", not "the compiler moved".
#
# Pinning fixes that, but only while the pins agree. Four call sites in `ci.yml`
# and the release workflows each name the version separately, because the
# workflow comment there wants the selection visible to a reader at the call
# site rather than hidden behind an action ref. Five copies of a version is five
# chances to bump four. A partial bump is worse than no bump: the lanes split,
# some lint under the new compiler and some under the old, and which of them is
# authoritative is a question nobody can answer from the diff.
#
# So `rust-toolchain.toml` is the single source of truth and this script is what
# makes the copies obey it. To bump: change `rust-toolchain.toml`, run this
# script, and fix whatever it names.
set -euo pipefail

cd "$(dirname "$0")/../.."

pinned="$(
  sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    rust-toolchain.toml | head -1
)"

if [ -z "$pinned" ]; then
  echo "assert-toolchain-pin: could not read [toolchain].channel from rust-toolchain.toml" >&2
  exit 1
fi

case "$pinned" in
  stable | beta | nightly | *-*)
    echo "assert-toolchain-pin: rust-toolchain.toml pins '$pinned'." >&2
    echo "  Expected an explicit version such as 1.98.0. A floating channel is" >&2
    echo "  what issue #1298 was about: it makes an upstream release red every" >&2
    echo "  open PR at once, with nothing in any diff to explain it." >&2
    exit 1
    ;;
esac

echo "rust-toolchain.toml pins $pinned."

# Every `toolchain:` input in the workflows, with its file and line, so a
# failure names the exact call site to edit.
status=0
found=0
while IFS=: read -r file line value; do
  found=$((found + 1))
  # Strip surrounding quotes and trailing comment/whitespace.
  value="$(printf '%s' "$value" | sed 's/#.*//; s/[[:space:]]*$//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')"
  if [ "$value" = "$pinned" ]; then
    echo "  ok  $file:$line -> $value"
  else
    echo "  BAD $file:$line -> '$value' (rust-toolchain.toml pins '$pinned')" >&2
    status=1
  fi
done < <(
  grep -rn '^[[:space:]]*toolchain:[[:space:]]*' .github/workflows/ \
    | sed 's/^\([^:]*\):\([0-9]*\):[[:space:]]*toolchain:[[:space:]]*/\1:\2:/'
)

# A grep that matches nothing exits 0 and would pass this check silently — the
# same shape of hole `assert-integration-targets-run.sh` exists to close.
if [ "$found" -eq 0 ]; then
  echo "assert-toolchain-pin: found no 'toolchain:' inputs in .github/workflows/." >&2
  echo "  Either the call sites stopped passing one explicitly (see the comment" >&2
  echo "  at the top of ci.yml for why they should), or this script's pattern is" >&2
  echo "  stale. Both need a human." >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  echo >&2
  echo "assert-toolchain-pin: bump every call site to '$pinned', or change" >&2
  echo "  rust-toolchain.toml if the workflows are the ones that are right." >&2
  exit 1
fi

echo "All $found toolchain call site(s) agree with rust-toolchain.toml."
