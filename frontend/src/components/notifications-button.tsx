// The way into the Notifications page, in the window's title row.
//
// # Third position, and why this one is different
//
// The approvals count has lived in two places and this file has argued for
// both. It was a `SidebarMenuBadge` on an Approvals row, plus a
// `SidebarMenuDot` that existed *only* because that badge carries
// `group-data-[collapsible=icon]:hidden` and so vanished at 32px (issue #1018)
// — two mechanisms for one number, the second a workaround for the first
// disappearing. It then spent a release as a shield glyph in this row, and went
// back to the sidebar on the argument that a queue is a place you GO and that
// one unlabelled square between an Overview glyph and an autonomy pill could
// not say so.
//
// Both of those were arguments about a *queue*. What this opens is a page:
// Approvals and the durable notification feed, as two tabs (`#/notifications`).
// A bell is the one glyph an operator already reads as "the things that
// happened to you, gathered in one place", which is what the destination now
// is — so the naming problem that sent the shield back downstairs does not
// arise. And the disappearance #1018 was really about cannot happen here: this
// band is chrome, it never collapses, and it is on screen on every page in
// every sidebar state. So the badge and the dot are both deleted rather than
// maintained.
//
// # What survives the move
//
// **The accessible name is the whole of what a screen reader gets** from an
// icon-only control, so it says where it goes AND what is waiting — the count
// and the word "approvals" together, the sentence the rail dot's `aria-label`
// carried, because that wording was the deliberate answer to "colour alone is
// not a signal everyone receives".
//
// **The count is one value, from one place.** `pending` is
// `feed.status.pending_approvals`, threaded through the shell — never counted
// again here. A second source is a second answer, and the contract issue #932
// pins is that there is one.
//
// **The chip counts approvals, not notifications.** The Activity tab's feed is
// unread-only by the host's own contract (`src/server/ops/notifications.rs`
// drops every row that has a `read_at`), and it clears when a channel is read
// or a toast is acknowledged — so a number built from it would fall to zero
// while things were still waiting. `pending_approvals` is the fact that stays
// true until somebody decides something, which is what a standing attention
// signal has to be.

import { Bell } from "lucide-react";

import { TITLE_BAR_ICON_BUTTON } from "@/components/window-title-bar";
import { cn } from "@/lib/utils";

/**
 * Above this the count prints `99+` instead of the number.
 *
 * The control grows with its count rather than carrying a mark on the glyph's
 * corner, so this is a ceiling on how far the row is allowed to stretch, not on
 * what fits — three digits are legible, four start pushing the switcher. The
 * true number stays in {@link notificationsLabel} and in `data-pending`, so
 * nothing is lost: the digits an operator cannot read are traded for an exact
 * count a screen reader still gets.
 *
 * The corner-mark arrangement was tried first and rejected at its real cap: at
 * 128 pending, `99+` sitting on a 32px glyph covered most of the bell and the
 * control stopped reading as anything at all. A count that obscures the thing
 * it is counting is worse than one that takes eighteen more pixels.
 */
export const APPROVALS_COUNT_CAP = 99;

/**
 * What is waiting, and how many — the sentence the collapsed-rail dot carried,
 * kept word for word because it is what makes the signal reach someone who
 * never sees the chip.
 *
 * At zero it is just the queue's name. "0 approvals need you" would be a
 * sentence about attention at the moment nothing wants any.
 */
export function approvalsLabel(pending: number): string {
  if (pending <= 0) return "Approvals";
  return `${pending} ${pending === 1 ? "approval needs" : "approvals need"} you`;
}

/**
 * What this control is called, given how much is waiting.
 *
 * The destination's name leads, always, because that is what the control DOES —
 * an operator who reaches a bell expects notifications whether or not anything
 * is pending. What is waiting follows it when there is something, so the one
 * accessible name answers both "where does this go" and "why is it lit".
 */
export function notificationsLabel(pending: number): string {
  // `pending > 0` rather than `pending <= 0`, and the difference is not style:
  // the count is reconciled from a queue length on the way here
  // (`use-company.ts`, issue #932), so a host that answers that route in an
  // unexpected shape can put `undefined` or `NaN` in this argument despite the
  // type. Both fail `<= 0` and would have produced the sentence "undefined
  // approvals need you" out loud to a screen reader. Anything that is not a
  // positive number is simply the destination's name — observed while
  // exercising the cap with a deliberately malformed queue response.
  if (!(pending > 0)) return "Notifications";
  return `Notifications — ${approvalsLabel(pending)}`;
}

/** What the chip prints — the count, or `99+` past {@link APPROVALS_COUNT_CAP}. */
export function approvalsCount(pending: number): string {
  return pending > APPROVALS_COUNT_CAP ? `${APPROVALS_COUNT_CAP}+` : String(pending);
}

export function NotificationsButton({
  pending,
  active = false,
  onNavigate,
  className,
}: {
  /**
   * How many approvals are waiting — `feed.status.pending_approvals`, passed
   * through unchanged. Zero is an ordinary state: the glyph stays and the chip
   * does not appear.
   */
  pending: number;
  /** Whether the Notifications page is the view on screen. */
  active?: boolean;
  onNavigate: () => void;
  className?: string;
}) {
  const label = notificationsLabel(pending);
  return (
    <button
      type="button"
      data-testid="title-bar-notifications"
      // So a test can read the count off the closed control without depending
      // on the chip's text, which is capped and therefore not the number.
      data-pending={pending}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        TITLE_BAR_ICON_BUTTON,
        // With something waiting the control stops being a 32px square and
        // grows to hold its count beside the glyph. `w-auto` and the padding
        // override the square; the height does not change, so the row's one
        // `items-center` rule still lands it on the same centre line.
        pending > 0 && "w-auto gap-1 px-1.5",
        className,
      )}
    >
      <Bell aria-hidden="true" className="size-4 flex-none" />
      {pending > 0 && (
        <span
          data-testid="title-bar-notifications-count"
          // The digits are decoration for anyone reading the label: the button
          // already says "3 approvals need you", and announcing "3" again after
          // it is the same fact twice.
          aria-hidden="true"
          className={cn(
            "flex h-4 min-w-4 flex-none items-center justify-center rounded-full px-1",
            "text-3xs leading-none font-medium tabular-nums select-none",
            // `--status-blocked` is the token for "waiting on someone", which is
            // exactly what a pending approval is; the rail dot this replaces used
            // the same one. Soft fill plus the matching text tone rather than a
            // solid block, because a solid fill has no foreground token that
            // themes with it — and this pair is what `workflow-node` already uses
            // for a blocked state in both light and dark.
            //
            // This is the row's only piece of colour, and deliberately so: it is
            // the one thing here that ever asks for attention.
            "bg-status-blocked-soft text-status-blocked-text",
          )}
        >
          {approvalsCount(pending)}
        </span>
      )}
    </button>
  );
}
