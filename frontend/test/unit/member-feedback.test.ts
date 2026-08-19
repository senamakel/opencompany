import { beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({
  base: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("sonner", () => {
  const toast = Object.assign(toasts.base, {
    success: toasts.success,
    error: toasts.error,
    warning: toasts.warning,
    info: toasts.info,
  });
  return { toast };
});

const { addMemberFailure, addMemberMessage, addOutcome, reportAddMember } =
  await import("@/lib/member-feedback");

/**
 * Issue #1099: adding a teammate said nothing at all, and the three surfaces
 * that can add one disagreed about how a failure was said.
 *
 * These pin the two halves the issue names. The first is that a clean add is
 * confirmed, by name. The second is that the two ways an add can *half* land —
 * a teammate whose inbox never came up, a teammate who exists only in this
 * browser tab — stay distinguishable from a clean one, because the operator
 * owes a follow-up in both and owes nothing in the first.
 */
describe("addMemberMessage", () => {
  it("confirms a clean add by name", () => {
    expect(addMemberMessage({ kind: "added", name: "Ada" })).toEqual({
      level: "success",
      title: "Added Ada.",
    });
  });

  it("does not call a half-landed add a success", () => {
    const msg = addMemberMessage({
      kind: "partial",
      name: "Ada",
      missed: "their inbox couldn't be switched on.",
      fix: "Turn it on from their actions menu.",
    });
    expect(msg.level).toBe("warning");
    expect(msg.title).toBe("Added Ada, but their inbox couldn't be switched on.");
    expect(msg.description).toBe("Turn it on from their actions menu.");
  });

  it("says a console-only row is console-only, and what that cost", () => {
    const msg = addMemberMessage({
      kind: "console-only",
      name: "Ada",
      note: "No inbox was created.",
    });
    expect(msg.level).toBe("warning");
    expect(msg.title).toBe("Added Ada to this console only.");
    // Both halves: the row is not durable, *and* the thing that needed a
    // durable row did not happen.
    expect(msg.description).toContain("gone when the console reloads");
    expect(msg.description).toContain("No inbox was created.");
  });

  it("omits the follow-up clause when nothing was owed", () => {
    const msg = addMemberMessage({ kind: "console-only", name: "Ada" });
    expect(msg.description).toBe(
      "This host can't save teammates, so they'll be gone when the console reloads.",
    );
  });

  it("carries a refusal through as an error", () => {
    expect(addMemberMessage({ kind: "failed", message: "Name already taken." })).toEqual({
      level: "error",
      title: "Name already taken.",
    });
  });
});

/**
 * A refetch that failed is a missed step, not a detail (review of #1099).
 *
 * Both `boot()`s swallow their own errors — `TeamView`'s goes further and
 * empties the roster — so before this the console could POST a teammate, fail
 * to read them back, and toast "Added Ada." over a list Ada was not in. The
 * refetch is what the toast's timing was justified by, so it has to be able to
 * withhold the confirmation it was supposed to substantiate.
 */
describe("addOutcome", () => {
  it("is a clean add only when nothing missed", () => {
    expect(addOutcome("Ada", [])).toEqual({ kind: "added", name: "Ada" });
  });

  it("withholds the confirmation when the read-back failed", () => {
    const outcome = addOutcome("Ada", [
      { what: "the roster couldn't be read back", fix: "Reload to see them." },
    ]);
    expect(outcome.kind).toBe("partial");
    expect(addMemberMessage(outcome)).toEqual({
      level: "warning",
      title: "Added Ada, but the roster couldn't be read back.",
      description: "Reload to see them.",
    });
  });

  it("reports every miss, rather than picking one", () => {
    // The inbox refusing and the read-back failing are different follow-ups
    // and the operator owes both; dropping either is how one goes unnoticed.
    const msg = addMemberMessage(
      addOutcome("Ada", [
        { what: "their inbox couldn't be switched on", fix: "Turn it on from their actions menu." },
        { what: "the roster couldn't be read back", fix: "Reload to see them." },
      ]),
    );
    expect(msg.title).toBe(
      "Added Ada, but their inbox couldn't be switched on, and the roster couldn't be read back.",
    );
    expect(msg.description).toBe(
      "Turn it on from their actions menu. Reload to see them.",
    );
  });

  it("carries no description when no step offered a follow-up", () => {
    expect(addOutcome("Ada", [{ what: "something slipped" }]).kind).toBe("partial");
    expect(addMemberMessage(addOutcome("Ada", [{ what: "something slipped" }])).description).toBeUndefined();
  });

  it("never reaches toast.success for a failed read-back", () => {
    for (const fn of Object.values(toasts)) fn.mockClear();
    reportAddMember(addOutcome("Ada", [{ what: "the roster couldn't be read back" }]));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });
});

describe("addMemberFailure", () => {
  it("prefers the host's own words", () => {
    expect(addMemberFailure(new Error("Name already taken."))).toEqual({
      kind: "failed",
      message: "Name already taken.",
    });
  });

  it("falls back when the failure carried no message", () => {
    expect(addMemberFailure("boom")).toEqual({
      kind: "failed",
      message: "Couldn't add teammate.",
    });
    expect(addMemberFailure(null, "Could not create teammate.")).toEqual({
      kind: "failed",
      message: "Could not create teammate.",
    });
  });
});

describe("reportAddMember", () => {
  beforeEach(() => {
    for (const fn of Object.values(toasts)) fn.mockClear();
  });

  it("raises a success toast for a clean add", () => {
    reportAddMember({ kind: "added", name: "Ada" });
    expect(toasts.success).toHaveBeenCalledWith("Added Ada.", undefined);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.warning).not.toHaveBeenCalled();
  });

  it("raises a warning, with the follow-up, for a half-landed add", () => {
    reportAddMember({
      kind: "partial",
      name: "Ada",
      missed: "they couldn't be added to that desk: 500",
      fix: "They're on the roster.",
    });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.warning).toHaveBeenCalledWith(
      "Added Ada, but they couldn't be added to that desk: 500",
      { description: "They're on the roster." },
    );
  });

  it("raises an error, and only an error, for a refusal", () => {
    reportAddMember({ kind: "failed", message: "Nope." });
    expect(toasts.error).toHaveBeenCalledWith("Nope.", undefined);
    expect(toasts.success).not.toHaveBeenCalled();
  });
});
