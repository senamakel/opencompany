import { Fragment, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import {
  childActive,
  childAnchor,
  grandchildActive,
  sectionOwning,
  type NavChild,
  type NavSection,
} from "@/components/sidebar-navigation";
import type { View } from "@/lib/console-routes";
import { cn } from "@/lib/utils";

/**
 * One row on a section's rail.
 *
 * `onSelect` rather than an `href`: these rows address views the shell already
 * navigates by `(view, sub)` pair, and routing them through the shell's own
 * `navigate` keeps one place that decides what an address means.
 * `SettingsSection` uses links because its rows are all one view's sub-pages
 * and a hash is the whole address; that difference is real and neither is a
 * copy of the other's mistake.
 */
export interface SectionRailRow {
  key: string;
  label: string;
  /**
   * What the page is for, in a phrase. The row's `title` and, below `lg`, the
   * line under the chip row — not a second line under the label. See `RailRow`
   * for why (issue #2131).
   */
  hint: string;
  icon: LucideIcon;
  active: boolean;
  /** The `data-tour` anchor, or `undefined` where it would collide. */
  anchor?: string;
  onSelect: () => void;
  /**
   * This row's own sub-pages, rendered indented beneath it while it is the open
   * row. Finance is the only one today — see `SectionContentRail` for why they
   * nest here rather than getting a second rail of their own.
   *
   * **One level, deliberately.** A nested row draws no children of its own: the
   * indent is the only thing expressing depth, and a second indent inside a
   * 240px column stops reading as hierarchy and starts reading as ragged. A
   * third level of navigation is a sign the section wants splitting, not a
   * deeper rail.
   */
  children?: SectionRailRow[];
  /**
   * Render as a caption over {@link children} rather than as a row.
   *
   * A group is a heading, not a destination: its pages are always listed, and
   * `onSelect` is never called. See `NavChild.group`.
   */
  group?: boolean;
}

/**
 * A section's sub-navigation, as the first column of its content area.
 *
 * ## Why the content area and not the sidebar
 *
 * The sidebar's middle region is the Room rail, permanently, on every section
 * (issue #2130) — the channel list is the thing an operator returns to most,
 * and losing it whenever they step into Company or Connections costs more than
 * the 240px this column charges. The full argument, including the one this
 * reverses, is on `NAV_SECTIONS` in `components/sidebar-navigation.tsx`.
 *
 * ## Modelled on the Settings rail, deliberately
 *
 * Same widths, same breakpoint, same two shapes: a `w-60` rail from `lg`, and a
 * scrolling row of chips below it. `SettingsSection` keeps drawing its own
 * because its rows are `<a href>` links over one view's sub-pages rather than
 * `(view, sub)` navigations, but the geometry is copied from it on purpose so
 * that an operator meets one pattern rather than two that nearly agree.
 *
 * The breakpoint is `lg`, not `sm`, and that is the whole of issue #1383: from
 * 768–1023px the app sidebar is already on, and a second `w-60` rail there
 * squeezes the working pane to ~290px. Below `lg` this collapses to chips so
 * the pane gets the full width.
 */
export function SectionRail({
  label,
  rows,
  children,
}: {
  /** The section's own name, as the rail's caption and its accessible name. */
  label: string;
  rows: SectionRailRow[];
  children: ReactNode;
}) {
  // The chip row is the rail flattened, and it follows the rail exactly: a
  // row's sub-pages join it while that row is the open one, and not before.
  //
  // Showing every nested page unconditionally was the alternative and is worse
  // here specifically. A chip row has no indentation to express depth with, so
  // Overview, Invoicing and Wallet would sit beside Brain as peers of it —
  // eight equal chips in a horizontal scroller, three of which are only
  // meaningful under a fourth. Following the rail costs one extra tap and keeps
  // the two surfaces saying the same thing.
  const chips = rows.flatMap((row) =>
    // A group contributes its pages and NOT itself: there is nothing to press
    // on a caption, and a chip that navigates nowhere is a dead control in a
    // row of live ones. Its pages are always present for the same reason they
    // are always listed on the rail above — a heading that hides what it heads
    // is not a heading.
    row.group
      ? (row.children ?? [])
      : [row, ...(row.active ? (row.children ?? []) : [])],
  );
  // The DEEPEST active row, not the first. On `#/finances/wallet` both Finance
  // and Wallet are active and Finance comes first, so a `find` here named the
  // parent — "What it earns and spends" — on the one surface where the label
  // alone does not say which page you are on (Codex P2 review). The leaf is
  // also the row that carries `aria-current`, for the same reason: there is one
  // current page, and an ancestor of it is not a second one.
  const current = chips.filter((row) => row.active).at(-1);

  // No rows is a real state — Room and Flows have no sub-navigation — and it
  // renders the same wrapper with neither the rail nor the chip row inside it.
  // The wrapper is what has to be constant; see `SectionContentRail`.
  const hasRail = rows.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      {hasRail && (
      <nav
        aria-label={label}
        className="hidden w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-3 lg:flex"
      >
        {/* A visual caption for the rail, not a heading. The `nav` is already
            named by its `aria-label`, so an `h2` here would add nothing for a
            screen reader and would break the document outline: the rail renders
            before the sub-page, so heading navigation meets a section-level
            heading ahead of the page's own `h1` (issue #1392, and
            `nav-rail-headings.test.ts` holds it). */}
        <div className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">{label}</div>
        {rows.map((row) => (
          <Fragment key={row.key}>
            {row.group ? (
              // A caption, matching the rail's own at the top of this column
              // and the Settings rail's group headings — `pt-3` rather than
              // `pt-1` because this one opens a group inside a list rather than
              // sitting above one. Not a `<button>`, not a heading element: the
              // `nav` is already named by its `aria-label`, and a heading here
              // would land in the document outline ahead of the page's own `h1`
              // (issue #1392).
              <div className="px-2 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {row.label}
              </div>
            ) : (
              <RailRow row={row} current={row === current} />
            )}
            {/* A group's pages are always listed; an ordinary row's appear only
                while it is the row you are on. Always-visible for every row
                would put every leaf of every branch on one rail, which is the
                wall `ledgers-console-ia.md` Rule 2 rejected — a group is the
                deliberate exception, and it earns it by being a heading rather
                than a place. */}
            {(row.group || row.active) &&
              row.children?.map((child) => (
                <RailRow
                  key={child.key}
                  row={child}
                  current={child === current}
                  nested={!row.group}
                />
              ))}
          </Fragment>
        ))}
      </nav>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Below `lg` the rail collapses to a scrolling row of chips, so the
            sub-pages stay reachable without a second drawer.

            `relative z-30`: on the macOS desktop `WindowDragBar` overlays the
            top 28px of the content area with a pointer-events-enabled drag band
            at `z-20`, and this row is the one page top that sits in that band
            below `lg`. Without its own stacking context its links are
            unreachable at 880–1023px window widths — the same fix, for the same
            reason, that `SettingsSection`'s chip row carries. */}
        {hasRail && (
        <div className="relative z-30 border-b lg:hidden">
          <div className="flex gap-1 overflow-x-auto p-2">
            {chips.map((row) => (
              <button
                key={row.key}
                type="button"
                title={row.hint}
                onClick={row.onSelect}
                aria-current={row === current ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  // The leaf, not every active row. Finance is active on
                  // `#/finances/wallet` and so is Wallet, and this row has no
                  // indent to say which of the two you are on — two filled
                  // chips read as two current destinations (Codex P2 review).
                  // What says "you are in this branch" here is the same thing
                  // that says it on the rail: its children are in the row at all.
                  row === current ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                {row.label}
              </button>
            ))}
          </div>
          {/* The hint survives here, and #2131 did not touch the equivalent row
              in Settings for the same reason: a chip carries the label alone,
              so this line is the only gloss it has — and it describes the
              *active* page rather than repeating itself under all of them.
              That is not a second line per row, which is what was removed. */}
          {current && <p className="px-3 pb-2 text-xs text-muted-foreground">{current.hint}</p>}
        </div>
        )}

        {children}
      </div>
    </div>
  );
}

/**
 * One rail row: one line, with the gloss on `title`.
 *
 * The hint was a second line under every label, and at `w-60` most of them
 * wrapped — so a five-row rail was fifteen lines of prose and had stopped being
 * a list you can scan. The labels are the navigation; the hint is a gloss, and a
 * gloss that triples the height of the thing it explains has stopped helping.
 * PR #2133 made exactly this change to the Settings rail (issue #2131) and this
 * copies it deliberately: the two layouts sit side by side and must not
 * diverge — same `items-center`, same iconless `mt-0.5` removal, same `title`.
 *
 * The `data-tour` anchor sits on the wrapper, not the button — the same shape
 * the sidebar's rows have, so every selector written as
 * `[data-tour="nav-x"] >> role=button` works against both.
 */
function RailRow({
  row,
  current,
  nested = false,
}: {
  row: SectionRailRow;
  /** The deepest active row — the one page you are actually on. */
  current: boolean;
  nested?: boolean;
}) {
  return (
    <div data-tour={row.anchor}>
      <button
        type="button"
        title={row.hint}
        onClick={row.onSelect}
        // Exactly one row per rail says `page`, and it is the leaf. Finance is
        // *active* while you are on `#/finances/wallet` — it is the branch you
        // are in — but it is not a second current page, and two nodes answering
        // `aria-current="page"` is a page a screen reader cannot locate you on.
        // What says "you are in this branch" is that its children are showing.
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
          // Depth is what the indent says. Every row is one line now, so this is
          // the only thing distinguishing a sub-page from its parent.
          nested && "pl-8",
          current ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
      >
        <row.icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{row.label}</span>
      </button>
    </div>
  );
}

/**
 * The section rail for whichever section the current address belongs to, or the
 * page bare where that section has no sub-pages.
 *
 * Driven by `NAV_SECTIONS` — the same table the sidebar's four rows come from,
 * `sectionOwning` resolves against and `childActive` lights a row from. One
 * table, read from both ends, so a row added to a section appears here without
 * anyone remembering to add it twice.
 *
 * Room and Flows have no children, so they render their page with no rail at
 * all: Room's sub-navigation is the channel list, which is pinned in the
 * sidebar, and Flows has none to move. Settings is not in this table (it is a
 * footer utility, not one of the four) and keeps drawing its own rail.
 *
 * ## The Finance question
 *
 * Company's rows include Finance, and Finance has three sub-pages of its own —
 * as does Settings, and both used to draw a `w-60` rail inside the page. Under
 * this layout Company already draws one, so Finance's would be the *second*
 * rail in the viewport: sidebar plus 240 plus 240 plus content, which is the
 * 768–1023px band issue #1383 was filed about, now reproduced at every width.
 *
 * So they nest rather than stacking: Finance's pages are indented rows on
 * Company's rail, visible while Finance is the open row. One rail per section,
 * always, and never two. `FinanceSection` is dispatch-only as a result — the
 * shape `ConnectionsSection` has had since PR #1977.
 */
export function SectionContentRail({
  view,
  sub,
  onNavigate,
  children,
}: {
  view: View;
  /** The hash's second segment, so a row can light for its own sub-page. */
  sub: string | null;
  onNavigate: (view: View, sub?: string) => void;
  children: ReactNode;
}) {
  const section = sectionOwning(view);
  // ALWAYS the same element at this position, even for a section with no rail.
  //
  // This used to be `if (!section?.children) return <>{children}</>` beside a
  // `<SectionRail>` return, and the two shapes are what made it a bug rather
  // than a tidiness question: React reconciles by position and type, so
  // swapping a Fragment for `SectionRail` unmounts and remounts everything
  // under it — and `children` here is the console's whole content area,
  // `ChatView` included.
  //
  // `ChatView` is deliberately mounted on every route (`room-rail.tsx`) so the
  // channel list is never a round trip away and returning to Room refetches
  // nothing. Remounting it on the way between Room and Company threw that away
  // silently: the rail portalled into the sidebar was torn down and rebuilt on
  // every such navigation, which reset the sidebar's scroll position to zero —
  // the visible symptom, and the one that led here.
  //
  // Measured before the fix: Company → Connections (both draw a rail) kept the
  // sidebar's scroll at 238px and unmounted nothing; Room → Company and
  // Connections → Flows each unmounted the rail once and dropped the scroll to
  // 0. Exactly the crossings that changed this element's type.
  const rows = section?.children ? sectionRows(section, view, sub, onNavigate) : [];

  return (
    <SectionRail label={section?.label ?? ""} rows={rows}>
      {children}
    </SectionRail>
  );
}

/** One section's children as rail rows, with their own children folded in. */
function sectionRows(
  section: NavSection,
  view: View,
  sub: string | null,
  onNavigate: (view: View, sub?: string) => void,
): SectionRailRow[] {
  const row = (child: NavChild, active: boolean, anchor?: string): SectionRailRow => ({
    // The address, plus the caption's own name. Every ROW is one address, but
    // Connections' three captions are all `connections` with no segment at all
    // (#2259) — and two of them under one React key is one caption.
    key: `${child.view}/${child.sub ?? ""}${child.group ? `#${child.label}` : ""}`,
    label: child.label,
    hint: child.hint,
    icon: child.icon,
    active,
    anchor,
    onSelect: () => onNavigate(child.view, child.sub),
  });

  return (section.children ?? []).map((child) => ({
    ...row(child, childActive(section, child, view, sub), childAnchor(section, child)),
    group: child.group,
    children: child.children?.map((grandchild) =>
      // No `data-tour` on a nested row: the anchors follow the address, and a
      // grandchild's address is its parent's view with a second segment — which
      // `childAnchor` would name after the view, colliding with the parent.
      row(grandchild, grandchildActive(section, grandchild, view, sub)),
    ),
  }));
}
