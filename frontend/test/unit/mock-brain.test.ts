import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The mock inference backend's decisions (issue #467).
 *
 * # Why this one spawns a process
 *
 * The rest of this directory tests pure functions, and this could have been one
 * too — but the thing that has to be right about `mock-brain.mjs` is the shape
 * it puts on the wire, and that is a property of the server, not of a helper
 * inside it. `src/harness/provider.rs` reads `choices[0].message.tool_calls[]`
 * with `function.arguments` as a JSON *string* and `finish_reason` a sibling of
 * `message`; get any of that wrong and the failure surfaces forty seconds into
 * a browser run as "the reply never arrived". So the subject here is the real
 * server over real HTTP, on an ephemeral port. It costs a few hundred
 * milliseconds once for the whole file.
 *
 * The three arms under test are the three the suite depends on: a plain reply
 * carrying the marker, a scripted tool call, and — the one with a bug worth
 * catching — a directive that must fire exactly once even though the harness
 * resends the whole transcript on every turn.
 */

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../e2e/mock-brain.mjs",
);

// `stdio: ["ignore", "ignore", "pipe"]` — only stderr is a stream, which is the
// one this reads the chosen port off.
let server: ChildProcessByStdio<null, null, Readable>;
let origin: string;

/** Starts the server on an ephemeral port and reads back the address it chose. */
beforeAll(async () => {
  server = spawn(process.execPath, [SCRIPT, "--bind", "127.0.0.1:0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  origin = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("mock brain never announced a port")), 10_000);
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk: string) => {
      const found = /listening on (http:\/\/\S+)/.exec(chunk);
      if (found) {
        clearTimeout(timer);
        ok(found[1]);
      }
    });
    server.on("error", fail);
  });
});

afterAll(() => {
  server?.kill();
});

/**
 * POSTs a chat-completions request and returns the parsed reply.
 *
 * `tools` is the belt the request offers, and it is optional because most arms
 * do not read it — but `__MOCK_PLAN__` does: a step is served only to a request
 * that could actually make the calls it names. Passing none is therefore the
 * same as asking as an agent with an empty belt.
 */
async function chat(messages: unknown[], tools: string[] = []): Promise<any> {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat-v1",
      messages,
      ...(tools.length
        ? { tools: tools.map((name) => ({ type: "function", function: { name } })) }
        : {}),
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

/**
 * The plan directive for `steps`, with a marker so each test owns its cursor.
 *
 * The marker goes AFTER the payload, which is where the fixture keys off it:
 * two of the tests below script the same single `spawn_task`, and a key taken
 * from the parsed steps alone would hand the second one the first one's spent
 * cursor.
 */
function plan(marker: string, steps: unknown[][]): string {
  return `close this out __MOCK_PLAN__ ${JSON.stringify(steps)} ${marker}`;
}

describe("the mock inference backend", () => {
  it("answers an ordinary turn with the marker and no tool call", async () => {
    const reply = await chat([{ role: "user", content: "e2e wiring ping 123" }]);

    expect(reply.choices[0].message.content).toContain("__MOCK_LLM__");
    expect(reply.choices[0].message.tool_calls).toBeUndefined();
    expect(reply.choices[0].finish_reason).toBe("stop");
  });

  it("does not quote the prompt back", async () => {
    // A spec that locates the operator's own bubble by its text must not match
    // the reply as well. The reply is fixed for that reason, and because the
    // harness's wrapping of a prompt is not this server's to predict.
    const reply = await chat([{ role: "user", content: "ship the launch checklist" }]);

    expect(reply.choices[0].message.content).toBe("__MOCK_LLM__ mock inference backend reply.");
  });

  it("ignores a truncated directive the host echoed back, and serves the real plan", async () => {
    // Issue #2002. The host appends briefings that quote other messages
    // *verbatim and truncated* — `[Other conversations in this channel…` lists
    // each thread's opening words. Once a spec opens a thread with a directive
    // in it, every LATER message in that channel carries a chopped-off copy.
    //
    // That ordering is the whole bug, so the fixture has to reproduce it: the
    // real plan is an older message, and the newest message carries only the
    // decoy. `findPlan` scans newest-first, met the unparsable copy, and
    // returned null for the entire thread — so the real plan behind it was
    // never served. `orchestration-simulation.spec.ts` died exactly there:
    // cards reached `in_review` and the closing `review_task` never ran.
    // The decoy sits BEFORE the live directive in the SAME message, which is
    // how the host actually composes a turn: a `## Relevant prior work` digest
    // quoting earlier tasks (truncated), then the operator's words under
    // `## Task`. `indexOf` reached the decoy first, so scanning older messages
    // was no help -- the real plan was further down the same string.
    const real = plan("echo-1", [[{ name: "review_task", arguments: { decision: "approve" } }]]);
    const composed =
      "## Relevant prior work\n" +
      '- Task: ship the digest. __MOCK_PLAN__ [[{"name":"spawn_task","arguments":{"title":"sim gather the sou' +
      "\n\n## Task\n" +
      real;

    const reply = await chat([{ role: "user", content: composed }], ["review_task"]);

    const call = reply.choices[0].message.tool_calls?.[0];
    expect(call?.function?.name).toBe("review_task");
  });

  it("calls spawn_task once for a SPAWNONE prompt, with a title off the message", async () => {
    const reply = await chat([{ role: "user", content: "please track this SPAWNONE 456" }]);

    const call = reply.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("spawn_task");
    // Arguments ride the wire as a JSON string, which is what the host parses.
    const { title } = JSON.parse(call.function.arguments);
    expect(title).toContain("please track this");
    // …and NOT the directive. The runtime reports the card it opened back into
    // the next prompt (`A card titled "<title>"…`), so a title carrying the
    // directive hands it to the model again, re-wrapped and unrecognisable as
    // the one already served.
    expect(title).not.toContain("SPAWNONE");
    expect(reply.choices[0].finish_reason).toBe("tool_calls");
  });

  it("does not revive a SPAWNONE quoted in prior work, but serves the current task", async () => {
    const priorOnly = await chat([
      {
        role: "user",
        content:
          "## Relevant prior work\n- earlier SPAWNONE old-marker\n\n## Task\njust report status",
      },
    ]);
    expect(priorOnly.choices[0].message.tool_calls).toBeUndefined();

    const current = await chat([
      {
        role: "user",
        content:
          "## Relevant prior work\n- earlier SPAWNONE old-marker\n\n## Task\nplease track this SPAWNONE current-marker",
      },
    ]);
    expect(current.choices[0].message.tool_calls?.[0]?.function?.name).toBe("spawn_task");
  });

  it("does not treat a reference-only channel briefing as the current task", async () => {
    const reply = await chat([
      {
        role: "user",
        content:
          "quick status\n\n[Other conversations in this channel, for reference only — do NOT read or answer from them unless this message explicitly refers to one]:\n- build this SPAWNONE old-channel-marker",
      },
    ]);
    expect(reply.choices[0].message.tool_calls).toBeUndefined();
  });

  it("emits the exact tool call a __MOCK_TOOL_CALL__ directive names", async () => {
    const directive = `__MOCK_TOOL_CALL__ ${JSON.stringify({
      name: "mcp_call_tool",
      arguments: { server: "simple", tool: "echo", arguments: { text: "hi" } },
    })} please`;
    const reply = await chat([{ role: "user", content: directive }]);

    const call = reply.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("mcp_call_tool");
    // The nested `arguments` object is what the brace scanner has to get right:
    // a naive match would stop at the first closing brace.
    expect(JSON.parse(call.function.arguments)).toEqual({
      server: "simple",
      tool: "echo",
      arguments: { text: "hi" },
    });
  });

  it("classifies without burning the directive the same message carries", async () => {
    // Issue #678. A triage escalation is handed the operator's RAW message, so
    // it carries whatever directive that message carried — and `servedDirectives`
    // is per-process, so serving it here would leave the agent's own turn with a
    // plain text reply and no tool call. That is not hypothetical: it took the
    // live-brain MCP spec red, with the tool call logged once, for the
    // classification.
    const directive = `__MOCK_TOOL_CALL__ ${JSON.stringify({
      name: "mcp_call_tool",
      arguments: { server: "simple", tool: "echo", arguments: { text: "burned?" } },
    })}`;

    const classification = await chat([
      { role: "system", content: "You classify one message an operator sent to their company's chat." },
      { role: "user", content: directive },
    ]);
    expect(
      classification.choices[0].message.tool_calls,
      "a classification must never be answered with a tool call",
    ).toBeUndefined();
    expect(classification.choices[0].message.content).toBe("chatter");

    // The turn that follows must still get its tool call — the whole point.
    const turn = await chat([
      { role: "system", content: "You are the CEO of Acme." },
      { role: "user", content: directive },
    ]);
    const call = turn.choices[0].message.tool_calls?.[0];
    expect(call, "the directive must survive the classification").toBeDefined();
    expect(call.function.name).toBe("mcp_call_tool");
  });

  it("serves a directive once, then answers with the tool's own output", async () => {
    // The transcript the harness resends after the tool ran. The directive is
    // still in it; firing again would open a second card per message forever.
    const reply = await chat([
      { role: "user", content: "please track this SPAWNONE 601" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "echo: marker-789" },
    ]);

    expect(reply.choices[0].message.tool_calls).toBeUndefined();
    expect(reply.choices[0].message.content).toContain("__MOCK_LLM__");
    expect(reply.choices[0].message.content).toContain("echo: marker-789");
  });

  it("serves a directive once even when the tool result never comes back", async () => {
    // `spawn_task` is serviced by the runtime's delegation seam rather than the
    // agent's own tool loop, so its result never enters the model-visible
    // transcript: the history looks untouched on the next call of the same
    // turn. Without an identity check the directive fires again, and again,
    // until the loop caps — four cards for one message, which is what the
    // lane's first runs did.
    const history = [{ role: "user", content: "please track this SPAWNONE 800" }];
    const first = await chat(history);
    const second = await chat(history);

    expect(first.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
    expect(second.choices[0].message.tool_calls).toBeUndefined();
  });

  it("never writes a directive into anything the model reads back", async () => {
    // The runtime echoes a spawned card's title into the next prompt. If the
    // title carries the directive, the fixture has handed itself a fresh one.
    const reply = await chat([{ role: "user", content: "please track this SPAWNONE 950" }]);
    const { title } = JSON.parse(reply.choices[0].message.tool_calls[0].function.arguments);

    const echoedBack = await chat([
      { role: "user", content: "please track this SPAWNONE 950" },
      { role: "assistant", content: `A card titled "${title}". It will be opened this turn.` },
    ]);

    expect(echoedBack.choices[0].message.tool_calls).toBeUndefined();
  });

  it("keeps that identity when the same message reaches a second agent", async () => {
    // One operator message reaches the orchestrator and then each desk the turn
    // delegates to, each inside its own wrapper. Keying on anything that
    // includes the wrapper gives every agent a fresh key, and every one of them
    // honours the directive — four cards for one message, which is what the
    // lane's first three runs did.
    const first = await chat([{ role: "user", content: "please track this SPAWNONE 900" }]);
    const second = await chat([
      { role: "user", content: "The operator asked: please track this SPAWNONE 900" },
    ]);

    expect(first.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
    expect(second.choices[0].message.tool_calls).toBeUndefined();
  });

  it("recognises the dispatcher's tool results, which are a user message", async () => {
    // The shape this host actually produces: OpenHuman's `to_provider_messages`
    // renders a tool result as a *user* turn. Reading only the native `tool`
    // role is what made the lane's first run call `spawn_task` four times for
    // one message, looping until the turn gave up.
    const reply = await chat([
      { role: "user", content: "please track this SPAWNONE 602" },
      { role: "assistant", content: "" },
      {
        role: "user",
        content:
          '[Tool results]\n<tool_result id="mock-call-0">\necho: marker-789\n</tool_result>\n',
      },
    ]);

    expect(reply.choices[0].message.tool_calls).toBeUndefined();
    // Quoted without its wrapper, so the operator's bubble is readable.
    expect(reply.choices[0].message.content).toBe("__MOCK_LLM__ echo: marker-789");
  });

  it("fires a fresh directive even after an earlier one was served", async () => {
    const reply = await chat([
      { role: "user", content: "please track this SPAWNONE 701" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "opened" },
      { role: "assistant", content: "__MOCK_LLM__ opened" },
      { role: "user", content: "and this one SPAWNONE 702" },
    ]);

    expect(reply.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
  });

  it("emits every call in one plan step together, then walks to the next step", async () => {
    // The shape a fan-out actually has: one assistant message, two calls. An
    // orchestrator that could only make one call per turn could not delegate a
    // goal to two teammates without two operator messages.
    const directive = plan("p-101", [
      [
        { name: "spawn_task", arguments: { title: "gather", assignee: "engineer" } },
        { name: "spawn_task", arguments: { title: "write", assignee: "writer" } },
      ],
      [{ name: "review_task", arguments: { task_id: "t-1", decision: "approve" } }],
    ]);
    const belt = ["spawn_task", "review_task"];
    const history = [{ role: "user", content: directive }];

    const first = await chat(history, belt);
    const calls = first.choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c: any) => c.function.name)).toEqual(["spawn_task", "spawn_task"]);
    expect(JSON.parse(calls[1].function.arguments)).toEqual({
      title: "write",
      assignee: "writer",
    });
    expect(first.choices[0].finish_reason).toBe("tool_calls");

    // The SAME history again — which is what the host sends, because a
    // delegation tool's result never enters the model-visible transcript. The
    // cursor is what makes this the second step rather than the first one over.
    const second = await chat(history, belt);
    expect(second.choices[0].message.tool_calls).toHaveLength(1);
    expect(second.choices[0].message.tool_calls[0].function.name).toBe("review_task");

    // Past the end the turn ends: prose, not a loop.
    const third = await chat(history, belt);
    expect(third.choices[0].message.tool_calls).toBeUndefined();
    expect(third.choices[0].message.content).toContain("__MOCK_LLM__");
  });

  it("leaves a plan unserved for an agent whose belt cannot make the call", async () => {
    // The teammate case, and the reason the belt is the key. One operator
    // message reaches the orchestrator and then everyone it hands work to, so
    // this exact directive is in the engineer's prompt as well — and the
    // engineer's belt really is narrower: fourteen tools on the harness
    // company against the orchestrator's twenty-seven, with no `spawn_task`
    // among them. Serving it there would spend the step on an agent that
    // cannot make the call, and the orchestrator would then get the step
    // after it.
    const directive = plan("p-202", [
      [{ name: "spawn_task", arguments: { title: "gather" } }],
    ]);

    const agent = await chat([{ role: "user", content: `The operator asked: ${directive}` }], [
      "workspace_read",
    ]);
    expect(agent.choices[0].message.tool_calls).toBeUndefined();
    expect(agent.choices[0].message.content).toContain("__MOCK_LLM__");

    // …and the step is still there for the agent that can.
    const orchestrator = await chat([{ role: "user", content: directive }], ["spawn_task"]);
    expect(orchestrator.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
  });

  it("answers a card-titling pass with a short name, not the canned reply", async () => {
    const titling = await chat([
      { role: "system", content: "You name tasks. You are given one message somebody sent." },
      {
        role: "user",
        content: "can you fix the checkout bug, it has been dropping one in twenty orders",
      },
    ]);
    const title = titling.choices[0].message.content;
    expect(
      titling.choices[0].message.tool_calls,
      "a titling pass must never be answered with a tool call",
    ).toBeUndefined();
    // Short and title-shaped, so a card in this lane has a plausible headline.
    expect(title.length).toBeLessThanOrEqual(80);
    // No marker: a title is rendered as a card headline all over the console,
    // and specs assert raw mock text does not reach the UI.
    expect(title).not.toContain("__MOCK_LLM__");
    // And deliberately NOT the request echoed back. A fixture that answered
    // with a prefix of the request would reproduce the very defect the titling
    // pass removes, and would let a spec key a request against a title and pass
    // here while being wrong against any real model.
    expect(title).not.toContain("checkout");
  });

  it("does not let a card-titling pass consume a directive", async () => {
    // The hazard the triage and planning arms already close, one prompt later:
    // a titling pass is handed the operator's RAW message, so it carries any
    // directive that message carried.
    //
    // A payload of its own: `servedDirectives` is per-process, so reusing the
    // triage test's directive would find it already served and prove nothing.
    const directive = `__MOCK_TOOL_CALL__ ${JSON.stringify({
      name: "mcp_call_tool",
      arguments: { server: "simple", tool: "echo", arguments: { text: "burned-by-titling?" } },
    })}`;

    const titling = await chat([
      { role: "system", content: "You name tasks. You are given one message somebody sent." },
      { role: "user", content: directive },
    ]);
    expect(
      titling.choices[0].message.tool_calls,
      "a titling pass must never be answered with a tool call",
    ).toBeUndefined();

    // The turn that follows must still get its tool call — the whole point.
    const turn = await chat([
      { role: "system", content: "You are the CEO of Acme." },
      { role: "user", content: directive },
    ]);
    expect(turn.choices[0].message.tool_calls?.[0]?.function?.name).toBe("mcp_call_tool");
  });

  it("does not let a triage classification consume a plan step", async () => {
    // The same hazard #678 fixed for `__MOCK_TOOL_CALL__`, one directive later.
    const directive = plan("p-303", [
      [{ name: "spawn_task", arguments: { title: "gather" } }],
    ]);

    const classification = await chat(
      [
        {
          role: "system",
          content: "You classify one message an operator sent to their company's chat.",
        },
        { role: "user", content: directive },
      ],
      ["spawn_task"],
    );
    expect(classification.choices[0].message.content).toBe("chatter");

    const turn = await chat([{ role: "user", content: directive }], ["spawn_task"]);
    expect(turn.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
  });

  it("answers in prose for an explicitly empty plan step", async () => {
    // How a spec says "and then just reply": the step is consumed rather than
    // re-read, so a turn that follows it moves on.
    const directive = plan("p-404", [[], [{ name: "spawn_task", arguments: { title: "later" } }]]);
    const history = [{ role: "user", content: directive }];

    const first = await chat(history, ["spawn_task"]);
    expect(first.choices[0].message.tool_calls).toBeUndefined();

    const second = await chat(history, ["spawn_task"]);
    expect(second.choices[0].message.tool_calls[0].function.name).toBe("spawn_task");
  });

  it("returns embeddings at the width the host validates against", async () => {
    const response = await fetch(`${origin}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embedding-v1", input: ["one", "two"] }),
    });
    const body = await response.json();

    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toHaveLength(1024);
    // Deterministic: two runs of the suite must not disagree about a note.
    expect(body.data[0].embedding).not.toEqual(body.data[1].embedding);
  });
});
