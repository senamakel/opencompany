import { useCallback } from "react";
import {
  BookText,
  Brain,
  FolderClosed,
  type LucideIcon,
  MessagesSquare,
  Network,
  Plug,
  Wallet,
  Workflow,
} from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { RESTING_ROW } from "@/components/sidebar-controls";
import { useRoomRailSlot } from "@/components/room-rail";
import { isNavigationActive, type View } from "@/lib/console-routes";
import { CONNECTION_PAGE_GROUPS, connectionPagesIn } from "@/views/connection-pages";
// The leaf table, not the section — importing `FinanceSection` here would pull
// `InvoicingView`, `WalletView` and the lazy `FinancesView` into the module the
// sidebar renders on every route. Same reason `connection-pages.ts` exists.
import { FINANCE_PAGES } from "@/views/finance/finance-pages";
import { cn } from "@/lib/utils";

/**
 * One destination inside a section: a row on that section's content rail
 * (`components/section-rail.tsx`) while it is the section you are in.
 *
 * `sub` is the hash's second segment, for a child that is a sub-page of its
 * parent's view (`#/connections/apps`) rather than a view of its own.
 */
export interface NavChild {
  view: View;
  sub?: string;
  label: string;
  icon: LucideIcon;
  /**
   * What the page is for, in a phrase.
   *
   * Not a second line under the label — that was removed from every rail in the
   * console by issue #2131, because at `w-60` most of them wrapped and a rail
   * of them was a wall rather than a list. It is the row's `title`, and below
   * `lg` it is the line under the chip row naming the active page. Kept as data
   * for exactly that reason, the way `SETTINGS_PAGES` keeps its own.
   */
  hint: string;
  /**
   * This child's own sub-pages, rendered indented under it. Finance is the only
   * one, and it nests rather than drawing a rail of its own because two `w-60`
   * rails in one viewport is issue #1383 — the argument is on
   * `SectionContentRail`.
   */
  children?: NavChild[];
  /**
   * Render this child as a **caption over its pages**, not as a row you press.
   *
   * A row with children is a destination that also opens: you click it, it
   * navigates, and its pages appear under it. A `group` is not a destination at
   * all — it is a heading, its pages are always listed beneath it, and there is
   * nothing to press on the heading itself. The Settings rail has had exactly
   * this shape all along (`SETTINGS_PAGE_GROUPS`), which is what makes it the
   * pattern to match rather than a third thing to learn.
   *
   * A `group` therefore needs no `view`/`sub` of its own that anyone lands on —
   * it keeps them only so the table stays one type, and the rail never calls
   * its `onSelect`.
   */
  group?: boolean;
}

/**
 * A top-level sidebar row, and everything filed under it.
 *
 * A view with no row of its own but an obvious owner — `#/tasks/<id>` under
 * Work, `#/team/<id>` under Agents — is claimed by
 * `isNavigationActive` in `console-routes.ts` rather than by a list here, so
 * there is one place that decides it and the routing module owns it.
 */
export interface NavSection {
  /** Where the section's own row goes. */
  view: View;
  sub?: string;
  label: string;
  icon: LucideIcon;
  children?: NavChild[];
}

/**
 * The console's five sections.
 *
 * ## Why four rows and not ten
 *
 * Ten flat rows is not a list an operator scans, it is a wall — the same
 * judgement `docs/spec/runtime/ledgers-console-ia.md` made when it rejected a
 * row per declared list. What replaces it is a handful of things you can name
 * without reading: the room you talk in, the company you are running, what it
 * is connected to, the work it repeats, and what is waiting on you. Everything
 * else is filed under one of them, in the sidebar, visible while you are in
 * that section.
 *
 * ## Labels and view ids are allowed to differ
 *
 * "Room" is the `chat` view and "Flows" is `workflows`, exactly as "Work" has
 * been the `ledgers` view since #1284. A view id is an **address** — every
 * `#/chat/<channelId>` link ever minted, every `#/workflows/<id>` a run row
 * points at — and renaming a row is not a reason to break them. The `data-tour`
 * anchors follow the view id for the same reason: they are how the guided tour
 * and the e2e specs find a row, and they should not move when a word does.
 *
 * ## Sub-navigation lives in the CONTENT area, not here
 *
 * This table feeds two surfaces now, and only one of them is the sidebar. The
 * top-level rows above are the sidebar's; every `children` list below is read by
 * `components/section-rail.tsx` and drawn as the first column of the content
 * area, the way Settings has always drawn its own.
 *
 * ### This reverses what shipped, on purpose (issue #2130)
 *
 * The argument that put these rows in the sidebar was good, and it is written
 * out here rather than deleted, because a decision reversed without its reasons
 * on the page gets reversed back. It said: a rail inside the page puts the same
 * kind of list in two different places depending on which section you are in —
 * the sidebar for the sections without sub-pages, a rail for the ones with — so
 * there is no rule to learn; and it charges the content pane 240px on every page
 * under it, on a screen that already has a sidebar. PR #1977 shipped a
 * Connections content rail and then removed it on exactly that reasoning.
 *
 * What outweighs it is what the sidebar's middle region was being spent on. It
 * held whichever section you were in, which meant it held the **channel list**
 * only while you were in Room — and the channel list is the one list an operator
 * comes back to continuously, from wherever they are. Losing it on every trip to
 * Company, Connections or Flows costs more than 240px of content width does,
 * because it is not a width, it is a round trip: go to Room, find the channel,
 * come back.
 *
 * So the trade is inverted. The sidebar's middle region is the Room rail,
 * permanently, on every section (`SidebarNavigation` below, and `room-rail.tsx`
 * for the portal that fills it). The sections that had sub-navigation there draw
 * it as a content rail instead.
 *
 * The "two places" half of the old argument survives the reversal, and is
 * answered rather than ignored: there is exactly **one** rule now, which is that
 * a section's sub-navigation is the first column of its content, and exactly one
 * rail on screen at a time. Finance and Settings each drew a `w-60` rail of
 * their own; Finance's is gone, folded into Company's as nested rows, precisely
 * so that the rule has no exception (see `SectionContentRail`). Settings keeps
 * drawing its own because it is not one of the four sections at all — it is a
 * footer utility — and its rail *is* this pattern.
 */
export const NAV_SECTIONS: NavSection[] = [
  // The chat column, whole, and the console's default landing view
  // (`app-shell.tsx`'s `useHashView` fallback). The room is where an operator
  // says what they want and where their company answers — the thing they came
  // to do — so it is what opens, and it is first.
  //
  // It has no `children`, and it needs none: its contents are the channel list
  // `RoomView` renders, portalled into the sidebar's own middle region — which
  // is now pinned there on every section rather than being Room's turn at it.
  // See `room-rail.tsx`.
  { view: "chat", label: "Room", icon: MessagesSquare },
  // The company itself: who is in it, what they are working on, what it keeps,
  // what it remembers, and what it spends. Five surfaces that were five
  // top-level rows and are one subject.
  {
    view: "company",
    label: "Company",
    icon: Network,
    children: [
      // Today's Company page, renamed. "Company > Company" said the word twice
      // and told you nothing; what the page actually is, is the roster and the
      // org chart — the agents.
      { view: "company", sub: "agents", label: "Agents", icon: Network, hint: "Who is in this company" },
      // Tasks by default; every other list the company declared is one click
      // away through the switcher on `LedgersView`'s own title. See
      // `docs/spec/runtime/ledgers-console-ia.md` Rule 2 for why this is one
      // row and not one per list.
      { view: "ledgers", label: "Work", icon: BookText, hint: "Tasks, and every list it declared" },
      { view: "workspace", label: "Workspace", icon: FolderClosed, hint: "The files it keeps" },
      // One row, not a three-row caption group. Brain's Overview, Upload and
      // Settings are tabs in the page's own header now
      // (`views/memory/brain-pages.ts` argues why): one subject looked at three
      // ways, rather than three destinations worth three of the sidebar's
      // scarce rows. The addresses are unchanged — the row still opens
      // `#/company/brain`, and `#/company/brain/upload` still opens Upload.
      { view: "brain", label: "Brain", icon: Brain, hint: "What it remembers" },
      // A row under Company, with sub-pages of its own — the table's one
      // grandchild list.
      //
      // It was briefly a top-level section beside Company and Connections, on
      // the argument that being two levels down made its pages reachable
      // differently from everybody else's. What that missed is what the row is
      // *about*: what a company earns and spends is one of the facts Company
      // enumerates, alongside who is in it and what it remembers — a section of
      // its own put a peer of Connections next to it and said this is a
      // different subject, which it is not.
      //
      // Nested rather than left as a second rail inside the Finance page:
      // Company already draws a `w-60` rail, and a second one beside it is
      // issue #1383 at every width rather than only at 768–1023px.
      // `FinanceSection` is dispatch-only as a result, which is the shape
      // `ConnectionsSection` already had.
      {
        view: "finances",
        label: "Finance",
        icon: Wallet,
        hint: "What it earns and spends",
        // A caption over its three pages, not a row that reveals them.
        //
        // As a row it was the odd one out twice over: the only entry on this
        // rail whose pages were hidden until you pressed it, and — because a
        // row is an icon and a word — a glyph that looked like a destination
        // and behaved like a disclosure. Overview, Invoicing and Wallet are
        // now simply listed, the way Settings lists the pages under
        // "Identity & lifecycle".
        group: true,
        children: FINANCE_PAGES.map((page) => ({
          view: "finances" as const,
          sub: page.id,
          label: page.label,
          icon: page.icon,
          hint: page.hint,
        })),
      },
    ],
  },
  // What the company can act through: the apps its teammates sign in to, and
  // the MCP tool servers they can call. Its children come straight off
  // `connection-pages.ts` rather than being restated here — that module is
  // already what the route resolver, the rewrites and `CONNECTIONS_NAMED_BY`
  // read, and a fourth copy of two labels is a fourth thing to forget. This
  // section shipped with a content rail of its own (PR #1977), gave it up for
  // rows in the sidebar, and has it back — as the shared one every section with
  // sub-pages now draws, rather than one built here. See the reversal argument
  // on this table above; `ConnectionsSection` is still dispatch-only either way.
  //
  // Three caption groups rather than seven flat rows (issue #2259), and they
  // are the same shape Finance already has above and the Settings rail has had
  // all along: `group: true` over a list of pages, drawn as a heading by
  // `section-rail.tsx`. Nothing about the addresses changes — every group's
  // rows name a `ConnectionPage`, and the grouping is read off
  // `CONNECTION_PAGE_GROUPS`, which argues what the split means.
  {
    view: "connections",
    label: "Connections",
    icon: Plug,
    children: CONNECTION_PAGE_GROUPS.map((group) => ({
      view: "connections" as const,
      label: group.label,
      // A caption's own icon is never drawn; the table is one type, so it
      // carries the section's rather than pretending the field is optional.
      icon: Plug,
      hint: "",
      group: true,
      children: connectionPagesIn(group.id).map((page) => ({
        view: "connections" as const,
        sub: page.id,
        label: page.label,
        icon: page.icon,
        hint: page.hint,
      })),
    })),
  },
  // Was "Workflows". One word, and the word an operator uses out loud.
  //
  // No `children`, and so no content rail — it has no sub-navigation to move.
  // The canvas's own Workflows/Runs toggle is a control on the page's title row
  // whose state is persisted client-side rather than carried by the address
  // (`WorkflowsView`'s `indexTab`), so it is not a pair of routes and promoting
  // it to a rail would be inventing sub-pages rather than relocating any.
  { view: "workflows", label: "Automations", icon: Workflow },
  // Approvals is NOT here any more, and this is the third position it has held.
  //
  // It was a row with a `SidebarMenuBadge` and an icon-rail `SidebarMenuDot`;
  // it spent a release as a shield glyph in the window's title row (issue
  // #1018: a count has to survive the rail collapsing, and chrome is the only
  // place that is true of); and it came back here on the argument that a queue
  // is a place you GO and one unlabelled square could not say so.
  //
  // What settles it is that the destination changed. It is not a bare queue any
  // more — it is the Approvals tab of a Notifications page (`#/notifications`),
  // which also carries the durable activity feed that had no surface at all.
  // A bell in the title row names that page without ambiguity, so the objection
  // that sent the shield back downstairs does not apply to it, and the count
  // goes with it: this column draws no second copy, and the dot that existed
  // only to survive a collapse it can no longer suffer is gone with the badge.
  // See `components/notifications-button.tsx`.
  //
  // Overview is NOT here, and neither is Observatory. Both are Rule-6 calls,
  // made explicitly in `docs/spec/runtime/ledgers-console-ia.md`:
  //
  //   - Overview moved UP, into the window's title row, where it is chrome
  //     rather than a destination — a place you jump to from anywhere.
  //     Discoverable elsewhere, in Rule 6's first sense. Approvals went with
  //     it and has come back; see the row above.
  //   - Observatory moved DOWN, into Settings (`settings-pages.ts`), as a rail
  //     row. The rewrite runs the other way from the one you would guess:
  //     `#/settings/observatory` is rewritten onto `#/observatory`, NOT the
  //     reverse. The Observatory reads four query keys straight off the hash
  //     and keys them on its head being `observatory` (`views/observatory/
  //     hash.ts`), so under `#/settings/…` its analytics tab and its
  //     agent/turn selection stop being addressable. The rail row is the
  //     doorway; the surface keeps its own top-level address, and
  //     `#/observatory/<runId>` stays deep-linkable from workflow rows,
  //     approval cards and chat.
  //
  // Agent-authored internal dashboard pages, rendered in a sandboxed iframe
  // (docs/spec/runtime/pages.md), are deliberately NOT offered here (issues
  // #1171, #1172). Do not "fix" the omission by adding a row. What keeps
  // `#/pages` answering is its entry in `@/lib/console-routes`, never a row in
  // this table — a commented row routes nothing, which is exactly how the
  // address died for four months (issue #1311).
  //
  // Settings is not here either, and its absence is deliberate in the same
  // way: it is a utility, not a place an operator works, so it sits on the
  // sidebar's footer with Feedback and Discord (`SidebarUtilityBar`), which
  // still carries the `data-tour="nav-settings"` anchor the guided tour
  // spotlights.
];

/**
 * The section an address belongs to, or `undefined` for a view that is filed
 * under none (Settings and Feedback are in the footer; Overview and Approvals
 * are in the window title row; `not-found` is nowhere by design).
 */
export function sectionOwning(view: View): NavSection | undefined {
  return NAV_SECTIONS.find(
    (section) =>
      isNavigationActive(section.view, view) ||
      section.children?.some((child) => isNavigationActive(child.view, view)),
  );
}

/**
 * Whether a child row is the one currently open.
 *
 * A child with no `sub` of its own owns the bare address AND every second
 * segment its view carries — `#/ledgers/goals` is still Work, `#/workspace/<id>`
 * is still Workspace. A child that names a `sub` owns exactly that segment, and
 * the section's first **rail row** additionally owns the bare address, because
 * that is what the parent row lands on (`#/connections` renders Apps).
 *
 * "First rail row" rather than "first child" since Connections was grouped
 * (issue #2259): the first child of that section is a caption, and a caption is
 * not somewhere an address can land. See {@link sectionRailRows}.
 */
export function childActive(
  section: NavSection,
  child: NavChild,
  view: View,
  sub: string | null,
): boolean {
  return rowActive(sectionRailRows(section), child, view, sub);
}

/**
 * Whether a row nested under a caption group is the one open.
 *
 * The same question as {@link childActive} and, deliberately, against the same
 * set: the **section's** rows, not the group's. A caption is not a scope. Once
 * Connections became three groups (issue #2259), asking this against one
 * group's own list meant every group answered the "first of the set owns every
 * segment none of them names" fallback for itself — so `#/connections/inference`
 * lit LLM under "API Keys" *and* Apps under "Integrations", because
 * "integrations" names no `inference` row. Flattening the groups away is what
 * keeps one address lighting one row.
 */
export function grandchildActive(
  section: NavSection,
  grandchild: NavChild,
  view: View,
  sub: string | null,
): boolean {
  return rowActive(sectionRailRows(section), grandchild, view, sub);
}

/**
 * Every row a section's rail draws, flattened, in document order.
 *
 * A `group` contributes its pages and **not itself**: it is a caption rather
 * than a destination (`NavChild.group`), and `section-rail.tsx` already draws
 * it that way and already leaves it out of the chip row. This is the same fact
 * stated for the purpose of deciding which row an address lights — the set an
 * address is matched against is what an operator can actually press.
 */
function sectionRailRows(section: NavSection): NavChild[] {
  return (section.children ?? []).flatMap((child) =>
    child.group ? (child.children ?? []) : [child, ...(child.children ?? [])],
  );
}

/**
 * Which of a section's rail rows an address lights, if any.
 *
 * A row that names no `sub` owns its whole view. A row that names one owns
 * exactly that segment — **and the first of the set additionally owns every
 * segment none of them names**, not only the bare address.
 *
 * That second half is the part worth stating, because it is not a nicety: it is
 * what keeps this table agreeing with the page. `resolveFinancePage`,
 * `resolveConnectionPage` and `resolveSettingsPage` all fall back to their first
 * page for an unknown segment, so `#/finances/old-page` — a stale bookmark, a
 * typo, a renamed page — *renders Overview*. Matching on the segment alone left
 * the rail marking only the Finance ancestor and the chip row naming the parent
 * while Overview was on screen (Codex P2 review on #2130). The resolver decides
 * what renders; this decides what is marked; they have to be the same rule.
 *
 * The set a row is matched against is narrowed to the rows of the **view the
 * address is on**, which is what lets Company's rail hold both its own pages
 * and Finance's: on `#/finances` the candidates are Overview, Invoicing and
 * Wallet, so "first of the set" is Overview rather than Agents.
 *
 * One row per address, and every row is a page. A draft of #2259 gave the rail
 * a second row on the Apps page pointing at its Credentials tab, which made
 * this function resolve on `(page, tab)` instead — a mechanic nothing else in
 * the console had. Composio is a page of its own now, so the rail is
 * page-addressed again and that whole dimension is gone. If a row ever needs to
 * address less than a page again, the answer is a page.
 */
function rowActive(
  rows: readonly NavChild[],
  row: NavChild,
  view: View,
  sub: string | null,
): boolean {
  if (!isNavigationActive(row.view, view)) return false;
  if (row.sub === undefined) return true;
  const peers = rows.filter((r) => r.sub !== undefined && isNavigationActive(r.view, view));
  const named = peers.some((peer) => peer.sub === sub);
  if (sub === null || !named) return peers[0] === row;
  return row.sub === sub;
}

/**
 * A child row's `data-tour` name, or `undefined` where it would collide.
 *
 * Anchors follow the address, not the label (see `NAV_SECTIONS`), so the child
 * that lands on its section's own address — Agents on `#/company` — would name
 * itself exactly what the section row is already called. Two nodes answering
 * one selector is worse than none: a spec that clicked `nav-company` stops
 * clicking anything and fails as a strict-mode violation.
 */
export function childAnchor(section: NavSection, child: NavChild): string | undefined {
  const anchor = `nav-${child.sub ?? child.view}`;
  return anchor === `nav-${section.view}` ? undefined : anchor;
}

/**
 * The sidebar: four fixed rows, and the Room rail under them — always.
 *
 * ## Not an accordion, and no longer a swap either
 *
 * The four rows are always visible, always contiguous, and always in the same
 * place. Selecting a section does not displace its siblings and does not expand
 * a row in place.
 *
 * What is below the four used to swap with the section you were in. It does not
 * any more (issue #2130): it is the channel list, on every section, and every
 * other section's sub-navigation is the first column of its content area
 * instead (`components/section-rail.tsx`). The reversal and what it is worth are
 * argued on `NAV_SECTIONS` above.
 *
 * That makes the column entirely fixed furniture — four rows and one list, in
 * the same place on every route — which is the property the four-row restructure
 * was reaching for and could not have while the middle region was a variable.
 * There is still no open/closed state to keep anywhere.
 *
 * The two blocks are separated by space rather than by a rule: the column is
 * already quiet, and the console draws no rule above its footer either, so one
 * here would have been the only seam in it.
 *
 * The alternative — each row expanding under itself, pushing the rows after it
 * down — was the first thing this looked like and is worse in two specific
 * ways. The rows move, so the muscle memory of "Flows is the fourth thing" only
 * holds while nothing above it is open. And the one region whose contents are
 * unbounded, the channel list, pushes every row after it off the bottom at an
 * ordinary twenty channels — which recreates, inside one row, exactly the wall
 * this restructure exists to remove (`ledgers-console-ia.md` Rule 2, Draft 1).
 *
 * With a fixed block the four rows never scroll away and the rail is the only
 * thing that scrolls.
 *
 * ## On the collapsed rail
 *
 * The four icons stay, and so does the channel list: `ChannelRail` has a compact
 * variant built for exactly this width (avatars and `#` glyphs with unread
 * dots), and dropping it would make collapsing the sidebar silently lose the
 * channel list — the same regression issue #1018 filed about the approvals
 * badge. Nothing else is in this region to hide any more; the fixed lists of
 * child rows that used to be hidden here at 3rem are content-rail rows now.
 */
export function SidebarNavigation({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (view: View, sub?: string) => void;
  // No `pending`. The approvals count is drawn once, by the title row's bell
  // (`components/notifications-button.tsx`), and this column no longer carries
  // a copy of it — see the note beside `NAV_SECTIONS` above.
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { setElement } = useRoomRailSlot();

  const navigate = useCallback(
    (next: View, nextSub?: string) => {
      onNavigate(next, nextSub);
      if (isMobile) setOpenMobile(false);
    },
    [isMobile, onNavigate, setOpenMobile],
  );

  const active = sectionOwning(view);

  return (
    <>
      {/* The four. Fixed: this group never grows, never shrinks and never
          scrolls, so the rows stay where an operator left them. */}
      <SidebarGroup className="shrink-0">
        <SidebarMenu>
          {NAV_SECTIONS.map((section) => (
            <SidebarMenuItem key={section.view} data-tour={`nav-${section.view}`}>
              <SidebarMenuButton
                isActive={section === active}
                tooltip={section.label}
                onClick={() => navigate(section.view, section.sub)}
                className={RESTING_ROW}
              >
                <section.icon />
                <span>{section.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {/* Space, not a rule.

          A horizontal line here was the reflex and it is the wrong mark: this
          column is already quiet, and one more seam across 13.5rem reads as
          hardware bolted on. The gap does the same work — above it, the four
          places you can go; below it, the room you talk in — and it does it
          without adding anything to look at. The console draws no rule above its
          footer either, so a rule here would also have been the only one in the
          column.

          The gap is the column's own rhythm, and no more: the fixed block's
          `pb-1` plus `SidebarContent`'s `gap-1` is 8px, which is the same step
          between any two rows in the column. This carried a `pt-5` on top of
          that — 24px against an 8px rhythm — on the argument that the break had
          to be legible at a glance. It read instead as the channel list having
          come loose from the four rows above it, which is the one thing this
          column should never suggest: they are one navigation surface, and the
          section caption below already names where the second half starts.

          `min-h-0 flex-1`, so a long channel list scrolls INSIDE itself rather
          than pushing the four rows or the footer off the column. A flex item's
          default `min-height: auto` floors it at its content, which is why the
          zero has to be said here as well as on the child that actually
          scrolls. */}
      <SidebarGroup
        className={cn(
          // No `min-h-0 flex-1` any more. It used to claim the column's
          // leftover height so a long channel list scrolled INSIDE itself
          // rather than pushing the rows above it away; the whole column is one
          // scroller now (`sidebar-inner`), so the list grows to its content
          // and the column scrolls past it.
          "",
          // On the 3rem rail this group's own `px-2` is the difference between
          // fitting and not. The rail is 48px; the gutter leaves a 32px content
          // box, and `ChannelRail`'s compact rows are `size-9` (36px) with their
          // unread dots hung off the right edge — so the rows overhung the slot
          // by 2px a side and the dots landed in horizontal overflow (codex P2
          // review). Measured before this: slot `clientWidth` 32 against
          // `scrollWidth` 34.
          //
          // The gutter goes rather than the rows shrinking: 36px is the compact
          // rail's own avatar size, shared with the roster and the `#` glyphs,
          // and re-sizing it for one container is how the two densities drift
          // apart. Only in icon mode — the expanded column keeps the gutter
          // every other group has.
          "group-data-[collapsible=icon]:px-0",
        )}
      >
        {/* The Room rail's mount point, on every section. What lands in it is
            `RoomView`'s own `ChannelRail`, unchanged — see `room-rail.tsx`, and
            `app-shell.tsx` for why `RoomView` stays mounted off Room to keep
            feeding it. It scrolls rather than truncating behind a "show all": a
            channel list is scanned for a name you already know, and hiding its
            tail behind a control makes the one thing you came for the one thing
            you cannot see. */}
        <div
          ref={setElement}
          data-testid="room-rail-slot"
          // Grows to the list it holds. It scrolled itself while the column
          // had a fixed-height middle; with one scroller on `sidebar-inner`
          // a second one here would trap the channel list in a box inside a
          // page that also scrolls.
          className="flex min-w-0 flex-col"
        />
      </SidebarGroup>
    </>
  );
}
