// The one list of every file that carries the application version, shared by
// `bump-version.mjs` (which writes it) and `verify-version-sync.mjs` (which
// checks it). Keeping the list in one module is the point: v0.1.5 shipped with
// `crates/opencompany-app/Cargo.toml` still saying 0.1.4 because the hand bump
// that cut it edited five files and the desktop shell's manifest was a sixth.
// A script that reads its list from here cannot skip one.
//
// Each entry knows how to read the version out of its file and how to write a
// new one back WITHOUT re-serialising the file — a `JSON.stringify` round trip
// would reorder nothing but could change indentation or the trailing newline,
// and the release commit should diff as exactly the version lines it changed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The root `Cargo.toml` — `[workspace.package].version`, inherited by
 *  `opencompany-core` and `opencompany-tui` via `version.workspace = true`. */
function cargoWorkspaceVersion(rel) {
  const re = /(\[workspace\.package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
  return {
    file: rel,
    read: (root) => matchOne(root, rel, re),
    write: (root, next) => replaceOne(root, rel, re, next),
  };
}

/** A crate with its own `[package].version` — the desktop shell, which is
 *  excluded from the root workspace and so cannot inherit. */
function cargoPackageVersion(rel) {
  const re = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
  return {
    file: rel,
    read: (root) => matchOne(root, rel, re),
    write: (root, next) => replaceOne(root, rel, re, next),
  };
}

/** The top-level `"version"` of a JSON document (`tauri.conf.json`,
 *  `package.json`). Matched at two-space indentation so a nested dependency
 *  version can never be picked up instead. */
function jsonTopLevelVersion(rel) {
  const re = /(^ {2}"version":\s*")([^"]+)(")/m;
  return {
    file: rel,
    read: (root) => matchOne(root, rel, re),
    write: (root, next) => replaceOne(root, rel, re, next),
  };
}

/** `package-lock.json` records the root version twice: at the top level and
 *  under `packages[""]`. `npm ci` refuses a lock whose root disagrees with
 *  `package.json`, so both have to move with it. */
function packageLockVersion(rel) {
  const top = /(^ {2}"version":\s*")([^"]+)(")/m;
  const nested = /(^ {4}"":\s*\{\s*\n(?:[^\n]*\n)*? {6}"version":\s*")([^"]+)(")/m;
  return {
    file: rel,
    read: (root) => {
      const a = matchOne(root, rel, top);
      const b = matchOne(root, rel, nested);
      if (a !== b) {
        throw new Error(`${rel}: top-level version ${a} disagrees with packages[""].version ${b}`);
      }
      return a;
    },
    write: (root, next) => {
      replaceOne(root, rel, top, next);
      replaceOne(root, rel, nested, next);
    },
  };
}

/** A `Cargo.lock` carries one `[[package]]` block per crate. The named
 *  first-party crates are the ones whose version follows the manifests; a
 *  build with `--locked` fails if the lock still names the old one. Patching
 *  the block textually is exactly the edit `cargo update --workspace` makes,
 *  without needing a toolchain or the vendored submodules in the job that
 *  cuts the version. */
function cargoLockVersions(rel, crates) {
  const blockFor = (crate) =>
    new RegExp(`(^\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"]+)(")`, 'm');
  return {
    file: rel,
    read: (root) => {
      const seen = crates.map((crate) => matchOne(root, rel, blockFor(crate), crate));
      const unique = [...new Set(seen)];
      if (unique.length !== 1) {
        throw new Error(`${rel}: first-party crates disagree: ${crates.map((c, i) => `${c}=${seen[i]}`).join(', ')}`);
      }
      return unique[0];
    },
    write: (root, next) => {
      for (const crate of crates) replaceOne(root, rel, blockFor(crate), next, crate);
    },
  };
}

function matchOne(root, rel, re, what = 'version') {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const m = text.match(re);
  if (!m) throw new Error(`${rel}: could not find ${what}`);
  if (!SEMVER.test(m[2])) throw new Error(`${rel}: ${what} "${m[2]}" is not SemVer X.Y.Z`);
  return m[2];
}

function replaceOne(root, rel, re, next, what = 'version') {
  const abs = path.join(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  if (!re.test(text)) throw new Error(`${rel}: could not find ${what} to replace`);
  fs.writeFileSync(abs, text.replace(re, `$1${next}$3`));
}

/** Every version-bearing file, in the order the release commit lists them. */
export const VERSION_FILES = [
  cargoWorkspaceVersion('Cargo.toml'),
  cargoLockVersions('Cargo.lock', ['opencompany-core', 'opencompany-tui']),
  cargoPackageVersion('crates/opencompany-app/Cargo.toml'),
  cargoLockVersions('crates/opencompany-app/Cargo.lock', ['opencompany-app', 'opencompany-core']),
  jsonTopLevelVersion('crates/opencompany-app/tauri.conf.json'),
  jsonTopLevelVersion('frontend/package.json'),
  packageLockVersion('frontend/package-lock.json'),
];

/** Read every file's version. Returns `{ [file]: version }`. */
export function readVersions(root) {
  const out = {};
  for (const entry of VERSION_FILES) out[entry.file] = entry.read(root);
  return out;
}

/** Write `next` into every file. */
export function writeVersions(root, next) {
  if (!SEMVER.test(next)) throw new Error(`refusing to write non-SemVer version "${next}"`);
  for (const entry of VERSION_FILES) entry.write(root, next);
}

/** The first positional argument (not a flag, not a flag's value), or null. */
export function positional(argv) {
  return argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root') ?? null;
}

/** `--root <dir>` from argv, else the repository root this script lives in. */
export function resolveRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1) {
    const dir = argv[i + 1];
    if (!dir) throw new Error('--root needs a directory');
    return path.resolve(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
