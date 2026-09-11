// The durable notification feed, rendered as a list for the first time.
//
// # Why this did not exist
//
// `GET {scope}/notifications` has been the company's durable, per-person
// notification store since issue #749 was closed, and its rows have reached a
// person through exactly three narrow channels: a per-channel mention badge, a
// week-1 nudge banner, and — for everything else — a one-shot toast
// (`lib/operational-notifications.ts`), whose own module header says why it had
// to exist: those rows had "no badge, no rendered item anywhere, and no path
// back to the server to mark them read". A toast is an announcement, not a
// surface. Miss it and the row is gone from the screen while still being the
// only record that anything happened.
//
// This is the surface. It does not replace the toast — the toast is how a
// failure reaches someone who is looking at something else — it is where the
// toast's contents can be found afterwards.
//
// # This is unread activity, not a history, and it says so
//
// `list()` in `src/server/ops/notifications.rs` filters `read_at.is_none()`
// before it serialises: **the route returns unread rows only.** There is no
// history endpoint, and this list does not pretend there is one. The empty
// state says what the emptiness means rather than "nothing has happened",
// because those are different facts and only one of them is true.
//
// That also decides what "mark read" means here. Marking a row read removes it
// from this list permanently — it is the same latch the mention badge and the
// toast acknowledgement use, and there is nowhere for a read row to go. So the
// control says "Dismiss", which is what it does, rather than "Mark read", which
// implies a read pile that can be revisited.

import { useMemo, useState } from "react";
import {
  AtSign,
  Bell,
  CircleAlert,
  Clock,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import type { NotificationDto } from "@/api/types";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/language";
import { byNewestFirst, notificationHref } from "@/lib/notification-links";
import { cn } from "@/lib/utils";

/** The glyph for a row's `kind`. Unknown kinds get the generic bell. */
function glyphFor(kind: string): LucideIcon {
  if (kind === "mention") return AtSign;
  if (kind === "dispatch_failed") return CircleAlert;
  if (kind === "approval_expired") return Clock;
  if (kind.startsWith("workflow_")) return Workflow;
  return Bell;
}

/**
 * The tone a row carries.
 *
 * Only the kinds that name something that went wrong get the blocked token —
 * the same one the title row's count uses, and for the same reason: it is the
 * token for "waiting on someone". A mention is not an alarm, so it stays in
 * the calm register. An unrecognized kind is calm too: this list cannot know
 * a novel kind's severity, and under-alarming it is safer than crying wolf.
 */
function isAlarming(kind: string): boolean {
  return (
    kind === "dispatch_failed" ||
    kind === "approval_expired" ||
    kind.startsWith("workflow_run_")
  );
}

export function ActivityTab({
  notifications,
  now,
  channels,
  onDismiss,
  onDismissAll,
}: {
  /**
   * The feed as the shell polls it — unread rows only, by the host's contract.
   *
   * Passed in rather than fetched here on purpose: the shell already polls this
   * exact route on its own cadence, on each agent reply and on window focus
   * (`refreshMentions`). A second poller would be a second answer to the same
   * question, and the badge and this list would disagree for a poll interval
   * every time one landed before the other.
   */
  notifications: readonly NotificationDto[];
  /** The company clock the rest of the console renders relative times against. */
  now: number;
  /** What `notificationHref` needs to resolve a `message` row's channel. */
  channels: { rendered: ReadonlySet<string>; mainChannelId: string | undefined };
  /**
   * Mark exactly one row read. Never an empty list — see `NotificationsView`.
   *
   * Returns when the write is over, so the optimistic hide below can be
   * released. A caller with nothing to await may return nothing.
   */
  onDismiss: (id: string) => void | Promise<void>;
  /** Mark everything this person can see read, in one request. */
  onDismissAll: () => void;
}) {
  // Local, so a dismissed row leaves at the click rather than at the next poll.
  // The poll reconciles: a failed write brings the row back, which is the
  // honest outcome and the same optimism the mention clear already uses.
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(
    () =>
      byNewestFirst(notifications).filter(
        // `readAt` is what the shell stamps optimistically on a dismiss — which
        // is what makes "Dismiss all" empty the list at the click rather than at
        // the next poll. `dismissing` covers the single-row case for the same
        // reason, and both are reconciled by the poll that follows the write.
        (n) => n.readAt === undefined && !dismissing.has(n.id),
      ),
    [notifications, dismissing],
  );

  function dismiss(id: string) {
    setDismissing((current) => new Set(current).add(id));
    // Released when the write settles, not left standing until unmount. This
    // set is an optimistic hide, and a hide with no release outlives the thing
    // it was hiding for: a write that fails against an offline or older host is
    // restored unread by the shell's refresh, and the row would stay filtered
    // out of this list anyway — hidden here, unread on the host, visible to
    // nobody (Codex, CodeRabbit).
    //
    // Settling is the whole signal, either way. On success the shell's own
    // optimistic `readAt` stamp already hides the row and the following poll
    // drops it for good, so releasing changes nothing; on failure the refresh
    // brings it back and releasing is exactly what lets it reappear.
    void Promise.resolve(onDismiss(id))
      .catch(() => {})
      .then(() =>
        setDismissing((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      );
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="activity-empty"
        className="rounded-lg border border-dashed px-4 py-10 text-center"
      >
        <Bell aria-hidden="true" className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing unread</p>
        {/* The distinction this page must not blur. An operator who reads
            "nothing here" on an empty activity list will conclude nothing
            happened; what is actually true is that nothing is still waiting. */}
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
          This is what is still waiting for you, not a history — your company keeps unread
          notifications only, so a row leaves this list for good once it is dismissed or
          its channel is read.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="activity-list">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows.length === 1 ? "1 unread notification" : `${rows.length} unread notifications`}
        </p>
        <Button variant="ghost" size="sm" onClick={onDismissAll} data-testid="activity-dismiss-all">
          Dismiss all
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const Glyph = glyphFor(row.kind);
          const href = notificationHref(row, channels);
          const alarming = isAlarming(row.kind);
          return (
            <li
              key={row.id}
              data-testid="activity-row"
              data-kind={row.kind}
              className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5"
            >
              <Glyph
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 flex-none",
                  alarming ? "text-status-blocked-text" : "text-muted-foreground",
                )}
              />
              <div className="min-w-0 flex-1">
                {/* The link is on the title rather than the whole row: the row
                    also carries a Dismiss button, and a clickable row with a
                    button inside it is a hit-test an operator has to aim at. */}
                {href ? (
                  <a href={href} className="text-sm font-medium transition-opacity hover:opacity-80">
                    {row.title}
                  </a>
                ) : (
                  <p className="text-sm font-medium">{row.title}</p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {timeAgo(row.createdAt, now)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="flex-none"
                onClick={() => dismiss(row.id)}
                // The row's own line is the only thing naming it, so the
                // control has to say which row it dismisses.
                aria-label={`Dismiss: ${row.title}`}
              >
                Dismiss
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
