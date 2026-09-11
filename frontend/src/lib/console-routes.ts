/**
 * The console's route table: every surface `AppShell` can render, and the
 * allow-list `useHashView` validates a hash against.
 *
 * # The rule
 *
 * **`NAV` is presentation. `VIEWS` is routing.** A view routes because it is a
 * member of `View` below and therefore has a `ROUTABLE` entry — never because
 * it happens to have a sidebar row. Taking a row out of `NAV` (issue #302 for
 * Inbox and Finances, #1140 for the Tasks board, #1141 for Team, #1172 for
 * Pages) hides a surface; it does not retire its address. Retiring an address
 * is a separate, deliberate act: drop the view from the union here, delete its
 * render block in `app-shell.tsx`, and send the old address somewhere real with
 * the shell's `REWRITE_RETIRED`.
 *
 * # Why this file exists
 *
 * Routing used to be `[...NAV.map((i) => i.view), ...HIDDEN_VIEWS]` — the nav
 * list plus a hand-maintained second list of views deliberately absent from it.
 * That made "hidden" and "routable" two halves of one treatment that had to be
 * applied together, and issue #1311 is what happens when only one half lands:
 * #1172 commented Pages out of `NAV`, wrote a comment promising `#/pages`
 * "stays live", and never added `pages` to the second list. The address
 * collapsed onto Overview for four months while the shell's `view === "pages"`
 * block, the `lazy()` import above it and the whole sandboxed-iframe surface
 * behind it (`docs/spec/runtime/pages.md`) sat unreachable.
 *
 * `ROUTABLE` is a `Record<View, true>`, so it is complete *by construction*:
 * a view in the union with no entry is a compile error, and `npm run typecheck`
 * is the first step of every console CI lane. There is no longer a second list
 * to forget — a surface the shell can render is a surface an address can reach.
 *
 * Keeping the table in a plain `.ts` module is also what makes it testable:
 * the unit lane (`frontend/vitest.config.ts`) collects the `.test.ts` files
 * under `test/unit` with no React plugin, so `test/unit/task-route.test.ts`
 * — which needs the shell's route table — had to *duplicate*
 * the shell's route table verbatim to reach it — which is precisely why nothing
 * noticed #1311. `test/unit/console-routes.test.ts` imports the real thing.
 */

export type View =
  | "overview"
  | "company"
  | "chat"
  | "inbox"
  | "tasks"
  | "ledgers"
  | "team"
  | "workspace"
  /**
   * The company's durable memory — what it remembers, and what it forgot.
   *
   * A settings sub-page (`#/settings/brain`) until it got its own nav row.
   * Settings is where an operator changes how the company is configured; the
   * brain is something they *read*, repeatedly, the way they read the board.
   * Filing it behind a settings rail meant three clicks to answer "does it
   * already know this", which is a question asked far more often than any
   * setting is changed.
   */
  | "brain"
  /**
   * What is waiting on you, and what has happened to you — the approvals queue
   * and the durable notification feed, as two tabs of one page.
   *
   * Reached from a bell in the window's title row rather than from a sidebar
   * row. The two subjects are one question asked twice ("what needs me?"), and
   * only one of them was ever a page: approvals were a sidebar destination, and
   * the feed (`GET {scope}/notifications`) had no rendered surface at all — it
   * reached a person as a channel badge and a one-shot toast, and nowhere else.
   */
  | "notifications"
  /**
   * The approvals queue's own address, kept alive rather than retired.
   *
   * It has no nav row any more — it is the Approvals tab of `notifications`
   * above — but `#/approvals` and `#/approvals/<taskId>` are linked to from six
   * places in tree (a blocked card's Review link, a chat approval row, a
   * blocked workflow node, the Overview, the onboarding gate, and the queue's
   * own "Show all"), plus every bookmark ever taken. `REWRITE_RETIRED` maps
   * `[head, sub] -> [View, sub]` and has no query-string channel, so
   * `#/approvals/<taskId>` could NOT be rewritten onto
   * `#/notifications?tab=approvals&task=<id>` without dropping the id on the
   * floor. The shell renders the Notifications page for this head instead, with
   * the Approvals tab forced and the second segment forwarded — so the address
   * keeps the whole of its meaning and nothing had to be relinked.
   */
  | "approvals"
  | "workflows"
  | "observatory"
  | "pages"
  | "finances"
  /**
   * What this company can reach outside itself: the apps its teammates act
   * through, and the tool servers they can call.
   *
   * Two settings sub-pages (`#/settings/oauth`, `#/settings/mcp`) until they
   * got a section of their own. Both old addresses still resolve, rewritten by
   * `console-route-rewrites.ts`.
   */
  | "connections"
  | "settings"
  | "feedback"
  /** The first-run setup dialog, opened from a direct address or Settings. */
  | "setup"
  /** The explanation shown when an address names no console surface. */
  | "not-found";

/**
 * Every routable view, one entry per member of `View` — the compiler enforces
 * that, which is the point (see the header).
 *
 * The entries with no `NAV` row in `app-shell.tsx` are annotated with why they
 * have none. They are parked rather than retired: their host routes, stores and
 * e2e specs are untouched, and re-listing one in `NAV` is all it takes to bring
 * it back. Issue #1337 is the open question of what a parked surface should
 * *say* to an operator who arrives on one; this file only decides that they
 * still answer.
 */
const ROUTABLE: Record<View, true> = {
  overview: true,
  company: true,
  chat: true,
  /** No nav row: parked by issue #302, host routes and per-agent store intact. */
  inbox: true,
  /**
   * No nav row, and the load-bearing entry of issue #1140. The board page is
   * gone — bare `#/tasks` is rewritten onto the board's ledger by the shell's
   * `REWRITE_RETIRED` — but `#/tasks/<id>` is the card detail (the timeline,
   * the plan brief, the discussion, the attempts, the steer controls), linked
   * from chat, from an approval card, from a workflow run's rows and from every
   * card on the board. Ledgers deliberately reproduces none of it. Drop this
   * entry and `useHashView` discards the head *and* its sub-page, so every one
   * of those links quietly lands on Overview instead of the card it named.
   */
  tasks: true,
  ledgers: true,
  /**
   * No nav row, for a narrower reason than it used to have (issue #1141). Bare
   * `#/team` is rewritten to `#/company`, whose Cards half is the grid Team
   * used to draw. What this entry keeps alive is `#/team/<agentId>`: the
   * teammate detail page, deliberately a page rather than a modal so it can be
   * linked, and linked to today from the org chart's seats, its "Not on a desk"
   * chips and the chat member pane.
   */
  team: true,
  workspace: true,
  brain: true,
  /** The tabbed page the title row's bell opens. Approvals, and the feed. */
  notifications: true,
  /**
   * No nav row: the Approvals tab of `notifications`. Routable on purpose, and
   * this entry is the load-bearing half of that — see the union above for why
   * `#/approvals/<taskId>` could not be rewritten instead.
   */
  approvals: true,
  workflows: true,
  /**
   * The run observatory: what a company's agents actually did, run by run.
   *
   * A view of its own rather than a fourth lens inside `workflows`, which is an
   * *authoring and operating* surface — create, edit, arm, run, cancel, decide
   * approvals. This one is read-only, cross-run and agent-centric, and the DAG
   * is one lens on it rather than the subject.
   *
   * Addresses past the second segment are query keys, because `useHashView`
   * carries only head/sub: `#/observatory/<runId>?agent=&turn=&step=`.
   */
  observatory: true,
  /**
   * No nav row (issues #1171, #1172) — and this entry is the half of that
   * removal which went missing until issue #1311. Pages is the agent-authored
   * dashboard surface: a sandboxed iframe, a per-document capability and the
   * `oc:graphql` bridge (`docs/spec/runtime/pages.md`), hardened as recently as
   * #1122 and #1221. Without an entry here `#/pages` is an unknown hash, so the
   * shell's `view === "pages"` block is dead code and `nav_visible = false` in a
   * `page.toml` — documented as keeping a page "reachable only by direct URL" —
   * has no URL to be reachable by.
   */
  pages: true,
  /**
   * Un-parked. Issue #302 took the nav row off a flat Finances page; what has a
   * row again is a *section* — the same ledger projection as its Overview, plus
   * Invoicing (Chargebee) and Wallet (PayPal), which are live provider surfaces
   * the host had no HTTP route for until `server::ops::finance`. Its sub-pages
   * ride the second hash segment (`#/finances/wallet`), so this one entry
   * routes all three; see docs/spec/runtime/finance-console.md.
   */
  finances: true,
  /**
   * Apps (the third-party accounts, Composio included) and MCP Servers, under
   * one nav row. Its sub-pages ride the second hash segment
   * (`#/connections/mcp`), so this one entry routes both — the same shape
   * `finances` above uses. See docs/spec/runtime/ledgers-console-ia.md, Rule 7.
   */
  connections: true,
  settings: true,
  /** No nav row: linked from the sidebar footer instead. */
  feedback: true,
  /** No nav row: opens SetupController over Overview (issue #1417). */
  setup: true,
  /** No nav row: the explicit destination for an unrecognized address (#1417). */
  "not-found": true,
};

/**
 * The allow-list `useHashView` validates a hash's first segment against.
 *
 * Derived from `ROUTABLE`, so it can never be a subset of the views the shell
 * renders. Order is irrelevant — the hook only ever asks whether a head is a
 * member.
 */
export const VIEWS: View[] = Object.keys(ROUTABLE) as View[];

/**
 * Where the console opens: an empty hash, a bare `#/`, or an address whose view
 * no longer exists.
 *
 * A constant rather than a literal at the `useHashView` call site, because two
 * things have to agree on it and they are 120 lines apart. The other is the
 * shell's `deepLinked`, which asks "did the operator arrive at a *specific*
 * address, or just open the console?" and answers it by comparing the resolved
 * view against this one. First-run setup only offers itself when the answer is
 * "just opened" — so a default view changed in one place and not the other is
 * not a cosmetic drift, it is a company that can never be set up.
 *
 * There is a third place, and it is the one that actually broke (#1999): a test
 * that opens the console at a *named* view is asserting against whatever this
 * constant said the day it was written. When this moved from `overview` to
 * `chat`, `company-setup.spec.ts` started arriving deep-linked and the
 * first-run specs went red against a console that was working correctly. Tests
 * that mean "just opened the console" must navigate to `/` — an empty hash
 * resolves here by definition and cannot drift.
 */
export const DEFAULT_VIEW: View = "chat";

/**
 * Whether a sidebar destination owns the current view.
 *
 * The two views with no row of their own but an obvious owner. Each is a
 * Rule-6 deep-link destination (`docs/spec/runtime/ledgers-console-ia.md`):
 * routable, linked to from all over the console, and not a place you navigate
 * to from the sidebar.
 *
 * - A task card (`#/tasks/<id>`) is a card on the board Work draws.
 * - A teammate (`#/team/<id>`) is a seat on the org chart Agents draws.
 *
 * Without this the sidebar empties the moment an operator opens one of them:
 * the row they came from goes dark, and — since the restructure into sections —
 * the whole section collapses, taking its sub-navigation with it. The detail
 * screen should read as part of the surface it was opened from.
 */
export function isNavigationActive(item: View, view: View): boolean {
  if (item === view) return true;
  if (item === "ledgers" && view === "tasks") return true;
  if (item === "company" && view === "team") return true;
  return false;
}
