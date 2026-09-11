import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { NotificationDto } from "@/api/types";
import {
  isOperationalNotification,
  operationalNotificationSeverity,
  operationalNotificationsToAnnounce,
} from "@/lib/operational-notifications";

/**
 * `mentionCountsByChannel` / `mentionsToClear` / `threadsToReReadForMentions`
 * (see `chat-mention-badge.test.ts`) all filter to `kind === "mention"` by
 * design, which left `dispatch_failed` / `approval_expired` /
 * `workflow_run_*` rows with no rendering and no acknowledgement path even
 * though `GET /notifications` returns them (Codex #1883 P1). These tests pin
 * the pure logic behind the toast that announces them.
 *
 * The acknowledgement half of that fix is gone. `ActivityTab` renders these
 * rows now and its Dismiss is the path back to the server, so marking a row
 * read when its toast was raised would only hide it from the one surface
 * built to show it — the host serialises unread rows only (Codex #2256 P1).
 * `scheduleAcknowledgement` / `flushPendingAcknowledgements` went with it,
 * and their tests with them.
 *
 * What remains is that a row is announced exactly once per session, which
 * never depended on the ack: `operationalNotificationsToAnnounce` reads the
 * caller's own session-local announced set and nothing else.
 */

const note = (over: Partial<NotificationDto> & Pick<NotificationDto, "id" | "kind">): NotificationDto => ({
  subjectKind: "task",
  subjectId: "t-1",
  title: "A card's dispatch failed and returned to To-do: boom",
  createdAt: 1,
  ...over,
});

describe("isOperationalNotification", () => {
  it("is false for mentions", () => {
    expect(isOperationalNotification(note({ id: "a", kind: "mention" }))).toBe(false);
  });

  it("is true for every non-mention kind the runtime writes", () => {
    for (const kind of [
      "dispatch_failed",
      "approval_expired",
      "workflow_run_failed",
      "workflow_run_stranded",
      "workflow_run_blocked",
    ]) {
      expect(isOperationalNotification(note({ id: kind, kind }))).toBe(true);
    }
  });

  /**
   * PR #1878 review (comment 3893066248): `notifications()` retired its
   * server-side kind allowlist in favour of a mixed feed with client-side
   * filtering — the same design #1883's toast+ack consumer relies on. That
   * makes `workflow_nudge` (issue #1845's week-1 nudge) just another
   * non-mention row on the exact feed `app-shell` polls unfiltered, so
   * without an explicit carve-out it reads as operational: toasted as a
   * generic warning and marked read the moment the tab is visible, before
   * `WorkflowsView`'s `pickActiveNudge` ever gets a chance to show the
   * banner. The nudge must never be auto-acknowledged by this classifier.
   */
  it("is false for the week-1 nudge — it has its own banner, not a toast+ack", () => {
    expect(isOperationalNotification(note({ id: "a", kind: "workflow_nudge" }))).toBe(false);
  });
});

describe("operationalNotificationsToAnnounce", () => {
  it("returns unread operational rows not already announced", () => {
    const rows = [
      note({ id: "a", kind: "dispatch_failed" }),
      note({ id: "b", kind: "mention" }),
      note({ id: "c", kind: "approval_expired" }),
    ];
    expect(operationalNotificationsToAnnounce(rows, new Set()).map((n) => n.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("excludes rows already read", () => {
    const rows = [note({ id: "a", kind: "dispatch_failed", readAt: 5 })];
    expect(operationalNotificationsToAnnounce(rows, new Set())).toEqual([]);
  });

  it("excludes rows already announced this session", () => {
    const rows = [note({ id: "a", kind: "dispatch_failed" })];
    expect(operationalNotificationsToAnnounce(rows, new Set(["a"]))).toEqual([]);
  });

  it("does not re-announce a row on the next poll once it is in the guard set", () => {
    const announced = new Set<string>();
    const rows = [note({ id: "a", kind: "dispatch_failed" })];
    const first = operationalNotificationsToAnnounce(rows, announced);
    expect(first.map((n) => n.id)).toEqual(["a"]);
    first.forEach((n) => announced.add(n.id));
    // The row is durable and keeps coming back on every poll until the
    // server marks it read — the guard, not the row disappearing, is what
    // stops the repeat toast.
    expect(operationalNotificationsToAnnounce(rows, announced)).toEqual([]);
  });

  /**
   * PR #1878 review (comment 3893066248) — the actual bug shape: app-shell's
   * poll of the unfiltered feed must never surface a `workflow_nudge` row as
   * something to toast-and-ack. If it did, `app-shell`'s handler would mark
   * it read server-side on the very next visible-tab poll, and
   * `pickActiveNudge` (`WorkflowsView`) would never see it unread again — the
   * banner this PR exists to ship would be silently defeated by a sibling
   * consumer of the same feed.
   */
  it("never includes a workflow_nudge row alongside operational rows from the same poll", () => {
    const rows = [
      note({ id: "a", kind: "dispatch_failed" }),
      note({ id: "b", kind: "workflow_nudge" }),
      note({ id: "c", kind: "mention" }),
    ];
    expect(operationalNotificationsToAnnounce(rows, new Set()).map((n) => n.id)).toEqual(["a"]);
  });
});

describe("operationalNotificationSeverity", () => {
  it("treats dispatch_failed as an error", () => {
    expect(operationalNotificationSeverity(note({ id: "a", kind: "dispatch_failed" }))).toBe(
      "error",
    );
  });

  it("treats every workflow_run_* kind as an error", () => {
    for (const kind of ["workflow_run_failed", "workflow_run_stranded", "workflow_run_blocked"]) {
      expect(operationalNotificationSeverity(note({ id: kind, kind }))).toBe("error");
    }
  });

  it("treats approval_expired as a warning", () => {
    expect(operationalNotificationSeverity(note({ id: "a", kind: "approval_expired" }))).toBe(
      "warning",
    );
  });

  it("defaults an unrecognized kind to warning rather than error", () => {
    expect(operationalNotificationSeverity(note({ id: "a", kind: "something_new" }))).toBe(
      "warning",
    );
  });
});

describe("announcing a row does not acknowledge it", () => {
  // Read as source because the behaviour is a *missing* call, and a missing
  // call is the one thing rendering cannot show you: the surface it defeats is
  // the Activity tab, which would simply look empty — the exact reading it
  // gives when nothing is waiting. `title-bar-jumps.test.ts` pins its own
  // "this is gone" rules the same way.
  const shell = readFileSync(resolve(process.cwd(), "src/components/app-shell.tsx"), "utf8");

  /** The toast block, from the seed gate to the end of `refreshMentions`. */
  const announceBlock = (() => {
    const start = shell.indexOf("const seeding = !operationalSeededRef.current");
    expect(start, "the announce block should still exist").toBeGreaterThan(-1);
    const end = shell.indexOf("\n      })\n      .catch(", start);
    expect(end, "the announce block should end inside refreshMentions").toBeGreaterThan(start);
    return shell.slice(start, end);
  })();

  it("raises a toast and stops there", () => {
    // The row stays unread so the Activity tab can show it. Marking it read
    // here would remove it from a feed the host serialises unread-only, which
    // is the whole of why that surface would be empty (Codex #2256 P1).
    expect(announceBlock).toContain("toast.error");
    expect(announceBlock).toContain("toast.warning");
    expect(announceBlock).not.toContain("markNotificationsRead");
    expect(announceBlock).not.toContain("readAt");
  });

  it("still holds the toast to one per row, which never needed the ack", () => {
    // `operationalAnnouncedRef` is session-local and non-durable. It is what
    // stops a poll every few seconds re-toasting the same dispatch failure,
    // and it is updated the moment a row is announced.
    expect(announceBlock).toContain("operationalAnnouncedRef.current.add");
  });

  it("seeds the first poll of a scope instead of announcing it", () => {
    // Without the ack, an unread row no longer means "unseen" — only
    // "undismissed" — so announcing the whole unread set on arrival re-toasts
    // the backlog on every load. That is not hypothetical: a warning toast
    // landed over the bottom of a 390px Settings page and covered the button
    // `sidebar-toggle-reachable.spec.ts` hit-tests, on a row an earlier load
    // had already announced.
    expect(announceBlock).toContain("const seeding = !operationalSeededRef.current");
    // Marked announced either way, or a seeded row toasts on the second poll
    // instead of the first — the same bug, one tick later.
    const add = announceBlock.indexOf("operationalAnnouncedRef.current.add");
    const gate = announceBlock.indexOf("if (!seeding)");
    expect(add, "the announced set is updated before the toast gate").toBeLessThan(gate);
    expect(announceBlock).toContain("toast.error");

    // And a company switch is a new backlog: its first poll seeds too, so
    // switching does not announce everything the next company was sitting on.
    expect(shell).toMatch(/operationalSeededRef\.current = false/);
  });

  it("leaves no scheduling machinery behind", () => {
    // Dead exports outlive their callers and get called again. Both helpers
    // and their tests went with the ack.
    expect(shell).not.toContain("scheduleAcknowledgement");
    expect(shell).not.toContain("flushPendingAcknowledgements");
    expect(shell).not.toContain("pendingAckRef");
    const lib = readFileSync(
      resolve(process.cwd(), "src/lib/operational-notifications.ts"),
      "utf8",
    );
    expect(lib).not.toMatch(/export function scheduleAcknowledgement/);
    expect(lib).not.toMatch(/export function flushPendingAcknowledgements/);
  });
});
