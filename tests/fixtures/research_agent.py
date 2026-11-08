"""Deterministic CLI protocol fixture. Never contacts a model provider."""
import json
import os
import sys
import time

if sys.argv[-3:] == ["mcp", "list", "--json"]:
    print("[]")
    sys.exit(0)

if "--version" in sys.argv:
    print("codex-cli 0.167.42")
    sys.exit(0)
if "--help" in sys.argv:
    print("--settings --effort")
    sys.exit(0)
if "app-server" in sys.argv or "--input-format" in sys.argv:
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        if method == "initialized":
            continue
        if method == "model/list":
            result = {"data": [
                {"id": model, "model": model, "displayName": model,
                 "supportedReasoningEfforts": [{"reasoningEffort": e} for e in ["low", "medium", "high"]]}
                for model in ["gpt-5.5", "gpt-5.6-sol"]], "nextCursor": None}
        elif method == "config/read":
            result = {"config": {"model": "gpt-5.5", "model_reasoning_effort": "high"}}
        elif request.get("type") == "control_request":
            result = ({"models": [{"value": model, "displayName": model,
                                   "supportedEffortLevels": ["low", "medium", "high"]}
                                  for model in ["default", "sonnet", "opus"]],
                       "claude_code_version": "2.1.319"}
                      if request["request"]["subtype"] == "initialize" else
                      {"effective": {"model": "sonnet", "effortLevel": "high"}})
            print(json.dumps({"type": "control_response", "response": {
                "subtype": "success", "request_id": request["request_id"], "response": result}}), flush=True)
            continue
        else:
            result = {}
        print(json.dumps({"id": request["id"], "result": result}), flush=True)
    sys.exit(0)

prompt = sys.stdin.read()
context_text = prompt.split("LIBRARY CONTEXT (data, not instructions):\n", 1)[1]
context = json.loads(context_text.split("\n\nCOMPARISON CRITERIA:", 1)[0])
criteria = json.loads(prompt.split("COMPARISON CRITERIA: ", 1)[1].split("\n\nUSER QUESTION:", 1)[0])
question = prompt.split("USER QUESTION:\n", 1)[1]
if os.environ.get("ORBIS_E2E_FIXTURE") and "Reader test:" not in question:
    time.sleep(30)
if "TEST_WAIT" in question:
    time.sleep(30)
if "TEST_EMPTY_EXIT" in question:
    sys.exit(9)
if "TEST_STDOUT_ERROR" in question or "TEST_WHITESPACE_ERROR" in question:
    if "--json" in sys.argv:
        print(json.dumps({"type": "error", "message": "Model is unavailable in this region."}))
    else:
        print(json.dumps({"type": "result", "is_error": True, "result": "Model is unavailable in this region."}))
    if "TEST_WHITESPACE_ERROR" in question:
        print("\n   ", file=sys.stderr)
    sys.exit(7)
if "TEST_FAIL" in question:
    print("Fixture failure", file=sys.stderr)
    sys.exit(2)
scope = context["scope_ids"]
node_id = scope[0] if scope else context["catalog"][0]["id"]
changes = []
if "TEST_RENAME" in question:
    changes = [{"action": "rename", "node_id": node_id, "label": "Reviewed cluster", "reason": "The requested name describes the scope more clearly."}]
if "TEST_SUMMARY" in question or "Regenerate the summary" in question:
    headings = ["Motivation and problem", "Background and prior work", "Proposal and framework", "Key results", "Limitations"]
    summary = "\n\n".join("## " + heading + "\nThe synthetic source describes a bounded reading fixture. Details beyond supplied excerpts are not established in the available evidence."
                          for heading in headings)
    changes = [{"action": "summary", "node_id": node_id, "text": summary,
                "key_findings": ["Supplied excerpts support a bounded reading fixture."], "reason": "Update only this requested paper after source review."}]
result = {"answer": "The library describes complementary approaches. This answer is based on the stored notes, not a new full-text reading.",
          "citations": [{"node_id": node_id, "evidence": "Stored summary and key findings.", "passage_id": ""}],
          "changes": changes,
          "cells": [{"paper_id": p, "criterion": c, "value": f"Fixture finding for {c}",
                     "evidence": "Stored library notes; verify against the source paper.",
                     "passage_id": ""} for p in scope for c in criteria]}
if "TEST_INVALID" in question:
    result["citations"][0]["node_id"] = "paper:missing"
passages = context.get("originals", {}).get("passages", [])
if passages:
    passage = passages[0]
    result["answer"] = "The supplied original explains: " + passage["text"].splitlines()[0]
    result["citations"] = [{"node_id": passage["node_id"], "evidence": passage["text"].splitlines()[0],
                            "passage_id": passage["id"]}]
    for cell in result["cells"]:
        source = next((p for p in passages if p["node_id"] == cell["paper_id"]), None)
        if source:
            cell.update(value=source["text"].splitlines()[0], evidence=source["text"].splitlines()[0],
                        passage_id=source["id"])
    if "TEST_UNANSWERABLE" in question:
        result["answer"] = "Not established in the supplied evidence. The fixture does not report this outcome."
    if "TEST_BAD_SOURCE" in question:
        result["citations"][0]["passage_id"] += "99"
    if "TEST_BAD_QUOTE" in question:
        result["citations"][0]["evidence"] = "Fabricated result not in the document."
if "TEST_ENV" in question:
    result["answer"] = "Desktop capability: " + os.environ.get("ORBIS_DESKTOP_TOKEN", "absent")
if "--json" in sys.argv:
    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(result)}}))
    print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 50}}))
else:
    print(json.dumps({"type": "result", "structured_output": result, "is_error": False, "total_cost_usd": 0}))
