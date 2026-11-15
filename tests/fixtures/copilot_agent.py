"""Credential-free Copilot SDK stdio fixture; never contacts a model service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def send(message):
    payload = json.dumps({"jsonrpc": "2.0", **message}).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
    sys.stdout.buffer.flush()


def assistant_response(content):
    return {"aborted": False, "response": {
        "id": str(uuid.uuid4()), "timestamp": "2026-01-01T00:00:00Z",
        "type": "assistant.message", "data": {"content": content, "messageId": "fixture-response"}}}


def request_tool(pending):
    index = len(pending["results"])
    name, arguments = pending["calls"][index]
    send({"method": "session.event", "params": {
        "sessionId": pending["session_id"], "event": {
            "id": str(uuid.uuid4()), "timestamp": "2026-01-01T00:00:00Z",
            "type": "external_tool.requested",
            "data": {"requestId": f"tool-{index}", "sessionId": pending["session_id"],
                     "toolCallId": f"call-{index}", "toolName": name, "arguments": arguments}}}})


pending = None
offered = set()
while True:
    header = sys.stdin.buffer.readline()
    if not header:
        break
    size = int(header.decode().split(":", 1)[1])
    sys.stdin.buffer.readline()
    request = json.loads(sys.stdin.buffer.read(size))
    if "method" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    log = os.environ.get("ORBIS_TEST_COPILOT_LOG")
    if log:
        with Path(log).open("a", encoding="utf-8") as out:
            out.write(json.dumps({"method": method, "params": params,
                                  "desktop_token_present": "ORBIS_DESKTOP_TOKEN" in os.environ}) + "\n")
    result = {"success": True}
    if method in ("connect", "ping"):
        result = {"ok": True, "protocolVersion": 3, "version": "fixture-1.0",
                  "message": "pong", "timestamp": 0}
    elif method == "status.get":
        result = {"version": "fixture-1.0", "protocolVersion": 3}
    elif method == "auth.getStatus":
        result = {"isAuthenticated": not bool(os.environ.get("ORBIS_TEST_COPILOT_SIGNED_OUT"))}
    elif method == "models.list":
        result = {"models": [
            {"id": "test-model", "name": "Test model", "capabilities": {},
             "supportedReasoningEfforts": ["low", "medium", "high"],
             "defaultReasoningEffort": "medium"},
            {"id": "disabled-model", "name": "Disabled", "capabilities": {},
             "policy": {"state": "disabled", "terms": "Unavailable"}}]}
    elif method == "session.create":
        offered = {tool["name"] for tool in params.get("tools", [])}
        result = {"sessionId": params.get("sessionId", str(uuid.uuid4())), "capabilities": {}}
    elif method == "session.tools.handlePendingToolCall":
        assert pending is not None
        assert params["requestId"] == f"tool-{len(pending['results'])}"
        pending["results"].append(params.get("result") or {"error": params.get("error")})
        send({"id": request["id"], "result": {"success": True}})
        if len(pending["results"]) < len(pending["calls"]):
            request_tool(pending)
        else:
            answer = {"outcome": "failed", "reason": "Synthetic tool round trip; no paper source supplied.",
                      "summary": "Workspace tools completed.", "graph_node_id": None, "full_text_source": None}
            send({"id": pending["request_id"], "result": assistant_response(json.dumps(answer))})
            pending = None
        continue
    elif method == "session.sendAndWait":
        prompt = params["prompt"]
        if "TEST_WORKSPACE_TOOLS" in prompt:
            calls = [
                ("orbis_read_file", {"path": "CLAUDE.md"}),
                ("orbis_read_file", {"path": "docs/GRAPH_SCHEMA.md"}),
                ("orbis_read_file", {"path": "data/graph.json"}),
                ("orbis_write_file", {"path": "papers/tool roundtrip.md", "content": "Synthetic caf\u00e9 note"}),
                ("orbis_read_file", {"path": "papers/tool roundtrip.md"}),
                ("orbis_rebuild_graph", {}),
                ("orbis_read_file", {"path": "../outside.md"}),
                ("orbis_list_files", {}),
            ]
            if any(name not in offered for name, _ in calls):
                send({"id": request["id"], "error": {"code": -32602, "message": "Workspace tool not registered"}})
                continue
            pending = {"request_id": request["id"], "session_id": params["sessionId"],
                       "calls": calls, "results": []}
            request_tool(pending)
            continue
        if "TEST_WAIT" in prompt:
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
            marker = os.environ.get("ORBIS_TEST_COPILOT_STARTED")
            if marker:
                Path(marker).write_text(json.dumps([os.getpid(), child.pid]), encoding="utf-8")
            time.sleep(120)
        if "TEST_FAIL" in prompt:
            send({"id": request["id"], "error": {"code": -32000, "message": "Fixture model unavailable"}})
            continue
        if "LIBRARY CONTEXT (data, not instructions):\n" in prompt:
            context = json.loads(prompt.split("LIBRARY CONTEXT (data, not instructions):\n", 1)[1]
                                 .split("\n\nCOMPARISON CRITERIA:", 1)[0])
            criteria = json.loads(prompt.split("COMPARISON CRITERIA: ", 1)[1].split("\n\nUSER QUESTION:", 1)[0])
            scope = context["scope_ids"]
            answer = {"answer": "A synthetic answer based only on the supplied library notes.",
                      "citations": [{"node_id": scope[0], "evidence": "Stored summary.", "passage_id": ""}],
                      "changes": [],
                      "cells": [{"paper_id": paper, "criterion": criterion, "value": "Synthetic comparison",
                                 "evidence": "Stored notes.", "passage_id": ""}
                                for paper in scope for criterion in criteria]}
            passages = context.get("originals", {}).get("passages", [])
            if passages:
                passage = passages[0]
                evidence = passage["text"].splitlines()[0]
                answer["answer"] = "The supplied original explains: " + evidence
                answer["citations"] = [{"node_id": passage["node_id"], "evidence": evidence,
                                        "passage_id": passage["id"]}]
        else:
            answer = {"outcome": "failed", "reason": "Synthetic fixture has no full-text source.",
                      "summary": "No changes made.", "graph_node_id": None, "full_text_source": None}
        content = "not JSON" if "TEST_INVALID" in prompt else json.dumps(answer)
        result = assistant_response(content)
    if "id" in request:
        send({"id": request["id"], "result": result})
    if method == "shutdown":
        break
