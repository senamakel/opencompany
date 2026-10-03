// Self-test for the CI lane flow: scripts/ci/lanes/{lanes-plan,lanes}.mjs (run
// by ci-fast.yml / ci-fast-hosted.yml through ci-lanes.yml). Pure where it can
// be; the runner tests spawn only `true`, `false`, `echo` and `sleep`.
// Run: node --test scripts/ci/lanes/lanes.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AREA_ENV,
  HOSTED_GROUPS,
  areasFromEnv,
  buildPlan,
  hostedMatrix,
  selectLanes,
  validatePlan,
} from "./lanes-plan.mjs";
import {
  PrioritySemaphore,
  Runner,
  buildEnv,
  defaultHeavySlots,
  expandEnvValue,
  foldLine,
  gatingFailures,
  orderProblems,
  parseArgs,
  processTable,
  renderSummary,
  treeRssMiB,
} from "./lanes.mjs";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const ALL = Object.fromEntries(Object.keys(AREA_ENV).map((k) => [k, true]));
const NONE = Object.fromEntries(Object.keys(AREA_ENV).map((k) => [k, false]));
const EX63_ENV = { CI_SCRATCH_DIR: "/scratch" };

const plans = (areas = ALL) => [
  buildPlan({ profile: "ex63", areas, env: EX63_ENV }),
  buildPlan({ profile: "hosted", areas }),
];
const allRuns = (plan) => plan.lanes.flatMap((l) => l.checks.map((c) => c.run));
const on = (plan) =>
  plan.lanes.flatMap((l) =>
    l.checks.filter((c) => c.when).map((c) => `${l.name}:${c.name}`),
  );

test("both profiles build a plan whose dependencies resolve and cannot deadlock", () => {
  for (const plan of plans()) {
    assert.deepEqual(validatePlan(plan), [], plan.profile);
    assert.deepEqual(orderProblems(plan), [], plan.profile);
  }
});

test("every hosted group resolves on its own, and every lane has exactly one group", () => {
  const plan = buildPlan({ profile: "hosted", areas: ALL });
  for (const g of HOSTED_GROUPS) {
    const sub = selectLanes(plan, g.lanes);
    assert.deepEqual(validatePlan(sub), [], g.group);
    assert.deepEqual(orderProblems(sub), [], g.group);
  }
  const grouped = HOSTED_GROUPS.flatMap((g) => g.lanes).sort();
  assert.deepEqual(grouped, plan.lanes.map((l) => l.name).sort());
});

test("commands are static: no suite is ever narrowed to the diff", () => {
  for (const plan of plans()) {
    for (const run of allRuns(plan)) {
      assert.doesNotMatch(
        run,
        /\$\{\{|CI_AREA_|git diff|CHANGED|--changed|\brelated\b|--test-files/,
        run,
      );
    }
  }
});

test("both profiles run the same checks; only how they run differs", () => {
  // The EX63 shares one checkout across lanes, so the hosted-only frontend
  // installs fold into the console lane there. Everything else is identical.
  const hostedOnly = /:(npm-ci|console-build)$/;
  const [ex63, hosted] = plans().map((p) => on(p));
  const strip = (ids) => ids.filter((id) => !hostedOnly.test(id) || id.startsWith("console:"));
  assert.deepEqual(strip(ex63).sort(), strip(hosted).sort());
});

test("every step the old ci.yml ran on a Rust change is still in the plan", () => {
  const runs = allRuns(buildPlan({ profile: "hosted", areas: ALL })).join("\n");
  for (const needle of [
    "cargo fmt --all -- --check",
    "cargo clippy --locked --all-targets -- -D warnings",
    "cargo test --locked\n",
    "--features sqlite --lib store::sqlite",
    "--features openhuman --all-targets",
    "--features openhuman --tests",
    "--features openhuman,mcp,composio --bin opencompany",
    "--bin opencompany\n",
    "--test offline_e2e",
    "cargo check --locked --all-features --all-targets",
    "--features tinyplace --lib",
    "--features webhooks --lib server::webhook",
    "-p opencompany-tui --features harness --lib",
    "-p opencompany-tui --features sqlite --lib",
    "scripts/ci/assert-integration-targets-run.sh openhuman",
    "scripts/ci/assert-auth-matrix.sh",
    "scripts/ci/assert-feature-lanes.sh",
    "scripts/ci/assert-toolchain-pin.sh",
    "npm run e2e && npm run e2e:analytics",
    "npm run e2e:live",
    "scripts/ci/assert-e2e-spec-ran.sh",
    "tauri build --debug --no-bundle",
  ]) {
    assert.ok(`${runs}\n`.includes(needle), needle);
  }
});

test("untouched areas leave only the always-on static checks", () => {
  for (const plan of plans(NONE)) {
    const ids = on(plan);
    assert.ok(ids.length > 0);
    for (const id of ids) assert.match(id, /^static:/, plan.profile);
  }
});

test("a frontend-only change builds the binaries e2e needs and runs no Rust suite", () => {
  const areas = { ...NONE, frontend: true };
  const ids = on(buildPlan({ profile: "hosted", areas }));
  assert.ok(ids.includes("core:host-binary"));
  assert.ok(ids.includes("gated:gated-binary"));
  assert.ok(ids.includes("e2e:e2e"));
  assert.ok(ids.includes("desktop:package-from-root"));
  assert.ok(!ids.includes("core:test"));
  assert.ok(!ids.includes("gated:test-openhuman"));
});

test("a desktop-only change runs the desktop lane and nothing heavy besides it", () => {
  const areas = { ...NONE, desktop: true };
  const ids = on(buildPlan({ profile: "hosted", areas }));
  assert.ok(ids.includes("desktop:clippy"));
  assert.ok(!ids.some((id) => /^(core|gated|e2e)/.test(id)));
});

test("hosted matrix only spins up groups with active lanes", () => {
  const all = hostedMatrix(buildPlan({ profile: "hosted", areas: ALL }));
  assert.deepEqual(
    all.map((g) => g.group),
    HOSTED_GROUPS.map((g) => g.group),
  );
  const none = hostedMatrix(buildPlan({ profile: "hosted", areas: NONE }));
  assert.deepEqual(none, [{ group: "checks", lanes: "static", "max-parallel": 2 }]);
});

test("ex63 needs a scratch dir and gives every Rust lane its own target dir and sccache", () => {
  assert.throws(() => buildPlan({ profile: "ex63", areas: ALL }), /CI_SCRATCH_DIR/);
  const plan = buildPlan({ profile: "ex63", areas: ALL, env: EX63_ENV });
  const rustLanes = plan.lanes.filter((l) => l.heavy != null);
  assert.deepEqual(rustLanes.map((l) => l.name).sort(), ["core", "desktop", "gated"]);
  const dirs = rustLanes.map((l) => l.targetDir);
  assert.equal(new Set(dirs).size, dirs.length);
  for (const l of rustLanes) {
    assert.ok(l.targetDir.startsWith("/scratch/target/"), l.name);
    assert.equal(l.env.RUSTC_WRAPPER, "sccache", l.name);
  }
  // Hosted: cargo's own target dir (rust-cache restores it), no sccache —
  // OpenHuman measured 0% extra hits for it under a warm rust-cache (#4721).
  for (const l of buildPlan({ profile: "hosted", areas: ALL }).lanes) {
    assert.equal(l.targetDir ?? null, null, l.name);
    assert.equal(l.env?.RUSTC_WRAPPER, undefined, l.name);
  }
});

test("ex63 never needs sudo or apt; hosted keeps them", () => {
  const ex63 = allRuns(buildPlan({ profile: "ex63", areas: ALL, env: EX63_ENV })).join("\n");
  assert.doesNotMatch(ex63, /\bsudo\b|--with-deps|apt-get/);
  assert.match(ex63, /unshare --user --map-root-user --net/);
  const hosted = allRuns(buildPlan({ profile: "hosted", areas: ALL })).join("\n");
  assert.match(hosted, /sudo --preserve-env=\S+ unshare --net/);
});

test("ex63 serialises the two e2e suites: they share one checkout's host port", () => {
  const plan = buildPlan({ profile: "ex63", areas: ALL, env: EX63_ENV });
  const live = plan.lanes.find((l) => l.name === "e2e-live");
  const check = live.checks.find((c) => c.name === "e2e-live");
  assert.deepEqual(check.after, ["e2e:e2e-first-run"]);
  // ...by ordering only: a red e2e must not hide the live-brain result.
  assert.ok(!check.needs.includes("e2e:e2e-first-run"));
});

test("e2e runs the binary copied out of the target dir, never target/debug", () => {
  for (const plan of plans()) {
    const lane = (n) => plan.lanes.find((l) => l.name === n);
    assert.equal(lane("e2e").env.PW_HOST_BINARY, "${ROOT}/ci-out/bin/opencompany");
    assert.equal(lane("e2e-live").env.PW_HOST_BINARY, "${ROOT}/ci-out/bin/opencompany-gated");
    const hostBin = lane("core").checks.find((c) => c.name === "host-binary");
    assert.match(hostBin.run, /cp "\$\{CARGO_TARGET_DIR:-target\}\/debug\/opencompany" ci-out\/bin\/opencompany$/);
  }
});

test("assert-feature-lanes.sh reads the plan, and the plan has the bare default test", () => {
  const script = read("scripts/ci/assert-feature-lanes.sh");
  assert.match(script, /scripts\/ci\/lanes\/lanes-plan\.mjs/);
  assert.match(read("scripts/ci/lanes/lanes-plan.mjs"), /run: "cargo test --locked" \}/);
});

test("every lane the plan can start has a step in BOTH ci-lanes.yml lane jobs", () => {
  // One `Lane:` step in the ex63 job and one in the hosted `lanes` job: a lane
  // missing from either runs in the background with no step reporting it.
  const yml = read(".github/workflows/ci-lanes.yml");
  const job = (start, end) => yml.slice(yml.indexOf(start), yml.indexOf(end));
  const jobs = {
    ex63: job("\n  ex63:\n", "\n  lanes:\n"),
    hosted: job("\n  lanes:\n", "\n  services-mail:\n"),
  };
  for (const [name, body] of Object.entries(jobs)) {
    assert.ok(body.length > 0, `${name} job not found in ci-lanes.yml`);
    for (const lane of buildPlan({ profile: "hosted", areas: ALL }).lanes) {
      const wait = new RegExp(`lanes\\.mjs --wait ${lane.name}(?![\\w-])`, "g");
      assert.equal((body.match(wait) ?? []).length, 1, `${name}: ${lane.name}`);
    }
  }
});

test("area flags are read strictly from CI_AREA_*", () => {
  assert.deepEqual(areasFromEnv({ CI_AREA_RUST: "true", CI_AREA_FRONTEND: "1" }), {
    rust: true,
    frontend: false,
    desktop: false,
  });
});

test("argument parsing", () => {
  assert.deepEqual(
    parseArgs(["--profile", "hosted", "--lanes", "core, e2e", "--max-parallel", "2"]),
    {
      profile: "hosted",
      lanes: ["core", "e2e"],
      maxParallel: 2,
      out: "ci-out",
      dryRun: false,
      printMatrix: false,
      detach: false,
      wait: null,
      waitAll: false,
    },
  );
  assert.equal(parseArgs(["--wait", "core"]).wait, "core");
  assert.throws(() => parseArgs([]), /--profile is required/);
  assert.throws(() => parseArgs(["--profile"]), /needs a value/);
});

test("env values expand ${NAME}, ${NAME:-default} and ${ROOT}, layer by layer", () => {
  assert.equal(expandEnvValue("${CI_CACHE_DIR:-/cache}/npm", {}), "/cache/npm");
  assert.equal(expandEnvValue("${CI_CACHE_DIR:-/cache}/npm", { CI_CACHE_DIR: "/c" }), "/c/npm");
  assert.equal(expandEnvValue("${ROOT}/ci-out", {}, "/repo"), "/repo/ci-out");
  assert.equal(expandEnvValue("${UNSET}x", {}), "x");
  const env = buildEnv({ A: "1" }, { B: "${A}2" }, { C: "${B}3" });
  assert.equal(env.C, "123");
});

const stubPlan = () => ({
  profile: "hosted",
  lanes: [
    {
      name: "a",
      active: true,
      checks: [
        { name: "fails", when: true, run: "false", needs: [], after: [] },
        { name: "still-runs", when: true, run: "echo ran", needs: [], after: [] },
        { name: "needs-failed", when: true, run: "true", needs: ["fails"], after: [] },
        { name: "report-only", when: true, run: "false", needs: [], after: [], reportOnly: true },
        { name: "off", when: false, run: "false", needs: [], after: [] },
      ],
    },
    {
      name: "b",
      active: true,
      checks: [
        { name: "waits-on-a", when: true, run: "true", needs: ["a:still-runs"], after: [] },
        { name: "after-a-failure", when: true, run: "true", needs: [], after: ["a:fails"] },
      ],
    },
  ],
});

test("runner: a failure never stops later checks, blocks its dependants, and gates the run", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "oc-lanes-"));
  fs.mkdirSync(path.join(out, "logs"));
  try {
    const lanes = await new Runner(stubPlan(), { out, maxParallel: 0 }).run();
    const status = Object.fromEntries(
      lanes.flatMap((l) => l.checks.map((c) => [`${l.name}:${c.name}`, c.status])),
    );
    assert.deepEqual(status, {
      "a:fails": "failure",
      "a:still-runs": "success",
      "a:needs-failed": "blocked",
      "a:report-only": "failure",
      "a:off": "skipped",
      "b:waits-on-a": "success",
      // `after` orders without requiring success.
      "b:after-a-failure": "success",
    });
    assert.deepEqual(gatingFailures({ lanes }), ["a:fails", "a:needs-failed"]);
    assert.match(fs.readFileSync(path.join(out, "logs", "a.log"), "utf8"), /ran/);
    const summary = renderSummary({ lanes });
    assert.match(summary, /\| a \| report-only \| failure \(report-only\) \|/);
    assert.match(summary, /\| a \| needs-failed \| blocked \|/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("step-per-lane log folding: one group per check", () => {
  const state = { open: false };
  assert.equal(foldLine("[ci][lanes] ===== clippy =====", state), "::group::clippy");
  assert.equal(foldLine("warning: x", state), "warning: x");
  assert.equal(
    foldLine("[ci][lanes] clippy: success (exit 0, 3s)", state),
    "[ci][lanes] clippy: success (exit 0, 3s)\n::endgroup::",
  );
  assert.equal(state.open, false);
});

test("heavy-compile slots: priority order, FIFO within a priority, sized from RAM", async () => {
  const sem = new PrioritySemaphore(1);
  const order = [];
  await sem.acquire(5);
  const waits = [
    sem.acquire(2).then(() => order.push("desktop")),
    sem.acquire(1).then(() => order.push("core")),
    sem.acquire(0).then(() => order.push("gated")),
  ];
  for (let i = 0; i < 3; i++) {
    sem.release();
    await new Promise((r) => setImmediate(r));
  }
  sem.release();
  await Promise.all(waits);
  assert.deepEqual(order, ["gated", "core", "desktop"]);
  assert.equal(defaultHeavySlots(28 * 1024), 3);
  assert.equal(defaultHeavySlots(4 * 1024), 1);
});

test("peak RSS follows the process tree, including setsid'd descendants", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-proc-"));
  const stat = (pid, ppid, pages) => {
    fs.mkdirSync(path.join(dir, String(pid)));
    const fields = ["S", ppid, pid, ...Array(18).fill(0), pages];
    fs.writeFileSync(path.join(dir, String(pid), "stat"), `${pid} (cargo (x) y) ${fields.join(" ")}\n`);
  };
  stat(100, 1, 256);
  stat(101, 100, 512);
  stat(102, 101, 1024 * 256);
  stat(200, 1, 1024 * 256);
  fs.mkdirSync(path.join(dir, "self"));
  try {
    const table = processTable(dir);
    assert.equal(table.size, 4);
    assert.equal(treeRssMiB(table, 100), 1 + 2 + 1024);
    assert.equal(treeRssMiB(table, 999), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
