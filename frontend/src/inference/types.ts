// The shapes the inference surfaces pass around.
//
// Types only — no values, no behaviour. Kept apart from `routing.ts` and
// `classify.ts` so those stay readable as *decisions*, which is the whole reason
// they are separate from the components that render them.
//
// The credential rule, restated here because this is where someone would add a
// field to one of these: **no shape in this file carries a key.** The wire
// carries `keyConfigured: boolean` and nothing else. Four independent mechanisms
// keep credentials off the wire in this subsystem, and the easiest way to break
// all four at once is to put one on a record for convenience.

/** How a provider expects its credential presented. */
export type AuthStyle = "bearer" | "anthropic" | "none";

/** Which of the three questions a provider answers. */
export type ProviderCategory = "cloud" | "local" | "cli";

/**
 * One configured way for this company to reach a model.
 *
 * `id` is identity and survives a rename; `slug` is the address an operator
 * reads and hand-edits in a routing entry. They are two fields because they
 * answer two questions.
 */
export interface Provider {
  /** Stable, opaque. Never shown. */
  id: string;
  /** Routing key. Unique per company. What a routing entry names. */
  slug: string;
  /** Display label. Never used in routing. */
  label: string;
  /** Provider kind — a catalogue slug, or a legacy manifest kind. */
  kind: string;
  /** Resolved OpenAI-compatible base URL. */
  baseUrl: string;
  /** Abstract tier → concrete model id. */
  models: Record<string, string>;
  /** Whether this is available for routing. Distinct from deleted. */
  enabled: boolean;
  /** Whether a credential is stored — **never the credential**. */
  keyConfigured: boolean;
  /**
   * Whether an **unset** workload goes through this one.
   *
   * The resolved answer rather than the raw marker: a company that has never
   * said which provider is its default reports its first enabled one here,
   * because that is what it has always resolved to. So a row can say "Default"
   * without the console knowing whether it was chosen or inherited — and the
   * operator sees the same answer either way.
   *
   * Optional because an older host does not send it.
   */
  isDefault?: boolean;
  /**
   * Which slot this record lives in.
   *
   * `entryZero` is the pre-list company's single `inference/config` blob,
   * surfaced as element 0 of the list. It refuses edit, remove and disable with
   * three separate 400s — correct rules, and the console could not tell which row
   * they applied to, so it rendered all three controls live and every one of them
   * was a round trip to a refusal.
   *
   * Optional because an older host does not send it; absent reads as `indexed`,
   * which is what every row was treated as before.
   */
  origin?: "entryZero" | "indexed";
  /** The last thing the system learnt about reaching it, if anything. */
  health?: ProviderHealth;
}

/**
 * What the system last learnt about reaching a provider.
 *
 * Sourced from things that already happen — the add-time probe, the manual
 * Test, and the turn path's own 401 — rather than from a poller. A poller costs
 * a request per provider per interval across every company on the host, to learn
 * something the next real turn learns for free.
 */
export interface ProviderHealth {
  /** `ok`, or the probe class of the last failure. */
  state: "ok" | ProbeClass;
  /** When it was learnt, ISO-8601. */
  at: string;
}

/** What a failed check means. See `classify.ts` for the copy each one gets. */
export type ProbeClass = "auth" | "model" | "quota" | "endpoint" | "timeout" | "unknown";

/** A workload that owns a routing row. */
export type Workload = "chat" | "reasoning" | "agentic" | "vision";

/**
 * What one routing row points at.
 *
 * `managed` and `default` are different states on purpose: one is a choice, the
 * other is an absence. Collapsing them loses the ability to say "this row is
 * deliberately managed" as distinct from "this row was never set".
 */
export type ProviderRef =
  | { kind: "managed" }
  | { kind: "default" }
  | { kind: "cloud"; providerSlug: string; model?: string }
  | { kind: "local"; model?: string }
  | { kind: "claudeCode"; model?: string };

/** Workload → what it routes through. A workload absent from the map is unset. */
export type RoutingMap = Partial<Record<Workload, ProviderRef>>;

/**
 * The routing modes. **Inferred host-side from the routes, never stored.**
 *
 * `unset` is not a mode an operator picks — it is the absence of one. The host
 * reports it when every row is managed-or-empty *and* the managed chain resolves
 * to nothing, which used to be reported as `managed`: the screen said Managed
 * while the turn went to whichever provider happened to be first enabled, and on
 * a company whose only provider had just been added that turn was the reported
 * `404 model: agentic-v1`.
 */
export type RoutingMode = "managed" | "own" | "advanced" | "unset";
