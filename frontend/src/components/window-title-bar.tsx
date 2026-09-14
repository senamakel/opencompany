// The one row across the top of the window: which company you are in, the two
// places you jump to from anywhere, what the agents are allowed to do, and who
// you are signed in as.
//
// The switcher and the profile control used to live in the sidebar column — the
// switcher at its head, under a reserved strip for the traffic lights, and the
// profile row in its footer. That put the two facts that are *about the console
// rather than about the page* at opposite ends of a 13.5rem column, and it put
// the macOS traffic lights on top of a narrow column instead of across a bar,
// so the lights overlapped the switcher and the window had no title row to
// speak of.
//
// Now they are one row spanning the full window width, above the sidebar and
// above the content. Four rules hold it together:
//
// **It is chrome, not content.** It lives outside the sidebar's container and
// outside the scrolling content card, so it survives the sidebar collapsing and
// never scrolls away. The sidebar starts below it.
//
// **It exists in the browser too.** Only the traffic-light inset is gated on
// {@link usesOverlayTitleBar} — the row itself is not. One layout that is right
// everywhere beats a desktop layout and a web layout that drift apart, and the
// difference between them is a 72px spacer.
//
// **Everything on it is centred by one rule.** A single `items-center` on this
// flex row, and no per-item margins: see {@link WINDOW_TITLE_BAR_HEIGHT} for
// why it is the height at which that rule also lands on the traffic lights'
// centre line, which is the one item here whose position macOS owns.
//
// **Its right-hand end is three groups, not five loose items.** See
// {@link TITLE_BAR_GROUP} for what the hairlines between them are doing, and
// {@link TITLE_BAR_LADDER} for the single place that decides what the row drops
// as the window narrows.

import {
  WINDOW_TITLE_BAR_HEIGHT,
  WindowControlsInset,
} from "@/components/window-chrome";
import { cn } from "@/lib/utils";

/**
 * What the row drops as the window narrows — decided here, once, rather than by
 * each item picking its own breakpoint.
 *
 * The window's `minWidth` is 880 (`crates/opencompany-app/tauri.conf.json`) and the row's
 * contents do not fit there at their widest, so something has to go. What made
 * that a design problem rather than an arithmetic one is that every item can
 * make a locally reasonable case for surviving; the order below is the answer,
 * and it lives in one object so that reading it is reading the whole ladder
 * rather than grepping four components for `hidden`.
 *
 * | width   | what goes            |
 * |---------|----------------------|
 * | ≥ 1024  | nothing              |
 * | < 1024  | the company's name   |
 * | floor   | overview + utilities + autonomy + you |
 *
 * The autonomy sentence used to be the first rung, on the argument that it was
 * the longest thing here and the only one whose absence lost no fact. That was
 * right, and it turned out to be an argument against printing it at all: the
 * pill now states the tier and leaves the sentence on its `title`, at every
 * width, so there is nothing left to drop.
 *
 * **The company's name goes first** because the switcher is the widest item in
 * the row and the most redundant one in it — the window already belongs to one
 * company, and the glyph, the chevron and the hover title all survive.
 *
 * **There is no third rung any more.** Overview used to be it, on the argument
 * that Overview is a destination you *choose* while the pending count beside it
 * is one that *chooses you*. Both halves of that pairing have since moved:
 * Approvals is a sidebar row with its own count, and the sidebar footer that
 * carried Overview at narrow widths is gone — so dropping the glyph would leave
 * the page with no control at all below `md`, which is the P1 the old
 * arrangement existed to answer. The four glyphs are 32px each and the two
 * rungs above free far more than that.
 *
 * **The floor is the glyph group, autonomy and you.** What the agents may do
 * must survive any width — a row that has silently dropped it looks identical
 * to a company with no policy at all — and so must a way to reach Settings and
 * the page you came from.
 *
 * The tier's *name* never goes for the same reason. Nothing here wraps and
 * nothing scrolls — every item is `flex-none` except the deliberately elastic
 * middle — so the row cannot grow a second line or a horizontal scrollbar
 * however narrow the window gets.
 */
export const TITLE_BAR_LADDER = {
  /*
   * `autonomySentence` used to be the first rung — the host's leading sentence
   * on the autonomy pill, hidden below `xl`. The pill does not print a
   * sentence at any width now (see `AutonomyPill`), so the rung has nothing to
   * govern and is retired rather than left as a class nobody applies.
   */
  /*
   * `companyName` used to be the second rung — the company's name beside the
   * switcher's glyph, hidden below `lg` so the control collapsed to the glyph
   * alone. The `titlebar` switcher draws no glyph any more (it reads as a
   * select, with a border and the name in it), so the name is the only thing
   * identifying the company and there is nothing left to collapse *to*.
   * Dropping it would leave a bordered box holding a chevron. Retired rather
   * than left as a class nobody applies.
   */
  /**
   * The Overview glyph. Applied by the row itself, to the slot it sits in.
   *
   * `inline-flex` at every width, and it used to be `hidden md:inline-flex`.
   * The narrow case was covered by a second Overview row that the sidebar's
   * footer drew `md:hidden` — the exact complement, so the destination was on
   * screen once at every width and never twice. That footer is gone: Settings,
   * Feedback and Discord are glyphs in this row now, and the Overview fallback
   * had nowhere left to live. Dropping the glyph below `md` with nothing behind
   * it is the P1 that arrangement was built to answer (zero controls named
   * Overview at 390px), so the rung goes rather than the fallback moving again.
   *
   * The row can afford it: Approvals left this row for a sidebar of its own,
   * which returned a slot that grew to hold a count.
   */
  overview: "inline-flex",
} as const;

/**
 * The shape both title-row glyph buttons take — Overview and Approvals.
 *
 * Exported so the two are one decision rather than two copies that drift. It is
 * `relative` because the approvals chip is positioned against it, and it has no
 * fill at rest for the reason the switcher's trigger does not: these stand on
 * the window chrome rather than in a card, and announce themselves on hover and
 * on focus.
 */
export const TITLE_BAR_ICON_BUTTON = cn(
  "relative inline-flex size-8 flex-none items-center justify-center rounded-lg",
  "text-muted-foreground transition",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  // The view you are already on. Keyed off `aria-current` so the appearance and
  // the announced state cannot disagree.
  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
);

/**
 * One of the row's three right-hand groups.
 *
 * `empty:hidden` is load-bearing and not tidiness. Both of the last two groups
 * hold a control that renders **nothing** in a real state — the autonomy pill
 * when the host has not said what the tier is, the profile control on a host
 * with no sign-in — and the element handed to this row is truthy either way, so
 * the layout cannot ask. An empty wrapper would otherwise hold one `gap-2` of
 * dead space open, and, now that a group carries its own divider, would leave a
 * hairline standing beside nothing.
 */
const TITLE_BAR_GROUP = "flex flex-none items-center gap-2 empty:hidden";

/**
 * The hairline that opens a group.
 *
 * Three things after the company name is an accumulation; the rules are what
 * make it a design. They say *these are different kinds of thing* — where you
 * are going, what the agents may do, and who you are — so the eye reads three
 * objects rather than five loose controls, and a gap alone cannot say that at
 * any width that also fits.
 *
 * A `::before` rather than an element of its own, because that is what ties it
 * to {@link TITLE_BAR_GROUP}'s `empty:hidden`: a pseudo-element does not make
 * its host non-empty, so the rule vanishes with the group it introduces instead
 * of surviving it as a stray mark. `--chrome-border` is the border token for
 * this layer — the row stands on `--chrome`.
 */
const TITLE_BAR_DIVIDER = "before:mr-2 before:h-5 before:w-px before:bg-chrome-border before:content-['']";

export function WindowTitleBar({
  switcher,
  overview,
  sidebarToggle,
  search,
  utilities,
  approvals,
  autonomy,
  profile,
}: {
  /** The company/host switcher. Leads the row, right of the traffic lights. */
  switcher: React.ReactNode;
  /**
   * The Overview jump — first half of the right-hand row's first group, and the
   * first thing the row drops as it narrows. See {@link TITLE_BAR_LADDER}.
   */
  overview?: React.ReactNode;
  /**
   * The Approvals jump, carrying the pending count. Second half of the first
   * group and the one item in the row that ever demands attention, which is why
   * it is the last thing that would ever go.
   */
  approvals?: React.ReactNode;
  /**
   * The standing autonomy policy, the second group.
   *
   * Optional, and absent is a real state rather than a gap: the pill renders
   * nothing when the host has not said what the tier is, and the group closes up
   * around it — hairline included. See `AutonomyPill`.
   */
  autonomy?: React.ReactNode;
  /**
   * Show/hide the sidebar, beside the switcher at the row's leading end.
   *
   * Optional: the shell withholds it below `md`, where the sidebar is a sheet
   * with a trigger of its own and this control's two labels are both wrong.
   */
  sidebarToggle?: React.ReactNode;
  /**
   * The search field, filling the row's elastic middle. See
   * `title-bar-search.tsx` — a placed control, not a wired one.
   */
  search?: React.ReactNode;
  /**
   * Settings, Feedback and Discord, beside Overview in the first group.
   *
   * They were the sidebar's footer until they became what they are: controls
   * about the console rather than places inside the company. See
   * `title-bar-utilities.tsx`.
   */
  utilities?: React.ReactNode;
  /** The profile / account control, the third group and the far right. */
  profile: React.ReactNode;
}) {
  return (
    // `data-tauri-drag-region` is opt-in per element, not inherited: Tauri
    // starts a drag only when the pressed element is itself marked. So the
    // switcher and the profile control keep their clicks without opting out of
    // anything, and the empty middle has to opt *in* on its own — which is what
    // the spacer below does.
    <div
      data-tauri-drag-region
      data-testid="window-title-bar"
      className="flex w-full flex-none items-center gap-2 px-3"
      style={{ height: WINDOW_TITLE_BAR_HEIGHT }}
    >
      {/* Renders nothing off the macOS desktop, where the lights do not float
          over the page and there is nothing to clear. */}
      <WindowControlsInset />
      {/* The sidebar's column width, exactly — not a cap.

          `max-w-72` (18rem) was a cap and nothing more: it stopped the trigger
          running halfway across a 1280px row, but it left the width decided by
          the company's name, so the control ended at a different x on every
          host and overhung the sidebar's right edge by however long the name
          happened to be. Sized instead of capped, it lands on the same two
          vertical lines as the nav rows beneath it — the row's own `px-3` puts
          its left edge at 12px, and subtracting both gutters from
          `--sidebar-width` puts its right edge where theirs is.

          `--sidebar-width` rather than a literal: `SidebarProvider` sets it,
          this row is inside that provider, and the one number then lives in
          one place. `shrink-0` because the elastic member of this row is the
          drag spacer beside it; without it a crowded row would take the width
          back out of here and undo the alignment. The name inside still
          truncates, which is what makes a fixed box safe for a long one. */}
      <div className="w-[calc(var(--sidebar-width)-(--spacing(6)))] min-w-0 shrink-0">
        {switcher}
      </div>
      {/* Show/hide the column, beside the company whose column it acts on.
          It used to float over the seam between the sidebar and the content
          card, absolutely positioned out of `SidebarInset` — see
          `SidebarCollapseButton` for the three homes it had before this one and
          what each cost. Here it is one more glyph among the row's own. */}
      {sidebarToggle}
      {/* The elastic middle IS the search field — no spacers beside it.
          It briefly had one `flex-1` spacer either side, which made three
          equal-weight elastic members sharing the gap, so the field took a
          third of the middle and read as a chip that had drifted to the centre.
          One elastic member means it takes the whole of what the two `flex-none`
          groups leave.
          `TitleBarSearch` carries the drag region on its own wrapper — the
          padding around the input, and the band above and below it in a 52px
          row — so the window stays grabbable across the middle without a
          spacer to hold it. */}
      {search}
      {/* Group one — where you are going. The two places you jump to from
          anywhere, held tighter to each other (`gap-1`) than to the groups
          beside them, so they read as one object. No divider: it is the first
          group, and the elastic spacer already separates it from the switcher.

          It carries no `data-tauri-drag-region`, and neither do the groups
          below. The attribute is opt-in per element, so a control simply does
          not have it — marking one would hand its presses to the window drag
          instead of to the thing it opens. The `flex-1 self-stretch` spacer
          above is the row's only elastic member, so that spacer, and not any of
          these, is what keeps the band grabbable. */}
      <div
        data-testid="title-bar-group-go"
        className={cn(TITLE_BAR_GROUP, "gap-1")}
      >
        {/* The ladder's third rung, applied by the row rather than by the button
            — one place decides what goes, and the button decides what it is. */}
        <span
          data-testid="title-bar-overview-slot"
          className={cn(TITLE_BAR_LADDER.overview, "empty:hidden")}
        >
          {overview}
        </span>
        {approvals}
        {utilities}
      </div>
      {/* Group two — what the agents may do. Rendered inside a wrapper on
          purpose, unlike the bare slot this used to be: the wrapper is what
          carries the hairline, and `empty:hidden` is what stops the wrapper
          surviving a pill that returned `null`. */}
      <div
        data-testid="title-bar-group-state"
        className={cn(TITLE_BAR_GROUP, TITLE_BAR_DIVIDER)}
      >
        {autonomy}
      </div>
      {/* Group three — you. Last in the DOM as well as last on screen, so tab
          order reads left-to-right across the row. */}
      <div
        data-testid="title-bar-group-you"
        className={cn(TITLE_BAR_GROUP, TITLE_BAR_DIVIDER)}
      >
        {profile}
      </div>
    </div>
  );
}
