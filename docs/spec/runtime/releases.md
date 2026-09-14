# Cutting a release

Three workflows, dispatched in order, each with one decision to make. The
version is computed from the tree by the workflow; nobody types a tag.

```text
main ──promote──▶ release ──staging cut──▶ v0.2.4-staging   (artifacts, no Release)
                     │
                     └──production cut──▶ v0.2.5           (GitHub Release + DMGs + latest.json)
                                              │
                                              └── merged back into main
```

| Workflow | Dispatch from | The one decision | Produces |
|---|---|---|---|
| **Promote main to release** (`promote-main-to-release.yml`) | `main` | — | a merge commit on `release`, and a CI run for it |
| **Release Staging** (`release-staging.yml`) | `main` or `release` | which branch | tag `v<X.Y.Z>-staging`, signed DMGs as Actions artifacts, a throw-away Docker build |
| **Release Production** (`release-production.yml`) | `release` | `release_type`: patch / minor / major | tag `v<X.Y.Z>`, a published GitHub Release carrying both DMGs, both updater archives and `latest.json` |

Every cut bumps every version file, commits `chore(release): vX.Y.Z [skip ci]`
(or `chore(staging): …`) to the branch it was cut from, tags that commit, and
builds **the tag** — never the branch head, which may have moved by the time a
build starts. A cut from `release` is merged back into `main` at the end, so
`main`'s version never falls behind the last release.

## Day to day

```bash
# 1. Snapshot main into release. Re-running is a no-op when release already has main.
gh workflow run promote-main-to-release.yml --ref main -R tinyhumansai/opencompany

# 2. Optional: a staging build for testers, from release (or from main).
gh workflow run release-staging.yml --ref release -R tinyhumansai/opencompany

# 3. Ship. patch is the default; minor/major when the release warrants it.
gh workflow run release-production.yml --ref release -R tinyhumansai/opencompany -f release_type=patch
```

`--ref` is the branch in the web UI's "Use workflow from" dropdown, and it is
load-bearing: staging refuses anything but `main` or `release`, production
refuses anything but `release`. The dropdown lists every branch and tag; the
guard step is what makes picking the wrong one a five-second failure instead
of a build.

A fix found on `release` is a PR **against `release`**. It runs CI like any
other PR; the next cut picks it up and the back-merge carries it to `main`.
Re-dispatching the promotion afterwards merges — it never resets — so fixes on
`release` survive it.

## What a production cut does, in order

1. **`prepare-build`** — `scripts/release/bump-version.mjs <release_type>`
   moves the version in every file that carries it (the list is
   `scripts/release/version-files.mjs`: the workspace `Cargo.toml` and lock,
   the desktop shell's `Cargo.toml` and lock, `tauri.conf.json`,
   `frontend/package.json` and its lock), refuses a tree whose files already
   disagree, commits, tags `vX.Y.Z`, pushes, merges `release` back into `main`.
2. **`create-release`** — `scripts/release/generate-release-notes.mjs` writes
   the notes (OpenAI-polished when `OPENAI_API_KEY` is set, deterministic
   otherwise — the job log says which) and creates the Release **as a draft**.
3. **`build-desktop`** (`build-desktop.yml`) — both architectures, Developer-ID
   signed and notarized, plus the updater's `.app.tar.gz` + `.sig` built from
   the stapled bundle. Everything attaches to the draft.
4. **`build-docker`** — the tenant image built with the same feature set
   `deploy-staging.yml` ships and then discarded. `ci.yml` never runs the
   Dockerfile; this is the only proof the tag containerises.
5. **`updater-manifest`** — `latest.json` assembled from both architectures'
   assets, uploaded to the draft. See [desktop-updates.md](desktop-updates.md).
6. **`publish-release`** — every required asset is checked to be on the draft,
   then it is flipped public and marked latest. This repository has immutable
   releases: the asset list freezes at that moment, which is why nothing is
   published until it is complete.
7. **`cleanup-failed-release`** — if anything after the tag failed, the draft
   and the tag are deleted, so the next dispatch bumps cleanly and no
   half-built version is reachable. The bump commit stays; that is harmless.

`create_release: false` is a rehearsal: bump and build — no tag, no
Release, DMGs as Actions artifacts. The version still moves.

A staging cut is steps 1, 3 (without the updater archive) and 4, tagged
`vX.Y.Z-staging`, with no Release at all — see
[desktop-updates.md](desktop-updates.md#a-staging-cut-ships-no-update-anybody-can-reach)
for why that is the right shape for the auto-updater.

## Why it is shaped this way

**The version is computed, not typed.** The previous flow took a tag as an
input to two separate workflows, and the tag had to be created by hand first
— which is how v0.1.5 shipped with `crates/opencompany-app/Cargo.toml` still at
0.1.4: a hand bump touched five files and missed the sixth. Now one script
owns the list, `verify-version-sync.mjs` runs in CI on every PR, and the only
version-shaped input anywhere is patch/minor/major.

**One dispatch per cut.** The previous flow was `release.yml` (notes + draft)
followed by `Release Desktop (macOS DMG)` with `sign: true` and
`create_release: true` typed by hand, with the same tag typed into both. A
forgotten second dispatch left an asset-less draft that nobody could see from
the front page — v0.1.5 sat that way for a day. Now the second half cannot be
forgotten because it is not a separate thing.

**A long-lived `release` branch.** `main` moves continuously; a release needs a
point that can be fixed without taking everything that landed since. Fixes
land on `release` as PRs and reach `main` through the back-merge, so neither
branch loses them.

**No separate build-and-test job.** Everything on `release` came through a PR
that ran `ci.yml`, the promotion dispatches `ci.yml` on the snapshot, and the
desktop and Docker jobs compile the tag `--locked` anyway. A third compile of
the same tree cost ~30 minutes per cut and never found anything new.

**Pushes by the workflow do not trigger CI.** The bump commit and the
promotion merge are pushed with `GITHUB_TOKEN`, which GitHub deliberately
excludes from firing `push` workflows. The promotion dispatches `ci.yml`
explicitly for that reason (and `ci.yml` forces every lane on a dispatch, since
its path filter would otherwise see an empty diff). The bump commit is version
numbers only and is verified by the cut itself.

## When something goes wrong

| Symptom | What happened | What to do |
|---|---|---|
| "Tag vX.Y.Z already exists" in `prepare-build` | The tree's version is behind a tag that was already cut — usually a back-merge that never landed. | Merge `release` into `main` by hand (or the other way), check `node scripts/release/verify-version-sync.mjs`, re-dispatch. |
| "the tree does not agree on its current version" | Someone edited one version file by hand. | Fix the odd file to match, open a PR; CI's `verify-version-sync` step names it. |
| Production run red, no Release visible | `cleanup-failed-release` deleted the draft and the tag. | Read the failed job, fix on `release` via PR, re-dispatch. The next cut takes the next patch number. |
| "release→main back-merge hit conflicts" warning | Main and release diverged on the same lines. The release itself is fine and published. | Merge `release` into `main` by hand and resolve. |
| Release is published but `latest.json` is missing | Cannot happen through this flow — `publish-release` checks for it. If you see it, the release was published some other way. | Cut the next version; a published release cannot be amended. |
| Need a build from a commit behind `main`'s head | — | That is what `release` is for: put `release` at that point (promote, or a PR against `release`) and cut from `release`. A bump commit built on an older point cannot be pushed to a branch without force, so there is no "cut this SHA" input. |

## What is needed once

Repository secrets: the six `APPLE_*` values for signing and notarization,
`TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) for the updater
([desktop-updates.md](desktop-updates.md#operator-setup)),
and optionally `OPENAI_API_KEY` for polished notes. `build-desktop.yml`'s
`guard` job fails in seconds, naming the missing one, before any build starts.
