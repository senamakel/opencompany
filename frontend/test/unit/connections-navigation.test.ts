import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NAV_SECTIONS } from "@/components/sidebar-navigation";
import { TOUR } from "@/tour/steps";
import { SETTINGS_PAGES } from "@/views/settings-pages";
import {
  CONNECTION_PAGE_GROUPS,
  CONNECTION_PAGES,
  connectionPagesIn,
  connectionsHref,
  DEFAULT_CONNECTION_PAGE,
  isConnectionPage,
  resolveConnectionPage,
} from "@/views/connection-pages";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "../../src", rel), "utf8");

/**
 * The Connections section: Apps and MCP Servers, out of the Settings rail.
 *
 * The counterpart to `settings-navigation.test.ts`, which holds the rail they
 * left. What is worth pinning here is the part a reviewer cannot see by reading
 * either file alone — that the section's two pages are exactly the two that
 * moved, that its rail is built the way the other two rails are, and that the
 * one stop in the guided tour whose title is "Connect your tools" points at the
 * nav row that now leads there.
 */
describe("the Connections section", () => {
  it("carries exactly the pages that left the Settings rail", () => {
    // The ROUTING table, and since issue #2259 only that: what an operator sees
    // is `CONNECTION_RAIL_GROUPS` below, and this order no longer decides it.
    // Held all the same, because these are addresses — a page dropped or an id
    // renamed here is a bookmark that stops working.
    expect(CONNECTION_PAGES.map((page) => page.id)).toEqual([
      "apps",
      // Not one of the pages that left Settings — this one was written for the
      // rail, and it is the account every other page here spends through.
      "api-key",
      "mcp",
      "inference",
      // Nor this one: it was a TAB of the Apps page, and is a page since #2259.
      // INSERTED here rather than appended, because the rail draws each group's
      // pages in this table's order and Composio belongs under LLM. Inserting a
      // new id moves no existing one, which is the only reason that is allowed.
      "composio",
      "skills",
      "hosting",
      "search",
    ]);
  });

  it("leaves Settings nothing with an outside service at the other end of it", () => {
    // The other direction of the same fact, and worth asserting from here as
    // well: "Connections grew a page" and "Settings lost one" are the same
    // mistake seen from two sides, and only one of the two files would fail.
    // Inference, Skills, Hosting and Search were each argued to belong on the
    // settings rail ("a credential form belongs beside what it unlocks") until
    // it was noticed that what each unlocks IS the connection.
    const ids = CONNECTION_PAGES.map((page) => page.id as string);
    for (const moved of ["inference", "skills", "hosting", "search"]) {
      expect(ids, `${moved} names an outside service`).toContain(moved);
    }
    for (const stayed of SETTINGS_PAGES.map((page) => page.id as string)) {
      expect(ids, `${stayed} is Settings' own`).not.toContain(stayed);
    }
  });

  it("leads with Apps, so the section is never an empty frame", () => {
    expect(DEFAULT_CONNECTION_PAGE).toBe("apps");
    expect(resolveConnectionPage(null)).toBe("apps");
    expect(resolveConnectionPage("not-a-page")).toBe("apps");
    expect(resolveConnectionPage("mcp")).toBe("mcp");
  });

  it("distinguishes its page ids from unknown sub-hashes", () => {
    expect(isConnectionPage("apps")).toBe(true);
    expect(isConnectionPage("oauth")).toBe(false);
    expect(isConnectionPage(null)).toBe(false);
  });

  it("mints hashes under its own section, not under Settings", () => {
    // The typed helper exists so a link cannot outlive the page it names —
    // the defect `#/settings/connections` was for four releases.
    expect(connectionsHref("apps")).toBe("#/connections/apps");
    expect(connectionsHref("mcp")).toBe("#/connections/mcp");
  });

  it("gives every page a label and a hint, so the rail says what each is for", () => {
    for (const page of CONNECTION_PAGES) {
      expect(page.label, page.id).toBeTruthy();
      expect(page.hint, page.id).toBeTruthy();
      // The hint is the row's `title` and, below `lg`, the line naming the
      // active chip — it stopped being a second line under the label with
      // issue #2131. Repeating the label in it tells an operator nothing they
      // cannot already see, wherever it is shown.
      expect(page.hint, page.id).not.toBe(page.label);
    }
  });

  it("renames the accounts page to Apps everywhere it is named", () => {
    // Three places, and they have to agree: the rail's row, the rail's hint,
    // and the page's own `h1`. A rename that reaches two of the three leaves an
    // operator clicking "Apps" and landing on a page headed "OAuth".
    expect(CONNECTION_PAGES.find((p) => p.id === "apps")?.label).toBe("Apps");
    expect(read("views/OAuthView.tsx")).toContain('title="Apps"');
    expect(read("views/OAuthView.tsx")).not.toContain('title="OAuth"');
  });

  it("keeps the rail and the page agreeing about the two rows that were renamed", () => {
    // Issue #2259 relabels two rows and neither renames an id. The same trap the
    // Apps rename had: a rename that reaches the rail and not the page leaves an
    // operator clicking "LLM" and landing on a page headed "Inference".
    const label = (id: string) => CONNECTION_PAGES.find((p) => p.id === id)?.label;
    expect(label("inference")).toBe("LLM");
    expect(read("views/InferenceView.tsx")).toContain('title="LLM"');
    expect(read("views/InferenceView.tsx")).not.toContain('title="Inference"');
    expect(label("api-key")).toBe("Account");
    expect(read("views/connections/ApiKeyView.tsx")).toContain('title="Account"');
    expect(read("views/connections/ApiKeyView.tsx")).not.toContain('title="API Key"');
    // And the addresses they are reached at are untouched, which is the half a
    // relabel is most likely to take with it.
    expect(connectionsHref("inference")).toBe("#/connections/inference");
    expect(connectionsHref("api-key")).toBe("#/connections/api-key");
  });

  it("files every page under exactly one group, and every group under a real id", () => {
    // The failure grouping invites: a page tagged with a group the rail does
    // not draw is a page an operator can still reach by address and can no
    // longer find. `group` is typed against the page table, so the reverse —
    // a group label over no pages — is the one this has to catch at runtime.
    const filed = CONNECTION_PAGE_GROUPS.flatMap((group) => connectionPagesIn(group.id));
    expect(filed.map((page) => page.id).sort()).toEqual(
      CONNECTION_PAGES.map((page) => page.id).sort(),
    );
    expect(filed).toHaveLength(CONNECTION_PAGES.length);
    for (const group of CONNECTION_PAGE_GROUPS) {
      expect(connectionPagesIn(group.id).length, group.id).toBeGreaterThan(0);
    }
  });

  it("draws the groups in order, with Account at the head of the keys", () => {
    expect(
      CONNECTION_PAGE_GROUPS.map((group) => [
        group.label,
        connectionPagesIn(group.id).map((page) => page.label),
      ]),
    ).toEqual([
      ["Integrations", ["Apps", "MCP Servers", "Skills"]],
      // Account first: it is the account the rest of this group is billed to,
      // so the key that pays comes before the keys it pays for.
      ["API Keys", ["Account", "LLM", "Composio", "Search"]],
      ["Others", ["Hosting"]],
    ]);
  });

  it("opens a bare `#/connections` on the first row of the first group", () => {
    // `DEFAULT_CONNECTION_PAGE` and the rail's head have to agree, or every
    // existing bookmark to the section quietly lands somewhere else. The rail's
    // order is each group's pages in page-table order, so this is the pair that
    // has to be held rather than the page table's first entry alone.
    expect(CONNECTION_PAGE_GROUPS[0].label).toBe("Integrations");
    expect(connectionPagesIn(CONNECTION_PAGE_GROUPS[0].id)[0].id).toBe(DEFAULT_CONNECTION_PAGE);
    expect(DEFAULT_CONNECTION_PAGE).toBe("apps");
  });

  it("gives Composio an address of its own rather than a tab of the Apps page", () => {
    // The draft of #2259 gave the rail a second row on `#/connections/apps`
    // pointing at its Credentials tab, which made the rail resolve on
    // `(page, tab)` — a mechanic nothing else in the console had. A page id is
    // the plainer answer, and `connectionsHref` types it like every other.
    expect(isConnectionPage("composio")).toBe(true);
    expect(connectionsHref("composio")).toBe("#/connections/composio");
    expect(resolveConnectionPage("composio")).toBe("composio");
    // And the Apps page has no tab strip left to point at.
    expect(read("views/OAuthView.tsx")).not.toContain("APP_TABS");
    expect(read("views/OAuthView.tsx")).not.toContain("<PageTabs");
  });

  it("draws no rail of its own, whichever surface the sub-navigation is on", () => {
    // This section shipped with a `w-60` rail of its own, modelled on Finance's,
    // and gave it up for rows in the sidebar. Sub-navigation is a content rail
    // again since #2130 — but the SHARED one, `components/section-rail.tsx`,
    // built from the same `NAV_SECTIONS` table every section reads. This file
    // stays dispatch-only through both moves, which is the property worth
    // pinning: one rail implementation, not one per section.
    const section = read("views/connections/ConnectionsSection.tsx");
    expect(section).not.toMatch(/<nav[\s>]/);
    expect(section).not.toContain("w-60");

    // Where it went, asserted from the nav table rather than from source text: a
    // `toContain` over a nav table is satisfied by a commented-out row that
    // renders nothing (#1311).
    const connections = NAV_SECTIONS.find((s) => s.view === "connections")!;
    expect(
      connections.children?.map((group) => [
        group.label,
        group.children?.map((child) => [child.label, child.sub]),
      ]),
    ).toEqual([
      [
        "Integrations",
        [
          ["Apps", "apps"],
          ["MCP Servers", "mcp"],
          ["Skills", "skills"],
        ],
      ],
      [
        "API Keys",
        [
          ["Account", "api-key"],
          ["LLM", "inference"],
          // A page, not a tab of Apps: one row, one address, like every other
          // row on this rail.
          ["Composio", "composio"],
          ["Search", "search"],
        ],
      ],
      ["Others", [["Hosting", "hosting"]]],
    ]);
  });

  it("keeps the provider grid and the credential reading one shared state", () => {
    // This asserted that `ComposioSection` was ON the Apps page, because
    // `ProvidersSection` reads the credential's `credentialSource`, `granted`,
    // `openMode` and catalog warning to decide what every tile renders.
    //
    // The dependency is unchanged; what changed is the reading of it. It is a
    // DATA dependency, and colocation was only ever a proxy for "one state".
    // The two surfaces are two pages now (#2259) and the state is lifted, so
    // what has to be held is the lift: each page mounts the shared hook, and
    // NEITHER reaches for the status read itself. A page that did would be the
    // two-surfaces-disagreeing failure the original comment named.
    //
    // Matched at the JSX element boundary rather than as a substring. A bare
    // `toContain("<ComposioSection")` is satisfied by `<ComposioSectionAnything`,
    // so renaming the element past it proved nothing — verified by mutating it
    // to `<ComposioSectionRemoved`, which passed.
    const oauth = read("views/OAuthView.tsx");
    const composio = read("views/connections/ComposioView.tsx");
    expect(oauth).toMatch(/<ProvidersSection[\s/>]/);
    expect(composio).toMatch(/<ComposioSection[\s/>]/);
    for (const [name, source] of [
      ["OAuthView", oauth],
      ["ComposioView", composio],
    ] as const) {
      expect(source, `${name} mounts the shared credential`).toContain(
        "useComposioCredential(client, company)",
      );
      expect(source, `${name} does not read the status itself`).not.toContain(
        "getComposioStatus(",
      );
    }
  });
});

describe("the guided tour's Connect-your-tools stop", () => {
  const stop = TOUR.find((s) => s.title === "Connect your tools");

  it("exists", () => {
    expect(stop).toBeDefined();
  });

  it("spotlights the nav row that actually leads to the tools", () => {
    // It used to navigate to `{ view: "settings", sub: "oauth" }` and spotlight
    // `nav-settings` — so a step titled "Connect your tools" pointed an operator
    // at a gear. The row exists now, so the step names the same surface the
    // sidebar does.
    expect(stop!.view).toBe("connections");
    expect(stop!.sub).toBe("apps");
    expect(stop!.target).toBe('[data-tour="nav-connections"]');
  });

  it("targets an anchor the sidebar actually renders", () => {
    // A tour step whose anchor never mounts degrades to a *skipped* step —
    // silently — so the tour goes on teaching half the product and nothing
    // reports it. That is why this is asserted rather than left to the browser.
    //
    // Asserted against the nav table itself rather than against the shell's
    // source text. The source form had to be anchored to the start of a line to
    // stop a **commented-out** row satisfying it (`// { view: "connections", …
    // }` still holds the substring, and a commented row renders no anchor at
    // all — issue #1311). Reading the table removes the trap by construction:
    // a commented row is not a member of it.
    const row = NAV_SECTIONS.find((section) => section.view === "connections");
    expect(row?.label).toBe("Connections");
    expect(stop!.target).toBe(`[data-tour="nav-${row!.view}"]`);
  });
});
