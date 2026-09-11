import { expect, test } from "@playwright/test";

// The first-run tour is modal and correctly receives focus while it is open;
// skip it here so this spec can exercise the shell's ordinary tab order.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key: string) {
      return key.startsWith("oc-tour:") ? '{"skipped":true}' : real.call(this, key);
    };
  });
});

test("the skip link reaches main content and the sidebar is the primary navigation", async ({
  page,
}) => {
  await page.goto("/#/company");

  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  const main = page.getByRole("main");

  // The console boots through a "Connecting…" phase that has no shell and so
  // no skip link; a Tab pressed against that phase moves focus nowhere. The
  // skip link exists only once the shell (and its sidebar) has mounted, so
  // waiting for it is the app-ready signal — and the sidebar's chrome renders
  // in the same commit, so nothing focusable appears between them.
  await skip.waitFor();

  // This is the first tab stop, ahead of the sidebar's host switcher and its
  // destination rows, even though the fixed sidebar renders before main.
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  // Hash routing owns `window.location.hash`; the skip link must focus main
  // without turning its conventional fragment into a route change.
  await page.keyboard.press("Enter");
  await expect(main).toBeFocused();
  await expect(main).toHaveAttribute("id", "main-content");
  await expect(page).toHaveURL(/#\/company$/);

  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(navigation).toBeVisible();
  // Four sections, and the four are the whole list. Asserted by count as well
  // as by name: a fifth row creeping back in is the thing this restructure
  // exists to stop, and four `toBeVisible` calls would not notice it.
  for (const name of ["Room", "Company", "Connections", "Automations"]) {
    await expect(navigation.getByRole("button", { name, exact: true })).toBeVisible();
  }
  // Scoped to the FIRST group — the fixed four. The group after it holds the
  // active section's contents, which is a different question and a different
  // count. Asserted by count as well as by name: a fifth row creeping back in
  // is the thing this restructure exists to stop, and four `toBeVisible` calls
  // would not notice it.
  await expect(
    page.locator("[data-slot=sidebar-content] [data-sidebar=group]").first()
      .locator("[data-sidebar=menu-button]"),
  ).toHaveCount(4);
  // Overview is not among them: it is chrome in the window's title row now,
  // not a destination in a list of destinations. Observatory never had a row
  // here — it is filed under Settings (`settings-pages.ts`). Approvals followed
  // Overview out of this column: it is the Approvals tab of the Notifications
  // page now, reached from the title row's bell asserted at the end of this
  // test rather than from a row here.
  for (const name of ["Overview", "Observatory", "Approvals"]) {
    await expect(navigation.getByRole("button", { name, exact: true })).toHaveCount(0);
  }

  // Settings and Discord are glyphs in the window's title row now
  // (`title-bar-utilities.tsx`), not a labelled footer group in the sidebar —
  // the sidebar footer this used to check is gone entirely ("No footer." per
  // `app-shell.tsx`). Feedback went further: it left the title row too and is
  // a plain row on the Settings rail (`#/settings/feedback`), so it is
  // asserted absent from both chrome positions rather than present in either.
  await expect(page.getByTestId("title-bar-settings")).toBeVisible();
  await expect(page.getByTestId("title-bar-discord")).toBeVisible();
  await expect(page.getByRole("button", { name: "Feedback", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Feedback", exact: true })).toHaveCount(0);

  // Not interleaved with the destinations: `sidebar-content` is the list of
  // places inside this company, and none of the console's own chrome belongs
  // in it.
  const destinations = page.locator("[data-slot=sidebar-content]");
  await expect(destinations.getByRole("button", { name: "Room", exact: true })).toBeVisible();
  await expect(destinations.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-slot=sidebar-footer]")).toHaveCount(0);

  // The bell that replaced the Approvals row. An icon-only control is a
  // destination only if it has an accessible name, which is this spec's whole
  // subject — so the guarantee moves with the feature instead of being dropped
  // when the row was. The name is "Notifications" at rest and
  // "Notifications — N approvals need you" once something is waiting
  // (`notifications-button.tsx`), so it is matched on the destination's name
  // leading it rather than on a count this fixture does not fix.
  const bell = page.getByTestId("title-bar-notifications");
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName(/^Notifications/);
  await bell.click();
  await expect(page).toHaveURL(/#\/notifications$/);
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
});

/**
 * The title row has no scroll and no wrap: the switcher is a fixed 12rem, the
 * glyph groups are all `flex-none`, and the search is the row's one elastic
 * member. So the band has a hard minimum width, and past it the trailing
 * controls simply fall under the shell's `overflow-hidden` — no scrollbar, no
 * ellipsis, nothing on screen saying anything is missing.
 *
 * Adding the Notifications bell moved that minimum: measured in a browser, the
 * profile group's right edge went from 447px to 483px, so a ~480px viewport
 * that fit began clipping most of the profile control (Codex). The Discord
 * glyph is `max-sm:hidden` to give those 36px back.
 *
 * Asserted at **480px**, which is the width that can tell the two apart. 640px
 * cannot: the elastic search absorbs the slack there and the row fits with or
 * without the fix, so a check at `sm` would have reported green against the
 * clipping build — it was written that way first and did exactly that.
 *
 * `toBeInViewport` is not enough on its own either — a control one pixel inside
 * counts — so each box is compared against the viewport's right edge.
 */
test("the title row's trailing controls stay inside a 480px viewport", async ({ page }) => {
  const width = 480;
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/#/company");

  const bell = page.getByTestId("title-bar-notifications");
  await bell.waitFor();

  // Discord is deliberately absent at this width and is not in this list. Every
  // control that remains is console function rather than an outbound link, and
  // each one has to be wholly on screen.
  for (const id of [
    "title-bar-notifications",
    "title-bar-overview",
    "title-bar-settings",
    "title-bar-group-you",
  ]) {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box, `${id} should have a box`).not.toBeNull();
    expect(box!.x, `${id} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(
      Math.round(box!.x + box!.width),
      `${id} ends inside the viewport, not under the shell's overflow-hidden`,
    ).toBeLessThanOrEqual(width);
  }

  // And the page does not solve it by growing a horizontal scrollbar instead.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, "the shell does not scroll horizontally").toBeLessThanOrEqual(width);

  // The glyph that yields the width is still there once there is width for it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("title-bar-discord")).toBeVisible();
});
