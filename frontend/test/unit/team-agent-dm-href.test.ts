// @vitest-environment jsdom
//
// A document, for one reason only: `agentDmHref` carries the connection scope
// off the current address (`withHostParam` → `window.location.hash`), so there
// has to be an address for it to read. Every assertion below is still about a
// pure string — nothing here renders.

import { beforeEach, describe, expect, it } from "vitest";

import type { TeamMember } from "@/lib/team";
import { dmChannelId, dmThreadId } from "@/views/room/channels";
import { agentDmHref } from "@/views/TeamView";

/**
 * The Agent board's Message action addresses the right conversation (issue #2252).
 *
 * Each agent card carries a Message control on its face — an anchor beside the
 * overflow trigger, not an item inside it — and the only thing about it that
 * can be silently wrong is the id it routes on. Moving the control changed
 * where an operator clicks and nothing about the address, which is why this
 * file did not move with it. `channels.ts` exports two id builders that agree
 * for most of the roster and disagree for exactly one teammate:
 *
 * - `dmChannelId(m)` is always `dm:<id>` — the console-local channel id, and so
 *   the address the hash router resolves.
 * - `dmThreadId(m)` is the bare `<id>` — the *host* thread a DM is journaled
 *   under — except when the teammate's own id spells General, where the host
 *   folds the bare key onto the company-wide line.
 *
 * So a card that routed on `dmThreadId` would work for every agent a test
 * roster usually contains, and send an operator who clicked the one teammate
 * called `main` to the company's General channel instead of that teammate's DM
 * (the class of bug behind issue #1743). Nothing in the types separates the two
 * — both are strings — and in a browser the failure reads as "the console
 * opened the wrong chat", not as a wrong function call. Hence this test.
 */

/**
 * A roster entry with only the fields a case actually varies spelled out.
 *
 * `id` and `name` are required because every assertion here is about one or the
 * other — the id is what the address is built from, the name is what the
 * control is labelled with — and a default for either would let a case pass
 * while testing the default instead of its own subject.
 */
function member(over: Partial<TeamMember> & Pick<TeamMember, "id" | "name">): TeamMember {
  return {
    role: "Engineer",
    description: "",
    tone: "sky",
    avatar: "green",
    inboxEnabled: false,
    effectiveTools: [],
    desks: [],
    ...over,
  };
}

describe("the Agent board's Message address", () => {
  // A one-host console, which writes no scope at all. Each case that cares
  // about the scope sets its own address first.
  beforeEach(() => {
    window.location.hash = "#/company";
  });

  it("routes to the teammate's DM channel, not the host thread", () => {
    const ada = member({ id: "agent-ada", name: "Ada" });

    expect(agentDmHref(ada)).toBe("#/chat/dm%3Aagent-ada");
  });

  it("is built from the channel id the router resolves", () => {
    const ada = member({ id: "agent-ada", name: "Ada" });

    expect(agentDmHref(ada)).toBe(`#/chat/${encodeURIComponent(dmChannelId(ada))}`);
  });

  it("keeps a teammate whose id spells General on their own DM", () => {
    // The one teammate for whom the two builders disagree. Routing on
    // `dmThreadId` here would address the company-wide line instead.
    const main = member({ id: "main", name: "Main" });

    expect(dmThreadId(main)).not.toBe(main.id);
    expect(agentDmHref(main)).toBe("#/chat/dm%3Amain");
    expect(agentDmHref(main)).toBe(`#/chat/${encodeURIComponent(dmChannelId(main))}`);
  });

  it("survives an id that needs escaping in an address", () => {
    const odd = member({ id: "agent/ada?x", name: "Ada" });

    expect(agentDmHref(odd)).toBe("#/chat/dm%3Aagent%2Fada%3Fx");
  });

  // The control is an anchor precisely so it can be copied, middle-clicked and
  // Cmd-clicked. Each of those opens a *new document*, which has no selected
  // host to repair from — `useHostAddress` only fixes a dropped scope on the
  // `hashchange` a same-tab click fires. A bare `#/chat/…` therefore resolves
  // this agent's id against the bootstrap host instead of the console whose
  // card was clicked, which on a second host is another company's roster.
  it("carries the console's host scope, so a copied link stays on that host", () => {
    window.location.hash = "#/company?host=conn-b";
    const ada = member({ id: "agent-ada", name: "Ada" });

    expect(agentDmHref(ada)).toBe("#/chat/dm%3Aagent-ada?host=conn-b");
  });

  // Only the scope rides along. `?new` and friends belong to the screen they
  // were opened over, not to the DM being opened next — the contract
  // `withHostParam` documents.
  it("drops the transient flags standing beside the scope", () => {
    window.location.hash = "#/company?host=conn-b&new";
    const ada = member({ id: "agent-ada", name: "Ada" });

    expect(agentDmHref(ada)).toBe("#/chat/dm%3Aagent-ada?host=conn-b");
  });
});
