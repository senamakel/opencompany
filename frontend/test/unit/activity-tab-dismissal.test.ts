// @vitest-environment jsdom

/**
 * What happens to a row between the click on Dismiss and the poll that settles
 * it — the window where the list is showing something it has been told, but not
 * yet proved, is gone.
 *
 * `ActivityTab` hides the row locally the instant it is clicked, because the
 * alternative is a list that ignores you for a poll interval. That optimism is
 * only honest if it is released: the host's `list()` serialises unread rows
 * only, so a write that fails leaves the row unread server-side while the
 * component goes on filtering it out — hidden here, unread there, visible to
 * nobody until the component happens to unmount (Codex, CodeRabbit).
 *
 * # Every test here observes the hide, then the release
 *
 * An end-state assertion alone cannot tell "hidden, then restored" from "never
 * hidden at all" — both leave one row on screen. The first draft of this file
 * asserted only the end state and would have passed against a component that
 * ignored the click entirely (tinysweeper). So each test walks three steps:
 *
 *   1. the row is listed;
 *   2. **synchronously** after the click it is not — `act(fn)` with a
 *      non-async callback flushes React's work but not the microtask queue, so
 *      the optimistic hide is observable before the promise settles;
 *   3. `await act(async () => {})` drains that queue, and the end state is
 *      whatever the release left behind.
 *
 * Step 2 is the one that makes step 3 mean anything.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NotificationDto } from "@/api/types";
import { ActivityTab } from "@/views/notifications/ActivityTab";

const NOW = new Date("2026-09-11T10:00:00Z").getTime();

const CHANNELS = {
  rendered: new Set(["desk-ops"]),
  mainChannelId: "desk-ops",
};

function row(over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "n1",
    kind: "dispatch_failed",
    subjectKind: "task",
    subjectId: "t-1",
    title: "A card's dispatch failed and returned to To-do",
    createdAt: NOW - 1_000,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Dismiss = (id: string) => void | Promise<void>;

/** Renders the tab, synchronously, the way the shell would. */
function render(notifications: readonly NotificationDto[], onDismiss: Dismiss): void {
  act(() => {
    root.render(
      createElement(ActivityTab, {
        notifications,
        now: NOW,
        channels: CHANNELS,
        onDismiss,
        onDismissAll: () => undefined,
      }),
    );
  });
}

const listed = () => container.querySelectorAll("[data-testid=activity-row]").length;

/**
 * Clicks Dismiss and flushes React's work — but deliberately NOT the microtask
 * queue, so the caller can assert the optimistic hide before the write settles.
 */
function clickDismiss(): void {
  act(() => {
    (container.querySelector("[data-testid=activity-row] button") as HTMLButtonElement).click();
  });
}

/** Drains the microtask queue, so a settled `onDismiss` has released its id. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("dismissing one row", () => {
  it("takes it off the list at the click, not at the next poll", async () => {
    let finish: () => void = () => undefined;
    render([row()], () => new Promise<void>((resolve) => (finish = resolve)));

    expect(listed()).toBe(1);
    clickDismiss();
    // The write has not finished — has not been allowed to — and the row is
    // already gone. That is the whole point of the local hide.
    expect(listed()).toBe(0);

    await act(async () => {
      finish();
    });
  });

  it("puts it back when the write fails and the shell restores it unread", async () => {
    // The shell's refresh hands the same unread row back down. Without the
    // release, `dismissing` still holds its id and the row stays filtered out
    // of a list whose whole claim is "this is what is still waiting for you".
    const onDismiss: Dismiss = () => Promise.reject(new Error("offline"));
    render([row()], onDismiss);

    expect(listed()).toBe(1);
    clickDismiss();
    expect(listed(), "hidden optimistically at the click").toBe(0);

    await settle();
    // Re-rendered with the row still unread, which is what the shell's own
    // refresh does after a failed write: the host never marked it read, so the
    // next poll returns it exactly as before.
    render([row()], onDismiss);
    expect(listed(), "restored once the failed write settled").toBe(1);
  });

  it("keeps it off the list when the write succeeds", async () => {
    // Faithful to the shell: `markNotificationsRead` stamps `readAt` on the
    // feed *before* it issues the request, and the poll after it drops the row
    // for good. Releasing the local hide is therefore a no-op on this path —
    // and it must stay one, or the release would resurrect a row that really
    // was dismissed.
    const onDismiss: Dismiss = () => {
      act(() => root.render(shell(NOW)));
      return Promise.resolve();
    };
    const shell = (readAt?: number) =>
      createElement(ActivityTab, {
        notifications: [row(readAt === undefined ? {} : { readAt })],
        now: NOW,
        channels: CHANNELS,
        onDismiss,
        onDismissAll: () => undefined,
      });

    act(() => root.render(shell()));
    expect(listed()).toBe(1);

    clickDismiss();
    expect(listed()).toBe(0);

    await settle();
    expect(listed(), "a dismissed row is not resurrected by the release").toBe(0);
  });

  it("releases the hide even for a caller that returns nothing at all", async () => {
    // The prop is `void | Promise<void>`: a caller with nothing to await is
    // allowed, and must not be the one case that leaves a row hidden forever.
    //
    // The hide is asserted before the release here rather than only after, or
    // this test would pass just as happily against a component that ignored the
    // click — one row on screen either way (tinysweeper).
    const onDismiss: Dismiss = () => undefined;
    render([row()], onDismiss);

    expect(listed()).toBe(1);
    clickDismiss();
    expect(listed(), "hidden optimistically even with nothing to await").toBe(0);

    await settle();
    // This fixture never stamps `readAt`, so the row coming back is the proof
    // the release ran. A real shell would have stamped it by now.
    render([row()], onDismiss);
    expect(listed(), "released once the synchronous caller settled").toBe(1);
  });
});
