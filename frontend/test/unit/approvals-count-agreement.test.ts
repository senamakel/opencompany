// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import type { ApprovalSummary, CompanyStatus } from "@/api/types";
import { useCompany, withApprovalCount, type CompanyFeed } from "@/hooks/use-company";

/**
 * The title row's count and the Approvals queue report one number (#932).
 *
 * That count was a sidebar badge when this was written and is the Notifications
 * bell's chip now (`notifications-button.tsx`). Which control draws it has
 * never been what this suite is about; that there is exactly one number, read
 * by both surfaces from `feed.status.pending_approvals`, is.
 *
 * The two counts on screen were read over two requests. The host has a single
 * source — the journal's parked set — but `GET …/{id}` answers with a *count*
 * and `GET …/{id}/approvals` answers with the *rows*, and the status handler
 * awaits a store load before it counts, so its sample is taken later than the
 * queue's. While a workflow run was parking gates, that gap was four: a count
 * reading 18 beside a page reading "14 things need your approval".
 *
 * The reconciliation is a pure function, and most of this suite treats it as
 * one. The hook case is here because the *pure* function cannot fail the way
 * the issue did: the bug was never a wrong count, it was two right counts from
 * two moments, and only driving a poll that returns a skewed pair shows that
 * the feed both surfaces read hands them the same number.
 */

const STATUS: CompanyStatus = {
  id: "acme",
  name: "Acme",
  lifecycle: "running",
  pending_approvals: 0,
};

function approvals(n: number): ApprovalSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    kind: "web_fetch",
    amount_usd: null,
    at_millis: 1_700_000_000_000 + i,
    agent: "seo",
    thread: "desk-marketing",
  }));
}

describe("withApprovalCount", () => {
  it("takes the queue's length when the count arrived ahead of it", () => {
    // The reported pair, in the direction it was reported: the later-sampled
    // count had already seen four gates the queue had not.
    const status = withApprovalCount({ ...STATUS, pending_approvals: 18 }, approvals(14));

    expect(status.pending_approvals).toBe(14);
  });

  it("takes the queue's length when the count arrived behind it", () => {
    // The same skew the other way — a resolution landing between the two
    // responses — because the rule is "the queue is the count", not "the
    // smaller one wins".
    const status = withApprovalCount({ ...STATUS, pending_approvals: 2 }, approvals(5));

    expect(status.pending_approvals).toBe(5);
  });

  it("carries the rest of the status through untouched", () => {
    const paused = { ...STATUS, lifecycle: "paused", emergency_paused: true };

    const status = withApprovalCount({ ...paused, pending_approvals: 3 }, approvals(1));

    expect(status).toEqual({ ...paused, pending_approvals: 1 });
  });

  it("returns the same object when the two already agree", () => {
    // Identity, not just equality: a fresh object every poll would re-render
    // every consumer of `status` five times a minute for an unchanged value.
    const agreed = { ...STATUS, pending_approvals: 2 };

    expect(withApprovalCount(agreed, approvals(2))).toBe(agreed);
  });
});

let container: HTMLDivElement;
let root: Root;

/** Renders `hook` and hands back the latest value it returned. */
function probe<T>(hook: () => T): () => T {
  let latest: T | undefined;
  const Probe = (): ReactElement | null => {
    latest = hook();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return () => {
    if (latest === undefined) throw new Error("the hook never rendered");
    return latest;
  };
}

/**
 * A client whose two reads disagree the way the host's did: the status count is
 * sampled after four more gates parked than the queue it is fetched beside.
 */
function skewedClient(counted: number, queued: number): OpenCompanyClient {
  return {
    status: async () => ({ ...STATUS, pending_approvals: counted }),
    approvals: async () => approvals(queued),
  } as unknown as OpenCompanyClient;
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

describe("useCompany — one number for one queue (#932)", () => {
  it("hands the badge and the page the same count after a skewed poll", async () => {
    // Hoisted, not built inside the render: `useCompany` keys its poll on the
    // client's identity, so a fresh object per render re-arms the effect
    // forever.
    const client = skewedClient(18, 14);
    const feed = probe<CompanyFeed>(() => useCompany(client, "acme", STATUS));

    // The mount fetch, awaited: `refresh` resolves two promises before it sets
    // state, so a bare `act` would assert against the pre-fetch render.
    await act(async () => {
      await Promise.resolve();
    });

    // The title row reads the first, the Approvals header the second. The
    // bug was that these two lines could differ.
    expect(feed().status.pending_approvals).toBe(feed().approvals.length);
    expect(feed().status.pending_approvals).toBe(14);
  });

  it("leaves the pre-fetch count alone, so the first read is not a rising edge", async () => {
    // The reconciliation is between a status and a queue that *arrived
    // together*. Before the first poll there is no queue to reconcile against
    // — an empty array here means "not read yet", not "nothing is pending".
    //
    // Reading it as a count of zero costs more than the flash it fixes:
    // `useEvents` fires the "needs a sign-off" push on a rise in this number,
    // with its detector seeded so the first read never toasts. Zeroing the
    // badge and letting the poll raise it turns every load and every company
    // switch into an unprompted push. Two E2E specs caught exactly that.
    const client = skewedClient(7, 7);
    const feed = probe<CompanyFeed>(() =>
      useCompany(client, "acme", { ...STATUS, pending_approvals: 7 }),
    );

    expect(feed().status.pending_approvals).toBe(7);

    // And once the queue does arrive, the two agree as before.
    await act(async () => {
      await Promise.resolve();
    });
    expect(feed().status.pending_approvals).toBe(feed().approvals.length);
  });
});
