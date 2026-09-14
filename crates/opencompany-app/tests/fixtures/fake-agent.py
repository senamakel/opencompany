#!/usr/bin/env python3
"""A minimal ACP agent, for testing the client against a real subprocess.

Not a mock of the client's own types: a separate process speaking the wire
format over actual pipes. That is the only way to exercise the parts that
mocking hides — the framing, the reader task's routing, replies arriving
interleaved with notifications, and what happens when the process dies.

Behaviour is driven by the prompt text so one fixture covers every case:

  "stream"     emit three session/update notifications, then end the turn
  "read:PATH"  call fs/read_text_file and echo what came back
  "write:PATH" call fs/write_text_file
  "ask"        call session/request_permission and report the choice
  "die"        exit without answering, to test a harness vanishing mid-turn
  anything     end the turn immediately
"""
import json
import sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})

pending = {}
next_id = [1000]

def call(method, params):
    """Agent -> client request; blocks for the matching reply."""
    rid = next_id[0]
    next_id[0] += 1
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    while True:
        line = sys.stdin.readline()
        if not line:
            sys.exit(0)
        msg = json.loads(line)
        if msg.get("id") == rid:
            if "error" in msg:
                return {"__error__": msg["error"]["message"]}
            return msg.get("result", {})
        pending.setdefault("queue", []).append(msg)

def handle(msg):
    method = msg.get("method")
    rid = msg.get("id")

    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "agentInfo": {"name": "fake-agent", "version": "0.1.0"},
        }})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "sess-1"}})
    elif method == "session/prompt":
        text = "".join(b.get("text", "") for b in msg["params"].get("prompt", []))
        sid = msg["params"]["sessionId"]

        if text == "die":
            sys.exit(1)

        if text == "stream":
            # Interleaved BEFORE the response: a client that read until it saw
            # its own reply would lose all of these.
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "thinking"}}})
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "tool_call", "toolCallId": "t1",
                "title": "Read a file", "status": "pending"}})
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "done"}}})
        elif text.startswith("read:"):
            got = call("fs/read_text_file", {"sessionId": sid, "path": text[5:]})
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text",
                            "text": got.get("__error__", got.get("content", ""))}}})
        elif text.startswith("write:"):
            path, _, body = text[6:].partition("|")
            got = call("fs/write_text_file",
                       {"sessionId": sid, "path": path, "content": body})
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text",
                            "text": got.get("__error__", "written")}}})
        elif text == "ask":
            got = call("session/request_permission", {
                "sessionId": sid,
                "toolCall": {"toolCallId": "t9", "title": "Delete everything"},
                "options": [
                    {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "no", "name": "Reject", "kind": "reject_once"},
                ]})
            chosen = got.get("outcome", {}).get("optionId", "?")
            notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "chose:" + chosen}}})

        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        # A notification: answering it would be a protocol error.
        notify("session/update", {"sessionId": msg["params"]["sessionId"],
                                  "update": {"sessionUpdate": "agent_message_chunk",
                                             "content": {"type": "text", "text": "cancelled"}}})
    elif rid is not None:
        send({"jsonrpc": "2.0", "id": rid,
              "error": {"code": -32601, "message": "no such method: %s" % method}})

for line in sys.stdin:
    if not line.strip():
        continue
    handle(json.loads(line))
    while pending.get("queue"):
        handle(pending["queue"].pop(0))
