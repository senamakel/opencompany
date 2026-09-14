# Routing states: what each one renders

Companion to [`routing.md`](routing.md), which holds the mode inference, the row
copy and the per-workload dialog. This file is the states side: what the
resolver can answer, what each answer looks like on screen, and what the three
write paths say before they change anything.

The shape of the finding this came from: **a reported state with no screen, or a
control that reports success and is inert.** A fresh company added Anthropic as
its first provider and every turn came back `404 model: agentic-v1` — and the
Routing tab meanwhile showed Managed selected, badged Not set up, on a company
where managed resolves to nothing.

## Managed is a fallback only when it resolves

**And neither is the claim.** Three places treated managed as an always-available
floor and every one of them was untrue on a company where it resolves to nothing:

- the inferred mode, above;
- `primaryLabel`, which printed `Primary (Managed)` whenever nothing was enabled
  — naming a destination that does not exist while every turn failed;
- the removal confirmation's *"leaves Managed as the only thing that can
  answer"*, a reassurance printed on exactly the companies where it is false.

All three now read `managed.configured`, and the Managed mode row is not
selectable when it is `false`: routing four workloads to a brain the same card
calls Not set up used to succeed.

## Which resolutions have a screen

`provider_for_workload` answers five ways, and two of them used to render
nowhere at all — `Disabled` was reported only by the turn that failed.

| Resolution | On the row | Elsewhere |
|---|---|---|
| `Resolved` | the provider and model | — |
| `Primary` | `Primary (X)`, or "Nothing — no provider can answer" | — |
| `Managed` | `Managed`, marked unusable when the chain resolves to nothing | the mode badge |
| `Missing` | "this company has no provider by that name" | the orphan banner |
| `Disabled` | "Switched off — this workload is parked" | `Parked` on the provider row |

The provider row carries `In use` / `Parked` beside `Default`, derived from the
same routing table the Routing tab renders. A confirmation helps whoever clicks
the toggle; a badge helps everyone who looks at the page afterwards.

## Switching a provider off is confirmed, in reversible language

Disabling does **not** scrub routes, deliberately (`providers.rs`): a disabled
provider keeps its endpoint, label and credential so that "stop billing this
account this week" is expressible, and scrubbing would make switching it back on
a re-configuration. What it does instead is say which tiers are parked.

The console now asks first, through the same `removalWarnings` machinery as
Remove but with a third intent, `disable`:

> **Switch off Anthropic?**
> Anthropic keeps its endpoint, its key and every route that names it. Switching
> it back on restores all of them — nothing is deleted.
> · Vision and 3 other workloads route through Anthropic and will be parked
>   until you switch it back on.
>
> `Cancel` · `Continue`

`Continue`, not a destructive verb, against Remove's deliberately severe copy one
menu item away.

### One matcher, three callers

`parked_tiers` matched on the slug alone, and a `local` or `claude-code` ref
carries none — so disabling the only Ollama runtime parked every `local:` route
while the note said *"Nothing was routed through it."* `orphaned_routes` had the
same bug and skipped those refs entirely. `scrub_removed` was the one that got it
right, with three rules. All three now read through one matcher:

- **cloud and custom** — matched by slug, decisive whatever the category;
- **CLI logins** — no slug, orphaned once no CLI provider is left;
- **local runtimes** — no slug, and only orphaned once *no* local runtime remains.


## Nothing asked which model the provider should serve

`add_provider` wrote `models: BTreeMap::new()` and the wire shape had no `model`
field at all, so there was no way to supply one. With no override and an endpoint
whose catalog publishes neither the tier names nor the shipped ids,
`model_for_tier`'s `Unknown` arm puts the **bare tier** on the wire — which is
the honest failure and should stay (the provider's error then names a string the
operator configured and can find). What was missing is that nothing ever gave
them a model id to configure.

`TierVocabulary::Unknown` exists precisely to refuse to guess, and
`tier_defaults()` returns an empty map for it *so the console will ask*. Nothing
on the add path consulted it, so the empty map shipped straight to a turn.

Now: the probe's published catalogue rides back on `ProbeResultDto`
(`models`, `needsModel`), the add dialog probes the draft **before** anything is
written and asks for a model id with that endpoint's own list in hand, and the
host refuses an add that would store a row it knows cannot answer.

**The rule is read from what the endpoint published, never from its kind.**
"Direct vendor APIs need a model, gateways do not" is the right intuition and the
wrong rule: a self-hosted LiteLLM publishing `agentic-v1` resolves tiers whoever
runs it. Anthropic, OpenAI, Groq, Ollama and LM Studio all come out `Unknown`;
the managed endpoint and tier-publishing gateways come out `Tiers`; OpenRouter
comes out `Concrete`.

## The one case where routing a new provider is not a guess

`auto_route_sole_provider` writes all four rows when, and only when:

- the route table is **empty** — nothing authored is overwritten;
- the managed chain **does not resolve** — there is no fallback behind the rows;
- after the add there is **exactly one enabled provider**, and it is this one.

All three together mean there is precisely one thing in the company that can
serve a turn, so routing to anything else is not a choice that exists.

"The first provider they added" is the wrong test. Because of entry zero a
company can hold a provider it never added, so the newly added one can be the
second element of the list and still be the one the operator expects to be used —
and equally, a company with entry zero already has something that answers.

**It deliberately stops when Managed is available.** A company on Managed that
adds an OpenRouter key may be doing it for one workload, for vision only, or to
compare; writing all four rows would bill them for everything, silently, from a
screen that still says Managed. Leaving the table empty reports `unset`, which
asks.

## Entry zero can be told apart

Entry zero is the pre-list company's `inference/config` blob, surfaced as element
0 of the provider list. It refuses **disable**, **edit** and **remove** with three
separate 400s — correct rules, and the console had no way to know which row they
applied to, so it rendered all three controls live and every one was a round trip
to a refusal.

`ProviderDto.origin` (`entryZero` / `indexed`) closes that. The rules do not
move; the row stops offering what cannot work, and its sub-line says what it is.

## A company routed to Managed is a configured company

`RuntimeBuilder::build` picks the harness brain over the offline echo brain on
one predicate: whether `resolve_effective_scoped` (`src/company/inference.rs`)
answers `Some`. It had two branches, and **Managed was in neither** — it has no
row in `inference/providers` (it resolves through a credential chain rather than
from a record), its credential lives at `provider/tinyhumans/key`, and its
*selection* lives in `inference/routes`.

So a company with its providers switched off and all four workloads routed to
`managed` resolved `None`, booted onto the echo brain, and stayed there.
Restarting the host changed nothing, because a fresh boot ran the same
computation and got the same answer — while `resolve_effective_for_tier`
resolved those same rows to `managed_decl` perfectly well. The turn path knew;
the boot path had no way to ask.

A third branch asks, **last of the three**, so it can only turn a `None` into a
`Some` and no company that resolves today resolves anywhere new:

1. the provider list — an enabled, indexed provider;
2. the legacy chain — runtime blob, then manifest, then the env default;
3. the routing table naming `managed`.

Three things decide what branch 3 answers, and each is deliberate:

- **It goes through `managed_decl`**, the same function the routed turn path
  calls, rather than forming a second opinion about what managed resolution
  means. Two implementations of that question is the bug class this branch
  exists to close, not one to add to.
- **The predicate is the resolved declaration's own credential.** `managed_decl`
  always returns a decl — the platform endpoint exists regardless — and only
  `managed_identity` decides whether a credential reaches it. `Credential::None`
  means the operator picked Managed and put nothing behind it, and that company
  belongs on the echo brain exactly as before.
- **`ProviderRef::Default` does not count.** An absent route resolves to
  `Resolution::Primary`, which branch 1 already tried; counting it would report
  every company as configured.

And it is gated on the Managed switch. `resolve_effective_for_tier` *refuses* an
explicit `managed` route while Managed is switched off, so a boot that selected
the harness brain on the strength of those rows would hand every turn to a
resolver that errors — inference that looks live on the status card and fails on
contact. Off means off on both paths.

`restart_pending` needs no change of its own: it runs over this same resolver, so
the banner and the predicate `build` actually tests cannot disagree.
