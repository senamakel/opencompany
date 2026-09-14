import { describe, expect, it } from "vitest";

import { categoryOf } from "@/inference/catalogue";
import {
  ADVANCED_INTRO,
  MODE_COPY,
  WORKLOADS,
  WORKLOAD_COPY,
  WORKLOAD_TIER,
  applyToEveryWorkload,
  formatRef,
  inferRoutingMode,
  MANAGED_TARGET_LABEL,
  UNSET_TARGET,
  modelTarget,
  ownModeDraft,
  parseRef,
  modelAfterProviderChange,
  refForTarget,
  removalImpact,
  removalWarnings,
  routingOptions,
  targetForRef,
  targetLabel,
  refSignature,
  routingTargets,
  rowValue,
  rowStateNote,
  scrubOnRemove,
  NOTHING_ANSWERS,
  nothingCanAnswer,
  orphanedRouteNote,
  primaryLabel,
  providerRoutingState,
  routingBadge,
  tierLabel,
} from "@/inference/routing";
import type { RemovalImpact } from "@/inference/routing";
import type { Provider, ProviderRef, RoutingMap } from "@/inference/types";

/**
 * Manage Routing, as decisions.
 *
 * Every case here is a branch that would otherwise only be reachable through a
 * rendered screen. They are the rules the Rust resolver holds for the turn path,
 * asserted on the side that has to draw a row before any request is made.
 */

function provider(slug: string, kind: string, enabled = true): Provider {
  return {
    id: `prv_${slug}`,
    slug,
    label: slug,
    kind,
    baseUrl: `https://${slug}.example/v1`,
    models: {},
    enabled,
    keyConfigured: true,
  };
}

describe("the rows the routing screen ships", () => {
  it("has one row per tier the runtime actually has", () => {
    expect(WORKLOADS).toEqual(["chat", "reasoning", "agentic", "vision"]);
    const tiers = WORKLOADS.map((w) => WORKLOAD_TIER[w]);
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it("has no coding row, because it would write the agentic tier twice", () => {
    // Two editable rows over one tier means setting one silently changes the
    // other — the inheritance bug in a different hat.
    expect(WORKLOADS).not.toContain("coding");
    expect(WORKLOAD_COPY.agentic.description).toContain("coding");
  });

  it("keeps the recommendation hint on every row", () => {
    // The hints are what make this screen usable by someone who has never
    // chosen a model. They are the first thing a rewrite would drop.
    for (const workload of WORKLOADS) {
      expect(WORKLOAD_COPY[workload].hint.length).toBeGreaterThan(40);
      expect(WORKLOAD_COPY[workload].label).toBeTruthy();
      expect(WORKLOAD_COPY[workload].description).toBeTruthy();
    }
  });

  it("names this product in the managed description, not the one the copy came from", () => {
    expect(MODE_COPY.managed.description).toContain("TinyHumans");
    expect(MODE_COPY.managed.description).not.toContain("OpenHuman");
    expect(ADVANCED_INTRO).toContain("Managed");
  });
});

describe("the hand-editable route grammar", () => {
  it("round-trips through a person", () => {
    const cases = ["", "managed", "acme", "acme:gpt-5", "local:llama3.1", "claude-code:opus"];
    for (const raw of cases) {
      expect(formatRef(parseRef(raw))).toBe(raw === "default" ? "" : raw);
    }
  });

  it("reads an empty value as unset rather than as a parse failure", () => {
    // Deleting the text is how an operator says "nothing here".
    expect(parseRef("")).toEqual({ kind: "default" });
    expect(parseRef("   ")).toEqual({ kind: "default" });
    expect(parseRef("default")).toEqual({ kind: "default" });
  });

  it("reads a trailing colon as a slug with no model", () => {
    expect(parseRef("acme:")).toEqual({ kind: "cloud", providerSlug: "acme", model: undefined });
  });

  it("gives two refs that mean the same thing the same signature", () => {
    // Structural equality would say no for an absent versus undefined model.
    expect(refSignature({ kind: "cloud", providerSlug: "acme" })).toBe(
      refSignature({ kind: "cloud", providerSlug: "acme", model: undefined }),
    );
    expect(refSignature({ kind: "default" })).toBe("default");
  });
});

/*
 * `orphanedRoutes` and its test are gone with the function. It was a green
 * suite over a rule the product did not follow: the host reports orphans on
 * `GET …/inference/routes` and the console renders `state.orphaned`, so the
 * console's copy was never called by anything.
 */

describe("inferring the mode the routes describe", () => {
  // The rendered mode is normally the host's. This is the fallback
  // `use-inference` uses when `GET …/inference/routes` is the response that did
  // not arrive — a member's 403, or a failed re-read after a provider write —
  // so it has to answer what `infer_routing_mode` would have answered. These
  // mirror its own tests in `src/company/inference/resolve.rs`.
  const every = (ref: ProviderRef): RoutingMap =>
    Object.fromEntries(WORKLOADS.map((w) => [w, ref])) as RoutingMap;

  it("reads an all-default table as Managed only when Managed resolves", () => {
    // The distinction the `unset` mode exists for: a company that has chosen
    // nothing and has nothing behind Managed has not chosen Managed, and saying
    // it did is the claim that put a selected radio on a card badged Not set up.
    expect(inferRoutingMode({} as RoutingMap, true)).toBe("managed");
    expect(inferRoutingMode({} as RoutingMap, false)).toBe("unset");
  });

  it("treats an explicit managed row beside unset ones the same way", () => {
    const partial = { chat: { kind: "managed" } } as RoutingMap;
    expect(inferRoutingMode(partial, true)).toBe("managed");
    expect(inferRoutingMode(partial, false)).toBe("unset");
  });

  it("reads four rows pointing at one provider as Own, whatever Managed does", () => {
    const own = every({ kind: "cloud", providerSlug: "acme", model: "gpt-5" });
    expect(inferRoutingMode(own, true)).toBe("own");
    expect(inferRoutingMode(own, false)).toBe("own");
  });

  it("ignores an absent versus undefined model when comparing rows", () => {
    // `refSignature`, not structural equality — the reason that helper exists.
    const own = {
      ...every({ kind: "cloud", providerSlug: "acme" }),
      chat: { kind: "cloud", providerSlug: "acme", model: undefined },
    } as RoutingMap;
    expect(inferRoutingMode(own, true)).toBe("own");
  });

  it("reads rows that disagree as Advanced", () => {
    const mixed = {
      ...every({ kind: "cloud", providerSlug: "acme" }),
      vision: { kind: "managed" },
    } as RoutingMap;
    expect(inferRoutingMode(mixed, true)).toBe("advanced");
    expect(inferRoutingMode(mixed, false)).toBe("advanced");
  });
});

describe("scrubbing the routes a removal orphans", () => {
  it("matches a cloud provider precisely by slug", () => {
    const routing: RoutingMap = {
      chat: { kind: "cloud", providerSlug: "acme", model: "gpt-5" },
      reasoning: { kind: "cloud", providerSlug: "openrouter", model: "big" },
    };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("acme", "openai_compatible"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
    expect(next.reasoning).toEqual({ kind: "cloud", providerSlug: "openrouter", model: "big" });
  });

  it("scrubs a CLI login's slug-less routes", () => {
    // Without this, disconnecting Claude Code left workloads pinned to
    // `claude-code:<model>`, which the resolver still honours — so chats kept
    // using the CLI after the provider was removed.
    const routing: RoutingMap = { chat: { kind: "claudeCode", model: "opus" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("claude-code", "claude-code"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
  });

  it("leaves a local route alone while another local runtime remains", () => {
    const routing: RoutingMap = { chat: { kind: "local", model: "llama3.1" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("ollama", "ollama"),
      [provider("lmstudio", "lmstudio")],
      categoryOf,
    );
    expect(reset).toEqual([]);
    expect(next.chat).toEqual({ kind: "local", model: "llama3.1" });
  });

  it("scrubs a local route once no local runtime remains", () => {
    // And before this rule existed the local case was silently a no-op.
    const routing: RoutingMap = { chat: { kind: "local", model: "llama3.1" } };
    const { routing: next, reset } = scrubOnRemove(
      routing,
      provider("ollama", "ollama"),
      [provider("openrouter", "openrouter")],
      categoryOf,
    );
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
  });

  it("never touches a managed or unset row", () => {
    const routing: RoutingMap = { chat: { kind: "managed" }, vision: { kind: "default" } };
    const { reset } = scrubOnRemove(
      routing,
      provider("acme", "openai_compatible"),
      [],
      categoryOf,
    );
    expect(reset).toEqual([]);
  });
});

describe("what a row offers and reads", () => {
  it("says Choose Model when nothing is set and Change Model when something is", () => {
    // An unset row names where it will actually go. "No model selected" said
    // nothing about a row that still resolves somewhere, on the one screen whose
    // job is to say where work goes.
    expect(rowValue({ kind: "default" }, [])).toEqual({
      value: "Primary (Managed)",
      action: "Choose Model",
      state: null,
    });
    expect(rowValue({ kind: "managed" }, []).action).toBe("Change Model");
  });

  it("names the primary an unset row resolves through, and follows the marker", () => {
    const openrouter = { ...provider("openrouter", "openrouter"), label: "OpenRouter" };
    const acme = { ...provider("acme", "openai_compatible"), label: "Acme gateway" };
    expect(rowValue({ kind: "default" }, [openrouter, acme]).value).toBe("Primary (OpenRouter)");
    // Marked, it moves — read on every render rather than cached.
    expect(
      rowValue({ kind: "default" }, [openrouter, { ...acme, isDefault: true }]).value,
    ).toBe("Primary (Acme gateway)");
    // A disabled marked provider is not a routing target, so it is not the
    // primary either.
    expect(
      rowValue({ kind: "default" }, [openrouter, { ...acme, isDefault: true, enabled: false }])
        .value,
    ).toBe("Primary (OpenRouter)");
  });

  it("names the provider by its label, not its slug", () => {
    const acme = { ...provider("acme", "openai_compatible"), label: "Acme gateway" };
    expect(rowValue({ kind: "cloud", providerSlug: "acme", model: "gpt-5" }, [acme]).value).toBe(
      "Acme gateway · gpt-5",
    );
  });

  it("falls back to the slug for a provider it cannot find", () => {
    expect(rowValue({ kind: "cloud", providerSlug: "ghost" }, []).value).toBe("ghost");
  });

  it("does not offer a disabled provider as a routing target", () => {
    const providers = [provider("openrouter", "openrouter"), provider("acme", "openai_compatible", false)];
    expect(routingTargets(providers).map((p) => p.slug)).toEqual(["openrouter"]);
  });
});

describe("ownModeDraft", () => {
  it("reads back what applyToEveryWorkload wrote", () => {
    // The round trip is the whole property: the shared-model form saved
    // correctly and then rendered empty, which reads as a lost save and is
    // indistinguishable from the routing table being inert.
    const saved = applyToEveryWorkload("anthropic", "claude-sonnet-5");
    expect(ownModeDraft(saved)).toEqual({ slug: "anthropic", model: "claude-sonnet-5" });
  });

  it("keeps a blank model blank rather than inventing a placeholder", () => {
    // Blank means "send the tier and let the endpoint resolve it" — a real
    // state of the field, not an absence to be filled in.
    const saved = applyToEveryWorkload("openrouter");
    expect(ownModeDraft(saved)).toEqual({ slug: "openrouter", model: "" });
  });

  it("is blank when the rows disagree", () => {
    // The same condition the host's `infer_routing_mode` calls advanced.
    // Showing the first row's provider here would misreport the other three.
    const mixed = {
      ...applyToEveryWorkload("openrouter", "gpt-5"),
      vision: parseRef("anthropic:claude-sonnet-5"),
    } as RoutingMap;
    expect(ownModeDraft(mixed)).toEqual({ slug: "", model: "" });
  });

  it("is blank for a managed or unset table, which own mode does not describe", () => {
    const managed = Object.fromEntries(
      WORKLOADS.map((w) => [w, { kind: "managed" } as const]),
    ) as RoutingMap;
    expect(ownModeDraft(managed)).toEqual({ slug: "", model: "" });
    expect(ownModeDraft({} as RoutingMap)).toEqual({ slug: "", model: "" });
  });
});

describe("the per-workload select", () => {
  const connected = [provider("openrouter", "openrouter"), provider("anthropic", "anthropic")];

  it("lists providers only — the primary is never a second entry", () => {
    // Three connected providers, three options. It used to list five: the unset
    // row's own display (`Primary (OpenRouter)`) and a second Managed sentinel,
    // both beside the real rows, two of them naming the same account.
    const options = routingOptions(connected);
    expect(options.map((o) => o.slug)).toEqual(["tinyhumans", "openrouter", "anthropic"]);
    expect(options[0].label).toBe(MANAGED_TARGET_LABEL);
    expect(options.some((o) => o.slug === UNSET_TARGET)).toBe(false);
  });

  it("lists managed once even when it is also a provider record", () => {
    // A company whose entry zero is the managed config has a `tinyhumans` row of
    // its own. One identity, one entry.
    const options = routingOptions([provider("tinyhumans", "managed"), ...connected]);
    expect(options.filter((o) => o.slug === "tinyhumans")).toHaveLength(1);
  });

  it("round-trips a slugless local route instead of pinning it to the primary", () => {
    // `local:<model>` is a valid persisted form with no option in the select to
    // restore to, so `targetForRef` maps it to unset — and unset plus a model
    // used to mean "pin it to the primary", which sent a local model id to a
    // cloud account on a Save that changed nothing.
    const local: ProviderRef = { kind: "local", model: "llama3" };
    expect(targetForRef(local)).toBe(UNSET_TARGET);
    expect(refForTarget(UNSET_TARGET, "llama3", connected, local)).toEqual(local);
    // An edited model stays on the same runtime rather than moving provider.
    expect(refForTarget(UNSET_TARGET, "mistral", connected, local)).toEqual({
      kind: "local",
      model: "mistral",
    });
    // And picking a provider is still how you leave it.
    expect(refForTarget("openrouter", "", connected, local)).toEqual({
      kind: "cloud",
      providerSlug: "openrouter",
      model: undefined,
    });
  });

  it("marks Managed unpickable when it cannot serve a turn", () => {
    // Routing a workload there while it is switched off or unresolved saves
    // successfully and then fails every turn — a click that reports the
    // opposite of what it did.
    const off = routingOptions(connected, { configured: true, enabled: false });
    expect(off[0].slug).toBe("tinyhumans");
    expect(off[0].unavailable).toBe(true);

    const unset = routingOptions(connected, { configured: false, enabled: true });
    expect(unset[0].unavailable).toBe(true);

    // Usable, and unknown — which is what every caller meant before the
    // argument existed — both stay pickable.
    expect(routingOptions(connected, { configured: true, enabled: true })[0].unavailable).toBe(
      false,
    );
    expect(routingOptions(connected)[0].unavailable).toBe(false);
  });

  it("does not promise a fallback Managed cannot provide", () => {
    const impact: RemovalImpact = {
      routed: [],
      isDefault: true,
      lastEnabled: true,
      defaultMovesTo: null,
    };
    const available = removalWarnings("provider", "Anthropic", impact, {
      configured: true,
      enabled: true,
    }).join(" ");
    expect(available).toContain("falls back to Managed");
    expect(available).toContain("only thing that can answer");

    const off = removalWarnings("provider", "Anthropic", impact, {
      configured: true,
      enabled: false,
    }).join(" ");
    expect(off).not.toContain("falls back to Managed");
    expect(off).toContain("nothing to think with");
  });

  it("gives Default and the provider it resolves to the same field shape", () => {
    // The bug this closes: `Primary (OpenRouter)` showed no Model id field and
    // `OpenRouter` did, for two names of one provider.
    expect(modelTarget(UNSET_TARGET, connected)).toBe("openrouter");
    expect(modelTarget("openrouter", connected)).toBe("openrouter");
    expect(modelTarget(UNSET_TARGET, connected)).toBe(modelTarget("openrouter", connected));
  });

  it("follows the marked default, not list order, when resolving unset", () => {
    const marked = [
      provider("openrouter", "openrouter"),
      { ...provider("anthropic", "anthropic"), isDefault: true },
    ];
    expect(modelTarget(UNSET_TARGET, marked)).toBe("anthropic");
  });

  it("offers no model id for managed, under either of its names", () => {
    // A `managed` ref carries no model in the route grammar, so a field there
    // could only be discarded on save — and both synonyms have to agree.
    expect(modelTarget("tinyhumans", connected)).toBeNull();
    expect(modelTarget(UNSET_TARGET, [])).toBeNull();
  });

  it("stays unset while the model is blank, and pins when one is chosen", () => {
    expect(refForTarget(UNSET_TARGET, "", connected)).toEqual({ kind: "default" });
    expect(refForTarget(UNSET_TARGET, "   ", connected)).toEqual({ kind: "default" });
    expect(refForTarget(UNSET_TARGET, "gpt-5", connected)).toEqual({
      kind: "cloud",
      providerSlug: "openrouter",
      model: "gpt-5",
    });
    expect(refForTarget("anthropic", "claude-sonnet-5", connected)).toEqual({
      kind: "cloud",
      providerSlug: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(refForTarget("tinyhumans", "gpt-5", connected)).toEqual({ kind: "managed" });
  });

  it("round-trips a stored ref back to the value the select shows", () => {
    expect(targetForRef({ kind: "default" })).toBe(UNSET_TARGET);
    expect(targetForRef({ kind: "managed" })).toBe("tinyhumans");
    expect(targetForRef(parseRef("anthropic:claude-sonnet-5"))).toBe("anthropic");
  });

  it("never shows a sentinel to an operator", () => {
    // The helper labels a provider by its slug, so these read lowercase — the
    // point is that neither sentinel reaches the screen.
    expect(targetLabel(UNSET_TARGET, connected)).toBe("Primary (openrouter)");
    expect(targetLabel("tinyhumans", connected)).toBe(MANAGED_TARGET_LABEL);
    expect(targetLabel("anthropic", connected)).toBe("anthropic");
  });
});

describe("what a removal costs", () => {
  const openrouter = { ...provider("openrouter", "openrouter"), isDefault: true };
  const anthropic = provider("anthropic", "anthropic");
  const providers = [openrouter, anthropic];

  it("names the workloads whose routes would reset", () => {
    const routing = {
      ...applyToEveryWorkload("anthropic", "claude-sonnet-5"),
      chat: parseRef("openrouter:gpt-5"),
    } as RoutingMap;
    const impact = removalImpact(anthropic, providers, routing, categoryOf);
    expect(impact.routed).toEqual(["reasoning", "agentic", "vision"]);
    expect(impact.isDefault).toBe(false);
    expect(impact.lastEnabled).toBe(false);
  });

  it("notices the default and the last provider switched on", () => {
    const impact = removalImpact(openrouter, [openrouter], {} as RoutingMap, categoryOf);
    expect(impact.isDefault).toBe(true);
    expect(impact.lastEnabled).toBe(true);
  });

  it("says removing a key is not removing a provider, either way round", () => {
    const impact: RemovalImpact = {
      routed: [],
      isDefault: false,
      lastEnabled: false,
      defaultMovesTo: null,
    };
    const key = removalWarnings("key", "Anthropic", impact)[0];
    const provider_ = removalWarnings("provider", "Anthropic", impact)[0];
    expect(key).toContain("stays on this page");
    expect(provider_).toContain("deletes Anthropic");
    expect(key).not.toEqual(provider_);
  });

  it("warns about the default on the action that moves it", () => {
    // The operator who removed their default provider was not told the default
    // had relocated. Silence there is a company's unrouted spend moving accounts.
    const lines = removalWarnings("provider", "Anthropic", {
      routed: [],
      isDefault: true,
      lastEnabled: false,
      defaultMovesTo: "OpenRouter",
    });
    expect(lines.some((l) => l.includes("default"))).toBe(true);
  });

  it("counts the routed workloads in words an operator can act on", () => {
    const one = removalWarnings("provider", "Anthropic", {
      routed: ["chat"],
      isDefault: false,
      lastEnabled: false,
      defaultMovesTo: null,
    });
    expect(one.some((l) => l.includes("One workload routes") && l.includes("Chat"))).toBe(true);
    const many = removalWarnings("provider", "Anthropic", {
      routed: ["chat", "vision"],
      isDefault: false,
      lastEnabled: false,
      defaultMovesTo: null,
    });
    expect(many.some((l) => l.includes("2 workloads route"))).toBe(true);
  });

  it("only mentions the last-provider case where it is true and relevant", () => {
    const impact: RemovalImpact = {
      routed: [],
      isDefault: false,
      lastEnabled: true,
      defaultMovesTo: null,
    };
    expect(removalWarnings("provider", "Anthropic", impact).some((l) => l.includes("only provider"))).toBe(true);
    // Clearing a credential does not remove the row, so it is still the only
    // provider switched on afterwards.
    expect(removalWarnings("key", "Anthropic", impact).some((l) => l.includes("only provider"))).toBe(false);
  });
});

describe("modelAfterProviderChange", () => {
  it("drops a model id when the provider changes", () => {
    // `claude-haiku-4-5-20251001` is meaningless at OpenRouter, and the field
    // was silently dropping into free-text mode rather than saying so — the
    // "wrong model at the wrong provider" failure, arriving through the form.
    expect(modelAfterProviderChange("claude-haiku-4-5-20251001", "anthropic", "openrouter")).toBe(
      "",
    );
  });

  it("keeps it when the provider has not changed", () => {
    // Not the mid-keystroke rule: re-selecting the same provider is not an edit.
    expect(modelAfterProviderChange("gpt-5", "openrouter", "openrouter")).toBe("gpt-5");
  });

  it("leaves blank blank, which is a working route everywhere", () => {
    expect(modelAfterProviderChange("", "anthropic", "openrouter")).toBe("");
  });
});

describe("where the default goes when a provider is removed", () => {
  it("names the provider that will actually hold it", () => {
    const anthropic = { ...provider("anthropic", "anthropic"), isDefault: true };
    const openrouter = provider("openrouter", "openrouter");
    const impact = removalImpact(
      anthropic,
      [anthropic, openrouter],
      {} as RoutingMap,
      categoryOf,
    );
    expect(impact.defaultMovesTo).toBe("openrouter");
    const lines = removalWarnings("provider", "Anthropic", impact);
    expect(lines.some((l) => l.includes("moves the default to openrouter"))).toBe(true);
    // One-way, and said so: re-adding the credential did not bring the marker
    // back, and nothing on screen admitted that.
    expect(lines.some((l) => l.includes("will not move it back"))).toBe(true);
  });

  it("says so plainly when nothing is left to take it over", () => {
    const only = { ...provider("anthropic", "anthropic"), isDefault: true };
    const impact = removalImpact(only, [only], {} as RoutingMap, categoryOf);
    expect(impact.defaultMovesTo).toBeNull();
    expect(
      removalWarnings("provider", "Anthropic", impact).some((l) => l.includes("Managed")),
    ).toBe(true);
  });
});

describe("removing a local runtime", () => {
  it("scrubs the routes that name it by slug", () => {
    // `ollama:llama3` parses as a cloud ref because it carries a slug, while
    // `categoryOf("ollama")` is local — so gating the cloud arm on the category
    // meant the two rules never met and removal scrubbed nothing. The routing
    // table on disk then became unsaveable, because the host fails closed on a
    // route naming a provider nobody holds.
    const ollama = provider("ollama", "ollama");
    const openrouter = provider("openrouter", "openrouter");
    const routing = {
      chat: parseRef("ollama:llama3"),
      reasoning: parseRef("openrouter:gpt-5"),
    } as RoutingMap;

    const { routing: next, reset } = scrubOnRemove(routing, ollama, [openrouter], categoryOf);
    expect(reset).toEqual(["chat"]);
    expect(next.chat).toEqual({ kind: "default" });
    expect(next.reasoning).toEqual(parseRef("openrouter:gpt-5"));
    expect(next.chat).toEqual({ kind: "default" });
  });

  it("leaves a slug-less local route alone while another runtime serves it", () => {
    const ollama = provider("ollama", "ollama");
    const lmstudio = provider("lmstudio", "lmstudio");
    const routing = { chat: parseRef("local:llama3") } as RoutingMap;
    expect(scrubOnRemove(routing, ollama, [lmstudio], categoryOf).reset).toEqual([]);
    expect(scrubOnRemove(routing, ollama, [], categoryOf).reset).toEqual(["chat"]);
  });
});

describe("the false Managed floor", () => {
  /**
   * `primaryLabel` printed `Primary (Managed)` whenever nothing was enabled —
   * the smallest, most concrete instance of treating Managed as an
   * always-available fallback. Here it needs a credential and can resolve to
   * nothing, and that string then named a destination that does not exist while
   * every turn failed.
   */
  it("stops naming Managed as a destination when Managed cannot answer", () => {
    expect(primaryLabel([], false)).toBe(NOTHING_ANSWERS);
    expect(primaryLabel([], true)).toBe("Primary (Managed)");
  });

  it("keeps the old answer when the host did not say, rather than inventing a dead end", () => {
    // An older host sends no `configured`. Claiming a company cannot think on
    // the strength of a field nobody sent is the same mistake pointing the
    // other way.
    expect(primaryLabel([])).toBe("Primary (Managed)");
  });

  it("says nothing can answer only when nothing actually can", () => {
    const off = provider("anthropic", "anthropic", false);
    const on = provider("anthropic", "anthropic");
    expect(nothingCanAnswer([off], false)).toBe(true);
    expect(nothingCanAnswer([on], false)).toBe(false);
    expect(nothingCanAnswer([off], true)).toBe(false);
    expect(nothingCanAnswer([], undefined)).toBe(false);
  });

  it("does not reassure that Managed will take over when it cannot", () => {
    const only = provider("anthropic", "anthropic");
    const impact = removalImpact(only, [only], {} as RoutingMap, categoryOf);
    expect(impact.lastEnabled).toBe(true);
    // Two different ways Managed cannot answer, and the sentence has to be the
    // same for both: a chain that resolves to nothing, and a switch that is off.
    for (const managed of [{ configured: false }, { enabled: false }]) {
      const lines = removalWarnings("provider", "Anthropic", impact, managed);
      expect(lines.some((l) => l.includes("nothing to think with"))).toBe(true);
      expect(lines.some((l) => l.includes("leaves Managed as the only thing"))).toBe(false);
    }
    // And the reassurance is printed where it is true.
    expect(
      removalWarnings("provider", "Anthropic", impact, { configured: true, enabled: true }).some(
        (l) => l.includes("leaves Managed as the only thing"),
      ),
    ).toBe(true);
  });
});

describe("the resolutions that had no rendering", () => {
  it("marks a row pointed at a switched-off provider as parked", () => {
    const off = provider("anthropic", "anthropic", false);
    const row = rowValue(parseRef("anthropic:claude-sonnet-5"), [off]);
    expect(row.state).toBe("parked");
    expect(rowStateNote(row.state)).toContain("parked");
  });

  it("marks a row pointed at a provider nobody holds as missing", () => {
    expect(rowValue(parseRef("ghost:gpt-5"), []).state).toBe("missing");
  });

  it("answers for a slug-less ref by its category, like resolve_by_category", () => {
    const ollama = provider("ollama", "ollama");
    expect(rowValue(parseRef("local:llama3"), [ollama]).state).toBeNull();
    expect(
      rowValue(parseRef("local:llama3"), [{ ...ollama, enabled: false }]).state,
    ).toBe("parked");
    expect(rowValue(parseRef("local:llama3"), []).state).toBe("missing");
  });

  it("marks a deliberately managed row dead when Managed resolves to nothing", () => {
    // `Resolution::Managed` is served unconditionally on the turn path, so the
    // row is the only place the operator can learn it will fail.
    expect(rowValue({ kind: "managed" }, [], false).state).toBe("dead");
    expect(rowValue({ kind: "managed" }, [], true).state).toBeNull();
  });

  it("leaves a healthy row unmarked", () => {
    const acme = provider("acme", "openai_compatible");
    expect(rowValue(parseRef("acme:gpt-5"), [acme]).state).toBeNull();
    expect(rowStateNote(null)).toBeNull();
  });
});

describe("routing health on the provider row", () => {
  /**
   * The data was already in the component — `ProvidersTab` builds the same
   * routing map the Routing tab renders — and the row carried no routing badge
   * at all, so "switched off while four workloads route through it" was
   * expressed only by a switch position.
   */
  it("says In use while a routed provider is on, and Parked once it is off", () => {
    const anthropic = provider("anthropic", "anthropic");
    const routing = {
      vision: parseRef("anthropic:claude-sonnet-5"),
    } as RoutingMap;
    expect(providerRoutingState(anthropic, [anthropic], routing)).toBe("inUse");
    expect(
      providerRoutingState(
        { ...anthropic, enabled: false },
        [anthropic],
        routing,
      ),
    ).toBe("parked");
    expect(routingBadge("inUse")).toBe("In use");
    expect(routingBadge("parked")).toBe("Parked");
  });

  it("says nothing about a provider no workload routes through", () => {
    const anthropic = provider("anthropic", "anthropic");
    expect(
      providerRoutingState(anthropic, [anthropic], {} as RoutingMap),
    ).toBeNull();
    expect(routingBadge(null)).toBeNull();
  });

  it("catches a local runtime, which a slug-only match would miss", () => {
    // The bug shape the host's `parked_tiers` had: `route.slug()` is null for a
    // `local:` ref, so disabling the only Ollama reported "Nothing was routed
    // through it" while every local route was in fact parked.
    const ollama = provider("ollama", "ollama");
    const routing = { chat: parseRef("local:llama3") } as RoutingMap;
    expect(providerRoutingState(ollama, [ollama], routing)).toBe("inUse");
  });
});

describe("switching a provider off", () => {
  it("names what is parked in the operator's own words, and is reversible throughout", () => {
    const anthropic = provider("anthropic", "anthropic");
    const routing = applyToEveryWorkload("anthropic", "claude-sonnet-5");
    const impact = removalImpact(anthropic, [anthropic], routing, categoryOf);
    const lines = removalWarnings("disable", "Anthropic", impact, { configured: true });
    expect(lines[0]).toContain("nothing is deleted");
    expect(
      lines.some((l) =>
        l.includes("3 other workloads route through Anthropic"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes("parked until you switch it back on")),
    ).toBe(true);
    // None of Remove's one-way language.
    expect(lines.some((l) => l.includes("deletes"))).toBe(false);
  });

  it("counts one and two workloads without the 'other' phrasing", () => {
    const anthropic = provider("anthropic", "anthropic");
    const one = removalWarnings(
      "disable",
      "Anthropic",
      removalImpact(
        anthropic,
        [anthropic],
        { vision: parseRef("anthropic:x") } as RoutingMap,
        categoryOf,
      ),
      { configured: true },
    );
    expect(one.some((l) => l.includes("Vision routes through Anthropic"))).toBe(
      true,
    );

    const two = removalWarnings(
      "disable",
      "Anthropic",
      removalImpact(
        anthropic,
        [anthropic],
        {
          vision: parseRef("anthropic:x"),
          chat: parseRef("anthropic:x"),
        } as RoutingMap,
        categoryOf,
      ),
      { configured: true },
    );
    expect(
      two.some((l) => l.includes("Chat and Vision route through Anthropic")),
    ).toBe(true);
  });

  it("says the company cannot think when the last provider goes off with no Managed", () => {
    const anthropic = provider("anthropic", "anthropic");
    const impact = removalImpact(
      anthropic,
      [anthropic],
      {} as RoutingMap,
      categoryOf,
    );
    for (const managed of [{ configured: false }, { enabled: false }]) {
      expect(
        removalWarnings("disable", "Anthropic", impact, managed).some((l) =>
          l.includes("agents cannot think"),
        ),
      ).toBe(true);
    }
  });
});

describe("the orphan banner's vocabulary", () => {
  it("names the workload, not the tier id", () => {
    // "`chat-v1` names `ghost`" was the right mechanism in the wrong
    // vocabulary: every other sentence on both tabs says "Chat".
    expect(tierLabel("chat-v1")).toBe("Chat");
    const note = orphanedRouteNote([["chat-v1", "ghost"]]);
    expect(note).toContain("Chat is routed to ghost");
    expect(note).not.toContain("chat-v1");
  });

  it("passes a tier it does not recognise through unchanged", () => {
    expect(tierLabel("embedding-v1")).toBe("embedding-v1");
  });
});
