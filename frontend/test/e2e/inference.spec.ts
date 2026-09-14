import { expect, test } from "@playwright/test";

/**
 * Connections → LLM, against a real browser and a real host.
 *
 * The `Console E2E` job runs this (issue #428) and it is a merge gate, so treat
 * a red run here as a real regression rather than a stale reproduction.
 *
 * ## What these cover, and why they are the ones that need a browser
 *
 * The rules this surface is built on are pure functions with unit tests —
 * which category offers what, what a probe class means, what a removal
 * orphans, whether an override is sendable. None of those needs a browser.
 *
 * What does need one is the part that only breaks in integration: a credential
 * travelling from a dialog through a write route into a store and back as a
 * boolean, a probe classification reaching the row it belongs to, and a delete
 * that has to move a route in a different subsystem. Those are below.
 *
 * ## The invariant that predates the list (issue #265)
 *
 * The page must never report a successful save for a save that threw the
 * operator's key away. It used to be possible because there was **one**
 * credential slot: switching provider left the previous vendor's key in it, and
 * a managed save was a revert that carried none. The list removes the shape of
 * the bug — each provider holds its own credential — and the test for it is now
 * "two providers, two independent keys", below.
 */

type Page = import("@playwright/test").Page;

/**
 * A fresh browser context has no tour state, so the first-run welcome dialog
 * opens over the console and swallows clicks. Skip it when it shows up.
 */
async function openInference(page: Page) {
  await page.goto("/#/settings/inference");
  const skip = page.getByRole("button", { name: "Skip for now" });
  await skip
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => skip.click())
    .catch(() => {
      /* already seen in this context — nothing to dismiss */
    });
  // Either the list or its empty state — a company with nothing connected shows
  // the second, and waiting only for the first would hang on exactly the
  // company a first run starts from.
  await expect(
    page.getByTestId("inference-providers").or(page.getByTestId("inference-providers-empty")),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Wait for the connect dialog to have finished seeding its own fields.
 *
 * It resets Name, URL and Key in an effect keyed on the option it opened for,
 * so a `fill()` that lands before that effect commits is wiped by it —
 * silently, leaving a disabled Add button and a sixty-second wait on a click
 * that can never happen. That is how `a second provider holds a credential of
 * its own` failed on the live-brain lane: Name and Key were set,
 * `#inference-connect-url` was blank, and nothing on the page said so.
 *
 * Waiting on the dialog being visible is enough: React has committed the effect
 * by the time the element it mounted is in the DOM.
 */
async function connectDialogReady(page: Page) {
  await expect(page.getByTestId("inference-connect-provider")).toBeVisible();
}

/** Open the add dialog and choose one option out of a category. */
async function choose(page: Page, category: "cloud" | "local" | "cli", label: string) {
  await page.getByTestId("inference-add-open").click();
  await expect(page.getByTestId("inference-add-provider")).toBeVisible();
  await page.locator(`#inference-add-${category}`).click();
  await page.getByRole("option", { name: new RegExp(label) }).click();
  await connectDialogReady(page);
}

/**
 * Open the add dialog, then take the custom-provider route out of it.
 *
 * `inference-add-custom` is rendered inside the dialog's content, so reaching
 * for it straight off the page waits out the timeout on an element that has
 * not been mounted yet.
 */
async function addCustom(page: Page) {
  await page.getByTestId("inference-add-open").click();
  await expect(page.getByTestId("inference-add-provider")).toBeVisible();
  await page.getByTestId("inference-add-custom").click();
  await connectDialogReady(page);
}

/** The discard port: refused immediately, no DNS, no wait. */
const UNREACHABLE = "http://127.0.0.1:9/v1";

test("Managed is a connected row only when its chain actually resolves", async ({ page }) => {
  // Managed is not a record, so the row is keyed on whether the chain answers
  // rather than on anything having been stored. Both states are asserted here
  // on purpose: the default lane's host serves a company with no managed
  // credential anywhere in the chain and the live-brain lane's has one, so a
  // test that assumed either would be red on the other — and one that simply
  // returned early on the state it did not expect would be quietly vacuous.
  await openInference(page);

  const managed = page.getByTestId("inference-provider-managed");
  if ((await managed.count()) === 0) {
    // Nothing in the chain answers. The honest rendering is not a dead row: it
    // is no row, plus the sentence saying managed is not a fallback.
    await expect(page.getByTestId("inference-managed-fallback")).toContainText("not set up");
    return;
  }

  // It resolves, so the row says which step answers and who it bills.
  await expect(managed).toContainText("Billed to");
  // The switch is this row's one statement about routing — excluding managed
  // from routing is a different act from removing its key, and only the switch
  // expresses it — so it is present, on, and operable rather than decorative.
  const toggle = page.getByTestId("inference-provider-managed-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeEnabled();
  // And there is nothing to remove: no provider record exists, so the menu
  // offers key actions only.
  await page.getByTestId("inference-provider-managed-menu").click();
  await expect(page.getByRole("menuitem", { name: "Remove provider" })).toHaveCount(0);
});

test("a provider behind an unreachable endpoint is saved, amber, and keeps its key", async ({
  page,
}) => {
  // The non-destructive path, and the one the naive implementation gets wrong:
  // a proxy, a WAF, a rate limit and a mistyped model id all fail a probe while
  // the key is perfectly good.
  await openInference(page);

  await addCustom(page);
  await page.locator("#inference-connect-name").fill("E2E Gateway");
  await expect(page.getByTestId("inference-slug-preview")).toHaveText("Slug: e2e-gateway");
  await page.locator("#inference-connect-url").fill(UNREACHABLE);
  await page.locator("#inference-connect-key").fill(`pw-e2e-${Date.now()}`);
  await page.getByTestId("inference-connect-submit").click();

  const row = page.getByTestId("inference-provider-e2e-gateway");
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The row was created and the credential was kept: the save succeeded, and
  // only reachability is in question.
  await expect(row).toContainText("•••• configured");
  await expect(page.getByTestId("inference-provider-e2e-gateway-health")).toContainText(
    "unreachable",
  );

  // And it survives a reload, which is the half a component test cannot see.
  await page.reload();
  await openInference(page);
  await expect(page.getByTestId("inference-provider-e2e-gateway")).toContainText(
    "•••• configured",
  );
});

test("a second provider holds a credential of its own", async ({ page }) => {
  // The first moment two keys exist at once. One slot per company is why
  // switching provider used to strand a credential for the wrong vendor in the
  // only slot there was.
  await openInference(page);

  for (const name of ["E2E One", "E2E Two"]) {
    await addCustom(page);
    await page.locator("#inference-connect-name").fill(name);
    await page.locator("#inference-connect-url").fill(UNREACHABLE);
    await page.locator("#inference-connect-key").fill(`pw-e2e-${name}-${Date.now()}`);
    await page.getByTestId("inference-connect-submit").click();
    await expect(page.getByTestId("inference-connect-provider")).toHaveCount(0, {
      timeout: 30_000,
    });
  }

  await expect(page.getByTestId("inference-provider-e2e-one")).toContainText("•••• configured");
  await expect(page.getByTestId("inference-provider-e2e-two")).toContainText("•••• configured");
});

test("the add dialog stops offering a provider once it is connected", async ({ page }) => {
  // Offering to add something twice is how you get two rows for one provider.
  await openInference(page);

  await choose(page, "cloud", "Groq");
  await page.locator("#inference-connect-key").fill(`pw-e2e-${Date.now()}`);
  await page.getByTestId("inference-connect-submit").click();

  // A real vendor is reachable from CI and rejects a made-up key, and an add
  // whose credential was rejected is refused and rolled back rather than stored
  // looking green. That refusal is the behaviour this surface exists to have,
  // and there is no real Groq credential here to satisfy it with — so this test
  // asserts the refusal and then takes the documented escape hatch, which is
  // the only honest way to reach a connected catalogue row without a key.
  await expect(page.getByTestId("inference-connect-error")).toContainText(
    "rejected the credential",
    { timeout: 30_000 },
  );
  await page.getByTestId("inference-add-anyway").click();
  await expect(page.getByTestId("inference-provider-groq")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("inference-add-open").click();
  await page.locator("#inference-add-cloud").click();
  await expect(page.getByRole("option", { name: /^Groq/ })).toHaveCount(0);
});

test("a custom provider may not take a name the catalogue ships", async ({ page }) => {
  // A routing entry saying `cerebras` would otherwise mean two things — and the
  // refusal happens before anything is written.
  //
  // **Deliberately a catalogue row nothing else connects.** `checkSlug` reports
  // `taken` before `reserved`, and every test in this file shares one company:
  // once "the add dialog stops offering a provider once it is connected" has
  // added Groq, typing "Groq" here answers "This company already has a provider
  // with that name" — a true sentence about the wrong rule, and the assertion
  // below would be pinning test order rather than the reservation. Cerebras is
  // in the catalogue and is connected by no test.
  await openInference(page);

  await addCustom(page);
  await page.locator("#inference-connect-name").fill("Cerebras");
  await page.locator("#inference-connect-url").fill(UNREACHABLE);
  await expect(page.getByTestId("inference-slug-error")).toContainText("built-in");
  await expect(page.getByTestId("inference-connect-submit")).toBeDisabled();
});

test("disabling a provider keeps its credential", async ({ page }) => {
  // Distinct from deleting it: "stop billing this account this week" has to be
  // expressible, and a disable that scrubbed would make re-enabling a
  // re-configuration.
  await openInference(page);

  await addCustom(page);
  await page.locator("#inference-connect-name").fill("E2E Parked");
  await page.locator("#inference-connect-url").fill(UNREACHABLE);
  await page.locator("#inference-connect-key").fill(`pw-e2e-${Date.now()}`);
  await page.getByTestId("inference-connect-submit").click();
  await expect(page.getByTestId("inference-provider-e2e-parked")).toBeVisible({ timeout: 30_000 });

  // Switching off is confirmed now, in reversible language: it parks the
  // workloads routed through this provider rather than losing anything.
  await page.getByTestId("inference-provider-e2e-parked-toggle").click();
  await expect(page.getByTestId("inference-remove-dialog")).toContainText("Switch off");
  await page.getByTestId("inference-remove-confirm").click();
  await expect(page.getByTestId("inference-remove-dialog")).toHaveCount(0);
  await page.reload();
  await openInference(page);

  const row = page.getByTestId("inference-provider-e2e-parked");
  await expect(row.locator("[role='switch']")).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("•••• configured");
});

test("deleting a provider removes its row and resets the routes that named it", async ({
  page,
}) => {
  await openInference(page);

  await addCustom(page);
  await page.locator("#inference-connect-name").fill("E2E Doomed");
  await page.locator("#inference-connect-url").fill(UNREACHABLE);
  await page.locator("#inference-connect-key").fill(`pw-e2e-${Date.now()}`);
  await page.getByTestId("inference-connect-submit").click();
  await expect(page.getByTestId("inference-provider-e2e-doomed")).toBeVisible({ timeout: 30_000 });

  // Point one workload at it, through the routing tab.
  await page.getByRole("tab", { name: "Routing" }).click();
  await page.getByTestId("inference-mode-advanced").click();
  await page
    .getByTestId("inference-workload-reasoning")
    .getByRole("button", { name: /Model$/ })
    .click();
  await page.locator("#inference-workload-provider").click();
  await page.getByRole("option", { name: "E2E Doomed", exact: true }).click();
  await page.getByTestId("inference-workload-apply").click();
  await expect(page.getByTestId("inference-workload-reasoning")).toContainText("E2E Doomed");

  // Remove it, and the row that named it moves back to the primary.
  await page.getByRole("tab", { name: "LLM Providers" }).click();
  await page.getByTestId("inference-provider-e2e-doomed-menu").click();
  // Named exactly. The menu carries "Remove key" beside "Remove provider" —
  // two different acts, and the distinction between them is the whole reason
  // both are there — so a substring match resolves to both and takes neither.
  await page.getByTestId("inference-provider-e2e-doomed-remove").click();
  // Removing a provider moves routes that belong to other workloads, so it is
  // confirmed rather than done on a single click.
  await expect(page.getByTestId("inference-remove-dialog")).toBeVisible();
  await page.getByTestId("inference-remove-confirm").click();
  await expect(page.getByTestId("inference-provider-e2e-doomed")).toHaveCount(0, {
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Routing" }).click();
  await page.getByTestId("inference-mode-advanced").click();
  await expect(page.getByTestId("inference-workload-reasoning")).toContainText("Primary (");
});

test("the routing mode is inferred from the routes and round-trips", async ({ page }) => {
  // There is no stored mode to drift out of sync with the rows.
  await openInference(page);
  await page.getByRole("tab", { name: "Routing" }).click();

  // **Managed is only selectable when Managed can answer.** On an instance whose
  // managed chain resolves to nothing, an empty table must not read as Managed
  // and the row must not be clickable — which is the reported defect, and the
  // opposite of what this screen did before.
  const managedMode = page.getByTestId("inference-mode-managed");
  if (await managedMode.isDisabled()) {
    // Whatever else this company's routes say, the one thing that must hold is
    // that Managed is neither selected nor selectable when it cannot answer.
    await expect(managedMode).toHaveAttribute("aria-pressed", "false");
    return;
  }

  await managedMode.click();
  await page.reload();
  await openInference(page);
  await page.getByRole("tab", { name: "Routing" }).click();
  await expect(page.getByTestId("inference-mode-managed")).toHaveAttribute("aria-pressed", "true");
});

test("coding is shown as an alias and cannot be routed separately", async ({ page }) => {
  // Four editable rows, not five: coding and agentic are one tier, so an
  // editable coding row would write one tier's route under two names.
  await openInference(page);
  await page.getByRole("tab", { name: "Routing" }).click();
  await page.getByTestId("inference-mode-advanced").click();

  const coding = page.getByTestId("inference-workload-coding");
  await expect(coding).toContainText("Follows Agentic");
  await expect(coding.getByRole("button")).toHaveCount(0);
});
