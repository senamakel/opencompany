#!/usr/bin/env node
// Bump the application version in every file that carries it.
//
// Usage:
//   node scripts/release/bump-version.mjs <patch|minor|major> [--root <dir>]
//
// Prints, one per line, and appends the same to $GITHUB_OUTPUT when set:
//   version=X.Y.Z
//   tag=vX.Y.Z
//   files=<every file it wrote, space-separated>
//
// `files` is what the workflows `git add`, so the staged set can never drift
// from the written set — the list lives in `version-files.mjs` and nowhere else.
//
// The files are the list in `version-files.mjs`; this script owns no copy of
// it. The current version is read from ALL of them and must agree — a bump on
// top of a drift would carry the drift forward as a bigger one — so a tree
// like the one v0.1.5 was cut from (five files at 0.1.5, the desktop manifest
// at 0.1.4) fails here, naming the odd file out, rather than shipping.

import fs from 'node:fs';
import { VERSION_FILES, positional, readVersions, resolveRoot, writeVersions } from './version-files.mjs';

const argv = process.argv.slice(2);
const releaseType = positional(argv);
const allowed = new Set(['patch', 'minor', 'major']);
if (!allowed.has(releaseType)) {
  console.error(`Usage: bump-version.mjs <patch|minor|major> [--root <dir>]  (got: "${releaseType}")`);
  process.exit(2);
}

const root = resolveRoot(argv);
const versions = readVersions(root);
const unique = [...new Set(Object.values(versions))];
if (unique.length !== 1) {
  console.error('[bump-version] the tree does not agree on its current version; fix that first:');
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}: ${version}`);
  process.exit(1);
}

const [major, minor, patch] = unique[0].split('.').map(Number);
const next =
  releaseType === 'major' ? `${major + 1}.0.0`
  : releaseType === 'minor' ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

writeVersions(root, next);

const lines = `version=${next}\ntag=v${next}\nfiles=${VERSION_FILES.map((f) => f.file).join(' ')}\n`;
process.stdout.write(lines);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
console.error(`[bump-version] ${unique[0]} → ${next}`);
