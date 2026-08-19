/**
 * Which acknowledgement an edit-save of a workflow should raise (issue #1017).
 *
 * A save can silently *disarm* a workflow: adding or changing a schedule makes
 * the host return the graph with `enabled: false`, and the plain "Workflow
 * saved." toast never told the operator their workflow will no longer run on its
 * schedule. This pure reducer names the one transition that earns the paused,
 * Resume-carrying toast — armed → disarmed — so the branch is unit-testable
 * without rendering `WorkflowsView`. The view maps the result to the toast; the
 * decision lives here.
 */
export type WorkflowSavedToast = "saved" | "disarmed";

/**
 * Classifies an edit-save from the `enabled` state before the save and the
 * state the host returned.
 *
 * Only an *explicit* `false` is off (mirrors `WorkflowSummary.enabled`), so an
 * `undefined` prev counts as armed. A workflow that was armed and comes back
 * disarmed is the schedule-edit path that pauses it — that, and only that, is
 * `"disarmed"`. Every other save (unchanged, re-armed, or a re-save of an
 * already-paused workflow) is a plain `"saved"`, because nothing the operator
 * needs to act on just changed.
 */
export function workflowSavedToast(
  prevEnabled: boolean | undefined,
  savedEnabled: boolean | undefined,
): WorkflowSavedToast {
  const justDisarmed = prevEnabled !== false && savedEnabled === false;
  return justDisarmed ? "disarmed" : "saved";
}
