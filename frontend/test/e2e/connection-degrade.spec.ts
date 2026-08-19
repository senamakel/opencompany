import { expect, test, type Page } from "@playwright/test";

import { openHostMenu } from "./host-switcher";

/**
 * The headline requirement, and the regression that comes with it.
 *
 * The console holds several OpenCompany hosts at once. The thing that makes
 * that worth having — and the thing that is easy to lose — is that the
 * connections are *independent*: one host being unreachable reddens one row in
 * the host switcher and leaves every other host's console working.
 *
 * Before this, failure was global. `App` held one phase, so a host that could
 * not be reached rendered a full-screen "Can't connect" over the whole app, and
 * a 401 anywhere dropped the entire console to a sign-in screen. With one host
 * that is indistinguishable from correct. With two it is the bug.
 *
 * block/buzz is the cautionary example and it is worth naming, because its
 * desktop *looks* like this: a rail of workspaces down the left edge. Only one
 * is live. Its `AppState` holds a single `relay_url_override`, its retention
 * database is scoped per community, and switching rows is a stateful apply that
 * re-resolves identity and restarts agents. The rail is the easy half; staying
 * genuinely N-at-once is the half this spec guards.
 *
 * The second host here is deliberately one that does **not** exist. A test that
 * needs two live servers is a test nobody runs; an unreachable address exercises
 * exactly the property under test — that a dead connection is contained.
 */

/** A port nothing is listening on, so the second connection is always down. */
const DEAD_HOST = "http://127.0.0.1:9";

/** The tour modal covers the board and swallows clicks. */
async function silenceTour(page: Page) {
  await page.addInitScript(() => {
    for (const key of ["oc-tour:single", "oc-tour:e2e-harness-co", "oc-tour:null"]) {
      window.localStorage.setItem(key, JSON.stringify({ skipped: true, seenAt: Date.now() }));
    }
  });
}

/**
 * Seeds a second host into the connection store before the app boots.
 *
 * Through `localStorage`, the same way the app itself persists hosts, because
 * the switcher's own "Add a host" item only appears once there are two — and
 * the first extra host on a *browser* has no other entry point yet (the desktop
 * shell is where adding hosts becomes a first-class flow).
 */
async function seedSecondHost(page: Page) {
  await silenceTour(page);
  await page.addInitScript((dead) => {
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        // The bootstrap host, same-origin. Named with the id the app would have
        // minted so it adopts this row rather than adding a third.
        {
          id: "conn-primary",
          baseUrl: "",
          label: "Primary",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
        {
          id: "conn-dead",
          baseUrl: dead,
          label: "Offline host",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );
  }, DEAD_HOST);
}

test("a host that is down reddens its own row and leaves the others working", async ({
  page,
}) => {
  await seedSecondHost(page);
  await page.goto("/#/ledgers/tasks");

  // Both hosts are present, so the switcher is a control rather than a
  // nameplate.
  const switcher = page.getByTestId("host-switcher");
  await expect(switcher).toBeVisible({ timeout: 30_000 });
  await expect(switcher).toHaveAttribute("data-host-count", "2");

  // The trigger says so with the menu shut. This is the rail's amber dot,
  // carried across (issue #1142): the console on screen is fine, and an
  // operator still learns that something somewhere is not — without which
  // hiding the rows behind a dropdown would be a net loss.
  await expect(switcher).toHaveAttribute("data-worst-status", "down", { timeout: 30_000 });

  // The live one reaches `live`; the dead one reaches `down`. Neither waits on
  // the other — that independence is the property, and a global phase would
  // have blanked the app before either resolved.
  await openHostMenu(page);
  await expect(page.getByTestId("host-row-conn-primary")).toHaveAttribute(
    "data-status",
    "live",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("host-row-conn-dead")).toHaveAttribute("data-status", "down", {
    timeout: 30_000,
  });
  // And it says so in words, not only in the colour of its dot. An operator
  // who cannot separate amber from green — or who can, and still does not know
  // *what* amber means here — otherwise learns the host is gone by switching
  // to it and landing on its failure (issue #1167).
  await expect(page.getByTestId("host-row-state-conn-dead")).toHaveText("Unreachable");
  // The working row stays quiet: a state printed beside every host is a state
  // beside none of them.
  await expect(page.getByTestId("host-row-state-conn-primary")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // THE assertion. The working host's console is rendered, not a full-screen
  // error — the dead host is contained to its row.
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(1);
  await expect(page.getByTestId("connection-error")).toHaveCount(0);
});

test("selecting the dead host shows its failure without disturbing the live one", async ({
  page,
}) => {
  await seedSecondHost(page);
  await page.goto("/#/tasks");
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(1, {
    timeout: 30_000,
  });

  await openHostMenu(page);
  await page.getByTestId("host-row-conn-dead").click();

  // The dead host says so, in the console area rather than over the whole app.
  await expect(page.getByTestId("connection-error")).toBeVisible({ timeout: 30_000 });

  // And the switcher is still there — on a screen with no sidebar to hold it,
  // which is the case the rail used to cover for free by living outside the
  // console. Without it this screen is a dead end with only a reload.
  await openHostMenu(page);
  // Still showing the live host as live: selecting a broken connection must not
  // tear down a working one. This is exactly what a stateful "apply" switch
  // would break.
  await expect(page.getByTestId("host-row-conn-primary")).toHaveAttribute("data-status", "live");

  // Switching back finds the working console still working, with no reload.
  await page.getByTestId("host-row-conn-primary").click();
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(1);
  await expect(page.getByTestId("connection-error")).toHaveCount(0);
});

test("the number row switches hosts, and leaves the browser alone past the last one", async ({
  page,
}) => {
  await seedSecondHost(page);
  await page.goto("/#/tasks");
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(1, {
    timeout: 30_000,
  });

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // Second host: the dead one, whose console reports its own failure.
  await page.keyboard.press(`${mod}+2`);
  await expect(page.getByTestId("connection-error")).toBeVisible({ timeout: 30_000 });

  // Third host: there isn't one. Nothing happens, and — the reason this is
  // asserted rather than assumed — the key is not swallowed to do nothing, so
  // the browser keeps its own use of it.
  await page.keyboard.press(`${mod}+3`);
  await expect(page.getByTestId("connection-error")).toBeVisible();

  // First host: back to a working console, without a reload.
  await page.keyboard.press(`${mod}+1`);
  await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(1);
  await expect(page.getByTestId("connection-error")).toHaveCount(0);
});

/**
 * The naming half of issue #1167, and the state that produced the screenshot.
 *
 * The same-origin host is the one with no url of its own to read, and it used
 * to be named by a constant — so a console holding it beside anything else
 * unnamed offered two rows reading "This host", one live and one not, with only
 * a dot colour between them. Nothing is seeded for it here on purpose: the
 * point is what the console calls a host it was told nothing about.
 */
test("names the host it was told nothing about by the address it answers on", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://127.0.0.1:8080").host;
  await silenceTour(page);
  await page.addInitScript((dead) => {
    window.localStorage.setItem(
      "oc.connections.v1",
      JSON.stringify([
        // A second host, and nothing about the bootstrap one — which is exactly
        // the arrangement an ordinary console reaches by adding a host.
        {
          id: "conn-unnamed-dead",
          baseUrl: dead,
          label: "Offline host",
          defaultCompany: null,
          credential: { kind: "cookie" },
        },
      ]),
    );
  }, DEAD_HOST);

  await page.goto("/#/ledgers/tasks");
  await openHostMenu(page);

  const rows = await page.getByRole("menuitem").allInnerTexts();
  // Every menu item but the trailing "Add a host", down to its first line: a
  // row also carries its state and its shortcut, and a shortcut differs on
  // every row — comparing whole rows would call two identical names distinct.
  const names = rows
    .filter((text) => !text.includes("Add a host"))
    .map((text) => text.split("\n")[0].trim());
  expect(names.length).toBe(2);
  expect(new Set(names).size, `two hosts must not read alike: ${JSON.stringify(names)}`).toBe(2);
  // Addressable, so it distinguishes — and distinct from every other row, which
  // a constant could never promise.
  expect(names.some((name) => name.includes(origin))).toBe(true);
  expect(names.some((name) => name.includes("This host"))).toBe(false);
});
