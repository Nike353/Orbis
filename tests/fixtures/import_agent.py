"""Synthetic import protocol fixture; no provider or network access."""
import json
import os
import sys
import time

if sys.argv[-3:] == ["mcp", "list", "--json"]:
    print("[]")
    sys.exit(0)
codex = "--json" in sys.argv
prompt = sys.argv[sys.argv.index("-p") + 1] if "-p" in sys.argv else sys.argv[-1]
url = "https://example.org/synthetic"
def emit(event):
    print(json.dumps(event), flush=True)

if codex:
    emit({"type": "thread.started"})
    emit({"type": "item.completed", "item": {"id": "source", "type": "web_search",
          "action": {"type": "open_page", "url": url}}})
else:
    emit({"type": "system", "subtype": "init"})
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use",
          "name": "WebFetch", "input": {"url": url}}]}})
time.sleep(30 if "TEST_WAIT" in prompt else .1)
result = {"outcome": "excluded", "reason": "Synthetic source outside scope.",
          "summary": "Fixture reviewed without library changes.", "graph_node_id": None,
          "full_text_source": {"url": url, "format": "publisher-html", "evidence": "Method and results sections."}}
if "TEST_ENV" in prompt:
    result["summary"] = "Desktop capability: " + os.environ.get("ORBIS_DESKTOP_TOKEN", "absent")
if codex:
    emit({"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(result)}})
    emit({"type": "turn.completed"})
else:
    emit({"type": "result", "structured_output": result, "is_error": False})
