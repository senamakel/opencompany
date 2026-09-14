// Manage Routing, as decisions rather than markup.
//
// Every branch the routing screen makes lives here, as a plain function over
// plain data: which mode the current routes describe, whether two rows point at
// the same thing, what a removal orphans, how a row reads. The components are
// then layout plus handlers, with nothing in them that deserves a test of its
// own. This is the shape `frontend/src/search/` uses and it is the closest
// worked example in this console.
//
// The Rust side holds the same rules for the turn path (`inference::resolve`).
// These are not a second opinion: the console needs them to render a row before
// a request is made, and the host needs them to decide where a turn goes. Where
// they overlap they are written to agree, and the ones that matter — the mode
// inference and the three scrub rules — are pinned on both sides.

import { categoryOf } from "./catalogue";
import { MANAGED_OPTION_SLUG } from "./connect";
import { overrideIsSendable } from "./proxy-compat";
import type { Provider, ProviderRef, RoutingMap, RoutingMode, Workload } from "./types";

/**
 * The workloads with a row of their own — one per abstract tier the runtime
 * actually has.
 *
 * The design being ported lists nine, in two groups. Five of those have no
 * equivalent here: `memory`, `heartbeat`, `learning` and `subconscious` are
 * background loops OpenCompany does not run, and shipping four empty rows would
 * be a screen that lies about what the product does.
 *
 * `coding` is the fifth, and it is absent for a different and sharper reason:
 * it maps onto the same `agentic-v1` tier as `agentic`, so an editable coding
 * row would write one tier's route under two names. Setting one would silently
 * change the other — which is the inheritance bug this module exists to prevent,
 * wearing a different hat. It resolves through the agentic route as an alias,
 * and it gets a row when a coding tier exists to give it.
 */
export const WORKLOADS: readonly Workload[] = ["chat", "reasoning", "agentic", "vision"];

/** The abstract tier a workload routes through. */
export const WORKLOAD_TIER: Record<Workload, string> = {
  chat: "chat-v1",
  reasoning: "reasoning-v1",
  agentic: "agentic-v1",
  vision: "vision-v1",
};

/** What a row says about itself. */
export interface WorkloadCopy {
  label: string;
  description: string;
  /** What to pick, for someone who does not already know. */
  hint: string;
}

/**
 * The row copy, ported verbatim.
 *
 * The recommendation hints are the part that makes this screen usable by someone
 * who has never chosen a model before, and they are the first thing a rewrite
 * would drop as verbose. They are not verbose; they are the feature.
 *
 * One substitution from the source: the managed brain is named for this product
 * rather than the one the copy was written for. Keeping another product's name
 * in our own UI would be a bug, not fidelity.
 */
export const WORKLOAD_COPY: Record<Workload, WorkloadCopy> = {
  chat: {
    label: "Chat",
    description: "Direct conversational back-and-forth",
    hint: "a cheap or mid-cost fast chat model with high tokens/sec and low latency. Open-source local models can work well here if they feel responsive.",
  },
  reasoning: {
    label: "Reasoning",
    description: "Main chat agent, meeting summarizer",
    hint: "a more expensive frontier or strong reasoning model for deep thinking. Used for the main chat agent, meeting summaries, and heavier answer synthesis.",
  },
  agentic: {
    label: "Agentic",
    description: "Sub-agent runners, tool loops, and coding passes",
    hint: "a reliable instruction-following model with strong tool use. Mid-cost frontier models are usually safest; capable open-source models can work if tool calling is stable.",
  },
  vision: {
    label: "Vision",
    description: "Image understanding for the vision sub-agent: always multimodal",
    hint: "a multimodal model that accepts image input. The managed default is image-capable; any provider routed here is always treated as vision-enabled.",
  },
};

/**
 * The modes an operator can pick, in the order they are offered.
 *
 * `unset` is not one of them and never appears here: it is what the host reports
 * when the table is managed-or-empty and managed resolves to nothing, i.e. the
 * **absence** of a usable mode. Offering it as a fourth row would be offering the
 * operator the state they are trying to leave.
 */
export const SELECTABLE_MODES = ["managed", "own", "advanced"] as const;

/** One of the three modes an operator can choose. */
export type SelectableMode = (typeof SELECTABLE_MODES)[number];

/** The three modes, and what each one claims. */
export const MODE_COPY: Record<SelectableMode, { label: string; description: string }> = {
  managed: {
    label: "Managed",
    description:
      "TinyHumans will run all inference in the cloud, choose the best model for the task, optimize for cost, and keep the safest routing defaults.",
  },
  own: {
    label: "Use Your Own Models",
    description:
      "Choose one provider + model and route every workload through it. This is simple, but it can be inefficient because lightweight and heavyweight inference all share the same route.",
  },
  advanced: {
    label: "Advanced",
    description:
      "Pick different models for different tasks. This is the best option for tight cost optimization and the most control.",
  },
};

/**
 * Managed is a badge, not a disabled toggle.
 *
 * A locked switch reads as switchable-but-broken and invites a fight the
 * operator cannot win. A badge says the same thing and is honest about it.
 *
 * **What it says depends on whether managed actually resolves.** The design this
 * ports says `Always on`, which is true there — they run the managed backend.
 * Here it needs a credential, so a badge claiming permanent availability on a
 * company whose chain resolves to nothing would be the same lie the provider row
 * was carrying.
 */
export function managedModeBadge(configured: boolean | undefined): string {
  return configured ? "Available" : "Not set up";
}

/**
 * What managed's absence means — the statement, with no navigation in it.
 *
 * Used on the page that **holds the action**, where the button is already on
 * screen. Telling an operator to go to the tab they are looking at is a sentence
 * that has stopped reading its own surroundings.
 */
export const MANAGED_NOT_SET_UP =
  "Managed is not set up on this company, so it is not a fallback.";

/** The same statement plus where to fix it, for a page that does not hold the action. */
export const MANAGED_NOT_SET_UP_ELSEWHERE = `${MANAGED_NOT_SET_UP} Connect it on the LLM Providers tab.`;

/**
 * What to say under the Connected list about managed being a fallback, or `null`
 * when the row above has already said everything true.
 *
 * Three states, and only two of them need a sentence:
 *
 * - **Not set up** — nothing in the chain answers. Say so.
 * - **Set up but switched off** — it resolves and is still not a fallback,
 *   which is the one case the row's own "On" badge cannot express.
 * - **Set up and on** — the row names the step that answers and who it bills.
 *   Repeating it here would be duplication, and the sentence it used to repeat
 *   ("always available") was not true besides.
 */
export function managedFallbackNote(
  managed: { configured?: boolean; enabled?: boolean } | undefined,
): string | null {
  if (!managed) return null;
  if (managed.configured === false) return MANAGED_NOT_SET_UP;
  if (managed.enabled === false) return MANAGED_SWITCHED_OFF;
  return null;
}

/** The same statement plus where to fix it, for the page that cannot switch it. */
export const MANAGED_SWITCHED_OFF_ELSEWHERE =
  "Managed is switched off, so it cannot be routed to. Switch it back on from its row on the LLM Providers tab.";

/** Set up, but switched out of routing — which is also not a fallback. */
export const MANAGED_SWITCHED_OFF =
  "Managed is switched off, so it is not a fallback. Its credential is untouched.";

/** What the shared-model row covers, said out loud rather than implied. */
export const OWN_MODE_SCOPE =
  "Applies the same provider + model to chat, reasoning, agentic and vision. Changes save when you click save.";

/** What the shared-model row says when there is nothing to choose from. */
export const OWN_MODE_EMPTY =
  "Add or connect a provider first. Then you can route every workload through one model here.";

/** The line above the rows in Advanced. */
export const ADVANCED_INTRO =
  "Fine-grained routing gives you the best cost optimization and the most control. Use the rows below to decide which workloads stay Managed, which use your shared default, and which pin to a specific model.";

/** The unset ref. Its own constant so the absence is a value, not a `null`. */
export const UNSET: ProviderRef = { kind: "default" };

/**
 * Parses the hand-editable string grammar (`acme:gpt-5`).
 *
 * An operator reads and edits routes as text, so the grammar has to survive a
 * round trip through a person. An empty string is `default` — an absence, not a
 * parse failure, because "nothing set here" is what deleting the value means.
 */
export function parseRef(raw: string): ProviderRef {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "default") return { kind: "default" };
  if (trimmed === "managed") return { kind: "managed" };
  const colon = trimmed.indexOf(":");
  const slug = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  const rawModel = colon === -1 ? "" : trimmed.slice(colon + 1).trim();
  const model = rawModel || undefined;
  if (slug === "claude-code") return { kind: "claudeCode", model };
  if (slug === "local") return { kind: "local", model };
  return { kind: "cloud", providerSlug: slug, model };
}

/** The string form of a ref, for the same grammar. */
export function formatRef(ref: ProviderRef): string {
  switch (ref.kind) {
    case "default":
      return "";
    case "managed":
      return "managed";
    case "cloud":
      return ref.model ? `${ref.providerSlug}:${ref.model}` : ref.providerSlug;
    case "local":
      return ref.model ? `local:${ref.model}` : "local";
    case "claudeCode":
      return ref.model ? `claude-code:${ref.model}` : "claude-code";
  }
}

/**
 * A comparable identity for a ref.
 *
 * Used to answer "do all the rows point at the same thing", which is what makes
 * the mode inferable. Structural equality on the objects would say no for two
 * refs that differ only by an absent versus undefined `model`.
 */
export function refSignature(ref: ProviderRef): string {
  return formatRef(ref) || "default";
}

/** The ref for a workload, or the unset one. */
export function refFor(routing: RoutingMap, workload: Workload): ProviderRef {
  return routing[workload] ?? UNSET;
}

/*
 * `orphanedRoutes` used to live here, a faithful port of the host's
 * `orphaned_routes`. **It was never called** — the host reports orphans on
 * `GET …/inference/routes` and the console renders `state.orphaned` — so it
 * decided nothing, rendered nothing, and was pinned by unit tests that made a
 * rule the product did not follow look covered. Deleted rather than corrected.
 */

/**
 * Which mode the current routes describe.
 *
 * **Inferred, never stored.** A mode field would be a fifth thing that can
 * disagree with the four routes, and the routes are the truth.
 *
 * Normally the rendered mode is the host's — `RoutesDto.mode`, which calls
 * `resolve::infer_routing_mode`. This exists for the two paths in
 * `use-inference.ts` where that response is the thing that did not arrive: a
 * member is refused `GET …/inference/routes` with a 403, and a provider write's
 * follow-up re-read can fail. Both still hold the persisted table, on the
 * status the other call answered with, so the mode is derived from the same
 * four routes the host would have derived it from rather than left at whatever
 * it was before.
 *
 * `managedResolves` is the host's `managed_resolves` — `status.managed.configured`
 * — and it is the whole difference between `managed` and `unset`: an all-default
 * table with nothing behind Managed is not a company that chose Managed, it is a
 * company that has not chosen. Keep this in step with `infer_routing_mode` in
 * `src/company/inference/resolve.rs`; the tests below mirror its own.
 */
export function inferRoutingMode(routing: RoutingMap, managedResolves: boolean): RoutingMode {
  const refs = WORKLOADS.map((w) => refFor(routing, w));
  if (refs.every((r) => r.kind === "managed" || r.kind === "default")) {
    return managedResolves ? "managed" : "unset";
  }
  const first = refSignature(refs[0]);
  if (refs.every((r) => refSignature(r) === first)) return "own";
  return "advanced";
}

/**
 * The routes a removal orphans, and the map with them reset.
 *
 * Three matching rules, because only one of the three kinds of ref carries a
 * slug, and all three cases are real bugs:
 *
 * - **Cloud and custom** — matched precisely by `providerSlug`.
 * - **CLI logins** — their refs carry no slug. Without this, disconnecting one
 *   left workloads pinned to `claude-code:<model>`, which the resolver still
 *   honours, so chats kept using the CLI after the provider was removed.
 * - **Local runtimes** — no slug either, and a `local` ref is only definitively
 *   orphaned once **no** local runtime remains. Scrubbing on the first removal
 *   would unpin a route a second runtime still serves.
 *
 * Returns the affected workloads as well as the new map, so the UI can say which
 * rows moved rather than leaving the operator to notice.
 */
export function scrubOnRemove(
  routing: RoutingMap,
  removed: Pick<Provider, "slug" | "kind">,
  remaining: readonly (Pick<Provider, "slug" | "kind"> & { enabled?: boolean })[],
  categoryOf: (kind: string) => "cloud" | "local" | "cli",
): { routing: RoutingMap; reset: Workload[] } {
  const category = categoryOf(removed.kind);
  // **Enabled, not merely present**, mirroring `resolve::scrub_removed`. A
  // slugless `local:` route survives only while something in that category can
  // still serve it, and a switched-off runtime cannot — the resolver looks for
  // an enabled target and fails the workload closed when it finds none, so
  // counting a disabled row as a survivor leaves the route pinned to a
  // hard failure instead of resetting it to the primary.
  //
  // `enabled` is optional so a caller passing bare `{slug, kind}` — which is
  // what this signature took before — still means "these are the survivors".
  const categorySurvives = remaining.some(
    (p) => p.enabled !== false && categoryOf(p.kind) === category,
  );

  const next: RoutingMap = { ...routing };
  const reset: Workload[] = [];
  for (const workload of WORKLOADS) {
    const ref = next[workload];
    if (!ref) continue;
    let orphaned = false;
    if (ref.kind === "cloud") {
      // A slug match is decisive, whatever the category — `ollama:llama3`
      // parses as a cloud ref because it carries a slug, while `categoryOf`
      // says local, so gating on the category meant the two rules never met and
      // removing a local runtime scrubbed nothing. See `scrub_removed`.
      orphaned = ref.providerSlug === removed.slug;
    } else if (ref.kind === "local") {
      orphaned = category === "local" && !categorySurvives;
    } else if (ref.kind === "claudeCode") {
      orphaned = category === "cli" && !categorySurvives;
    }
    if (orphaned) {
      next[workload] = { kind: "default" };
      reset.push(workload);
    }
  }
  return { routing: next, reset };
}

/**
 * The provider an **unset** workload goes through.
 *
 * The marked default, and only then list order. `isDefault` is the host's
 * resolved answer — a company that has never said reports its first enabled
 * provider — so this reads the same fact the turn path resolves, rather than
 * a second opinion about it.
 *
 * `undefined` means nothing enabled resolves, which every surface reads as the
 * managed brain: always available, and the right fallback.
 */
export function primaryProvider(providers: readonly Provider[]): Provider | undefined {
  return providers.find((p) => p.isDefault && p.enabled) ?? providers.find((p) => p.enabled);
}

/**
 * The sentence for a company with nothing behind it — no enabled provider, and a
 * managed chain that resolves to nothing.
 *
 * The one state on this whole surface where the honest answer is that the
 * company cannot think. It reads as a destination because it is where an unset
 * row's work goes: nowhere.
 */
export const NOTHING_ANSWERS = "Nothing — no provider can answer";

/**
 * What an unset row says it will actually use.
 *
 * `Primary (OpenRouter)` rather than a bare "Default", because "unset" is
 * otherwise a mystery on the one screen whose job is to say where work goes.
 * Read through {@link primaryProvider} on every render and never cached, so the
 * rows move when the marked default does.
 *
 * **`Primary (Managed)` used to be printed unconditionally** when nothing was
 * enabled — the smallest, most concrete instance of treating managed as an
 * always-available floor. It is not one here: managed needs a credential and can
 * resolve to nothing, and on such a company that string named a destination that
 * does not exist while the turn failed. `managedConfigured` is optional because
 * an older host does not send it, and absent reads as the old behaviour rather
 * than as a dead end — claiming a company cannot think on the strength of a
 * field nobody sent would be the same mistake pointing the other way.
 */
export function primaryLabel(providers: readonly Provider[], managedConfigured?: boolean): string {
  const primary = primaryProvider(providers);
  if (primary) return `Primary (${primary.label})`;
  return managedConfigured === false ? NOTHING_ANSWERS : "Primary (Managed)";
}

/**
 * Whether this company has anything at all that can serve a turn.
 *
 * Rows E2 and A2: every provider switched off (or none added) with a managed
 * chain that resolves to nothing. The one condition under which the console
 * should stop describing routing and say that agents cannot think.
 */
export function nothingCanAnswer(
  providers: readonly Provider[],
  managedConfigured?: boolean,
): boolean {
  return managedConfigured === false && !providers.some((p) => p.enabled);
}

/**
 * Whether any workload routes through this provider, and whether it can serve
 * them.
 *
 * **A confirmation helps whoever clicks the toggle; a badge helps everyone who
 * looks at the page**, including the person who did not click it. The row
 * carried exactly one badge before this — `Default` — plus credential health
 * that is deliberately silent when healthy, so routing health was absent
 * entirely and "switched off" was expressed only by the switch position.
 *
 * Read through {@link scrubOnRemove}'s three matching rules rather than by
 * comparing slugs here, so a local runtime and a CLI login get the same answer
 * as a cloud row — the slug-only match is the bug this shape exists to avoid.
 */
export function providerRoutingState(
  provider: Pick<Provider, "slug" | "kind" | "enabled">,
  providers: readonly Provider[],
  routing: RoutingMap,
): "inUse" | "parked" | null {
  const remaining = providers.filter((p) => p.slug !== provider.slug);
  const { reset } = scrubOnRemove(routing, provider, remaining, categoryOf);
  if (reset.length === 0) return null;
  return provider.enabled ? "inUse" : "parked";
}

/** The badge each routing state gets, or `null` for a provider nothing routes to. */
export function routingBadge(state: "inUse" | "parked" | null): string | null {
  if (state === "inUse") return "In use";
  if (state === "parked") return "Parked";
  return null;
}

/**
 * The workload a tier belongs to, for surfaces the host answers in tier ids.
 *
 * The orphan banner read *"`chat-v1` names `ghost`, which this company has no
 * provider for"* — the right mechanism in the wrong vocabulary. `chat-v1` is an
 * internal tier name; every other sentence on both tabs says "Chat". An operator
 * should not have to learn a second name for the same row to read a warning
 * about it.
 */
export function workloadForTier(tier: string): Workload | null {
  return WORKLOADS.find((w) => WORKLOAD_TIER[w] === tier) ?? null;
}

/** What a tier is called on screen — its workload's name, or the raw id. */
export function tierLabel(tier: string): string {
  const workload = workloadForTier(tier);
  return workload ? WORKLOAD_COPY[workload].label : tier;
}

/**
 * The orphan banner, in workload names.
 *
 * `local` and `claude-code` arrive here as slugs too, because the host now
 * reports slug-less refs as orphans — a `local:` route on a company holding no
 * local runtime used to be reported by nothing at all while the turn refused it.
 */
export function orphanedRouteNote(orphaned: readonly [string, string][]): string {
  return orphaned
    .map(
      ([tier, slug]) =>
        `${tierLabel(tier)} is routed to ${slug}, which this company has no provider for.`,
    )
    .join(" ");
}

/** The providers a row may be pointed at: enabled ones, in list order. */
export function routingTargets(providers: readonly Provider[]): Provider[] {
  return providers.filter((p) => p.enabled);
}

/**
 * The model id to carry when the provider changes.
 *
 * **A model id belongs to the provider it was chosen from.** Keeping
 * `claude-haiku-4-5-20251001` when the select moves from Anthropic to OpenRouter
 * leaves a value that is meaningless at the new endpoint — and worse, one the
 * field then quietly presents as free text, because it is not in the new
 * catalogue. That is the "wrong model at the wrong provider" failure the routing
 * fix exists to prevent, arriving through the form instead of the resolver.
 *
 * Blank is not a broken state here: it means *send the tier and let the endpoint
 * resolve it*, which is a working route at every provider. So clearing costs the
 * operator one choice and never costs them a turn.
 *
 * This is **not** the rule the nine proxy regressions are about. Those are about
 * discarding a value **mid-keystroke**, while it is still being typed. Changing
 * the provider is a settled act with an explicit target.
 */
export function modelAfterProviderChange(model: string, from: string, to: string): string {
  return from === to ? model : "";
}

/**
 * The three things that can be done to a provider from its row, in increasing
 * severity: park it, forget its credential, delete it.
 *
 * One discriminator rather than three code paths, because the three are one menu
 * apart and the copy is the only thing that keeps them distinguishable.
 */
export type ProviderIntent = "disable" | "key" | "provider";

/** What removing a provider — or just its key — would cost. */
export interface RemovalImpact {
  /** Workloads whose route would be reset to the primary. */
  routed: Workload[];
  /** Whether unrouted work goes through it today. */
  isDefault: boolean;
  /** Whether it is the last provider this company has switched on. */
  lastEnabled: boolean;
  /**
   * The provider the default marker would move to, when removing this one moves
   * it. `null` when it is not the default, or when nothing is left to hold it.
   */
  defaultMovesTo: string | null;
}

/**
 * What a removal would cost, as facts rather than prose.
 *
 * Read through {@link scrubOnRemove} rather than by matching slugs here, so the
 * confirmation names exactly the workloads the write will actually reset — all
 * three of its matching rules included, which is what makes it right for a local
 * runtime and a CLI login as well as a cloud row.
 */
export function removalImpact(
  provider: Pick<Provider, "slug" | "kind" | "enabled"> & { isDefault?: boolean },
  providers: readonly Provider[],
  routing: RoutingMap,
  categoryOf: (kind: string) => "cloud" | "local" | "cli",
): RemovalImpact {
  const remaining = providers.filter((p) => p.slug !== provider.slug);
  const { reset } = scrubOnRemove(routing, provider, remaining, categoryOf);
  const isDefault = Boolean(provider.isDefault);
  return {
    routed: reset,
    isDefault,
    lastEnabled: provider.enabled && !remaining.some((p) => p.enabled),
    // Read through the same `primaryProvider` the rows render, so the sentence
    // names the provider that will actually hold it rather than a guess at list
    // order.
    defaultMovesTo: isDefault ? (primaryProvider(remaining)?.label ?? null) : null,
  };
}

/**
 * The sentences a removal confirmation says, in the order they matter.
 *
 * A confirmation that only asks "are you sure?" is a speed bump, not a safeguard:
 * it tells the operator nothing they did not already know and trains them to
 * click through. These name what is actually about to change, and there is one
 * per fact rather than a paragraph, so an operator can see at a glance whether
 * any of them is the one they care about.
 *
 * **Removing a key is not removing a provider**, and the first sentence says so
 * either way. The two are one menu apart and one is recoverable by retyping a
 * credential while the other deletes a record, its endpoint and its routes.
 */
export function removalWarnings(
  intent: ProviderIntent,
  label: string,
  impact: RemovalImpact,
  managed?: { configured?: boolean; enabled?: boolean },
): string[] {
  // **"Managed will answer" is a claim, and it has to be checked.** Two of
  // these sentences promise a fallback the resolver will refuse if managed is
  // switched off, or build without a credential if its chain resolves to
  // nothing — so the operator would be confirming a destructive action under a
  // reassurance that is false exactly when it matters most. Unknown is treated
  // as available, which is what every caller meant before this argument.
  //
  // Computed here and passed down, so the disable sentences and the remove
  // sentences cannot come to different conclusions about the same company.
  const managedCanAnswer = !(managed?.enabled === false || managed?.configured === false);
  if (intent === "disable") return disableWarnings(label, impact, managedCanAnswer);
  const lines: string[] =
    intent === "key"
      ? [
          `${label} stays on this page, keeping its endpoint and every route that names it. It just has no credential, so it cannot answer until you add one.`,
        ]
      : [
          `This deletes ${label} and clears its stored key in the same operation. Adding it again means entering the credential again.`,
        ];
  if (impact.isDefault) {
    if (intent === "key") {
      lines.push(
        `It is this company's default, so every unrouted workload goes through it — and would start failing.`,
      );
    } else {
      // **Named, not implied.** An operator removed their default provider, the
      // marker relocated in silence, and re-adding the credential did not bring
      // it back — so a setting they had chosen was reassigned by a delete and
      // stayed reassigned. A removal that moves the default has to say where to
      // and that it is one-way.
      lines.push(
        impact.defaultMovesTo
          ? `It is this company's default. Removing it moves the default to ${impact.defaultMovesTo}, and adding this provider again will not move it back.`
          : managedCanAnswer
            ? `It is this company's default, and nothing is left to take that over — unrouted work falls back to Managed.`
            : `It is this company's default, nothing is left to take that over, and Managed cannot answer either. This company will have nothing to think with.`,
      );
    }
  }
  if (impact.routed.length > 0) {
    const named = impact.routed.map((w) => WORKLOAD_COPY[w].label).join(", ");
    lines.push(
      intent === "key"
        ? `${impact.routed.length === 1 ? "One workload routes" : `${impact.routed.length} workloads route`} to it (${named}), and the route stays pointed here.`
        : `${impact.routed.length === 1 ? "One workload routes" : `${impact.routed.length} workloads route`} to it (${named}). Those rows reset to the primary.`,
    );
  }
  if (impact.lastEnabled && intent === "provider") {
    // **Not "leaves Managed as the only thing that can answer"** — that was the
    // same false floor as `primaryLabel`'s old `Primary (Managed)`. Managed needs
    // a credential here and can resolve to nothing, and on such a company
    // removing the last enabled provider leaves the company unable to think at
    // all. Saying otherwise turned the most consequential line in this dialog
    // into a reassurance that was untrue exactly when it mattered.
    lines.push(
      managedCanAnswer
        ? `It is the only provider switched on, so removing it leaves Managed as the only thing that can answer.`
        : `It is the only provider switched on, and Managed cannot answer — removing it leaves this company with nothing to think with.`,
    );
  }
  return lines;
}

/**
 * What switching a provider **off** costs — a third intent, and deliberately not
 * a removal.
 *
 * Disabling keeps the endpoint, the label, the credential and **every route that
 * names it**, which is why the host refuses to scrub them: scrubbing would make
 * switching it back on a re-configuration rather than a switch. So the honest
 * frame is *parked until you switch it back on*, not *this will be lost* — and
 * the language is reversible throughout, against Remove's deliberately severe
 * copy one menu item away.
 *
 * It exists because the toggle had **no confirmation at all**: the host already
 * computes which tiers are parked and answers with them, and the console
 * discarded that into a toast while the Routing tab went on rendering the parked
 * rows as healthy.
 */
function disableWarnings(label: string, impact: RemovalImpact, managedCanAnswer: boolean): string[] {
  const lines: string[] = [
    `${label} keeps its endpoint, its key and every route that names it. Switching it back on restores all of them — nothing is deleted.`,
  ];
  if (impact.routed.length > 0) {
    const named = impact.routed.map((w) => WORKLOAD_COPY[w].label);
    lines.push(
      `${describeWorkloads(named)} through ${label} and will be parked until you switch it back on.`,
    );
  }
  if (impact.isDefault) {
    lines.push(
      impact.defaultMovesTo
        ? `It is this company's default, so unrouted work moves to ${impact.defaultMovesTo} while it is off.`
        : `It is this company's default, and nothing else is switched on to take that over.`,
    );
  }
  if (impact.lastEnabled) {
    lines.push(
      managedCanAnswer
        ? `It is the only provider switched on, so unrouted work falls back to Managed while it is off.`
        : `It is the only provider switched on, and Managed cannot answer — with it off, nothing can answer and agents cannot think.`,
    );
  }
  return lines;
}

/**
 * "Vision and 3 other workloads", rather than a comma list that grows past
 * reading.
 *
 * The operator's own phrasing, and it is the right one: the count is what tells
 * them whether this is a small change, and the first name is what tells them
 * whether it is the one they care about.
 */
function describeWorkloads(named: readonly string[]): string {
  if (named.length === 1) return `${named[0]} routes`;
  if (named.length === 2) return `${named[0]} and ${named[1]} route`;
  return `${named[0]} and ${named.length - 1} other workloads route`;
}

/** The managed brain's name wherever a row or a list has to say it. */
export const MANAGED_TARGET_LABEL = "Managed";

/**
 * The sentinel a per-workload select uses for the row's **unset** state.
 *
 * Unset is a state, not an option — see {@link routingOptions}.
 */
export const UNSET_TARGET = "__unset__";

/** One choosable provider in the per-workload select. */
export interface RoutingOption {
  /** The slug a chosen row writes. */
  slug: string;
  /** The name shown. */
  label: string;
  /**
   * Whether picking it would save a route that cannot serve a turn.
   *
   * Managed only, and for the two reasons the resolver refuses it: switched
   * off, or a credential chain that resolves to nothing. Listed rather than
   * dropped, because a workload already pointed there has to keep showing what
   * it is pointed at — a select whose current value is missing from its own
   * options is a worse lie than a disabled row.
   */
  unavailable?: boolean;
}

/**
 * The providers one workload may be pointed at — **providers only**.
 *
 * The dialog used to list the primary twice: once as `Primary (OpenRouter)`,
 * which is the unset row's own display, and once as `OpenRouter`. Three
 * connected providers produced five entries, two of which named the same
 * account and behaved differently. "Follow the default" is not a fourth
 * provider; it is the absence of a choice, and the Routing tab already renders
 * it as `Primary (OpenRouter)`. Getting back to it is an **action**, not a list
 * entry.
 *
 * Managed is first and is listed by its own slug rather than a second sentinel,
 * so it is one identity everywhere — and so a company whose entry zero *is* the
 * managed config does not get a row for it twice.
 */
export function routingOptions(
  providers: readonly Provider[],
  managed?: { configured?: boolean; enabled?: boolean },
): RoutingOption[] {
  const rest = routingTargets(providers)
    .filter((p) => p.slug !== MANAGED_OPTION_SLUG)
    .map((p) => ({ slug: p.slug, label: p.label }));
  // Unknown (no `managed` passed) is treated as available, because that is what
  // every caller meant before this argument existed and a select that grey-out
  // a working target is its own defect.
  const unavailable = managed?.enabled === false || managed?.configured === false;
  return [
    { slug: MANAGED_OPTION_SLUG, label: MANAGED_TARGET_LABEL, unavailable },
    ...rest,
  ];
}

/**
 * The provider whose model id a chosen target would set, or `null` when it
 * takes none.
 *
 * **The one place that decides whether the Model id field appears**, and it
 * decides on the *kind of provider* rather than on which synonym was picked.
 * `Primary (OpenRouter)` and `OpenRouter` are two names for one provider, and a
 * field that appeared under one and not the other was reporting a difference
 * that does not exist.
 *
 * `null` for managed because the route grammar has no managed-plus-model form:
 * a `managed` ref carries no model, so a field there could only be discarded on
 * save. Both of its synonyms resolve through this function, so they agree by
 * construction rather than by two branches being kept in step.
 */
export function modelTarget(target: string, providers: readonly Provider[]): string | null {
  const slug = target === UNSET_TARGET ? primaryProvider(providers)?.slug : target;
  if (!slug || slug === MANAGED_OPTION_SLUG) return null;
  return slug;
}

/**
 * The ref a chosen target and model write.
 *
 * Unset stays unset while the model is blank. **Choosing a model pins the row**
 * to the provider the default currently resolves to, because "follow the
 * default, but with this model" is not expressible in the route grammar — and
 * silently dropping the model would be the worse of the two answers.
 *
 * The override is judged here, at the one point that crosses the boundary,
 * rather than by clearing the input: the operator can see what they typed and
 * why it will not be used.
 */
export function refForTarget(
  target: string,
  model: string,
  providers: readonly Provider[],
  current?: ProviderRef,
): ProviderRef {
  if (target === MANAGED_OPTION_SLUG) return { kind: "managed" };
  const slug = modelTarget(target, providers);
  const pinned = slug && overrideIsSendable(slug, model) ? model.trim() : "";
  if (target === UNSET_TARGET) {
    // **A slug-less ref round-trips rather than collapsing.** `local:<model>`
    // and `claude-code:<model>` are valid persisted forms with no option in
    // this select to restore to, so `targetForRef` maps them to unset — and
    // unset plus a model meant "pin it to the primary", which would have sent a
    // local model id to a cloud account on a Save that changed nothing. Unset
    // here means *unchanged* for those two; the way out is picking a provider,
    // which is the only way in as well.
    if (current && (current.kind === "local" || current.kind === "claudeCode")) {
      const kept = model.trim();
      return { ...current, model: kept.length > 0 ? kept : undefined };
    }
    return pinned && slug ? parseRef(`${slug}:${pinned}`) : { kind: "default" };
  }
  return parseRef(pinned ? `${target}:${pinned}` : target);
}

/**
 * What the per-workload trigger reads for a chosen target.
 *
 * A function rather than an inline ternary because a select that shows
 * `__unset__` to an operator is the failure this exists to prevent — the same
 * trap `TaskEditDialog` documents for a column id versus its label.
 */
export function targetLabel(target: string, providers: readonly Provider[]): string {
  if (target === UNSET_TARGET) return primaryLabel(providers);
  if (target === MANAGED_OPTION_SLUG) return MANAGED_TARGET_LABEL;
  return providers.find((p) => p.slug === target)?.label ?? target;
}

/** The select value a stored ref restores to. */
export function targetForRef(ref: ProviderRef): string {
  if (ref.kind === "managed") return MANAGED_OPTION_SLUG;
  if (ref.kind === "cloud") return ref.providerSlug;
  return UNSET_TARGET;
}

/**
 * Whether the thing a row names can actually serve it.
 *
 * `null` is healthy. The other three are the resolutions that had no rendering:
 * `parked` is the host's `Resolution::Disabled` — the provider is held and
 * switched off, which is reversible; `missing` is `Resolution::Missing` —
 * nothing by that name is held at all; `dead` is the company-wide dead end,
 * where the row resolves somewhere that resolves to nothing.
 */
export type RowState = "parked" | "missing" | "dead" | null;

/** What a row's value column reads, what its button says, and whether it works. */
export interface RowValue {
  value: string;
  action: "Change Model" | "Choose Model";
  state: RowState;
}

/** The sentence a row in each unhealthy state carries. */
export function rowStateNote(state: RowState): string | null {
  switch (state) {
    case "parked":
      return "Switched off — this workload is parked until it is switched back on.";
    case "missing":
      return "This company has no provider by that name, so the workload fails.";
    case "dead":
      return "Nothing is switched on and Managed is not set up, so this workload cannot run.";
    default:
      return null;
  }
}

/**
 * What a row's value column reads, and what its button says.
 *
 * The button is **Change Model** when something is set and **Choose Model**
 * when nothing is, because those are two different invitations.
 */
export function rowValue(
  ref: ProviderRef,
  providers: readonly Provider[],
  managedConfigured?: boolean,
): RowValue {
  switch (ref.kind) {
    case "default":
      // Not "No model selected". An unset row is not a gap — it resolves
      // somewhere, and naming where is the difference between a screen that
      // reports routing and one that hides half of it.
      return {
        value: primaryLabel(providers, managedConfigured),
        action: "Choose Model",
        state: nothingCanAnswer(providers, managedConfigured) ? "dead" : null,
      };
    case "managed":
      return {
        value: MANAGED_TARGET_LABEL,
        action: "Change Model",
        // A row the operator deliberately pointed at a brain that resolves to
        // nothing. `Resolution::Managed` is served unconditionally on the turn
        // path, so this is the only place the operator can learn it will fail.
        state: managedConfigured === false ? "dead" : null,
      };
    case "cloud": {
      const target = providers.find((p) => p.slug === ref.providerSlug);
      const label = target?.label ?? ref.providerSlug;
      return {
        value: ref.model ? `${label} · ${ref.model}` : label,
        action: "Change Model",
        // `Resolution::Missing` and `Resolution::Disabled` — two of the five
        // resolutions, and until now neither had any rendering at all. Both are
        // *reported* states rather than silent demotions (the turn fails closed
        // rather than moving the spend), so the row is the only surface that can
        // say so before the turn does.
        state: !target ? "missing" : target.enabled ? null : "parked",
      };
    }
    case "local":
      return {
        value: ref.model ? `Local · ${ref.model}` : "Local",
        action: "Change Model",
        state: categoryState(providers, "local"),
      };
    case "claudeCode":
      return {
        value: ref.model ? `Claude Code · ${ref.model}` : "Claude Code",
        action: "Change Model",
        state: categoryState(providers, "cli"),
      };
  }
}

/**
 * A slug-less ref names a **category**, not a record, so its health is the
 * category's: parked once every runtime of that kind is switched off, missing
 * once none is held at all.
 *
 * Kept in step with the host's `resolve_by_category`, which answers the same
 * three ways for the same three inputs.
 */
function categoryState(providers: readonly Provider[], category: "local" | "cli"): RowState {
  const of = providers.filter((p) => categoryOf(p.kind) === category);
  if (of.length === 0) return "missing";
  return of.some((p) => p.enabled) ? null : "parked";
}

/**
 * Applies one provider and model to every row — what Use Your Own Models does.
 *
 * Written as a whole-map replacement rather than a loop at the call site so the
 * "every row, not some rows" part is the function's contract instead of a
 * component's discipline.
 */
/**
 * The provider and model an **own**-mode table is describing — the inverse of
 * {@link applyToEveryWorkload}.
 *
 * Without it the shared-model form saves correctly and then shows nothing back:
 * an operator sets a provider and a model, saves, returns to the tab, and finds
 * an empty select with Save disabled while the store holds exactly what they
 * chose. Nothing is lost, but "my save did not stick" is what it reads as, and
 * that is indistinguishable from the routing table being inert — which is the
 * bug it sat next to.
 *
 * Blank when the rows do not agree, which is the same condition
 * the host's `infer_routing_mode` calls `advanced`: there is no single provider to show
 * and inventing one from the first row would misreport the other three.
 */
export function ownModeDraft(routing: RoutingMap): { slug: string; model: string } {
  const refs = WORKLOADS.map((w) => refFor(routing, w));
  const first = refs[0];
  if (!first || first.kind !== "cloud") return { slug: "", model: "" };
  const signature = refSignature(first);
  if (!refs.every((r) => refSignature(r) === signature)) return { slug: "", model: "" };
  // `model` is optional and blank is meaningful — it means "send the tier and
  // let the endpoint resolve it" — so an absent one becomes the empty string the
  // field renders, never a placeholder.
  return { slug: first.providerSlug, model: first.model ?? "" };
}

export function applyToEveryWorkload(providerSlug: string, model?: string): RoutingMap {
  const ref: ProviderRef = { kind: "cloud", providerSlug, model };
  return Object.fromEntries(WORKLOADS.map((w) => [w, ref])) as RoutingMap;
}
