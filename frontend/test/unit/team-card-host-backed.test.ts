import { describe, expect, it } from "vitest";

import type { TeamMember } from "@/lib/team";
import { localMemberId, newMember } from "@/lib/team";
import { hostBackedCard } from "@/views/TeamView";

/**
 * Which agent cards may offer a control that resolves an id on the host.
 *
 * The Agent board's card carries two of those — the title's link to the detail
 * page, and the Message link to the agent's DM (issue #2252) — and they are
 * wrong in exactly the same states, so they share one gate. What this file
 * pins is that the gate asks **two** questions rather than one.
 *
 * `fromHost` is a single flag for the whole roster, set by the *read*. It is
 * enough for the obvious case: the read failed, or answered with nobody, so
 * every card on screen is a local placeholder and neither control is offered.
 *
 * It is not enough for the case that reads as fine. A host that serves
 * `GET …/team` and 404s the `POST` — no team write plane — leaves `fromHost`
 * true, and `TeamView`'s `addMember` appends a console-only row next to the
 * real ones so the operator's work is not thrown away. That row's id exists
 * nowhere but this browser tab. Offering the detail link on it opens a page
 * reporting a teammate that was never removed; offering the DM lands on the
 * room's unknown-channel fallback. Both read as "the console is broken", and
 * neither is visible to a test that only ever varies `fromHost`.
 *
 * So: one gate, two inputs, and every combination below.
 */

function member(id: string): TeamMember {
  return {
    id,
    name: "Ada",
    role: "Engineer",
    description: "",
    tone: "sky",
    avatar: "green",
    inboxEnabled: false,
    effectiveTools: [],
    desks: [],
  };
}

const NONE: ReadonlySet<string> = new Set<string>();

describe("an agent card's host-backed gate", () => {
  it("offers the controls on a host row of a host roster", () => {
    expect(hostBackedCard(member("agent-ada"), true, NONE)).toBe(true);
  });

  it("withholds them from every row when the roster is not the host's", () => {
    // The read failed or answered with nobody. Nothing on screen has a record
    // behind it, whatever the row's id happens to look like.
    expect(hostBackedCard(member("agent-ada"), false, NONE)).toBe(false);
  });

  it("withholds them from a console-only row standing on a host roster", () => {
    // The case `fromHost` alone cannot see: the read landed, so the flag is
    // true, and only the write had nowhere to go.
    const local = newMember({ name: "Ada", role: "Engineer", description: "" });

    expect(hostBackedCard(local, true, new Set([local.id]))).toBe(false);
  });

  it("still offers them on the host rows beside that console-only one", () => {
    // The marker is per row, not per page — one local add must not disarm the
    // whole roster, which is the over-correction of the bug it fixes.
    const local = newMember({ name: "Ada", role: "Engineer", description: "" });

    expect(hostBackedCard(member("maya"), true, new Set([local.id]))).toBe(true);
  });

  it("keys on the id `newMember` actually mints, not on a guess at its shape", () => {
    // `addMember` marks the row it appended by that row's own id. Pinning the
    // builder the marker comes from keeps the two from drifting into a gate
    // that matches nothing and quietly stops gating.
    const local = newMember({ name: "Ada", role: "Engineer", description: "" });

    expect(local.id).toBe(localMemberId("Ada"));
    expect(hostBackedCard(local, true, new Set([localMemberId("Ada")]))).toBe(false);
  });
});
