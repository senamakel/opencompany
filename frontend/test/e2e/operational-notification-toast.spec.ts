import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Which operational rows get a toast, and which only get the Activity tab.
 *
 * `dispatch_failed` / `approval_expired` / `workflow_run_*` reach a person
 * through `lib/operational-notifications.ts`. Two facts about them changed
 * together, and this spec is where the pair is pinned:
 *
 *   - **The toast no longer marks the row read.** It used to, because these
 *     rows had no rendered surface at all; the Notifications page's Activity
 *     tab is that surface now, and a row acked on announcement could never
 *     appear in it — the host serialises unread rows only.
 *   - **So the first poll of a scope seeds instead of announcing.** An unread
 *     row stopped meaning "nobody has seen this" the moment the ack went. It
 *     means "nobody has dismissed this", which is equally true three page loads
 *     later — so announcing the unread set on arrival re-toasts the backlog on
 *     every single load.
 *
 * That second one is not hypothetical. It passed the default lane and failed
 * `Console E2E (live brain)`, where agents actually run and produce these rows:
 * a warning toast sat over the bottom of a 390px Settings page and covered the
 * button `sidebar-toggle-reachable.spec.ts` hit-tests. The toast was for a row
 * an earlier page load had already announced.
 *
 * # Toasts are recorded, not sampled
 *
 * A toast lives 4s (`DEFAULT_TOAST_DURATION_MS`) and `dismissTour` alone can
 * wait ten, so `expect(locator).toHaveCount(0)` after a page settles passes
 * whether the toast never appeared or merely expired first. It was written that
 * way first and passed against the broken build. Every toast is instead
 * recorded from an init script as it enters the DOM, and the assertions read
 * that log — a claim about what happened rather than about one moment.
 *
 * Driven from the browser the same way `workflow-week1-nudge.spec.ts` does it:
 * `/notifications` and `/events` are intercepted, everything else hits the real
 * harness host.
 */

/** The notifications route, and only it. */
function isNotifications(url: URL): boolean {
  return /\/api\/v1\/(company|companies\/[^/]+)\/notifications$/.test(url.pathname);
}

async function dismissTour(page: Page) {
  const skip = page.getByRole("button", { name: "Skip for now" });
  try {
    await skip.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return;
  }
  await skip.click();
  await expect(skip).toBeHidden();
}

/**
 * Records the text of every sonner toast that ever enters the DOM.
 *
 * A 100ms poll rather than a `MutationObserver`: an init script runs before the
 * document exists, so `observe(document.documentElement, …)` throws on a null
 * target and takes the rest of the script with it. That version recorded
 * nothing and every "was not toasted" assertion passed vacuously — including
 * against a build that toasted. A toast lives 4s, which forty scans cannot miss.
 */
async function recordToasts(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = seen;
    setInterval(() => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        const text = el.textContent?.trim() ?? "";
        if (text && !seen.includes(text)) seen.push(text);
      }
    }, 100);
  });
}

/** Every toast raised so far, oldest first — survives auto-dismiss. */
function toastsSoFar(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);
}

/**
 * Force a notification poll now.
 *
 * `app-shell` refreshes the feed on `window`'s `focus` as well as on the
 * company poll's own cadence, and the cadence is slow enough that waiting for
 * it costs more than this whole spec's time budget. Same code path either way.
 */
async function pollNow(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

const BACKLOG = {
  id: "op-backlog",
  kind: "dispatch_failed",
  subjectKind: "task",
  subjectId: "t-backlog",
  title: "A card's dispatch failed and returned to To-do: backlog row",
  createdAt: Date.now() - 60_000,
};

const LIVE = {
  id: "op-live",
  kind: "dispatch_failed",
  subjectKind: "task",
  subjectId: "t-live",
  title: "A card's dispatch failed and returned to To-do: live row",
  createdAt: Date.now(),
};

type Row = typeof BACKLOG;

/**
 * Serves `rows()` on every `GET`, so a test can add a row between polls the way
 * the host would. `PUT` is recorded and answered without mutating anything — no
 * test here dismisses, and a latch would only hide a stray ack.
 */
async function mockNotifications(page: Page, rows: () => Row[], marked: string[][]) {
  await page.route(
    (url) => isNotifications(url),
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        const body = (request.postDataJSON() ?? {}) as { ids?: string[] };
        marked.push(body.ids ?? ["<all>"]);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ unread: rows().length }),
        });
      }
      const kind = new URL(request.url()).searchParams.get("kind");
      const served = kind ? rows().filter((r) => r.kind === kind) : rows();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications: served, unread: served.length }),
      });
    },
  );
}

async function mockEmptyEvents(page: Page) {
  await page.route("**/events", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: "",
    }),
  );
}

test("a row already waiting when the console opens is never toasted", async ({ page }) => {
  const marked: string[][] = [];
  await recordToasts(page);
  await mockNotifications(page, () => [BACKLOG], marked);
  await mockEmptyEvents(page);

  await page.goto("/#/company");
  await dismissTour(page);
  // Three more polls after the seeding one, so this reads as "never announced"
  // rather than "not announced yet" — and so a seed that merely deferred the
  // toast by a tick would be caught here rather than shipping.
  for (let i = 0; i < 3; i++) {
    await pollNow(page);
    await page.waitForTimeout(1_000);
  }

  expect(await toastsSoFar(page), "the backlog was announced on arrival").not.toEqual(
    expect.arrayContaining([expect.stringContaining("backlog row")]),
  );

  // And nothing acked it on the way past, which is what keeps it in the
  // Activity tab at all.
  expect(marked, "no mark-read was sent for a row nobody dismissed").toEqual([]);
});

test("the backlog row is waiting on the Notifications page instead", async ({ page }) => {
  // The other half of the rule: staying quiet is only correct because the row
  // is somewhere. If seeding ever started dropping rows rather than merely not
  // announcing them, this is what catches it.
  const marked: string[][] = [];
  await recordToasts(page);
  await mockNotifications(page, () => [BACKLOG], marked);
  await mockEmptyEvents(page);

  await page.goto("/#/notifications?tab=activity");
  await dismissTour(page);

  const row = page.getByTestId("activity-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-kind", "dispatch_failed");
  await expect(row).toContainText("backlog row");
});

test("a row that arrives while the console is open is toasted", async ({ page }) => {
  // The one claim a transient announcement can honestly make: something failed
  // while you were here, looking at something else.
  const rows: Row[] = [BACKLOG];
  const marked: string[][] = [];
  await recordToasts(page);
  await mockNotifications(page, () => rows, marked);
  await mockEmptyEvents(page);

  await page.goto("/#/company");
  await dismissTour(page);
  await pollNow(page);
  await page.waitForTimeout(1_000);

  rows.push(LIVE);
  await pollNow(page);
  await expect
    .poll(() => toastsSoFar(page), { timeout: 15_000 })
    .toEqual(expect.arrayContaining([expect.stringContaining("live row")]));

  // Still only the new one — seeding is not deferral.
  expect(await toastsSoFar(page)).not.toEqual(
    expect.arrayContaining([expect.stringContaining("backlog row")]),
  );
});
