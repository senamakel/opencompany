// `node --test scripts/release/bump-version.test.mjs`
//
// Runs the bump and the verifier against a copy of the REAL version files, so
// the test breaks when a file grows a shape the regexes no longer match — the
// failure that would otherwise surface inside a release dispatch.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION_FILES, readVersions } from './version-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const bump = path.join(here, 'bump-version.mjs');
const verify = path.join(here, 'verify-version-sync.mjs');

function copyTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bump-'));
  for (const { file } of VERSION_FILES) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  return root;
}

function run(script, args, env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fails(script, args) {
  try {
    run(script, args);
  } catch (e) {
    return String(e.stderr);
  }
  assert.fail(`${path.basename(script)} ${args.join(' ')} should have failed`);
}

test('the checked-in tree agrees with itself', () => {
  const versions = readVersions(repo);
  assert.equal(new Set(Object.values(versions)).size, 1, JSON.stringify(versions));
});

test('patch, minor and major each move every file and only the version lines', () => {
  for (const [type, expect] of [
    ['patch', ([a, b, c]) => `${a}.${b}.${c + 1}`],
    ['minor', ([a, b]) => `${a}.${b + 1}.0`],
    ['major', ([a]) => `${a + 1}.0.0`],
  ]) {
    const root = copyTree();
    const before = readVersions(root);
    const current = Object.values(before)[0];
    const next = expect(current.split('.').map(Number));

    const out = run(bump, [type, '--root', root]);
    assert.equal(out, `version=${next}\ntag=v${next}\nfiles=${VERSION_FILES.map((f) => f.file).join(' ')}\n`);
    assert.deepEqual(new Set(Object.values(readVersions(root))), new Set([next]));
    run(verify, [next, '--root', root]);

    // Only lines that carried the old version changed; nothing was
    // re-serialised. Compare line counts and every unchanged line.
    for (const { file } of VERSION_FILES) {
      const a = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
      const b = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      assert.equal(a.length, b.length, `${file}: line count changed`);
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          assert.ok(a[i].includes(current) && b[i].includes(next), `${file}:${i + 1} changed unexpectedly:\n-${a[i]}\n+${b[i]}`);
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a drifted tree is refused, naming the odd file', () => {
  const root = copyTree();
  const file = 'crates/opencompany-app/Cargo.toml';
  const abs = path.join(root, file);
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(/(\[package\][\s\S]*?^version\s*=\s*")[^"]+/m, '$19.9.9'));
  assert.match(fails(bump, ['patch', '--root', root]), new RegExp(`${file}: 9\\.9\\.9`));
  assert.match(fails(verify, ['--root', root]), new RegExp(`${file}: 9\\.9\\.9`));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the verifier rejects an agreed version that is not the expected one', () => {
  const root = copyTree();
  const current = Object.values(readVersions(root))[0];
  assert.match(fails(verify, ['0.0.0', '--root', root]), new RegExp(`every file says ${current.replace(/\./g, '\\.')}, expected 0\\.0\\.0`));
  fs.rmSync(root, { recursive: true, force: true });
});

test('appends outputs to GITHUB_OUTPUT when set', () => {
  const root = copyTree();
  const outFile = path.join(root, 'gh-output');
  run(bump, ['patch', '--root', root], { GITHUB_OUTPUT: outFile });
  assert.match(fs.readFileSync(outFile, 'utf8'), /^version=\d+\.\d+\.\d+\ntag=v\d+\.\d+\.\d+\nfiles=Cargo\.toml .*\n$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unknown release type is a usage error', () => {
  assert.match(fails(bump, ['huge', '--root', copyTree()]), /Usage: bump-version\.mjs/);
});
