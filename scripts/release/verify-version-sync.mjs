#!/usr/bin/env node
// Fail unless every file that carries the application version agrees.
//
// Usage:
//   node scripts/release/verify-version-sync.mjs [expected-version] [--root <dir>]
//
// With an expected version, every file must say exactly that; without one,
// they must merely all say the same thing. The release workflows run the
// first form right after `bump-version.mjs`, and CI runs the second on every
// PR so a drift is caught at the PR that introduces it rather than at the
// release that trips over it.

import { positional, readVersions, resolveRoot } from './version-files.mjs';

const argv = process.argv.slice(2);
const expected = positional(argv);

const versions = readVersions(resolveRoot(argv));
const unique = [...new Set(Object.values(versions))];
const bad = unique.length !== 1 || (expected !== null && unique[0] !== expected);
if (bad) {
  console.error(
    expected !== null && unique.length === 1
      ? `[verify-version-sync] every file says ${unique[0]}, expected ${expected}`
      : '[verify-version-sync] version mismatch:',
  );
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}: ${version}`);
  process.exit(1);
}
console.log(`[verify-version-sync] OK ${unique[0]}`);
