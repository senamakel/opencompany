// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useHashView } from "@/hooks/use-hash-view";
import { DEFAULT_VIEW, isNavigationActive, VIEWS, type View } from "@/lib/console-routes";
import { REWRITE_RETIRED } from "@/lib/console-route-rewrites";

/**
 * Every surface the console renders has to answer at its own address.
 *
 * Issue #1311: `#/pages` resolved to Overview for four months. #1172 commented
 * the Pages row out of `NAV` and wrote a comment promising the route "stays
 * live", but routing was `NAV` plus a second hand-maintained list, and only the
 * first half of the treatment landed. The shell's `view === "pages"` block, its
 * `lazy()` import and the entire sandboxed-iframe Pages surface behind them
 * were unreachable code the whole time, and nothing said so.
 *
 * These tests import the REAL table from `@/lib/console-routes` rather than
 * transcribing it (which is what `task-route.test.ts` has to do for the shell's
 * `REWRITE_RETIRED`, and why a copy of the route table could rot unobserved).
 */

describe("the console's route table", () => {
  /**
   * The regression itself. Named on its own rather than left to the table below
   * so a failure reads as "Pages is unreachable again" rather than as one row
   * of a loop.
   */
  it("keeps #/pages routable even though Pages has no nav row (#1311)", () => {
    expect(VIEWS).toContain("pages");
  });

  it("retires #/memory from the table after Brain moves under Settings (#1416)", () => {
    // The shell no longer renders a `view === "memory"` block — the browser
    // lives at `#/settings/brain`. The legacy address still works, but it is
    // served by the shell's `REWRITE_RETIRED` (which runs before the
    // allow-list), not by a `memory` view: keeping a table entry for a surface
    // the shell cannot render would break the #1311 invariant that every VIEWS
    // member answers to a render block.
    expect(VIEWS).not.toContain("memory");
  });

  it("has no duplicate entries", () => {
    expect(new Set(VIEWS).size).toBe(VIEWS.length);
  });
});

describe("sidebar navigation", () => {
  it("keeps Work active while a task detail is open (#1354)", () => {
    expect(isNavigationActive("ledgers", "tasks")).toBe(true);
  });

  it("does not make unrelated destinations active", () => {
    expect(isNavigationActive("approvals", "tasks")).toBe(false);
    expect(isNavigationActive("company", "workspace")).toBe(false);
    expect(isNavigationActive("chat", "workflows")).toBe(false);
  });

  it("keeps a card under Work and an agent under Agents", () => {
    // Both are Rule-6 deep-link destinations with no row of their own. Without
    // this the whole section collapses the moment one is opened.
    expect(isNavigationActive("ledgers", "tasks")).toBe(true);
    expect(isNavigationActive("company", "team")).toBe(true);
  });
});

describe("resolving an address", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: [View, string | null];
  let rewrite: typeof REWRITE_RETIRED | undefined;

  // Most assertions exercise the allow-list alone. The unknown-address case
  // opts into the shell's policy below; bare Tasks and Team are deliberately
  // rewritten retired routes, so applying it to every view would make this
  // table assert the opposite of their contracts.
  function Probe() {
    // The shell's own fallback, not a literal: this probe is how the default
    // landing view's contract is asserted, and a copy of it here would be a
    // second opinion that cannot disagree loudly.
    const [view, sub] = useHashView<View>(VIEWS, DEFAULT_VIEW, rewrite);
    seen = [view, sub];
    return null;
  }

  /**
   * One render per test: `useHashView` canonicalizes from a mount effect, so a
   * second `render()` into the same root updates rather than remounts and would
   * report the first address's answer.
   */
  async function visit(hash: string) {
    window.history.replaceState(null, "", hash);
    await act(async () => {
      root.render(createElement(Probe));
    });
  }

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rewrite = undefined;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // Every routable view, including the ones with no nav row. A view dropped
  // from the table lands on Overview silently — a link that quietly shows
  // Overview looks like a link that worked — so each one is asserted, not just
  // the one #1311 was filed about.
  it.each(VIEWS)("resolves #/%s to itself and leaves the address alone", async (view) => {
    await visit(`#/${view}`);
    expect(seen).toEqual([view, null]);
    expect(window.location.hash).toBe(`#/${view}`);
  });

  it("carries a sub-page through for a hidden view's deep link", async () => {
    // `#/team/<agentId>` and `#/pages` are hidden for the same reason and would
    // fail the same way: an unknown head discards its sub-page too.
    await visit("#/team/agent-1");
    expect(seen).toEqual(["team", "agent-1"]);
    expect(window.location.hash).toBe("#/team/agent-1");
  });

  it("explains an address that names nothing instead of silently showing Overview (#1417)", async () => {
    // The route remains safe — an unknown head is never accepted as a real
    // page — but it now reaches a named explanation rather than pretending the
    // operator asked for Overview.
    rewrite = REWRITE_RETIRED;
    await visit("#/nope");
    expect(seen).toEqual(["not-found", "nope"]);
    expect(window.location.hash).toBe("#/not-found/nope");
  });

  it("404s the retired #/conversation instead of rewriting it onto Room", async () => {
    // Room replaced the desk transcript, but `#/conversation` names no channel,
    // so there is no address to rewrite it onto: a bare redirect would drop an
    // operator on whichever channel Room defaults to and read as a link that
    // worked. It is retired by removal from the `View` union, which is what
    // takes it out of `VIEWS` and lands it on the same explanation any other
    // unrecognized head gets.
    rewrite = REWRITE_RETIRED;
    expect(VIEWS).not.toContain("conversation");
    await visit("#/conversation");
    expect(seen).toEqual(["not-found", "conversation"]);
    expect(window.location.hash).toBe("#/not-found/conversation");
  });

  // Retired top-level addresses keep working through `REWRITE_RETIRED`. Each
  // has a real replacement; asserting the replacement (and that the address bar
  // follows it) is what keeps a bookmark or habit written before the move alive.
  it.each([
    // Apps and MCP Servers left the settings rail for the Connections section.
    // Four addresses reach them from before that move: the two bare aliases
    // that predate the original Connections split, and the two settings
    // addresses they answered at for as long as they were sub-pages — which are
    // the ones an operator is most likely to have bookmarked.
    ["#/oauth", "connections", "apps"],
    ["#/mcp", "connections", "mcp"],
    ["#/settings/oauth", "connections", "apps"],
    ["#/settings/mcp", "connections", "mcp"],
    ["#/people", "settings", "people"],
    ["#/work", "ledgers", "tasks"],
    ["#/settings/not-a-page", "settings", "general"],
  ])("rewrites retired %s onto its replacement", async (hash, view, sub) => {
    rewrite = REWRITE_RETIRED;
    await visit(hash);
    expect(seen).toEqual([view, sub]);
    expect(window.location.hash).toBe(`#/${view}/${sub}`);
  });

  // Brain's two former addresses, which rewrite onto a view with no sub-page —
  // so the replacement hash is bare, not `#/<view>/<sub>`. `#/memory` was the
  // surface's first name; `#/settings/brain` is where it lived for as long as
  // it was a settings sub-page, and that is the one an operator is most likely
  // to have bookmarked.
  it.each(["#/memory", "#/settings/brain"])(
    "rewrites %s onto the Brain nav row",
    async (hash) => {
      rewrite = REWRITE_RETIRED;
      await visit(hash);
      expect(seen).toEqual(["brain", null]);
      expect(window.location.hash).toBe("#/brain");
    },
  );

  it("keeps the Observatory index on the Settings rail, and does not rewrite it away", async () => {
    // It used to be a doorway: `#/settings/observatory` rewrote to
    // `#/observatory`, on the argument that a surface reading four query keys
    // of its own off `window.location` must keep its own head.
    //
    // The index is embedded in Settings now, and `views/observatory/hash.ts`
    // reads BOTH heads deliberately — `#/settings/observatory` for the index,
    // `#/observatory/<runId>` for one run, which cannot move because
    // `useHashView` carries only two segments. So the rewrite would now undo
    // the embedding on arrival, and the address it produced would render the
    // index outside the rail it belongs to.
    rewrite = REWRITE_RETIRED;
    await visit("#/settings/observatory");
    expect(seen).toEqual(["settings", "observatory"]);
    expect(window.location.hash).toBe("#/settings/observatory");
  });

  // The two addresses that rewrite onto the *section* rather than one of its
  // pages, so the replacement hash is bare.
  //
  // `#/settings/connections` is the dead link this section was built over. It
  // named the pre-split Connections page, matched no `SETTINGS_PAGES` id after
  // the split, and so was repaired onto **General** by the branch above — an
  // operator following it landed on a real page that was not the one the link
  // promised, which is worse than a 404 because it looks like it worked. It was
  // still live in four places in the setup flow. It answers again now.
  //
  // `#/connections/not-a-page` is the same rule one level down: the section
  // owns a fixed table of sub-pages, so a segment naming none is repaired to
  // the section rather than silently rendering Apps under an address that says
  // something else.
  it.each(["#/settings/connections", "#/connections/not-a-page"])(
    "rewrites %s onto the Connections section itself",
    async (hash) => {
      rewrite = REWRITE_RETIRED;
      await visit(hash);
      expect(seen).toEqual(["connections", null]);
      expect(window.location.hash).toBe("#/connections");
    },
  );

  // `#/connections` is a real address rather than a rewrite now, which is the
  // load-bearing half of this move: it used to be sent to `#/settings/oauth`.
  // Named on its own so a regression reads as "the section stopped answering"
  // rather than as one row of the `VIEWS` loop above.
  it("answers #/connections as the section itself, not as a rewrite", async () => {
    rewrite = REWRITE_RETIRED;
    await visit("#/connections");
    expect(seen).toEqual(["connections", null]);
    expect(window.location.hash).toBe("#/connections");
  });

  // The one retired address on this rail that differs from a live one by its
  // QUERY rather than its path (issue #2259, Codex review on PR #2263). Apps
  // carried a linkable Credentials tab until Composio became a page of its own;
  // `readSegments` drops the query, so `#/connections/apps?tab=credentials` and
  // a plain visit to Apps are the same two segments. Without the rewrite the
  // bookmark renders the provider grid — a link that looks like it worked,
  // which is the failure `#/settings/connections` above exists to prevent.
  it("rewrites the retired Credentials tab onto the Composio page", async () => {
    rewrite = REWRITE_RETIRED;
    await visit("#/connections/apps?tab=credentials");
    expect(seen).toEqual(["connections", "composio"]);
    // And the query goes with it: the tab it named does not exist on the
    // destination, so leaving it on the bar would hand out a dead address again.
    expect(window.location.hash).toBe("#/connections/composio");
  });

  // The other side of that branch: Apps' own default tab was never a separate
  // place, so neither address may be moved off the page they have always shown.
  it.each(["#/connections/apps", "#/connections/apps?tab=providers"])(
    "leaves %s on the Apps page",
    async (hash) => {
      rewrite = REWRITE_RETIRED;
      await visit(hash);
      expect(seen).toEqual(["connections", "apps"]);
    },
  );

  // #1867 review: `#/work` is a bare-only alias onto the ledgers board — the
  // Work surface's real sub-pages are addressed under `#/ledgers/...` (for
  // example `#/ledgers/manage`), never under `#/work/...`. Before this test,
  // the rewrite ignored `sub` entirely, so a plausible-looking deep link like
  // `#/work/manage` silently collapsed onto the bare board instead of the
  // named page. That is worse than the address simply being unknown: it looks
  // like it worked. An address with a sub-segment is unknown here and falls
  // through to the same not-found handling any other unrecognized head gets.
  it("does not swallow a deep link under the bare-only #/work alias (#1797)", async () => {
    rewrite = REWRITE_RETIRED;
    await visit("#/work/manage");
    expect(seen).toEqual(["not-found", "work"]);
    expect(window.location.hash).toBe("#/not-found/work");
  });

  // A trailing slash with nothing after it (`#/work/`) is not a deep link —
  // `readSegments` in `use-hash-view.ts` filters the empty final segment out,
  // so this is indistinguishable from the bare `#/work` and resolves the same
  // way. Asserted explicitly so the decision is a passing test, not something
  // left to fall out of string-splitting.
  it("treats a trailing slash on #/work the same as the bare address (#1797)", async () => {
    rewrite = REWRITE_RETIRED;
    await visit("#/work/");
    expect(seen).toEqual(["ledgers", "tasks"]);
    expect(window.location.hash).toBe("#/ledgers/tasks");
  });

  it("opens the console in the Room (#1321, four-row sidebar)", async () => {
    // An empty address is the ordinary console entry point, and where it lands
    // is a product decision rather than an accident of the union's order — so
    // it is asserted against the constant the shell actually passes.
    rewrite = undefined;
    await visit("/");

    expect(DEFAULT_VIEW).toBe("chat");
    expect(seen).toEqual([DEFAULT_VIEW, null]);
    expect(window.location.hash).toBe(`#/${DEFAULT_VIEW}`);
  });

  it("keeps the default landing view routable and reachable by its own address", async () => {
    // A fallback that is not itself a routable view would canonicalize into an
    // address the allow-list rejects, and the console would bounce on boot.
    expect(VIEWS).toContain(DEFAULT_VIEW);
  });
});
