#!/usr/bin/env bash
# Refuse to cut a desktop release that the auto-updater cannot use.
#
# The updater has two halves that must agree, and they live in different places
# on purpose: the minisign PUBLIC key is committed in
# `crates/opencompany-app/tauri.conf.json`, and the PRIVATE key is a GitHub Actions secret
# that is not in this repository and must never be. Nothing in Tauri checks
# either one at build time — `plugins.updater.pubkey` is read as an opaque
# string and only parsed when a downloaded bundle is verified, on somebody
# else's machine, after they have already spent 100 MB of their bandwidth.
#
# So this is the loud half. `crates/opencompany-app/src/update.rs` makes a build carrying the
# placeholder key *silent* — it reports no update rather than offering one it
# could never verify — and this script makes shipping that build *impossible*.
# Between them, the failure mode is a red release job rather than an error
# banner in front of every user.
#
# Usage:
#   assert-updater-configured.sh [tauri.conf.json]
#
# Required environment:
#   TAURI_SIGNING_PRIVATE_KEY   the minisign secret key, from the release secret
#
# Optional:
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   set only if the key was generated with
#                                        a passphrase; not checked here, because
#                                        an unprotected key legitimately has none
#
# Setting the keypair up is one command and two paste operations; see
# `docs/spec/runtime/desktop-updates.md`.
set -euo pipefail

CONF="${1:-crates/opencompany-app/tauri.conf.json}"

if [ ! -f "$CONF" ]; then
  echo "::error::assert-updater-configured: $CONF not found (run from the repository root)" >&2
  exit 1
fi

# The updater block has to exist at all. Without it the plugin has no endpoint
# to check and the shipped application silently never updates.
PUBKEY="$(jq -r '.plugins.updater.pubkey // ""' "$CONF")"
ENDPOINTS="$(jq -r '.plugins.updater.endpoints // [] | length' "$CONF")"

if [ "$ENDPOINTS" = "0" ]; then
  echo "::error::$CONF declares no plugins.updater.endpoints, so the shipped application would never learn that this release exists." >&2
  exit 1
fi

# Tauri stores the pubkey as base64 of the whole minisign public-key FILE, whose
# first line is always `untrusted comment: …`. `dW50cnVzdGVkIGNvbW1lbnQ6` is the
# base64 of `untrusted comment:`, so a key that does not start with it is not a
# minisign public key — which is exactly what the committed placeholder is not.
#
# The same prefix is the test in `crates/opencompany-app/src/update.rs::is_configured`, and a
# unit test there asserts the committed config still fails it. The two agree by
# construction: this script says "not yet", that one says "still not".
case "$PUBKEY" in
  dW50cnVzdGVkIGNvbW1lbnQ6*) ;;
  *)
    cat >&2 <<EOF
::error::$CONF still carries the updater placeholder public key, so this release would ship an application whose updates can never verify.

  Generate the keypair once, on a trusted machine:

      cd frontend && ./node_modules/.bin/tauri signer generate -w ~/.tauri/opencompany.key

  Put the PUBLIC key it prints into plugins.updater.pubkey in $CONF, and the
  PRIVATE key into the TAURI_SIGNING_PRIVATE_KEY repository secret — never into
  a file in this repository. Full steps, and what to verify afterwards, are in
  docs/spec/runtime/desktop-updates.md.
EOF
    exit 1
    ;;
esac

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "::error::TAURI_SIGNING_PRIVATE_KEY is not set, so the update artifacts cannot be signed and the release would carry a latest.json nothing can verify. Add it as a repository secret — see docs/spec/runtime/desktop-updates.md." >&2
  exit 1
fi

echo "[updater] $CONF carries a minisign public key and a signing secret is present."
