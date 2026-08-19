# Memory

What a company remembers, where it lives, and the Operator's rights over it.

## What is remembered

| Kind | Written by | Retention |
| --- | --- | --- |
| Compressed cycle traces | every cycle | written and exported; **not** summarized, **not** read back into a cycle, **not** evicted (issue #1175) |
| Task results (delegated work products) | cycles | durable |
| Context chunks (documents, research, transcripts the brain filed) | cycles, imports | durable, content-addressed |
| Customers, engagements, decisions, outcomes | cycles (as structured task results / context) | durable |
| Feedback items and their issue links | feedback flow | durable |

Conversation history with the hosted brain also exists server-side per
session ([integrations/medulla.md](../integrations/medulla.md)); the local
stores remain authoritative for export and migration.

## Port boundary

Memory spans three ports, not a database
([runtime/ports.md](../runtime/ports.md)):

- **`MemoryStore`** — the brain's own traces and task results; the shape of
  Medulla's `CyclePersistence` (`save_trace`, `recent_traces`,
  `save_task_result`, `evict`).
- **`ContextStore`** — the RLM environment (`put`/`list`/`peek`/`search`)
  the brain queries lazily instead of stuffing context windows.
- **`FactStore`** — the **operator's** durable, hand-curated Memory view: the
  facts, preferences, people, projects, and references the console's Memory
  surface lists, searches, adds, and deletes (`list`/`upsert`/`delete`). This
  is distinct from the two cognition ports above — it is a person-authored
  record, not compressed cognition — and is not fed into the cycle loop the way
  traces are.

The first two ports are the brain's memory; `FactStore` is the operator's. All
three key on `CompanyId` and travel with the export bundle.

Every `ContextStore` chunk carries `ChunkMeta::stored_at_millis`, the wall-clock
time it was stored; a chunk written before backends recorded one reports `0`.
The console's Brain header needs it: agents write memory **only** through the
`ContextStore`, so a freshness figure drawn from `FactStore` alone reads as
"never updated" for any company whose operator has not hand-authored a fact.
`GET /memory/stats` therefore reports `lastUpdatedAtMillis` as the max across
both ports, alongside the facts-only `factsUpdatedAtMillis`.

Read that stamp as a max across chunks, not as one row per body: the backends
differ on a re-`put` of an identical body (sqlite and mongo dedupe on the
content address and keep the first write; the fs index appends a second line),
and neither the export bundle nor a restore preserves it — a restored chunk is
stamped when it lands.

**TinyCortex is the intended backend for `MemoryStore` and `ContextStore`**
([integrations/tinycortex.md](../integrations/tinycortex.md)) but is a
choice, not a dependency: the fs default preserves the one-key promise, and
DB-agnosticism applies to memory exactly as to every other store.

## Compounding

**Intended**: each cycle loads recent traces, so decisions and outcomes bias
future work — the mechanism behind "memory compounds" in the
[vision](../vision/README.md). Eviction (`evict` with an `EvictionPolicy`)
keeps the working window bounded; evicted traces are archived, not deleted,
until retention policy or the Operator says otherwise.

**Today** (issue #1175), one narrower path does the compounding and the rest is
not wired:

- Before each turn the harness retrieves the top-5 prior task outcomes matching
  the incoming message from the `ContextStore` and injects them as text, then
  stores the turn's outcome back (`src/harness/memory_loop.rs`). This is the
  only live recall a company has.
- Traces are written every cycle and read by nothing. `CycleRequest` used to
  carry them; no `Brain` consumed the field, so it was removed rather than left
  looking functional.
- `evict` is implemented on every backend and called from no production path,
  so the trace window is unbounded. `ContextStore` has no delete verb at all,
  so the chunk store only grows — which is also why deleting an operator fact
  leaves its `ContextStore` mirror agent-recallable
  (`src/server/ops/memory.rs`), against the Delete right below.

## Operator rights (normative)

- **Inspect**: `GET /api/v1/companies/{id}/memory/traces` and the exported
  bundle expose everything remembered, human-readably.
- **Delete**: the Operator MAY delete any memory item, context chunk, or
  `FactStore` fact; deletion propagates to the backing store and is journaled
  to the `EventLog` (that a deletion happened is auditable; the content is
  gone).
- **Redact**: customer-content redaction requests are honored across traces
  and chunks — required for the privacy stance in
  [feedback-loop/privacy.md](../feedback-loop/privacy.md).
- **Export**: memory travels with the bundle; no store may hold memory
  hostage ([runtime/lifecycle.md](../runtime/lifecycle.md), export).
