#!/usr/bin/env bash
# Assemble latest.json — the file every installed desktop client polls.
#
# The Tauri updater fetches the JSON manifest named by `plugins.updater.endpoints`
# in `crates/opencompany-app/tauri.conf.json`, compares its `version` with the running
# application's, and — when it is newer — downloads the entry for this machine's
# platform and verifies it against the signature in the same entry.
#
# The manifest is hosted on the release itself, at
# `https://github.com/<repo>/releases/latest/download/latest.json`, which GitHub
# redirects to the asset on the newest published non-draft release. So a client
# always resolves the current release without anything having to be deployed.
#
# ## It runs before the release is published, and that is load-bearing
#
# This repository has immutable releases enabled: publishing freezes the asset
# list, and nothing can be added afterwards. `build-desktop.yml`
# therefore uploads every DMG and update archive to a DRAFT and publishes it
# last — so this script has to write latest.json into the draft, in the window
# between the builds finishing and the draft going public. A release published
# without it can never be updated *from*, and cannot be fixed in place.
#
# Required environment:
#   TAG          the release tag, e.g. v0.1.0
#   REPO         owner/name on GitHub
#   GH_TOKEN     a token with release write scope
#
# Optional:
#   VERSION      the bare version. Defaults to TAG without its leading `v`, and
#                is asserted against crates/opencompany-app/tauri.conf.json either way — a
#                manifest whose `version` does not match the application inside
#                the archive is an update every client takes and then re-offers.
set -euo pipefail

: "${TAG:?TAG is required, e.g. v0.1.0}"
: "${REPO:?REPO is required, e.g. tinyhumansai/opencompany}"
: "${GH_TOKEN:?GH_TOKEN is required}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="$REPO_ROOT/crates/opencompany-app/tauri.conf.json"

VERSION="${VERSION:-${TAG#v}}"
BUILT_VERSION="$(jq -r '.version' "$CONF")"
if [ "$VERSION" != "$BUILT_VERSION" ]; then
  echo "::error::latest.json would advertise $VERSION but the application in this release is $BUILT_VERSION (crates/opencompany-app/tauri.conf.json). A client would install the update and immediately be offered it again." >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "[updater] Reading the assets on $REPO $TAG"
gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' > "$WORKDIR/assets.txt"

# Find the one asset matching an extended regex. More than one match is an
# ambiguity worth failing on rather than guessing through: two archives for one
# platform means a re-run left a stale asset behind, and picking the wrong one
# ships the wrong build to everybody on that architecture.
find_asset() {
  local pattern="$1" matches count
  matches="$(grep -E "$pattern" "$WORKDIR/assets.txt" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" != "1" ]; then
    echo "[updater] ERROR: pattern '$pattern' matched $count assets on $TAG:" >&2
    printf '  %s\n' $matches >&2
    echo "[updater] Assets on the release:" >&2
    sed 's/^/  /' "$WORKDIR/assets.txt" >&2
    return 1
  fi
  printf '%s' "$matches"
}

# The detached minisign signature, verbatim. `package-updater-artifact.sh`
# produced it beside the archive; the updater compares it against the pubkey
# compiled into the application.
read_signature() {
  local name="$1.sig"
  if ! grep -Fxq "$name" "$WORKDIR/assets.txt"; then
    echo "[updater] ERROR: '$name' is not on the release. The archive was uploaded without its signature, and an entry with no signature is one every client refuses." >&2
    return 1
  fi
  gh release download "$TAG" --repo "$REPO" --pattern "$name" --dir "$WORKDIR" --clobber >&2
  if [ ! -s "$WORKDIR/$name" ]; then
    echo "[updater] ERROR: '$name' downloaded empty" >&2
    return 1
  fi
  cat "$WORKDIR/$name"
}

# The platform keys the updater looks itself up under. macOS only, because
# `build-desktop.yml` is the only desktop release path there is — a
# Windows or Linux client would find no entry for its target and report no
# update, which is the honest answer while no such build is published.
# See docs/spec/runtime/desktop-updates.md.
MAC_AARCH64="$(find_asset '^OpenCompany_.*_aarch64\.app\.tar\.gz$')"
MAC_X86_64="$(find_asset '^OpenCompany_.*_x64\.app\.tar\.gz$')"

MANIFEST="$WORKDIR/latest.json"
jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")" \
  --arg notes "See https://github.com/$REPO/releases/tag/$TAG" \
  '{version: $version, notes: $notes, pub_date: $pub_date, platforms: {}}' > "$MANIFEST"

add_platform() {
  local key="$1" name="$2" signature url
  signature="$(read_signature "$name")"
  url="https://github.com/$REPO/releases/download/$TAG/$name"
  jq --arg key "$key" --arg signature "$signature" --arg url "$url" \
    '.platforms[$key] = {signature: $signature, url: $url}' "$MANIFEST" > "$MANIFEST.next"
  mv "$MANIFEST.next" "$MANIFEST"
  echo "[updater] + $key → $name"
}

add_platform "darwin-aarch64" "$MAC_AARCH64"
add_platform "darwin-x86_64" "$MAC_X86_64"

# Both architectures or nothing. A manifest carrying only Apple Silicon leaves
# every Intel client silently pinned to the build it already has, with no error
# anywhere — the failure this whole feature exists to remove, reintroduced by a
# half-finished matrix.
MISSING="$(jq -r '["darwin-aarch64","darwin-x86_64"] - (.platforms | keys) | join(", ")' "$MANIFEST")"
if [ -n "$MISSING" ]; then
  echo "::error::latest.json is missing platform(s): $MISSING. Refusing to publish a partial manifest." >&2
  exit 1
fi

echo "[updater] The manifest:"
jq '.platforms |= map_values({url})' "$MANIFEST"

gh release upload "$TAG" "$MANIFEST" --repo "$REPO" --clobber
echo "[updater] Uploaded latest.json to $TAG"
