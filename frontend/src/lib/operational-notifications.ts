import type { NotificationDto } from "@/api/types";

import { WEEK1_NUDGE_KIND } from "@/lib/week1-nudge";

/**
 * The non-mention rows the honest-verdicts work (issue #1865) started
 * writing through the same durable store `GET /notifications` returns:
 * `dispatch_failed`, `approval_expired`, `workflow_run_failed` /
 * `_stranded` / `_blocked`.
 *
 * Every consumer of that feed on the console — `mentionCountsByChannel`,
 * `mentionsToClear`, `threadsToReReadForMentions` — filters to
 * `kind === "mention"` by design (a reply or reaction must not silently
 * start badging as a summons). That is correct for those three, but it left
 * these rows with nothing: no badge, no rendered item anywhere, and no path
 * back to the server to mark them read, so they sat unread forever despite
 * being returned on every poll (Codex #1883 P1). This module is the one-shot
 * toast that announces them.
 *
 * # It announces; it no longer acknowledges
 *
 * It used to do both — toast a row and then mark it read, scheduled around
 * tab visibility so an unseen toast did not ack (Codex #1883 P2). That second
 * job existed only because of the sentence above: with no rendered item
 * anywhere, an ack on announcement was the *only* way to stop a row coming
 * back on every poll forever.
 *
 * The Notifications page ended that. `ActivityTab` renders exactly these rows
 * and carries Dismiss and Dismiss all, so there is a path back to the server
 * that a person actually drives. Keeping the ack alongside it would have made
 * the new surface useless for precisely the rows it was built for: the host
 * serialises unread rows only (`src/server/ops/notifications.rs`), so a row
 * acked when its toast was raised can never appear in the list (Codex #2256
 * P1). The scheduling helpers went with it.
 *
 * The caller's own `operationalAnnouncedRef` — a session-local set, never
 * durable — is still what holds the toast to one per row rather than one per
 * poll, and it never depended on the ack.
 *
 * # What the caller does with the first poll
 *
 * Dropping the ack changes what an unread row *means*. It used to mean "nobody
 * has seen this"; it now means "nobody has dismissed this", and those differ
 * across a page load. So `app-shell` seeds this set from its first poll of a
 * scope without toasting: rows already waiting when the console opened are
 * backlog, and belong to the Activity tab and the bell's count rather than to a
 * transient announcement. The toast is for what happens while somebody is here,
 * looking at something else — which is the only claim it can honestly make.
 *
 * That rule lives in the caller because this module sees one poll at a time and
 * cannot tell the first from the fiftieth.
 *
 * [`WEEK1_NUDGE_KIND`] is excluded even though it is, mechanically, just
 * another non-mention row on this same feed (PR #1878 review, comment
 * 3893066248). `notifications()` on the host has no server-side kind
 * allowlist — every caller gets every unread row and filters client-side,
 * which is exactly the design this module itself relies on. That means an
 * unfiltered poll here would classify a week-1 nudge as operational too and
 * toast it as a generic warning, ahead of the purpose-built banner
 * `pickActiveNudge`/`WorkflowsView` draws for it. The nudge has its own
 * dedicated UI and its own dismiss path (`week1-nudge-banner.tsx`); this
 * module's job is the rows that have no other consumer, and the nudge is not
 * one of them.
 */
export function isOperationalNotification(notification: NotificationDto): boolean {
  return notification.kind !== "mention" && notification.kind !== WEEK1_NUDGE_KIND;
}

/**
 * Unread operational rows not yet announced this session.
 *
 * `announced` is the caller's running set of ids already toasted — a row is
 * durable and keeps coming back on every poll until it is marked read, so
 * without this guard the same dispatch failure would toast once per poll
 * interval rather than once, ever.
 */
export function operationalNotificationsToAnnounce(
  notifications: readonly NotificationDto[],
  announced: ReadonlySet<string>,
): NotificationDto[] {
  return notifications.filter(
    (n) => n.readAt === undefined && isOperationalNotification(n) && !announced.has(n.id),
  );
}

/** Toast severity for an operational row's `kind`. */
export type OperationalNotificationSeverity = "error" | "warning";

/**
 * `dispatch_failed` and every `workflow_run_*` kind name a run that did not
 * complete — an error. `approval_expired` is a deadline that passed rather
 * than a failure in the strict sense, so it gets the lighter warning
 * treatment. An unrecognized future kind defaults to warning rather than
 * error: this module cannot know its severity, and under-alarming a novel
 * kind is the safer default than crying wolf on it.
 */
export function operationalNotificationSeverity(
  notification: NotificationDto,
): OperationalNotificationSeverity {
  if (notification.kind === "dispatch_failed" || notification.kind.startsWith("workflow_run_")) {
    return "error";
  }
  return "warning";
}
