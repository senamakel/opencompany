# Desktop auto-update

**Status: implemented, and inert until an operator generates a signing key.**
How the desktop application learns that a newer build exists, what the person
using it is shown, what the release pipeline has to produce, and the one-time
setup without which none of it does anything.

The short version:

- The desktop shell reads a manifest on the newest GitHub release, five seconds
  after launch and every fifteen minutes after that. The **manifest itself is
  not signed** — what is signed is each platform's archive, and the signature
  travels in the manifest beside its url. So the manifest is a directory, and
  the trust is entirely in the bytes it points at.
- When it finds something newer it **downloads it in the background, silently**,
  and only then puts a banner on screen — "Restart now" or "Later". The
  operator is never asked to start a download and never watches a progress bar.
- Nothing is installed that was not signed by the key compiled into the running
  application. A bundle whose signature does not verify is discarded.
- **macOS only.** It is the only platform this repository releases, so it is the
  only platform the manifest advertises. A Windows or Linux build compiled from
  this tree finds no entry for its target and reports no update, quietly.
- Until somebody generates the minisign keypair and wires it up (see
  [Operator setup](#operator-setup)), the shipped configuration carries a
  placeholder and the whole feature reports "no update" and does nothing. That
  is deliberate, and CI refuses to cut a release while it is still true.

## Why the banner stays quiet

An update prompt competes with whatever the person is doing, and the console is
somewhere people are halfway through a sentence to an agent. So the flow is
arranged so that they are interrupted **once**, at the only moment their answer
changes anything.

There are eight states and three of them are visible:

| Phase | Shown | Why |
|---|---|---|
| `idle`, `checking` | nothing | Nobody asked, and nothing has happened yet. |
| `available` | nothing | Knowing a release exists is not actionable while the bytes are still on GitHub. |
| `downloading` | nothing | Background work. A progress bar here is a thing to watch, not a thing to decide. |
| `up-to-date` | nothing | The overwhelmingly common answer. |
| `ready` | **banner** | The bytes are on disk and verified. Restarting is now a few seconds, and it is the operator's call when. |
| `installing` | **banner** | Their own click, still running. The window is about to close. |
| `error` | **banner** | Something they may want to retry. |

Dismissing hides the banner until the flow re-enters an actionable state. A
**repeating** background failure that was already dismissed does not come back;
a different one does. Without that rule a release whose bundle 404s would put
the same banner on screen four times an hour.

**"Later" on a staged update means later than this session.** Once bytes are
staged the hook stops probing — a re-check that found a newer release would
throw ~100 MB of verified download away, and there is no menu item to bring the
banner back by hand (see [what is deliberately not
here](#what-is-deliberately-not-here)). Nothing is installed on quit either —
the bytes live in memory and go with the process — so what "Later" actually
buys is the offer again, five seconds into the next launch. Resurfacing within
a session is reachable from the `error` states, where nothing is staged and the
fifteen-minute probe keeps running.

The rule itself is a pure function, `isActionable` in
[`frontend/src/lib/app-update.ts`](../../../frontend/src/lib/app-update.ts), and
it is asserted directly in `frontend/test/unit/app-update-visibility.test.ts`
rather than through a render — "nothing appeared" is exactly the claim a render
test is worst at making, because an empty screen looks identical whether the
rule held or the component failed to mount.

## How the check works

The Tauri updater plugin fetches the JSON manifest named by
`plugins.updater.endpoints` in `crates/opencompany-app/tauri.conf.json`:

```
https://github.com/tinyhumansai/opencompany/releases/latest/download/latest.json
```

GitHub redirects `/releases/latest/download/<asset>` to that asset on the newest
**published, non-draft** release, so nothing has to be deployed for a client to
resolve the current version — cutting the release is the deploy.

The manifest names a version, and one entry per platform:

```json
{
  "version": "0.2.0",
  "notes": "See https://github.com/tinyhumansai/opencompany/releases/tag/v0.2.0",
  "pub_date": "2026-09-04T10:00:00.000Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<minisign>", "url": "https://…_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<minisign>", "url": "https://…_x64.app.tar.gz" }
  }
}
```

The plugin compares `version` with the running application's, downloads this
machine's entry, and verifies the bytes against the minisign public key
compiled into the application before anything touches the installed bundle.

Three commands sit over it, in `crates/opencompany-app/src/commands.rs`:

| Command | Does | On failure |
|---|---|---|
| `oc_app_update_check` | probes the endpoint | answers "no update" |
| `oc_app_update_download` | fetches and verifies, stages the bytes in memory | **reports the error** |
| `oc_app_update_install` | applies the staged bytes and relaunches | reports the error, and brings the local hosts back up |

The asymmetry is the point. The check runs on a timer nobody started, against
an endpoint that is routinely unreachable — a laptop on a train, a corporate
proxy, a release that has not been cut yet — and every one of those is the same
fact to the person using the application: there is nothing to do. The download
only runs because a check just said there is something to fetch, so a failure
there is real and worth showing.

A download that did not arrive is retried twice, with a 2s then 4s backoff —
both a dropped connection and an unsuccessful HTTP status, because a 503 from
GitHub's asset CDN on release day is exactly the minute the retry exists for. A
**signature** failure is never retried: re-fetching the same bytes cannot fix a
bad signature, and looping on one would turn a tampered bundle into a drain on
somebody's battery. The policy is a pure function in
`crates/opencompany-app/src/update.rs` and is unit tested there.

### The restart stops the local hosts first

`install` calls `LocalHosts::quiesce()` before it replaces the bundle. The
desktop runs company hosts **in this process**, each holding a lock on its data
root, and `restart` spawns the successor and *then* exits — so a host still
holding its root would still be holding it when the new process reached for the
same root, and the application would come back with every company down and
"held by another process" against each one.

`quiesce` is not `stop`. Stopping is an operator's decision and is recorded:
it clears `autostart`, so the instance stays down next launch. Quiescing
releases the locks and leaves the roster untouched, so the relaunched
application comes back running exactly what this one was running. There is a
test for precisely that in `crates/opencompany-app/src/local.rs`.

## What the release has to produce

The DMG is **not** what an update installs. On macOS the updater replaces the
`.app` bundle in place, out of a gzipped tarball with a detached minisign
signature beside it. `.github/workflows/build-desktop.yml` — the reusable build
`release-production.yml` calls — produces three things beyond the DMGs, all
gated on its `with_updater` input, which production sets and staging does not:

1. **A guard, before anything is built.** `scripts/release/assert-updater-configured.sh`
   fails the dispatch in seconds if `tauri.conf.json` still carries the
   placeholder public key, if it declares no endpoint, or if the
   `TAURI_SIGNING_PRIVATE_KEY` secret is missing.
2. **`OpenCompany_<version>_<arch>.app.tar.gz` and its `.sig`**, per
   architecture, built by `scripts/release/package-updater-artifact.sh` and
   attached to the draft release.
3. **`latest.json`**, assembled from both architectures' assets by
   `scripts/release/publish-updater-manifest.sh` in its own job, and uploaded
   to the draft before it is published.

### Two orderings that are load-bearing

**The archive is built after notarization, not by the bundler.** Tauri's
`bundle.createUpdaterArtifacts` would emit the tarball during `tauri build` —
from the *unsigned* `.app`, because Developer-ID signing and notarization happen
in later steps. Every client that took such an update would end up with a bundle
Gatekeeper refuses to launch, and no obvious way back. Building it after
`xcrun stapler validate` means the updater installs byte-for-byte the bundle
Apple approved, and the signing key is needed for one `signer sign` invocation
rather than for the whole compile.

**`latest.json` is written into the draft, before publish.** This repository has
immutable releases: publishing freezes the asset list, and nothing can be added
afterwards. A release published without a manifest pins every existing install
to the build it already has — silently, with no error anywhere, permanently.
That is why `publish` needs `updater-manifest`, and why the manifest script
refuses to upload a partial manifest that names only one architecture.

### A staging cut ships no update anybody can reach

`release-staging.yml` tags `v<version>-staging` and creates **no GitHub
Release**: its DMGs are Actions artifacts, and it never builds the updater
archive or a `latest.json`. So every install keeps reading the manifest on the
last production release, which is the correct outcome and not an accident to
fix. It also means a staging build cannot be *tested* through the updater —
verifying an update end to end (below) needs two production releases.

Adding a second endpoint to `plugins.updater.endpoints` is **not** the fix if an
rc channel is ever wanted. The plugin walks the list in order and stops at the
first that parses, so every build would take the first entry and none of them
would be opted in to anything — a channel is a property of the install, and
`endpoints` is compiled into all of them alike.

## macOS only, and why that is the honest answer

`build-desktop.yml` is the only desktop release path that exists. There
is no Windows or Linux build published anywhere, so there is nothing for a
Windows or Linux client to update *to*.

The plugin is compiled on every platform — it is not `cfg`-gated, and gating it
would mean a code path no lane compiles. What is macOS-specific is the
**manifest**: it advertises `darwin-aarch64` and `darwin-x86_64` and nothing
else. A client on another platform finds no entry for its target, the check
fails, and `oc_app_update_check` reports "no update" — the same silence as a
laptop with no network. No banner, no error, no promise.

Adding a platform is: publish a build for it, teach
`package-updater-artifact.sh` the target's arch word, and add the platform key
to `publish-updater-manifest.sh`'s required set. The required-set assertion is
what stops a half-finished addition from shipping a manifest that silently omits
the new platform.

## Operator setup

**One-time, and nobody has done it yet.** Until it is done, the application
reports no updates and the release workflow refuses to publish.

The private key must never touch this repository — not a file, not a commit, not
a test fixture, not a CI log. It lives in exactly two places: the operator's own
machine, and a GitHub Actions secret.

### 1. Generate the keypair

On a trusted machine, once:

```sh
cd frontend
./node_modules/.bin/tauri signer generate -w ~/.tauri/opencompany.key
```

It writes `~/.tauri/opencompany.key` (private) and `~/.tauri/opencompany.key.pub`
(public), and prints both, base64-encoded, to the terminal. Give it a passphrase
when it asks — an unprotected private key in a secret store is a key anybody who
can read the store can sign releases with.

**This is the only copy.** Losing it means no existing install can ever be
updated again: every client verifies against the public key compiled into the
build it is already running, so a new keypair cannot reach them. Back it up
somewhere an operator would back up a signing key.

### 2. Put the public half in the config

Copy the **public** key the command printed into
`crates/opencompany-app/tauri.conf.json`:

```json
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "endpoints": [
        "https://github.com/tinyhumansai/opencompany/releases/latest/download/latest.json"
      ]
    }
  }
```

Commit that. It is a public key; it is meant to be in the tree.

The test `the_shipped_placeholder_is_not_configured` in
`crates/opencompany-app/src/update.rs` asserts the committed config does **not** carry a
real-looking key. That test is the tripwire for a key pasted in by accident, so
the commit that legitimately adds one has to delete or invert it — a deliberate
edit, in the same change, rather than a silent one.

### 3. Add the private half as a repository secret

In the `tinyhumansai/opencompany` repository settings, under Secrets and
variables → Actions:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the **private** key the command printed |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase, if the key has one |

### 4. Cut a release

Dispatch `Release Production` from the `release` branch
([releases.md](releases.md)). Its `guard` job proves the key and the secret are
both present before anything builds.

## Verifying it end to end

The signature path cannot be exercised from a development machine without a real
keypair, so the only honest verification is a release-to-release one. Do it
deliberately the first time, on two versions:

1. **The release carries the right assets.** After the workflow finishes, the
   release should have, per architecture, a `.dmg`, a `.app.tar.gz` and a
   `.app.tar.gz.sig` — plus one `latest.json`.
2. **The manifest resolves.** `curl -sL https://github.com/tinyhumansai/opencompany/releases/latest/download/latest.json | jq`
   should print the version you just cut and both `darwin-*` platform entries.
3. **An older install finds it.** Install the *previous* release's DMG on a Mac,
   launch it, and wait. Within about five seconds the check runs; within a
   minute or two — download time — the banner should appear naming the new
   version. The log line to look for is `a newer desktop build is available`.
4. **The restart works and the companies come back.** Press "Restart now". The
   window closes and reopens, the About/version reads the new version, and every
   local company that was running before the update is running after it. That
   last part is the one worth checking on a machine with two local instances,
   because it is what `quiesce` exists for.
5. **Nothing appeared before step 3's banner.** If a progress bar or a "checking
   for updates" notice was ever on screen, the UX contract has regressed.

Between releases, the cheap check is that a build with the placeholder key
stays silent: run the desktop from a checkout with no key configured, leave it
open, and confirm no banner and no error ever appear.

## What is deliberately not here

- **No "check for updates" menu item.** The check is automatic and the answer is
  almost always "no". A button whose usual outcome is a dialog saying nothing
  happened is a button that teaches people the feature does not work. If an
  About panel is added later, the hook already exposes `check()` for it.
- **No progress bar.** The download is silent by design, so nothing renders
  bytes, so the core reports none. If a surface ever wants one, that is when a
  progress channel earns its place — adding it now would mean a second writer
  to the phase machine carrying data nothing displays.
- **No self-hosted or enterprise update channel.** The endpoint is the public
  GitHub release. A fork that publishes its own builds must point
  `plugins.updater.endpoints` at its own manifest and use its own keypair;
  pointing a fork's clients at this repository's releases would have them
  install this repository's application.
- **No automatic install.** Applying an update always waits for a person, and
  the reason is in the first section: the restart is the interruption, and the
  operator decides when to take it.

## See also

- [releases.md](releases.md) — the three workflows that cut a release, and the
  one decision each of them takes
- [desktop.md](desktop.md) — the desktop client: connections, transport seam,
  embedded host
- [desktop-instances.md](desktop-instances.md) — several local hosts on one
  machine, which is what the restart has to bring back up
- [data-root.md](data-root.md) — the single-writer lock a quiesce releases
