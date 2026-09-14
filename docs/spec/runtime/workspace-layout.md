# Workspace layout on disk

How one instance lays out its data root: the embedded runtime's own root, the agent
sandboxes, how the root is chosen, and what a legacy doubled install looks like.

Split out of [`storage.md`](storage.md), which was over the repository's 500-line
ceiling. That file covers backend *selection* and the shipped backends; this one
covers the layout inside the root.

## Workspace layout (`src/store/layout.rs`)

`OPENCOMPANY_DATA_DIR` (default `$HOME/.opencompany`; `/data` in a hosted tenant
container) is the per-instance **workspace root** — everything one running
instance owns. [`DataLayout`](../../../src/store/layout.rs) names the canonical
subdirectories under it so stores, agents, and tools resolve well-known
locations instead of ad-hoc paths:

```text
<OPENCOMPANY_DATA_DIR>/
  companies/   ← per-company bundles (companies/<slug>/, owned by the fs store)
  memory/      ← instance-shared memory artifacts
  store/       ← instance-shared durable-store artifacts
  files/       ← instance-shared files (exports, attachments)
  logs/        ← instance logs
  tmp/         ← ephemeral scratch, cleared on startup by default
  openhuman/   ← the embedded OpenHuman runtime's own root (see below)
```

Two runtime trees are **not** `DataLayout` directories and are absent from this
tree: the agent + workflow sandboxes (`<home>/harness`, see below) and the MCP
registry (`<home>/mcp`). They hang off the resolved *home*, which coincides with
this root whenever `<home>` and `OPENCOMPANY_DATA_DIR` agree — as they do by
default and in the hosted shape — and splits from it when `--home` diverges
(see “`--home` moves the bundles and the runtime trees” below).

Per-company state (each bundle's own `memory/`/`context/`) lives under
`companies/<slug>/`; the top-level `memory/`/`store/`/`files/` are the shared,
instance-level locations. `serve` calls `DataLayout::ensure` at boot: it creates
the shared subdirectories and — unless `[workspace].clear_tmp_on_startup` is
`false` — empties `tmp/` so no stale scratch survives a restart. Because the hosting model runs **one container per tenant** with its
own `OPENCOMPANY_DATA_DIR`, this root *is* the per-tenant workspace — no separate
per-tenant path prefix is needed.

### The embedded runtime's root (`<data-dir>/openhuman`, `src/app/journal.rs`)

The vendored OpenHuman runtime resolves its own workspace, and its default is a
subdirectory of the user's **home directory** — which in a tenant container is
the read-only root filesystem. Its durable agent journal lives at
`<root>/workspace/tinyagents_store/`, where `<root>` is the value handed to it
as `OPENHUMAN_WORKSPACE` and the vendored resolver nests a `workspace/` level
under that root. It therefore failed to create its store root on
every append, and the vendored append worker reported that to stderr once per
event with no dedup or backoff, burying every other line in the container log
(issue #446).

`serve` closes that gap before any agent exists.
[`app::journal::prepare`](../../../src/app/journal.rs) resolves the root, proves
it is writable, and exports it as `OPENHUMAN_WORKSPACE` — the one seam the
vendored config loader consults ahead of its home-directory default:

```text
<OPENCOMPANY_DATA_DIR>/openhuman/            ← exported as OPENHUMAN_WORKSPACE
<OPENCOMPANY_DATA_DIR>/openhuman/workspace/tinyagents_store/   ← the journal
```

| Precedence | Source | Root |
|---|---|---|
| 1 | `OPENHUMAN_WORKSPACE` (non-blank) | its value verbatim — a self-hoster keeps an existing workspace |
| 2 | `OPENCOMPANY_DATA_DIR` | `<data-dir>/openhuman`, exported so the vendored loader finds it |

`serve` prints the resolved store path at startup (`agent journal: … (root …,
from …)`) so this class of problem is one line to diagnose rather than a code
trace. Only the path is printed; no other environment value is read or echoed.

An unwritable root **aborts boot** — the same precedent as a
selected-but-unavailable storage backend. A tenant that answers but records
nothing produces confident, unrecoverable work and reports the loss only at
`debug` level; a tenant that refuses to start is one loud, attributable line.
Because the check runs after `DataLayout::ensure` has already created the shared
subdirectories, it can only fail on a genuinely broken mount or an explicitly
misconfigured `OPENHUMAN_WORKSPACE`, so it cannot turn a healthy tenant into one
that will not wake.

#### Seeing an append failure that happens anyway (issue #450)

Boot proving the root writable does not make the sink infallible — a volume can
fill, go read-only or disappear under a running tenant. The vendored append
worker no longer prints its one-line-per-event flood described above; since
tinyagents `73e6f5d` it keeps a failure-run state machine and reports through
`tracing` on the target `tinyagents::observability`. Only the **first** failure of
a run is `error`. The three lines that say how bad it got are `warn`:

| Line | Level | Says |
|---|---|---|
| `durable append failed; the observation is lost…` | `error` | a failure run started |
| `…still failing after N consecutive observations` | `warn` | it is still going (rate-limited reminder) |
| `durable append recovered; N observation(s) lost` | `warn` | it ended, and the cost |
| `…never recovered before shutdown, N observation(s) lost` | `warn` | it outlived the process |

The binary's default `EnvFilter` is `error` and nothing in the container images,
compose files or deploy workflows sets `RUST_LOG`, so those three `warn` lines
were dropped in every deployed tenant: an operator saw a degraded run begin and
never learned that it continued, that it ended, or how many observations went
missing. `DEFAULT_LOG_FILTER` in `src/bin/opencompany.rs` is therefore
`error,tinyagents::observability=warn` — today's default plus that one target.
`RUST_LOG`, when set, still replaces the whole thing — and is parsed *lossily*,
carrying the same `error` default the binary had before this constant existed, so
one unparseable directive drops itself rather than the operator's whole
configuration, and an empty value still reports errors rather than silencing the
binary outright. The desktop shell
(`crates/opencompany-app/src/lib.rs`) names the same target for a sharper reason: its fallback
has no global directive at all, so an unnamed target is dropped at every level
including `error`.

**Known limitation.** The worker's own subscriber-independent fallback,
`AppendWorker::append_failures()` — a counter of appends attempted and rejected,
documented there as "the only subscriber-free signal of durable-log loss" — is
`pub(crate)` in tinyagents. OpenCompany cannot read it, and there is no other
seam that exposes it: the worker is constructed inside OpenHuman's agent journal,
which hands out no handle to it. So the log filter is the *whole* mechanism here,
and a tenant whose operator overrides `RUST_LOG` with something that excludes
`tinyagents::observability` has no second channel. Surfacing the count — as a
health field, a metric, or simply a `pub` accessor — needs an upstream tinyagents
change first; do not try to plumb it from this repo.

### Agent sandboxes (`<home>/harness`)

The tree an agent's file tools actually act in hangs off the **home**, not off a
bundle, and is deliberately **not** pre-created by `DataLayout::ensure` — the
same rule `companies/` follows: whoever owns a subtree mints it on demand.

```text
<home>/harness/<company>/
  <agent>/workspace/                      ← one agent's sandbox
  <agent>/skill-catalog/                  ← its materialized skill bundles
  _workflow/<workflow>/<run>/workspace/   ← one workflow run's sandbox
```

`<company>` and `<agent>` are the ids under the workspace naming rule —
lowercase and dashed, so a roster id `page_builder` lands at `page-builder/`
([`workspace-names.md`](workspace-names.md)). A sandbox left at the pre-rule
path is moved onto the canonical one, once, by `ensure_agent_workspace`: unlike
the note tree, this directory is private scratch that nothing outside the
process addresses, so an in-place move is invisible — and losing an agent's
half-finished work to a silent path change would not be.

An agent's sandbox is named by `harness::build::agent_workspace` and created by
`harness::build::ensure_agent_workspace`; a workflow run's is named and created
by `workflows::caps`. It must exist **before** the agent acts, not merely by the
time it finishes. OpenHuman's `validate_parent_path` resolves a relative write
against the sandbox, then walks up to the deepest *existing* ancestor to
canonicalize it; with the sandbox absent that walk climbs past it and lands
outside, so the write is refused as `Resolved parent path escapes workspace` for
a path that is plainly inside. The runtime writes its own bookkeeping there
(session transcripts, the TinyAgents journal), creating the directory as a side
effect — but only at the *end* of a turn, so it never helps the turn that needed
it. An agent holding `shell` never saw this: its first command creates the
directory before anything validates a path (issue #409).

Hence two creation points, not one. `build_agent` mints the sandbox before any
`SecurityPolicy` is constructed over it; the dispatch path re-ensures it every
turn. The second is not redundant — a roster is built once, cached behind
fingerprints and handed across an in-place rebuild, so a sandbox removed under a
live host (a restored data dir, a boot that raced an unmounted volume) would
otherwise stay missing for the life of the process.

### Choosing the root (`src/store/paths.rs`)

`OPENCOMPANY_DATA_DIR` is the **only** environment knob that places an instance.
`opencompany serve` (and `export` / `import`) resolve the root every company
bundle hangs off through `store::resolve_home`, in this order:

| Precedence | Source | Resolves to |
| --- | --- | --- |
| 1 | `--home <DIR>` | `<DIR>` verbatim — an explicit flag is never overridden by the environment |
| 2 | `OPENCOMPANY_DATA_DIR` | its value verbatim, so bundles land at `<root>/companies/<slug>` — exactly the layout above |
| 3 | neither | `$HOME/.opencompany` (a relative `.opencompany` when `$HOME` is unset) |

An empty `OPENCOMPANY_DATA_DIR` counts as unset — it would otherwise root the
instance at the process working directory.

All three branches resolve the home to the **workspace root**, so `Bundle`'s own
`companies/` segment puts bundles at `<root>/companies/<slug>` in every case —
exactly the layout above, and exactly `DataLayout::companies_dir()`.

One consequence worth knowing:

- **`--home` moves the bundles and the runtime trees, but not the shared
  workspace.** It places company bundles (`<home>/companies/`) and — since the
  harness and MCP trees hang off the same resolved home — the agent sandboxes
  and MCP registry (`<home>/harness`, `<home>/mcp`); `memory/`, `store/`,
  `files/`, `logs/` and `tmp/` always follow `OPENCOMPANY_DATA_DIR`. So two hosts
  isolated by `--home` alone still share one workspace. `serve` prints an
  operator-visible warning naming both roots whenever they are not aligned.
  Prefer `OPENCOMPANY_DATA_DIR`, which moves the whole instance. A hosted tenant
  sets both to the same value
  (`docker/entrypoint.sh` passes `--home "$OPENCOMPANY_DATA_DIR"`), so it never
  warns — nor does the local default, whose home and data root are now the same
  path. Passing `--home ~/.opencompany/companies` by hand recreates the legacy
  doubled shape below and does warn, correctly.

#### Migrating a legacy doubled install (`src/store/migrate.rs`)

The default home used to append a `companies` leaf of its own, so a default local
install's bundles were nested one level too deep at
`~/.opencompany/companies/companies/<slug>` while `DataLayout` materialized
`~/.opencompany/{memory,store,files,logs,tmp}` beside the *first* `companies/`. A
local sqlite database was orphaned the same way, at
`~/.opencompany/companies/opencompany.db`, because `serve` hands the resolved
home to `open_storage`. So were the two runtime trees that hang off the home
rather than off a bundle: the harness agent workspaces (`<home>/harness`) and the
MCP runtime registry (`<home>/mcp`, whose persisted installs and stored
environment values are reconnected on boot).

Dropping the leaf without moving that data would leave every existing local
company invisible, so `serve`, `export`, and `import` all run
`store::migrate::migrate_legacy_nest` against the resolved home before reading
anything:

- No `<home>/companies/companies` directory is a no-op. A hosted tenant takes
  this branch on every boot: two `stat`s that find nothing.
- A nest that is **bundle-shaped** — holding any of the top-level files
  (`company.toml`, `meta.json`, `events.jsonl`, `ledger.jsonl`, `tasks.json`, …)
  or subdirectories (`keys/`, `secrets/`, `memory/`, `context/`, …) that only a
  company owns — is a real bundle slugged `companies` and is left exactly as it
  is. A manifest is deliberately *not* the test: `Bundle::ensure_dirs` creates a
  bundle with neither marker at ~20 call sites, and under
  `OPENCOMPANY_STORAGE=sqlite|mongodb` the manifest never reaches the filesystem
  at all while the keys, secrets and task board still do — so a marker test would
  have dissolved exactly the installs that have no manifest to find.
- Only entries that are **themselves bundle-shaped directories** are relocated,
  the same test one level down. Anything else stays where it is, silently: the
  legacy nest holds nothing but bundles, so an entry that does not look like one
  is not something the migration knows where to put.
- Any `opencompany.db` (with its `-wal`/`-shm` siblings, as a set) moves from
  `<home>/companies/` to `<home>/`. Only **regular files** count as the database:
  a company slugged `opencompany.db` owns the directory at that exact path, and
  relocating it would delete the company.
- `<home>/companies/{harness,mcp}` move up to `<home>/{harness,mcp}` under the
  same shape guard — a company really can be slugged `harness`, and its canonical
  bundle sits at exactly the path the legacy tree occupied.
- An occupied destination is **skipped**, never merged: two copies of one company
  hold two event logs and two signing keys, which cannot be interleaved. Both
  copies stay put and a warning names both paths.
- Files move by `link`+`unlink`, never by `rename`. A rename replaces a regular
  file silently, and a "is the destination free?" check taken beforehand is stale
  the instant it is read — a `serve` that has already migrated is writing a live
  `-wal` at that path, and a rename over it drops every committed transaction the
  log still holds. A hard link fails when the destination exists, so the check and
  the move are one indivisible step. A crash between the link and the unlink
  leaves one file reachable under both names, which the next run recognises by
  device and inode and finishes rather than reporting as two databases.
  Directories keep `rename`, which cannot replace a populated directory
  (`ENOTEMPTY`) or a regular file (`ENOTDIR`) at all.
- The nest directory is removed only once emptied, so a crash mid-migration
  resumes on the next boot. Re-running a migrated install is silent.
- The database set resumes the same way. It is detected from **any** surviving
  member, not from `opencompany.db` alone, so a run that moved the database and
  then died is finished by the next boot rather than being read as complete —
  which would have paired a relocated database with a stranded write-ahead log
  and lost whatever that log still held.
- A source another process moved first is a success, not a failure. Running
  `opencompany export` against a home a `serve` process is booting is ordinary
  and both migrate; the loser of that race must not abort on a `NotFound` that
  means "already done". Note that this is race *tolerance*, not a concurrency
  guarantee: two processes sharing one home is unsupported for the same reason
  the runtime journal is single-writer, and this migration does not change that.
  What the no-replace moves above do guarantee is that losing such a race can
  never cost data, whatever the interleaving.

An install whose migration genuinely cannot complete — `EXDEV` because
`companies/` is a mount point, a root-owned or read-only nest — still boots:
`--home ~/.opencompany/companies` resolves every bundle exactly where it already
sits and finds no nest beneath it to migrate. That shape warns about the split
workspace, correctly, and is the supported way to run an install this migration
cannot move.

Moves are printed on stderr rather than logged through `warn!`, which the default
`EnvFilter` drops unless `RUST_LOG` is set.

`OPENCOMPANY_HOME` is **not** a synonym and is **not supported**. It was never
wired to anything, so setting it used to be ignored silently. The resolver now
reads it solely to reject it: `serve`, `export`, and `import` abort with an error
naming `OPENCOMPANY_DATA_DIR` instead. The rejection is checked before `--home`,
so passing the flag does not suppress it — a stale entrypoint that still exports
the variable fails loudly rather than half-placing a store.

#### Running two hosts side by side

A data root has exactly one writer, enforced by an advisory lock — a second
`serve` over the same root is refused at boot. Give each host its own root; see
[`data-root.md`](data-root.md) for the recipe and the rules.

The `[workspace]` section of `config.toml` (in the data dir) tunes the lifecycle:

```toml
[workspace]
git_enabled = false           # opt in to automatic Git checkpoints per agent workspace
clear_tmp_on_startup = true   # default; set false to preserve tmp/ across restarts
storage_quota_gb = 5          # soft whole-workspace quota; omit or <= 0 = unlimited
tmp_quota_gb = 1              # soft tmp/ quota; omit or <= 0 = unlimited
tree_quota_gb = 2             # HARD cap on the note tree's binary payloads (#553)
max_blob_mb = 64              # HARD cap on ONE binary write (default 64)
```

When `git_enabled = true`, every private agent filesystem workspace under
`harness/<company>/<agent>/workspace` is initialized as a Git working tree.
OpenCompany creates a baseline commit and then commits changed files after each
tool call, including shell commands, so redirects and generated files are not
missed. Calls that leave the tree unchanged add no commit. Git history lives in
the sibling `workspace.git/` directory; the working tree contains only Git's
small `.git` pointer file, which keeps ordinary Git commands usable from inside
the workspace. The pointer file is write-only scaffolding: a `.git` an agent
plants is ignored for the checkpointer's own commands (which pass an explicit
`--git-dir`) and rewritten to name the real repository, and checkpoint Git
invocations are isolated from inherited config and hooks. Checkpoint failures
are warned about but never replace a tool's successful result. The setting
defaults to `false`, preserving existing workspaces unless an operator
explicitly opts in. See [sandbox.md](orchestration/sandbox.md#checkpointing) for
the security rationale.

**Checkpoint history retains everything a workspace ever contained.** Because the
checkpoint repository records the workspace tree state at each tool call, a file
an agent writes and later deletes survives in `workspace.git/` history long after
it leaves the working tree. Content an agent downloads, generates, or is handed
by the operator can therefore accumulate there with no size bound — there are no
ignore rules and `[workspace]` quotas do not apply to Git objects. Treat the
feature as suitable for workspaces whose contents are not secrets, or purge
history deliberately on the same schedule such data would otherwise be rotated.
The supported purge path is to drop the checkpoint history from the host,
because every checkpoint is committed to the `checkpoints` branch and remains
reachable from it even after data leaves the working tree — reflog expiry and
`gc` alone do **not** remove it. The clean purge is to delete the whole
`<workspace>.git/` directory, after which the next tool call re-initializes the
checkpointer from a fresh baseline. To keep a workspace but drop its prior
history without fully resetting, delete the branch ref first so its commits
become unreachable, then garbage-collect them: `git --git-dir=<workspace>.git update-ref -d refs/heads/checkpoints` followed by `git --git-dir=<workspace>.git gc --prune=now`. Either way, `<workspace>.git` must be removed or the `checkpoints` ref must be deleted before `gc --prune=now` will actually free the blobs. Deleting
`<workspace>.git/` resets a workspace to its next checkpoint baseline. No
retention is automatic: the checkpointer never rewrites history and leaves the
repository alone between checkpoints.

**The first two quotas are soft/advisory in the binary.** At boot `serve`
measures the workspace (and `tmp/`) and emits an operator-visible
`tracing::warn` when either exceeds its configured quota. **Hard enforcement**
of a whole data directory is the container/StorageClass layer's job (an EFS
access point cap or a k8s `ResourceQuota`), which is where the deploy manifests
wire it; the binary surfaces the condition rather than intercepting every write.

**`tree_quota_gb` and `max_blob_mb` are hard, and enforced at the store.** They
can be, because since #553 the runtime knows the size of every payload it is
asked to keep: `QuotaEnforcedWorkspace` wraps the workspace store at the single
assembly site and refuses an over-limit binary write **before** anything is
stored, so a refusal leaves no partial blob, no node and no orphan. Only
payloads are counted — prose notes are not, because the threat model is media.
Refusals answer 413 and name what was attempted alongside what is allowed; a
write is never truncated to fit, because a truncated binary is a corrupt binary
carrying a digest computed over bytes nobody has.

`max_blob_mb` is the **per-write** cap and matters most on MongoDB. Before
GridFS the 16 MB BSON document limit was an accidental brake on how much an
agent could write; GridFS removes it by chunking, so the cap is what replaces
it deliberately. It defaults to 64 MiB — an order of magnitude above a
generated image or document, and above a short generated video, so no
deliverable this feature exists to make durable is near it.

The console's upload route holds a **separate** `DefaultBodyLimit` of 256 MiB
(4× the default cap), and the gap is deliberate (#647). One shared number made
the store's refusal unreachable there: the body limit fired mid-parse, a body
that stops mid-part is indistinguishable from a malformed one, so an oversized
upload answered `400 malformed multipart` — a correct request called broken —
and `max_blob_mb` above 64 bought only a different way to fail. With headroom
the store speaks first. The route limit is a backstop against buffering an
unbounded body; when it does fire the handler classifies axum's parse error via
`MultipartError::status()` and answers 413 naming the 256 MiB ceiling but never
a size, since a truncated body has no knowable total. Both share the
`workspace_quota_exceeded` code, so callers need not know which limit noticed.

One decorator covers every writer: the console's REST surface, the agent
workspace tools and the publish drain all hold the *same* `ops.workspace`
handle, so there is one check rather than three that could drift.

**There is deliberately no per-company running total by default.**
`tree_quota_gb` is unset unless an operator sets it, so out of the box the
exposure is N writes × `max_blob_mb`, bounded per write and not in aggregate.
That is a considered trade — per-company accounting, eviction and an admin
policy surface are a larger feature than this one — and it is stated here
rather than left to be discovered.

Large-file S3 offload remains a follow-up (needs an S3 client + credentials).
