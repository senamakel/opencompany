import { describe, expect, it } from "vitest";

import { workflowSavedToast } from "@/lib/workflow-saved-toast";

/**
 * The edit-save acknowledgement reducer (issue #1017).
 *
 * `WorkflowsView.handleSaved` wires exactly one of two toasts off this result —
 * a paused, Resume-carrying toast for a save that just disarmed the workflow, or
 * the plain "saved" one — so the branch is proved here rather than through a
 * render.
 */
describe("workflowSavedToast", () => {
  it("flags a save that disarmed an armed workflow", () => {
    // The schedule-edit path: armed (true) → host returns disarmed (false).
    expect(workflowSavedToast(true, false)).toBe("disarmed");
  });

  it("treats an unknown prev state as armed", () => {
    // Only an explicit `false` is off, so `undefined` → `false` is a disarm.
    expect(workflowSavedToast(undefined, false)).toBe("disarmed");
  });

  it("stays a plain save when the workflow is still armed", () => {
    expect(workflowSavedToast(true, true)).toBe("saved");
  });

  it("does not re-flag a re-save of an already-paused workflow", () => {
    // false → false changed nothing the operator must act on.
    expect(workflowSavedToast(false, false)).toBe("saved");
  });

  it("is a plain save when an edit re-armed a paused workflow", () => {
    expect(workflowSavedToast(false, true)).toBe("saved");
  });
});
