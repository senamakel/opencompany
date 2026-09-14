#!/usr/bin/env bash
# Merge the release checkout's HEAD back into main and push.
#
# Usage: merge-release-into-main.sh <merge-commit-message>
#
# `release-staging.yml` (when cut from `release`) and `release-production.yml`
# call this right after the version-bump commit and tag land on `release`, so
# main carries the bump and any fix commits that were opened against
# `release`. Without it main's version falls behind the last release, and the
# next `promote-main-to-release.yml` would merge an OLDER version number
# forward — the bump script then refuses the drift, and rightly.
#
# Fast-forward when possible: if main has not moved since the promotion cut,
# main == release afterwards and the next promotion sees nothing to do.
# Otherwise a `--no-ff` merge commit with the given message. A conflict exits 1
# with a warning; callers keep `continue-on-error` so a conflicted back-merge
# never strands a release that is already tagged — resolve it by hand.
#
# Expects `origin` to be authenticated for a push to main. A push made with the
# default GITHUB_TOKEN does not trigger `push` workflows (GitHub's recursion
# guard), which is fine here: everything in the merge already ran CI on the
# PR that introduced it, and the bump commit changes version numbers only.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <merge-commit-message>" >&2
  exit 2
fi
MERGE_MESSAGE="$1"

log() { echo "[release][back-merge] $*"; }

RELEASE_SHA="$(git rev-parse HEAD)"
log "merging release ($RELEASE_SHA) back into main"
git fetch origin main
git checkout -B main origin/main
if git merge --ff-only "$RELEASE_SHA" 2>/dev/null; then
  git push origin HEAD:main
  log "fast-forwarded main to $RELEASE_SHA"
elif git merge --no-ff "$RELEASE_SHA" -m "$MERGE_MESSAGE"; then
  git push origin HEAD:main
  log "merged $RELEASE_SHA into main (merge commit)"
else
  git merge --abort || true
  echo "::warning::Automatic release→main back-merge hit conflicts. Merge branch 'release' into 'main' by hand."
  exit 1
fi
