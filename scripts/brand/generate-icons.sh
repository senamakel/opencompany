#!/usr/bin/env bash
#
# Render every shipped icon from the vector sources in docs/brand/logo/.
#
# The SVGs are the authority; everything under frontend/public/ and
# crates/opencompany-app/icons/ is generated. Re-run this after changing a source rather
# than hand-editing a PNG, so the set cannot drift apart one file at a time.
#
#   scripts/brand/generate-icons.sh
#
# Requires rsvg-convert (`brew install librsvg`). The macOS .icns and the
# desktop .ico come from `cargo tauri icon`; the web .ico is assembled here.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
logo="$root/docs/brand/logo"
public="$root/frontend/public"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
need rsvg-convert
need cargo

# `icon` carries the tile's own 80/350 corner radius and is what a browser tab,
# a Windows taskbar and the .icns artwork all show verbatim. `icon-square` is
# the full-bleed variant for the platforms that apply their own mask — the iOS
# home screen and Android maskable — where a pre-rounded tile gets rounded
# twice and shows dark fringes in the corners.
render() { rsvg-convert -w "$2" -h "$2" "$logo/$1.svg" -o "$3"; }

mkdir -p "$public"

echo "==> frontend/public"
cp "$logo/icon.svg" "$public/favicon.svg"
render icon         96 "$public/favicon-96x96.png"
render icon        192 "$public/web-app-manifest-192x192.png"
render icon        512 "$public/web-app-manifest-512x512.png"
render icon-square 180 "$public/apple-touch-icon.png"
render icon-square 512 "$public/maskable-512x512.png"

# One .ico holding 16/32/48, each frame rendered from the vector at its final
# size rather than downscaled from a bigger raster — that is what keeps the
# 16px frame legible. The container is assembled by hand because Pillow's ICO
# writer resizes from a single base image and silently drops any requested size
# larger than it, which quietly yields a one-frame 16px file.
for s in 16 32 48; do render icon "$s" "$work/ico-$s.png"; done
python3 "$root/scripts/brand/build_ico.py" "$work" "$public/favicon.ico"

echo "==> crates/opencompany-app/icons"
# Everything this script writes is reproducible except icons/icon.icns, which
# `tauri icon` re-encodes to different bytes at the same size on every run. So
# a re-run always shows one 135 KB binary diff even when no source changed —
# that is the tool, not a real change, and it is safe to check out over.
render icon 1024 "$work/tauri-source.png"
(cd "$root" && cargo tauri icon "$work/tauri-source.png" --output crates/opencompany-app/icons)

# `tauri icon` always writes the iOS and Android sets too. This app ships
# desktop only — tauri.conf.json names none of them — so they are thirty-odd
# PNGs that would be committed, reviewed and never read. Delete them here
# rather than leaving each re-run to reintroduce them. If mobile is ever
# targeted, drop these two lines and the sets come back.
rm -rf "$root/crates/opencompany-app/icons/android" "$root/crates/opencompany-app/icons/ios"

echo "done"
