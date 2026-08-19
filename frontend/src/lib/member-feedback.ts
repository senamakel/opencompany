/**
 * What adding a teammate actually did, and how the console says so (issue #1099).
 *
 * A teammate can be created from three surfaces — the Team roster, the Company
 * org chart, and the chat empty state — and every one of them ended by closing
 * its dialog and refetching, with nothing said. The operator was left inferring
 * success from a list that repaints a moment later, on the one write that
 * creates a *person*, while the budget writes on the same screen have confirmed
 * themselves for months ("Daily cap set to $5.00.").
 *
 * The failure half was worse than absent: it was inconsistent. The roster
 * toasted, the org chart pushed the same conditions into an inline banner with
 * its own wording, and the chat empty state said nothing at all for a host that
 * cannot persist teammates. Three implementations of one answer, which is
 * exactly the shape that drifts.
 *
 * So the answer lives here instead. The views still decide *what happened* —
 * only they know whether an inbox or a desk was part of the ask — and this
 * module decides what that is called and how loudly it is said. Two of the
 * outcomes are deliberately not `success`: a teammate whose inbox never came up,
 * and a teammate who exists only in this browser tab, are not clean adds, and
 * flattening either into "Added Ada." would be the console claiming a write it
 * did not get.
 */

import { toast } from "sonner";

/** The outcome of one add, as the surface that ran it saw it. */
export type AddMemberOutcome =
  /** Created on the host, and every follow-up step the operator asked for landed. */
  | { kind: "added"; name: string }
  /**
   * Created on the host, but a step that was part of the same ask did not
   * land — the inbox toggle, or the desk placement. `missed` completes the
   * sentence "Added Ada, but …"; `fix` is what the operator can do about it.
   */
  | { kind: "partial"; name: string; missed: string; fix?: string }
  /**
   * The host has no team write plane, so the row exists in this console and
   * nowhere else. `note` carries anything the missing host record cost — an
   * inbox that could not be created, say.
   */
  | { kind: "console-only"; name: string; note?: string }
  /** Nothing was created. `message` is the host's refusal where there is one. */
  | { kind: "failed"; message: string };

/**
 * One step of the add that did not land.
 *
 * A single add can miss in more than one way at once — the inbox refused *and*
 * the refetch that was meant to substantiate the whole thing failed — and
 * picking one to report would drop a failure the operator has to act on. So the
 * views collect what missed and `addOutcome` builds the sentence.
 */
export interface MissedStep {
  /** Completes "Added Ada, but …" — no leading capital, no trailing stop. */
  what: string;
  /** What the operator can do about it, as a whole sentence. */
  fix?: string;
}

/**
 * A clean add, or the honest version of one.
 *
 * Empty `missed` is the only thing that earns a plain success. In particular a
 * refetch that failed belongs in here rather than being ignored: the console
 * cannot see the record it is about to congratulate itself on, and on the Team
 * roster the failed read actively *replaces* the roster with the starter team,
 * so "Added Ada." would sit above a list Ada is not in.
 */
export function addOutcome(name: string, missed: MissedStep[]): AddMemberOutcome {
  if (missed.length === 0) return { kind: "added", name };
  const fixes = missed.map((m) => m.fix).filter(Boolean);
  return {
    kind: "partial",
    name,
    missed: `${missed.map((m) => m.what).join(", and ")}.`,
    fix: fixes.length ? fixes.join(" ") : undefined,
  };
}

/** A toast, decided but not yet raised — the testable half of the answer. */
export interface AddMemberMessage {
  level: "success" | "warning" | "error";
  title: string;
  description?: string;
}

/**
 * The words for an outcome.
 *
 * The person is named in every arm that has a name. "Teammate added" is a
 * status; "Added Ada." is a receipt, and a receipt is what an operator who has
 * just typed a name into a dialog is looking for.
 */
export function addMemberMessage(outcome: AddMemberOutcome): AddMemberMessage {
  switch (outcome.kind) {
    case "added":
      return { level: "success", title: `Added ${outcome.name}.` };
    case "partial":
      return {
        level: "warning",
        title: `Added ${outcome.name}, but ${outcome.missed}`,
        description: outcome.fix,
      };
    case "console-only":
      return {
        level: "warning",
        title: `Added ${outcome.name} to this console only.`,
        description: [
          "This host can't save teammates, so they'll be gone when the console reloads.",
          outcome.note,
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "failed":
      return { level: "error", title: outcome.message };
  }
}

/**
 * Raise it.
 *
 * A toast on every surface, including the org chart, which used to route these
 * into a banner above the chart. The banner is still right for a chart that
 * could not be *loaded* — that is a state of the page, and it sits with the
 * Retry button that clears it — but an add is an action the operator just took,
 * and its answer belongs where every other action's answer on that screen
 * already is. It also has to survive the dialog closing over it, which a banner
 * behind a modal does not.
 */
export function reportAddMember(outcome: AddMemberOutcome): void {
  const { level, title, description } = addMemberMessage(outcome);
  toast[level](title, description ? { description } : undefined);
}

/**
 * The wording for a host that refuses to create teammates at all (404 on the
 * team write plane).
 *
 * The org chart cannot fall back to a console-only row the way the roster and
 * the chat empty state do: a local teammate has no id to place on a desk and
 * would vanish from the chart on the next read, so that surface refuses and
 * says why. Shared so the two answers to one host condition stay recognisably
 * the same answer.
 */
export const NO_TEAM_WRITE_PLANE = "This host can't create teammates.";

/** The host's own words where it gave any, else a caller-chosen fallback. */
export function addMemberFailure(
  error: unknown,
  fallback = "Couldn't add teammate.",
): AddMemberOutcome {
  return { kind: "failed", message: error instanceof Error ? error.message : fallback };
}
