// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SectionContentRail } from "@/components/section-rail";
import { grandchildActive, NAV_SECTIONS } from "@/components/sidebar-navigation";
import type { View } from "@/lib/console-routes";
import { DEFAULT_CONNECTION_PAGE } from "@/views/connection-pages";

/**
 * A section's sub-navigation is the first column of its content area (#2130).
 *
 * The sidebar's middle region is the Room rail on every section now, so the rows
 * that used to live under a section's sidebar entry are drawn here instead. What
 * is worth pinning is what an operator can actually reach and what a spec can
 * actually click:
 *
 *   - the rows are the section's `children`, whole and in order, so a row that
 *     moved out of the sidebar did not go missing on the way;
 *   - a section with no children draws no rail at all, so Room and Flows keep
 *     their full pane;
 *   - there is never more than ONE rail on screen, which is the whole of the
 *     Finance decision and of issue #1383;
 *   - the `data-tour` anchors travelled with the rows. They are how the guided
 *     tour and `list-switcher.spec.ts` find a row, and they are deliberately
 *     pinned to view ids rather than labels — a row that moved surface and
 *     dropped its anchor is a silently skipped tour stop and a spec that clicks
 *     nothing.
 */

let container: HTMLDivElement;
let root: Root;

function render(view: View, sub: string | null = null, onNavigate = () => {}) {
  act(() =>
    root.render(
      createElement(SectionContentRail, {
        view,
        sub,
        onNavigate,
        children: createElement("main", { "data-testid": "page" }, "the page"),
      }),
    ),
  );
}

/**
 * Renders with the address that names the route also on the bar.
 *
 * The rail reads nothing off `window.location` — `view` and `sub` arrive as
 * props, and the draft of issue #2259 that had it resolving on `(page, tab)`
 * went with the Apps tab strip. The hash is still set so each case reads as the
 * address an operator is at rather than as two loose arguments, and so a rail
 * that started consulting the hash again would be asserted against a bar
 * agreeing with its props instead of one the previous case left behind.
 *
 * A fresh root each time, for that same independence: re-rendering one instance
 * would carry any state the rail grows from one case into the next.
 */
function renderAt(hash: string, view: View, sub: string | null, onNavigate = () => {}) {
  window.location.hash = hash;
  act(() => root.unmount());
  root = createRoot(container);
  render(view, sub, onNavigate);
}

/** The rail's own rows, in document order — the `lg` column, not the chips. */
function railRows(): string[] {
  const nav = container.querySelector("nav");
  if (!nav) return [];
  return [...nav.querySelectorAll("button")].map((el) => (el.textContent ?? "").trim());
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("which sections get a rail", () => {
  it("draws one for Company, with its pages whole and in order", () => {
    // Finance is a caption group rather than a row: its heading is a `<div>`
    // (not a button, so it is not in this list) and its three pages are always
    // listed under it. Brain went the other way — it was a three-row group and
    // is one row again, because its Overview / Upload / Settings are tabs in
    // the page's own header now.
    render("company");
    expect(railRows()).toEqual([
      "Agents",
      "Work",
      "Workspace",
      "Brain",
      "Overview",
      "Invoicing",
      "Wallet",
    ]);
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Company");
  });

  it("draws one for Connections, with every page that section holds", () => {
    // Three caption groups since issue #2259, so these buttons are the rows
    // under them — the captions are `<div>`s, asserted separately below. Eight
    // rows over eight pages: Composio is a page of its own, so the rail is one
    // row per address exactly as it was before it had groups.
    render("connections", "mcp");
    expect(railRows()).toEqual([
      "Apps",
      "MCP Servers",
      "Skills",
      "Account",
      "LLM",
      "Composio",
      "Search",
      "Hosting",
    ]);
  });

  it("heads those rows with three captions, in order, that nobody can press", () => {
    // Issue #2259. Seven flat rows said nothing about the one distinction an
    // operator had to reconstruct on every visit: Apps and MCP are things you
    // connect *to*, LLM and Search are the credentials that authorise the work.
    // The captions are the same shape Finance and the Settings rail already
    // use — `<div>`s, not buttons and not headings, so the rail's keyboard
    // order walks rows only and the document outline still opens on the page's
    // own `h1` (issue #1392).
    render("connections", "mcp");
    const nav = container.querySelector("nav")!;
    const captions = [...nav.querySelectorAll("div")]
      .filter((el) => el.className.includes("uppercase"))
      .map((el) => (el.textContent ?? "").trim());
    expect(captions).toEqual(["Integrations", "API Keys", "Others"]);
    // Eight rows, three captions, and not one caption among the pressables.
    expect(nav.querySelectorAll("button")).toHaveLength(8);
    for (const caption of captions) expect(railRows()).not.toContain(caption);
  });

  it("draws none for Room or Automations, so their pane keeps its full width", () => {
    // Room's sub-navigation is the channel list, which is pinned in the sidebar;
    // Flows has none to move. A rail here would be 240px charged for nothing.
    for (const view of ["chat", "workflows"] as View[]) {
      render(view);
      expect(container.querySelector("nav"), view).toBeNull();
      expect(container.querySelector("[data-testid='page']"), view).not.toBeNull();
    }
  });

  it("draws none for an address filed under no section", () => {
    // Settings and Feedback are footer utilities, Overview and Approvals are
    // chrome in the title row. Settings draws a rail of its own; nothing here
    // should draw a second one over it.
    for (const view of ["settings", "overview", "approvals", "not-found"] as View[]) {
      render(view);
      expect(container.querySelector("nav"), view).toBeNull();
    }
  });

  it("renders the page in every case, rail or no rail", () => {
    for (const view of ["chat", "company", "connections", "workflows", "settings"] as View[]) {
      render(view);
      expect(container.querySelector("[data-testid='page']"), view).not.toBeNull();
    }
  });
});

describe("never two rails at once", () => {
  it("keeps Finance's pages on Company's rail rather than giving them a second", () => {
    // The Finance decision, asserted as the property it is for rather than as a
    // layout preference: sidebar + 240 + 240 + content is the 768–1023px band
    // of issue #1383 reproduced at every width. One rail per section, always.
    render("finances", "wallet");
    expect(container.querySelectorAll("nav")).toHaveLength(1);
    expect(railRows()).toEqual([
      "Agents",
      "Work",
      "Workspace",
      "Brain",
      "Overview",
      "Invoicing",
      "Wallet",
    ]);
  });

  it("lists a caption group's pages whether or not one of them is open", () => {
    // The inverse of what this asserted. Finance was a collapsible row whose
    // pages appeared only while it was the open one; it is a caption group now,
    // and a heading that hides what it heads is not a heading — so its three
    // pages stand on Company's rail at all times, exactly as the Settings
    // rail's groups do.
    render("company");
    expect(railRows()).toContain("Wallet");
    render("brain");
    expect(railRows()).toContain("Wallet");
    // Still one rail, which is the property the Finance decision was about.
    expect(container.querySelectorAll("nav")).toHaveLength(1);
  });

  it("marks the resolved page for a segment that names none of them", () => {
    // The rendered half of the `grandchildActive` case below: the rail and the
    // chip row both have to say Overview, because Overview is what the page
    // resolver put on screen.
    render("finances", "old-page");
    const current = [...container.querySelectorAll('nav [aria-current="page"]')].map((el) =>
      (el.textContent ?? "").trim(),
    );
    expect(current).toEqual(["Overview"]);
    const chips = container.querySelector(".lg\\:hidden")!;
    expect(chips.textContent).toContain("Balance, budget and spend from the ledger");

    // And the same one level up: `#/connections/not-a-page` renders Apps.
    render("connections", "not-a-page");
    expect(
      [...container.querySelectorAll('nav [aria-current="page"]')].map((el) =>
        (el.textContent ?? "").trim(),
      ),
    ).toEqual(["Apps"]);
  });

  it("marks exactly one row current, and it is the leaf", () => {
    render("finances", "invoicing");
    const current = [...container.querySelectorAll('nav [aria-current="page"]')].map((el) =>
      (el.textContent ?? "").trim(),
    );
    // Finance is the branch you are in, not a second page you are on. Two nodes
    // answering `aria-current="page"` is a page a screen reader cannot locate
    // you on; what says "you are in this branch" is that its children show.
    expect(current).toEqual(["Invoicing"]);
  });

  it("names the page below lg, not the branch above it", () => {
    // Codex P2 on this PR: the chip row's explanatory line took the FIRST
    // active row, which on any `#/finances/…` address is Finance — so the one
    // surface where the label alone does not say which page you are on named
    // the parent instead. It takes the deepest active row.
    for (const [sub, hint] of [
      [null, "Balance, budget and spend from the ledger"],
      ["invoicing", "What customers owe, through Chargebee"],
      ["wallet", "The PayPal balance and what moved through it"],
    ] as const) {
      render("finances", sub);
      const chips = container.querySelector(".lg\\:hidden")!;
      expect(chips.textContent, String(sub)).toContain(hint);
      expect(chips.textContent, String(sub)).not.toContain("What it earns and spends");
    }
  });
});

describe("one line per row, with the gloss on hover", () => {
  it("prints the label alone and hangs the hint off `title` (issue #2131)", () => {
    // The rail matches what PR #2133 did to Settings, because the two sit side
    // by side: a second line under every label wrapped at `w-60` and turned a
    // five-row rail into fifteen lines of prose. The hint is kept as data — it
    // is the row's `title` here and the line under the active chip below `lg` —
    // so this asserts where it is shown, not that it went away.
    render("company");
    const agents = container.querySelector<HTMLButtonElement>("nav button")!;
    expect(agents.textContent?.trim()).toBe("Agents");
    expect(agents.getAttribute("title")).toBe("Who is in this company");
    expect(agents.className).toContain("items-center");
    expect(agents.className).not.toContain("items-start");
    expect(agents.querySelector("svg")?.getAttribute("class")).not.toContain("mt-0.5");
  });

  it("still names the active page once, below lg, where a chip has no room for it", () => {
    render("connections", "mcp");
    const chips = container.querySelector(".lg\\:hidden")!;
    expect(chips.textContent).toContain("Tool servers and their tools");
    // And exactly once — not under every chip.
    expect(chips.textContent?.match(/Tool servers and their tools/g)).toHaveLength(1);
  });

  it("fills exactly one chip, so a flat row never shows two current destinations", () => {
    // Codex P2 on this PR: the chip row had the accent on every *active* row,
    // so on `#/finances/wallet` both Finance and Wallet were filled — and
    // unlike the rail, a chip row has no indent to say which of the two you are
    // on. What says "you are in this branch" here is the same thing that says
    // it on the rail: its children are in the row at all.
    render("finances", "wallet");
    const chips = container.querySelector(".lg\\:hidden")!;
    const filled = [...chips.querySelectorAll("button")]
      .filter((b) => b.className.includes("bg-accent"))
      .map((b) => b.textContent?.trim());
    expect(filled).toEqual(["Wallet"]);
  });
});

describe("the tour anchors travelled with the rows", () => {
  it("keeps one node per anchor, and keeps the ones specs click", () => {
    render("company");
    const anchors = [...container.querySelectorAll("[data-tour]")].map((el) =>
      el.getAttribute("data-tour"),
    );
    expect(new Set(anchors).size, anchors.join(", ")).toBe(anchors.length);
    // `list-switcher.spec.ts` clicks this one from `#/company`.
    expect(anchors).toContain("nav-ledgers");
    // And it is a button inside the anchor, the shape every selector in the
    // e2e suite is written as (`[data-tour="nav-x"] >> role=button`).
    expect(
      container.querySelector('[data-tour="nav-ledgers"] button')?.textContent?.trim(),
    ).toBe("Work");
  });

  it("gives the row that shares its section's address no anchor of its own", () => {
    // Agents *is* `#/company`, so an anchor here would put two `nav-company`
    // nodes on screen and every selector written against it becomes a
    // strict-mode violation rather than a click. The sidebar row keeps the name.
    render("company");
    expect(container.querySelectorAll('[data-tour="nav-company"]')).toHaveLength(0);
  });

  it("gives a caption group no anchor of its own", () => {
    // Finance is not a row any more, so there is nothing for `nav-finances` to
    // anchor to and its pages carry their own anchors. A tour step pointing at
    // a caption would point at a `<div>` nobody can press — the degradation
    // `tour/steps.ts` documents as a skipped step rather than a broken one.
    render("finances");
    const anchors = [...container.querySelectorAll("[data-tour]")].map((el) =>
      el.getAttribute("data-tour"),
    );
    expect(anchors.filter((a) => a === "nav-finances")).toHaveLength(0);
    // Its pages carry no anchor either: `data-tour` names a tour *step*, and
    // there is no step pointing inside Finance. The rail's own rows have them
    // because the tour walks the sections.
    expect(anchors).not.toContain("nav-wallet");
    expect(anchors).toContain("nav-agents");
  });
});

describe("clicking a row", () => {
  it("navigates by (view, sub), the same pair the sidebar rows used", () => {
    const onNavigate = vi.fn();
    render("company", null, onNavigate);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-tour="nav-workspace"] button')!
        .click();
    });
    expect(onNavigate).toHaveBeenCalledWith("workspace", undefined);
  });

  it("navigates a nested page to its own segment", () => {
    const onNavigate = vi.fn();
    render("finances", null, onNavigate);
    const wallet = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (el) => el.textContent?.trim() === "Wallet",
    )!;
    act(() => wallet.click());
    expect(onNavigate).toHaveBeenCalledWith("finances", "wallet");
  });
});

describe("grandchildActive", () => {
  // The SECTION, not the group. A caption is not a scope: the set an address is
  // matched against is every row the rail draws, which is what keeps one address
  // lighting one row once a section has more than one group (issue #2259).
  const company = NAV_SECTIONS.find((s) => s.view === "company")!;
  const finance = company.children!.find((c) => c.view === "finances")!;
  const page = (label: string) => finance.children!.find((c) => c.label === label)!;

  it("lights the first page for the bare address, as the sections do", () => {
    // `#/finances` is Overview for the same reason `#/connections` is Apps: the
    // parent row lands on the bare address and the first page is what it shows.
    expect(grandchildActive(company, page("Overview"), "finances", null)).toBe(true);
    expect(grandchildActive(company, page("Wallet"), "finances", null)).toBe(false);
  });

  it("lights the page the segment names", () => {
    expect(grandchildActive(company, page("Wallet"), "finances", "wallet")).toBe(true);
    expect(grandchildActive(company, page("Overview"), "finances", "wallet")).toBe(false);
  });

  it("lights nothing outside its own view", () => {
    expect(grandchildActive(company, page("Overview"), "brain", null)).toBe(false);
  });

  it("lights the first page for a segment none of them names", () => {
    // Codex P2 on this PR. `resolveFinancePage` falls back to Overview for an
    // unknown segment, so `#/finances/old-page` — a stale bookmark, a typo, a
    // renamed page — *renders Overview*. Matching on the segment alone left the
    // rail marking only the Finance ancestor and the chip row naming the parent
    // while Overview was on screen. The resolver decides what renders and this
    // decides what is marked; they have to be one rule.
    expect(grandchildActive(company, page("Overview"), "finances", "old-page")).toBe(true);
    expect(grandchildActive(company, page("Wallet"), "finances", "old-page")).toBe(false);
  });

  // CodeRabbit on this PR: the cases above name two rows each, and a row that
  // started lighting BESIDE the right one passes every one of them. Company is
  // the section whose rail shape changed here — its Finance caption is no longer
  // a scope, so the candidate set an address is matched against is Agents, Work,
  // Workspace and Brain as well as the Finance pages — which is exactly the
  // mistake this catches and exactly the invariant the Connections suite below
  // already holds with `lit`. Same shape, so the two cannot drift.
  //
  // A group contributes its rows and a plain child contributes itself: Company
  // is the one section that is a mix of both, which is what the flattening in
  // `sectionRailRows` is for.
  const rows = company.children!.flatMap((child) => child.children ?? [child]);
  const litInCompany = (sub: string | null) =>
    rows
      .filter((row) => grandchildActive(company, row, "finances", sub))
      .map((row) => row.label);

  it("lights exactly one row across the whole section, captions flattened away", () => {
    expect(litInCompany(null)).toEqual(["Overview"]);
    expect(litInCompany("wallet")).toEqual(["Wallet"]);
    expect(litInCompany("old-page")).toEqual(["Overview"]);
  });
});

/**
 * One address lights one row, across groups.
 *
 * A draft of issue #2259 gave the rail a second row on the Apps page pointing
 * at its Credentials tab, so the rail had to resolve on `(page, tab)` — a
 * mechanic nothing else in the console had. Composio is a page now and that
 * whole dimension is gone; what is left to hold is the part groups actually
 * changed, which is that the candidate set is the SECTION's rows and not one
 * group's.
 */
describe("one address lights one row, across groups", () => {
  const connections = NAV_SECTIONS.find((s) => s.view === "connections")!;
  const rows = connections.children!.flatMap((group) => group.children ?? []);

  const lit = (sub: string | null) =>
    rows
      .filter((child) => grandchildActive(connections, child, "connections", sub))
      .map((child) => child.label);

  it("lights exactly one row for every address the section answers", () => {
    // The bug a per-group candidate set would have: "integrations" names no
    // `inference` row, so its first row would claim the unknown-segment
    // fallback and light Apps beside LLM.
    for (const [sub, label] of [
      [null, "Apps"],
      ["apps", "Apps"],
      ["mcp", "MCP Servers"],
      ["skills", "Skills"],
      ["api-key", "Account"],
      ["inference", "LLM"],
      ["composio", "Composio"],
      ["search", "Search"],
      ["hosting", "Hosting"],
      ["not-a-page", "Apps"],
    ] as const) {
      expect(lit(sub), String(sub)).toEqual([label]);
    }
  });

  it("keeps Apps the row a bare `#/connections` lands on", () => {
    // `DEFAULT_CONNECTION_PAGE` and the first rail row have to agree, or every
    // existing bookmark to the section quietly lands somewhere else.
    expect(connections.children![0].children![0].sub).toBe(DEFAULT_CONNECTION_PAGE);
    expect(connections.children![0].children![0].label).toBe("Apps");
  });

  it("marks exactly one of them current on screen, rail and chips alike", () => {
    const current = () =>
      [...container.querySelectorAll('nav [aria-current="page"]')].map((el) =>
        (el.textContent ?? "").trim(),
      );

    renderAt("#/connections/apps", "connections", "apps");
    expect(current()).toEqual(["Apps"]);

    renderAt("#/connections/composio", "connections", "composio");
    expect(current()).toEqual(["Composio"]);
    // And below `lg`, where a filled chip is the only thing saying where you
    // are: one chip, not two, exactly as `#/finances/wallet` gets one.
    const chips = container.querySelector(".lg\\:hidden")!;
    expect(
      [...chips.querySelectorAll("button")]
        .filter((b) => b.className.includes("bg-accent"))
        .map((b) => b.textContent?.trim()),
    ).toEqual(["Composio"]);
  });

  it("navigates by (view, sub) like every other row, with no query in sight", () => {
    // The draft passed `{ tab: … }` as a third argument from two of these rows.
    // Every row is a plain route navigation again, so a `?run=` or `?host=`
    // riding the address is not collateral of pressing one.
    const onNavigate = vi.fn();
    renderAt("#/connections/apps", "connections", "apps", onNavigate);
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>("nav button")]
        .find((el) => el.textContent?.trim() === "Composio")!
        .click();
    });
    expect(onNavigate).toHaveBeenCalledWith("connections", "composio");
  });
});
