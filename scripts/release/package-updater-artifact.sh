#!/usr/bin/env bash
# Build and sign the archive the auto-updater actually downloads.
#
# The DMG is for a person doing a fresh install. It is not what the updater
# consumes: on macOS Tauri replaces the `.app` bundle in place, out of a gzipped
# tarball with a detached minisign signature beside it. Without these two files
# on the release, `latest.json` has nothing to point at and an installed client
# has no way to move.
#
# ## Why this is not `bundle.createUpdaterArtifacts`
#
# Tauri's bundler can emit the tarball during `tauri build`. It would emit it
# from the UNSIGNED `.app`, because signing and notarization happen after the
# bundler runs — so the updater would ship an application bundle carrying no
# Developer ID and no notarization ticket, and Gatekeeper would refuse to launch
# what the update had just installed. Every user who took an update would be
# left with a broken application and no obvious way back.
#
# Building the tarball here, after `xcrun stapler validate` has passed, means
# what the updater installs is byte-for-byte the bundle Apple notarized. It also
# keeps the signing key out of the compile step: it is needed for one `signer
# sign` invocation rather than for every `tauri build`.
#
# Usage:
#   package-updater-artifact.sh <app_path> <target_triple> <out_dir>
#
# Required environment:
#   TAURI_SIGNING_PRIVATE_KEY            the minisign secret key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   its passphrase, if it has one
#
# Writes, into <out_dir>:
#   OpenCompany_<version>_<arch>.app.tar.gz
#   OpenCompany_<version>_<arch>.app.tar.gz.sig
#
# Prints exactly two lines on stdout — `archive=<path>` and `signature=<path>` —
# so the caller can append them straight to $GITHUB_OUTPUT. Everything else
# it has to say goes to stderr, because a stray log line in that file is a
# malformed-output error rather than a comment.
set -euo pipefail

APP_PATH="${1:?Usage: package-updater-artifact.sh <app_path> <target_triple> <out_dir>}"
TARGET="${2:?}"
OUT_DIR="${3:?}"

: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required to sign the update archive}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF="$REPO_ROOT/crates/opencompany-app/tauri.conf.json"
TAURI_CLI="$REPO_ROOT/frontend/node_modules/.bin/tauri"

if [ ! -x "$TAURI_CLI" ]; then
  echo "[updater] ERROR: the Tauri CLI is not at $TAURI_CLI — run \`npm ci\` in frontend/ first" >&2
  exit 1
fi

VERSION="$(jq -r '.version' "$CONF")"
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "[updater] ERROR: no .version in $CONF" >&2
  exit 1
fi

# The arch word in the filename. Matches the one Tauri puts in the DMG name for
# the same target, so a release's assets read consistently — and, more to the
# point, so `publish-updater-manifest.sh` can find this file by pattern.
case "$TARGET" in
  aarch64-apple-darwin) ARCH="aarch64" ;;
  x86_64-apple-darwin) ARCH="x64" ;;
  *)
    echo "[updater] ERROR: no updater archive naming for target '$TARGET'." >&2
    echo "[updater] Only macOS is wired end to end today — see docs/spec/runtime/desktop-updates.md." >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="$OUT_DIR_ABS/OpenCompany_${VERSION}_${ARCH}.app.tar.gz"

APP_DIR="$(cd "$(dirname "$APP_PATH")" && pwd)"
APP_NAME="$(basename "$APP_PATH")"

# `-C` so the archive holds `OpenCompany.app/…` at the top level and nothing
# above it. The updater extracts it over the installed bundle's parent
# directory, so a leading `./target/release/bundle/macos/` would unpack the
# application into a directory tree nobody asked for.
#
# `COPYFILE_DISABLE` keeps macOS `tar` from writing `._` AppleDouble members for
# extended attributes. They are noise in the archive and, on extraction, litter
# the installed bundle with files that were not in the notarized one.
echo "[updater] Archiving $APP_NAME for $ARCH (version $VERSION)" >&2
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$APP_DIR" "$APP_NAME"

echo "[updater] Signing $(basename "$ARCHIVE")" >&2
"$TAURI_CLI" signer sign "$ARCHIVE" >&2

SIGNATURE="$ARCHIVE.sig"
if [ ! -s "$SIGNATURE" ]; then
  echo "[updater] ERROR: the signer produced no signature at $SIGNATURE" >&2
  exit 1
fi

echo "[updater] Built $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1)) and its signature" >&2
echo "archive=$ARCHIVE"
echo "signature=$SIGNATURE"
