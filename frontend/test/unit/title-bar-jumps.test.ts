// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPROVALS_COUNT_CAP,
  approvalsCount,
  approvalsLabel,
  NotificationsButton,
  notificationsLabel,
} from "@/components/notifications-button";
import { OverviewButton, OVERVIEW_LABEL } from "@/components/overview-button";

/**
 * The two jumps in the title row's first group — and the signal that moved into
 * one of them.
 *
 * # What replaced what
 *
 * The approvals count was a `SidebarMenuBadge` on a sidebar row, plus a
 * `SidebarMenuDot` that existed *only* because that badge hides itself on the
 * 32px collapsed rail (issue #1018). Two elements for one number, the second of
 * them a workaround for the first disappearing.
 *
 * The title row does not collapse, so the disappearance cannot happen and both
 * are deleted. What must not be lost with them is the thing #1018 was actually
 * about: **the signal has to reach someone who is not reading a number.** For an
 * icon-only control the accessible name is the whole of what a screen reader
 * gets, so that is where the count and the word "approvals" both live — the same
 * sentence the dot's `aria-label` carried, verbatim.
 *
 * # What is pinned here, and what is not
 *
 * jsdom applies no Tailwind, so nothing about *visibility* can be computed —
 * the ladder's pixel behaviour is a browser measurement recorded in the PR.
 * What is pinned is behaviour a render can actually decide: the name, the
 * pluralisation, the zero state, the cap, and that the sidebar no longer draws
 * a second copy of the count.
 */

let container: HTMLDivElement;
let root: Root;

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

function renderNotifications(pending: number, extra: Record<string, unknown> = {}) {
  act(() => {
    root.render(createElement(NotificationsButton, { pending, onNavigate: () => {}, ...extra }));
  });
  return container.querySelector("[data-testid=title-bar-notifications]") as HTMLElement;
}

function renderOverview(extra: Record<string, unknown> = {}) {
  act(() => {
    root.render(createElement(OverviewButton, { onNavigate: () => {}, ...extra }));
  });
  return container.querySelector("[data-testid=title-bar-overview]") as HTMLElement;
}

describe("the notifications jump", () => {
  it("names where it goes AND what is waiting", () => {
    // The destination leads, because that is what the control does — a bell
    // opens notifications whether or not anything is pending. The rail dot's
    // sentence follows it, word for word: that wording is the whole of the
    // signal for anyone who never sees the chip.
    expect(renderNotifications(19).getAttribute("aria-label")).toBe(
      "Notifications — 19 approvals need you",
    );
    expect(renderNotifications(19).getAttribute("title")).toBe(
      "Notifications — 19 approvals need you",
    );
  });

  it("says 'approval needs' for exactly one", () => {
    expect(approvalsLabel(1)).toBe("1 approval needs you");
    expect(renderNotifications(1).getAttribute("aria-label")).toBe(
      "Notifications — 1 approval needs you",
    );
  });

  it("is just a destination when nothing is waiting", () => {
    // "0 approvals need you" is a sentence about attention at the moment
    // nothing wants any. The glyph stays; the chip does not appear.
    const button = renderNotifications(0);
    expect(button.getAttribute("aria-label")).toBe("Notifications");
    expect(notificationsLabel(0)).toBe("Notifications");
    expect(button.querySelector("[data-testid=title-bar-notifications-count]")).toBeNull();
    // Still on screen — an empty queue is not a reason to remove the way to
    // reach the page, which carries the activity feed as well.
    expect(button).not.toBeNull();
  });

  it("prints the count, and caps the digits without capping the fact", () => {
    expect(
      renderNotifications(7).querySelector("[data-testid=title-bar-notifications-count]")?.textContent,
    ).toBe("7");

    const over = APPROVALS_COUNT_CAP + 1;
    const button = renderNotifications(over);
    // Three digits do not fit a mark on the corner of a 32px control.
    expect(button.querySelector("[data-testid=title-bar-notifications-count]")?.textContent).toBe(
      `${APPROVALS_COUNT_CAP}+`,
    );
    // But the exact number still reaches a screen reader, and still reaches a
    // test through the closed control.
    expect(button.getAttribute("aria-label")).toBe(
      `Notifications — ${over} approvals need you`,
    );
    expect(button.getAttribute("data-pending")).toBe(String(over));
    expect(approvalsCount(APPROVALS_COUNT_CAP)).toBe(String(APPROVALS_COUNT_CAP));
  });

  it("does not announce the count twice", () => {
    // The button already says "3 approvals need you". A chip that is also read
    // appends a bare "3" to that sentence.
    const chip = renderNotifications(3).querySelector(
      "[data-testid=title-bar-notifications-count]",
    ) as HTMLElement;
    expect(chip.getAttribute("aria-hidden")).toBe("true");
  });

  it("never says 'undefined approvals need you'", () => {
    // The count is reconciled from a queue length on the way to this button
    // (`use-company.ts`, issue #932), so a host answering that route in an
    // unexpected shape puts `undefined` or `NaN` here despite the type. Both
    // fail a `<= 0` test, and the label was spoken to a screen reader as
    // "undefined approvals need you" — observed in a browser while exercising
    // the cap against a deliberately malformed queue response.
    const odd = [undefined, Number.NaN, null] as unknown as number[];
    for (const value of odd) {
      expect(notificationsLabel(value)).toBe("Notifications");
    }
  });

  it("marks itself as the page you are on, in more than a colour", () => {
    expect(renderNotifications(0, { active: true }).getAttribute("aria-current")).toBe("page");
    expect(renderNotifications(0).getAttribute("aria-current")).toBeNull();
  });

  it("navigates when pressed", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(createElement(NotificationsButton, { pending: 2, onNavigate }));
    });
    act(() => {
      (container.querySelector("[data-testid=title-bar-notifications]") as HTMLElement).click();
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("the overview jump", () => {
  it("keeps its name reachable without printing it", () => {
    // A labelled button in a chrome band reads as content. The word goes, and
    // both of the channels that can still carry it do.
    const button = renderOverview();
    expect(button.getAttribute("aria-label")).toBe(OVERVIEW_LABEL);
    expect(button.getAttribute("title")).toBe(OVERVIEW_LABEL);
    expect(button.textContent).toBe("");
  });

  it("marks itself as the page you are on", () => {
    expect(renderOverview({ active: true }).getAttribute("aria-current")).toBe("page");
    expect(renderOverview().getAttribute("aria-current")).toBeNull();
  });

  it("navigates when pressed", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(createElement(OverviewButton, { onNavigate }));
    });
    act(() => {
      (container.querySelector("[data-testid=title-bar-overview]") as HTMLElement).click();
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("the count is drawn once, in the title row", () => {
  const shell = readFileSync(
    resolve(process.cwd(), "src/components/app-shell.tsx"),
    "utf8",
  );
  const nav = readFileSync(
    resolve(process.cwd(), "src/components/sidebar-navigation.tsx"),
    "utf8",
  );

  it("leaves no second copy in the sidebar", () => {
    // The badge/dot pair (#1018) was two mechanisms for one number, the second
    // of them a workaround for the first hiding itself on the 32px rail. The
    // title row never collapses, so the disappearance cannot happen and both
    // are deleted rather than maintained. A badge that came back here would be
    // a count that can disagree with the bell's.
    expect(nav).not.toMatch(/<SidebarMenuBadge/);
    expect(nav).not.toMatch(/<SidebarMenuDot/);
    expect(nav).not.toContain("sidebar-approvals-count");
  });

  it("takes the Approvals row out of the list of places", () => {
    // It is the Approvals tab of the Notifications page now, and the page is
    // chrome-reached. A row here would be a second address for one surface.
    expect(nav).not.toMatch(/view: "approvals"/);
  });

  it("feeds the bell the same single pending value", () => {
    // Never re-counted. `feed.status.pending_approvals` is the one source, and
    // the contract issue #932 pins is that there is exactly one — which is why
    // it is passed through rather than derived where it is drawn.
    expect(shell).toMatch(/<NotificationsButton[\s\S]{0,200}pending=\{pending\}/);
    // And the sidebar is handed no copy of it to draw.
    expect(shell).not.toMatch(/<SidebarNavigation[^>]*pending=/);
  });

  it("opens the page rather than the bare queue", () => {
    // `#/approvals` still answers — six in-tree links and every bookmark point
    // at it — but the control an operator presses goes to the page that holds
    // both halves.
    expect(shell).toMatch(/onNavigate=\{\(\) => setView\("notifications"\)\}/);
  });
});
