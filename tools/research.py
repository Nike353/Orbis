"""Application-owned research conversations and explicitly reviewed graph edits.

Provider sessions are ephemeral. Only bounded, validated final answers are kept.
The journal makes accepting a change bundle recoverable across process crashes.
"""
import copy
import json
import math
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

try:
    from agent_bridge import (BridgeContractError, atomic_write_json,
                              atomic_write_graph, resolve_agent, utc_now, normalize_settings, settings_arguments,
                              agent_environment as research_environment, agent_profile, codex_tool_restrictions, stop_agent,
                              validate_paper_summary, state_fingerprint)
    from build_data_js import validate
    from documents import DocumentStore, normalized_text, evidence_excerpt
    from workspace import ensure_library_writable
except ModuleNotFoundError:
    from tools.agent_bridge import (BridgeContractError, atomic_write_json,
                                    atomic_write_graph, resolve_agent, utc_now, normalize_settings, settings_arguments,
                                    agent_environment as research_environment, agent_profile, codex_tool_restrictions, stop_agent,
                                    validate_paper_summary, state_fingerprint)
    from tools.build_data_js import validate
    from tools.documents import DocumentStore, normalized_text, evidence_excerpt
    from tools.workspace import ensure_library_writable


def graph_fingerprint(graph):
    """Portable proposal base: local revisions and JSON record order are not content."""
    def portable(value):
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, dict):
            return {k: portable(v) for k, v in value.items()}
        if isinstance(value, list):
            return [portable(v) for v in value]
        return value
    return state_fingerprint(portable({
        "meta": {k: v for k, v in graph["meta"].items() if k not in ("revision", "updated_at")},
        "nodes": sorted(graph["nodes"], key=lambda item: item["id"]),
        "edges": sorted(graph["edges"], key=lambda item: item["id"]),
    }))


def obj(properties):
    # Codex strict structured output requires explicit types, including enum/const fields.
    properties = {key: ({"type": "string", **value} if "const" in value or "enum" in value else value)
                  for key, value in properties.items()}
    return {"type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False}


STR = {"type": "string"}
NUM = {"type": "number"}
CHANGE_SCHEMAS = [
    obj({"action": {"const": "rename"}, "node_id": STR, "label": STR,
         "reason": STR}),
    obj({"action": {"const": "move"}, "node_id": STR, "cluster_id": STR,
         "reason": STR}),
    obj({"action": {"const": "create"}, "node_id": STR,
         "node_type": {"enum": ["cluster", "method", "representation",
                                 "assumption", "experiment", "claim", "open_question"]},
         "label": STR, "description": STR, "cluster_id": STR, "reason": STR}),
    obj({"action": {"const": "connect"}, "source_id": STR, "target_id": STR,
         "relation": STR, "evidence": STR, "confidence": NUM, "reason": STR}),
    obj({"action": {"const": "note"}, "node_id": STR, "text": STR,
         "reason": STR}),
    obj({"action": {"const": "summary"}, "node_id": STR, "text": STR,
         "key_findings": {"type": "array", "items": STR}, "reason": STR}),
]
RESEARCH_SCHEMA = obj({
    "answer": STR,
    "citations": {"type": "array", "items": obj({"node_id": STR, "evidence": STR, "passage_id": STR})},
    "changes": {"type": "array", "items": {"anyOf": CHANGE_SCHEMAS}},
    "cells": {"type": "array", "items": obj({
        "paper_id": STR, "criterion": STR, "value": STR, "evidence": STR, "passage_id": STR})},
})
MAX_SESSIONS = 100
MAX_TURNS = 100
TIMEOUT = 600
CONTEXT_BYTES = 96000


class ResearchError(BridgeContractError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require_text(value, name, limit=12000, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ResearchError(f"{name} must be {'at most' if empty else '1–'}{limit} characters.")
    return value.strip()


def graph_changes(graph, changes):
    """Return a validated preview. IDs and ownership are assigned by the server."""
    if not isinstance(changes, list) or len(changes) > 50:
        raise ResearchError("A proposal may contain at most 50 changes.")
    result = copy.deepcopy(graph)
    nodes = {n["id"]: n for n in result["nodes"]}
    previews = []
    schemas = {s["properties"]["action"]["const"]: s for s in CHANGE_SCHEMAS}
    for change in changes:
        if not isinstance(change, dict) or change.get("action") not in schemas:
            raise ResearchError("Unsupported graph change.")
        action = change["action"]
        if set(change) != set(schemas[action]["properties"]):
            raise ResearchError(f"Unexpected fields in {action} change.")
        for key, value in change.items():
            if key not in ("confidence", "key_findings"):
                require_text(value, key, 100000 if key == "text" else 12000,
                             empty=key in ("cluster_id", "description"))
        require_text(change["reason"], "reason", 2000)
        node = nodes.get(change.get("node_id"))
        before = copy.deepcopy(node)
        if action in ("rename", "move", "note", "summary") and node is None:
            raise ResearchError("The requested node no longer exists.", 409)
        if action == "rename":
            node["label"] = require_text(change["label"], "label", 250)
        elif action == "move":
            if node["type"] == "cluster":
                raise ResearchError("A cluster cannot be nested in another cluster.")
            if change["cluster_id"]:
                node["cluster"] = change["cluster_id"]
            else:
                node.pop("cluster", None)
        elif action == "note":
            node["notes"] = (node.get("notes", "") + "\n\n" + change["text"]).strip()
            if len(node["notes"]) > 100000:
                raise ResearchError("Notes exceed 100,000 characters; export and shorten them first.")
        elif action == "summary":
            if node["type"] != "paper":
                raise ResearchError("Only a paper can have a regenerated summary.")
            errors = validate_paper_summary(change["text"])
            if errors:
                raise ResearchError("; ".join(errors))
            findings = change["key_findings"]
            if not isinstance(findings, list) or len(findings) > 30:
                raise ResearchError("A summary may contain at most 30 key findings.")
            for finding in findings:
                require_text(finding, "key finding", 2000)
            node["paper"].update(summary=change["text"], key_findings=findings)
        elif action == "create":
            node_id = change["node_id"]
            node_type = change["node_type"]
            import re
            if (node_type not in schemas[action]["properties"]["node_type"]["enum"]
                    or not re.fullmatch(re.escape(node_type) + r":[a-z0-9][a-z0-9-]{0,100}", node_id)
                    or node_id in nodes):
                raise ResearchError("New nodes need a unique type:kebab-case ID.")
            node = {"id": node_id, "type": node_type,
                    "label": require_text(change["label"], "label", 250),
                    "description": change["description"], "created_at": utc_now()[:10]}
            if change["cluster_id"]:
                node["cluster"] = change["cluster_id"]
            nodes[node_id] = node
            result["nodes"].append(node)
        elif action == "connect":
            if (change["source_id"] not in nodes or change["target_id"] not in nodes
                    or change["source_id"] == change["target_id"]):
                raise ResearchError("Choose two different existing nodes for the connection.")
            confidence = change["confidence"]
            if (isinstance(confidence, bool) or not isinstance(confidence, (float, int))
                    or not 0 <= confidence <= 1):
                raise ResearchError("Confidence must be between 0 and 1.")
            if any(e["source"] == change["source_id"] and e["target"] == change["target_id"]
                   and e["relation"] == change["relation"] for e in result["edges"]):
                raise ResearchError("This directed relationship already exists.")
            number = max((int(e["id"][1:]) for e in result["edges"]), default=0) + 1
            node = {"id": f"e{number:03}", "source": change["source_id"],
                    "target": change["target_id"], "relation": change["relation"],
                    "transition_note": change["reason"], "evidence": change["evidence"],
                    "confidence": confidence, "created_at": utc_now()[:10]}
            result["edges"].append(node)
        if action != "summary":
            node["origin"] = "user"
            node["status"] = "accepted"
        previews.append({"action": action, "reason": change["reason"],
                         "before": before, "after": copy.deepcopy(node)})
    errors = validate(result)
    if errors:
        raise ResearchError("Invalid proposed graph: " + "; ".join(errors[:5]))
    return result, previews


def paper_note(root, node):
    relative = node.get("notes_file", "")
    if not relative:
        return ""
    target = (root / relative).resolve()
    if not target.is_relative_to((root / "papers").resolve()) or not target.is_file():
        return ""
    # No arbitrary paths or huge files from imported graph records.
    if target.stat().st_size > 250000:
        return "[Paper note exceeds the reading limit.]"
    return target.read_text(encoding="utf-8")


def encoded_size(value):
    return len(json.dumps(value, ensure_ascii=False).encode())


def context_budget(agent, settings):
    # UTF-8 bytes give a conservative token bound; reserve room for instructions/output.
    if agent == "codex":
        try:
            path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "models_cache.json"
            models = json.loads(path.read_text()).get("models", [])
            model = next((m for m in models if m.get("slug") == (settings or {}).get("model")), {})
            window = model.get("context_window")
            if type(window) is int and window > 24000:
                return min(CONTEXT_BYTES, window - 24000)
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    return CONTEXT_BYTES


def build_context(root, graph, session, question="", documents=None, selection=None, budget=CONTEXT_BYTES):
    ids = set(session["scope_ids"])
    selected = [n for n in graph["nodes"] if n["id"] in ids]
    expanded = set(ids)
    expanded.update(n["id"] for n in graph["nodes"] if n.get("cluster") in ids)
    expanded.update(e["source"] if e["target"] in ids else e["target"]
                    for e in graph["edges"] if e["source"] in ids or e["target"] in ids)
    candidates = selected + [n for n in graph["nodes"] if n["id"] in expanded and n["id"] not in ids]
    if not ids:
        candidates = graph["nodes"][:24]
    # Scope papers get a fair share so a large first note cannot exclude later papers.
    per_note = min(6000, max(128, budget // 8 // max(1, len(selected))))
    records, used, omitted = [], 0, 0
    for node in candidates:
        card = {key: node[key] for key in ("id", "type", "cluster", "status", "origin") if key in node}
        card["label"] = node["label"][:250]
        for key in ("description", "notes"):
            if key in node:
                card[key] = evidence_excerpt(node[key], question, per_note)
        card["source_note"] = evidence_excerpt(paper_note(root, node), question, per_note)
        if "paper" in node:
            paper = node["paper"]
            card["paper"] = {key: paper[key][:500] for key in ("title", "venue", "url")}
            card["paper"].update(year=paper["year"], authors=[a[:100] for a in paper["authors"][:8]],
                                 summary=evidence_excerpt(paper["summary"], question, per_note),
                                 key_findings=[f[:max(40, per_note // 12)] for f in paper["key_findings"][:12]])
        size = encoded_size(card)
        if node["id"] not in ids and used + size > budget // 2:
            omitted += 1
            continue
        records.append(card)
        used += size
    catalog = []
    catalog_size = 0
    for node in [*selected, *[n for n in graph["nodes"] if n["id"] not in ids]]:
        item = {"id": node["id"], "label": node["label"][:180], "type": node["type"],
                "cluster": node.get("cluster")}
        catalog_size += encoded_size(item)
        if catalog_size > budget // 6:
            break
        catalog.append(item)
    history = [{"question": t["question"][:2000], "answer": t.get("result", {}).get("answer", "")[:4000]}
               for t in session["turns"][-8:] if t["status"] == "completed"]
    originals = (documents or DocumentStore(root)).retrieve(
        session["scope_ids"], question + " " + " ".join(session["criteria"]), budget=budget // 2)
    if selection is not None:
        if (not isinstance(selection, dict) or set(selection) != {"document_id", "page", "text"}
                or type(selection["page"]) is not int):
            raise ResearchError("Invalid selected passage.")
        selected_text = require_text(selection["text"], "selected text", 4000)
        record = (documents or DocumentStore(root)).document(selection["document_id"])
        if record["node_id"] not in ids:
            raise ResearchError("Selected text must belong to a paper in this conversation.")
        pages = (documents or DocumentStore(root)).pages(record["id"])["pages"]
        page = next((p for p in pages if p["page"] == selection["page"]), None)
        if page is None or normalized_text(selected_text) not in normalized_text(page["text"]):
            raise ResearchError("Selected text no longer matches the original page.")
        text = normalized_text(page["text"])
        start = text.index(normalized_text(selected_text))
        excerpt = text[max(0, start - 800):start + len(normalized_text(selected_text)) + 800]
        passage_id = f"{record['id']}:{page['page']}"
        passage = {"id": passage_id, "node_id": record["node_id"], "document_id": record["id"],
                   "sha256": record["sha256"], "page": page["page"], "section": page["section"],
                   "source_url": record["source_url"], "text": excerpt, "truncated": len(excerpt) < len(text)}
        originals["passages"] = [passage, *[p for p in originals["passages"] if p["id"] != passage_id]]
        originals["selected_text"] = selected_text
    connections = []
    connection_size = 0
    for edge in graph["edges"]:
        if edge["source"] not in ids and edge["target"] not in ids:
            continue
        item = {**edge, "transition_note": evidence_excerpt(edge["transition_note"], question, 1500),
                "evidence": evidence_excerpt(edge.get("evidence", ""), question, 1500)}
        connection_size += encoded_size(item)
        if connection_size > budget // 6:
            break
        connections.append(item)
    context = {"graph_revision": graph["meta"]["revision"], "scope_ids": session["scope_ids"],
            "records": records, "catalog": catalog,
            "connections": connections,
            "history": history, "originals": originals, "coverage": {
                "records_included": len(records), "records_omitted": omitted,
                "note_character_limit": per_note, "history_turns": len(history),
                "catalog_truncated": len(graph["nodes"]) > len(catalog),
                "original_passages": len(originals["passages"]),
                "original_sources": originals["sources"], "context_byte_limit": budget}}
    # Drop optional overview/history first; every explicitly selected card survives.
    for key in ("catalog", "history", "connections"):
        while context[key] and encoded_size(context) > budget - 256:
            context[key].pop(0 if key == "history" else -1)
    while encoded_size(context) > budget - 256 and any(r["id"] not in ids for r in records):
        records.pop(next(i for i in range(len(records) - 1, -1, -1) if records[i]["id"] not in ids))
        omitted += 1
    while encoded_size(context) > budget - 256 and per_note > 128:
        per_note = max(128, per_note // 2)
        for record in records:
            for key in ("description", "notes", "source_note"):
                if key in record:
                    record[key] = evidence_excerpt(record[key], question, per_note)
            if "paper" in record:
                record["paper"]["summary"] = evidence_excerpt(record["paper"]["summary"], question, per_note)
                record["paper"]["key_findings"] = [f[:max(40, per_note // 12)]
                                                    for f in record["paper"]["key_findings"]]
    while encoded_size(context) > budget - 256:
        passages = originals["passages"]
        removable = next((i for i in range(len(passages) - 1, -1, -1)
                          if sum(p["node_id"] == passages[i]["node_id"] for p in passages) > 1
                          and not (selection and passages[i]["id"] == f"{selection['document_id']}:{selection['page']}")), None)
        if removable is None:
            raise ResearchError("Selected context exceeds this model's reading budget. Choose fewer papers.")
        passages.pop(removable)
    context["coverage"].update(
        records_included=len(records), records_omitted=omitted,
        note_character_limit=per_note, history_turns=len(context["history"]),
        catalog_truncated=len(context["catalog"]) < len(graph["nodes"]),
        original_passages=len(originals["passages"]),
        context_bytes=encoded_size(context))
    return context


def validate_result(result, graph, session, context=None):
    if not isinstance(result, dict) or set(result) != set(RESEARCH_SCHEMA["properties"]):
        raise ResearchError("Agent did not return a valid research answer.")
    require_text(result["answer"], "answer", 20000)
    ids = {n["id"] for n in graph["nodes"]}
    supplied_ids = {n["id"] for n in context["records"]} if context else ids
    passages = {p["id"]: p for p in (context or {}).get("originals", {}).get("passages", [])}
    if not isinstance(result["citations"], list) or len(result["citations"]) > 100:
        raise ResearchError("Invalid citation list.")
    def source_quote(node_id, evidence, passage_id):
        if not isinstance(passage_id, str):
            raise ResearchError("Invalid source passage identifier.")
        if passage_id:
            passage = passages.get(passage_id)
            if passage is None or passage["node_id"] != node_id:
                raise ResearchError("A source citation was not supplied to this answer.")
            if normalized_text(evidence) not in normalized_text(passage["text"]):
                raise ResearchError("A source citation does not quote its supplied passage.")

    for citation in result["citations"]:
        if (not isinstance(citation, dict)
                or set(citation) not in ({"node_id", "evidence"}, {"node_id", "evidence", "passage_id"})
                or citation["node_id"] not in supplied_ids):
            raise ResearchError("A citation refers to a missing library record.")
        require_text(citation["evidence"], "citation evidence", 4000)
        source_quote(citation["node_id"], citation["evidence"], citation.get("passage_id", ""))
    if session["scope_ids"] and not result["citations"]:
        raise ResearchError("Research answers must identify their supporting library records.")
    _, previews = graph_changes(graph, result["changes"])
    if not isinstance(result["cells"], list) or len(result["cells"]) > 240:
        raise ResearchError("Invalid comparison cells.")
    expected = {(p, c) for p in session["scope_ids"] for c in session["criteria"]}
    seen = set()
    for cell in result["cells"]:
        if (not isinstance(cell, dict) or set(cell) not in
                ({"paper_id", "criterion", "value", "evidence"},
                 {"paper_id", "criterion", "value", "evidence", "passage_id"})):
            raise ResearchError("Invalid comparison cell.")
        pair = (cell["paper_id"], cell["criterion"])
        if pair not in expected or pair in seen:
            raise ResearchError("Comparison has duplicate or unexpected cells.")
        seen.add(pair)
        require_text(cell["value"], "cell value", 3000)
        require_text(cell["evidence"], "cell evidence", 3000)
        source_quote(cell["paper_id"], cell["evidence"], cell.get("passage_id", ""))
    if seen != expected:
        raise ResearchError("Comparison is incomplete; every paper needs every criterion.")
    if context is not None:
        cited = []
        warnings = []
        def numbers(text, support, label):
            for number, unit in re.findall(r"\b(\d+(?:\.\d+)?)\s*(%|percent|trials|samples|seconds|ms|parameters)(?!\w)",
                                          text, re.I):
                if not re.search(r"\b" + re.escape(number) + r"\b", normalized_text(support)):
                    claim = number + ("%" if unit.lower() in ("%", "percent") else " " + unit)
                    warnings.append(f"{label}: the numerical claim {claim} is not present in the supplied evidence.")

        for citation in [*result["citations"], *result["cells"]]:
            passage = passages.get(citation.get("passage_id"))
            if passage:
                citation.update(document_id=passage["document_id"], sha256=passage["sha256"],
                                page=passage["page"], section=passage["section"],
                                source_url=passage["source_url"])
                cited.append(passage)
        original_count = sum(bool(c.get("passage_id")) for c in [*result["citations"], *result["cells"]])
        source_count = len(result["citations"]) + len(result["cells"])
        result["source_mode"] = (
            "originals" if cited and original_count == source_count
            else "mixed" if cited else "notes_only")
        if passages and not cited:
            warnings.append(
                "The answer did not cite an original passage. Treat it as notes-only.")
        records = {n["id"]: n for n in context["records"]}
        answer_support = " ".join(p["text"] for p in cited) + " ".join(
            json.dumps(records.get(c["node_id"], {})) for c in result["citations"] if not c.get("passage_id"))
        numbers(result["answer"], answer_support, "Answer")
        for cell in result["cells"]:
            passage = passages.get(cell.get("passage_id"))
            support = passage["text"] if passage else json.dumps(records.get(cell["paper_id"], {}))
            numbers(cell["value"], support, f"{cell['paper_id']} · {cell['criterion']}")
            if not passage and any(p["node_id"] == cell["paper_id"] for p in passages.values()):
                warnings.append(f"{cell['paper_id']} · {cell['criterion']}: this cell uses library notes, not an original-source quote.")
            cell["source_mode"] = "originals" if passage else "notes_only"
        cited_ids = {c["node_id"] for c in result["citations"]}
        nodes = {n["id"]: n for n in graph["nodes"]}
        for change in result["changes"]:
            if change["action"] == "connect":
                papers = {identifier for identifier in (change["source_id"], change["target_id"])
                          if nodes.get(identifier, {}).get("type") == "paper"}
                if not papers.issubset(cited_ids):
                    raise ResearchError("A proposed connection must cite evidence for each paper it connects.")
                numbers(change["evidence"] + " " + change["reason"], answer_support, "Proposed connection")
            elif change["action"] == "summary":
                support = " ".join(p["text"] for p in cited if p["node_id"] == change["node_id"])
                if not support:
                    raise ResearchError("Attach a readable original before regenerating its summary. Existing notes and history are preserved.")
                numbers(change["text"] + " ".join(change["key_findings"]), support, "Proposed summary")
        result["quality_warnings"] = list(dict.fromkeys(warnings))[:24]
    return previews


def research_command(agent_id, directory, settings=None):
    agent = resolve_agent(agent_id)
    overrides = settings_arguments(agent_id, settings)
    schema = directory / "output-schema.json"
    schema.write_text(json.dumps(RESEARCH_SCHEMA), encoding="utf-8")
    if agent_id == "codex":
        restrictions = codex_tool_restrictions(agent["command"], read_only=True)
        return [*agent["command"], "exec", *overrides, "--json", "--ephemeral", "--skip-git-repo-check",
                "--sandbox", "read-only", "-c", 'approval_policy="never"', *restrictions,
                "--output-schema", str(schema), "--color", "never", "-"]
    # Q&A uses the supplied library context; no write, shell or external MCP tools.
    return [*agent["command"], *agent_profile(agent_id, agent["command"]).get('startup_arguments', []),
            *overrides, "-p", "--no-session-persistence", "--output-format",
            "stream-json", "--verbose", "--json-schema", json.dumps(RESEARCH_SCHEMA),
            "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--max-turns", "4"]

def parse_output(raw, agent_id):
    result, cost, usage = None, None, None
    failed = None
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        if agent_id == "claude" and event.get("type") == "result":
            if event.get("is_error"):
                failed = str(event.get("result") or event.get("subtype"))
            result = event.get("structured_output")
            if result is None:
                try:
                    result = json.loads(event.get("result", ""))
                except (ValueError, TypeError):
                    pass
            cost = event.get("total_cost_usd")
            usage = event.get("usage")
        elif agent_id == "codex":
            if event.get("type") == "item.completed" and isinstance(event.get("item"), dict) and event["item"].get("type") == "agent_message":
                try:
                    result = json.loads(event["item"]["text"])
                except (ValueError, TypeError):
                    pass
            if event.get("type") == "turn.completed":
                usage = event.get("usage")
            if event.get("type") in ("turn.failed", "error"):
                failed = str(event.get("error") or event.get("message"))
    if failed:
        raise ResearchError("Agent failed: " + failed[:1200])
    if result is None:
        raise ResearchError("No structured answer was returned. Check the CLI version and sign-in, then retry.")
    return result, cost if type(cost) in (int, float) and math.isfinite(cost) and cost >= 0 else None, usage


class ResearchStore:
    def __init__(self, root, run_lock, graph_lock, app_root=None, documents=None):
        self.root = Path(root)
        self.app_root = Path(app_root or Path(__file__).resolve().parent.parent)
        self.path = self.root / "data" / "research.json"
        self.journal = self.root / "data" / "research-apply.json"
        self.lock = threading.RLock()
        self.run_lock, self.graph_lock = run_lock, graph_lock
        self.active = {}
        self.documents = documents or DocumentStore(self.root, graph_lock)

    def read(self):
        try:
            ensure_library_writable(self.root)
        except ValueError as exc:
            raise ResearchError(str(exc), 409) from exc
        if self.journal.exists():
            raise ResearchError("A graph transaction needs recovery. Restart the server before continuing.", 409)
        if not self.path.exists():
            return {"schema_version": 1, "sessions": []}
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
            if state.get("schema_version") != 1 or not isinstance(state.get("sessions"), list):
                raise ValueError("unsupported format")
            return state
        except (ValueError, OSError) as exc:
            raise ResearchError(f"Could not read research history: {exc}", 500) from exc

    def graph(self):
        return json.loads((self.root / "data/graph.json").read_text(encoding="utf-8"))

    def recover(self):
        with self.lock, self.graph_lock:
            if self.journal.exists():
                journal = json.loads(self.journal.read_text())
                current = self.graph()
                if current not in (journal["before"], journal["after"]):
                    raise ResearchError("Unfinished graph transaction conflicts with disk. Restore a workspace backup.", 409)
                atomic_write_graph(self.root, journal["after"])
                atomic_write_json(self.path, journal["state"])
                self.journal.unlink()
            state = self.read()
            changed = False
            for session in state["sessions"]:
                for turn in session["turns"]:
                    if turn["status"] == "running":
                        turn.update(status="interrupted", phase="interrupted",
                                    error="Server stopped. Send the question again to retry.", finished_at=utc_now())
                        changed = True
            if changed:
                atomic_write_json(self.path, state)

    def find(self, state, session_id, turn_id=None):
        session = next((s for s in state["sessions"] if s["id"] == session_id), None)
        if session is None:
            raise ResearchError("Conversation not found.", 404)
        if turn_id is None:
            return session
        turn = next((t for t in session["turns"] if t["id"] == turn_id), None)
        if turn is None:
            raise ResearchError("Answer not found.", 404)
        return session, turn

    def view(self, session_id):
        with self.lock, self.graph_lock:
            session = self.find(self.read(), session_id)
            current = graph_fingerprint(self.graph())
            for turn in session["turns"]:
                if turn.get("proposal_status") == "pending":
                    turn["proposal_stale"] = turn.get("base_fingerprint") != current
            return session

    def create(self, body):
        title = require_text(body.get("title"), "title", 160)
        scope = body.get("scope_ids", [])
        criteria = body.get("criteria", [])
        if (not isinstance(scope, list) or len(scope) > 20 or not all(isinstance(s, str) for s in scope)
                or len(set(scope)) != len(scope)):
            raise ResearchError("Choose up to 20 distinct records.")
        if not isinstance(criteria, list) or len(criteria) > 12:
            raise ResearchError("Choose at most 12 comparison criteria.")
        criteria = [require_text(c, "criterion", 80) for c in criteria]
        if len(set(c.lower() for c in criteria)) != len(criteria):
            raise ResearchError("Comparison criteria must be distinct.")
        graph = self.graph()
        nodes = {n["id"]: n for n in graph["nodes"]}
        if any(s not in nodes for s in scope):
            raise ResearchError("A selected record no longer exists.")
        if criteria and (len(scope) < 2 or any(nodes[s]["type"] != "paper" for s in scope)):
            raise ResearchError("Select 2–20 papers for a comparison.")
        with self.lock:
            state = self.read()
            if len(state["sessions"]) >= MAX_SESSIONS:
                raise ResearchError("Export and delete an old conversation before creating more (limit 100).")
            session = {"id": str(uuid.uuid4()), "title": title, "scope_ids": scope,
                       "criteria": criteria, "created_at": utc_now(), "archived": False,
                       "turns": []}
            state["sessions"].insert(0, session)
            atomic_write_json(self.path, state)
            return session

    def manage(self, session_id, body):
        with self.lock:
            state = self.read()
            session = self.find(state, session_id)
            if any(t["status"] == "running" for t in session["turns"]):
                raise ResearchError("Stop the running answer first.", 409)
            if body.get("action") == "archive":
                session["archived"] = bool(body.get("archived", True))
            elif body.get("action") == "delete":
                state["sessions"].remove(session)
            elif body.get("action") == "rename":
                session["title"] = require_text(body.get("title"), "title", 160)
            else:
                raise ResearchError("Unknown conversation action.")
            atomic_write_json(self.path, state)
            return {"ok": True}

    def draft(self, node_id, body=None):
        if not any(n["id"] == node_id and n["type"] == "paper" for n in self.graph()["nodes"]):
            raise ResearchError("Paper not found in this graph.", 404)
        path = self.root / ".orbis/research-drafts.json"
        with self.lock:
            drafts = self.documents.read(path, {})
            if not isinstance(drafts, dict):
                raise ResearchError("Invalid research draft state. Draft file is preserved.", 409)
            if body is None:
                return drafts.get(node_id, {"question": "", "selection": None})
            question = require_text(body.get("question", ""), "draft", 8000, empty=True)
            selection = body.get("selection")
            if question or selection is not None:
                try:
                    ensure_library_writable(self.root)
                except ValueError as exc:
                    raise ResearchError(str(exc), 409) from exc
            if selection is not None:
                if (not isinstance(selection, dict) or set(selection) != {"document_id", "page", "text"}
                        or not isinstance(selection["document_id"], str)
                        or type(selection["page"]) is not int or not 1 <= selection["page"] <= 1000):
                    raise ResearchError("Invalid selected-passage draft.")
                require_text(selection["text"], "selected text", 4000)
                if self.documents.document(selection["document_id"])["node_id"] != node_id:
                    raise ResearchError("Selected text must belong to this paper.")
            drafts[node_id] = {"question": question, "selection": selection}
            self.documents.write(path, drafts)
            return drafts[node_id]

    def start(self, session_id, body):
        question = require_text(body.get("question"), "question", 8000)
        agent = body.get("agent")
        resolve_agent(agent)
        try:
            settings = normalize_settings(agent, body.get("settings"))
        except ValueError as exc:
            raise ResearchError(str(exc)) from exc
        if not self.run_lock.acquire(blocking=False):
            raise ResearchError("Another agent run is active. Wait or stop it first.", 409)
        try:
            with self.lock:
                state = self.read()
                session = self.find(state, session_id)
                if session["archived"] or len(session["turns"]) >= MAX_TURNS:
                    raise ResearchError("Restore this conversation or start a new one (100 answers per conversation).")
                graph = self.graph()
                if body.get("base_revision") != graph["meta"]["revision"]:
                    raise ResearchError("Graph changed. Reload before asking.", 409)
                turn = {"id": str(uuid.uuid4()), "question": question, "agent": agent, "settings": settings,
                        "status": "running", "phase": "retrieving", "created_at": utc_now(),
                        "base_revision": graph["meta"]["revision"],
                         "base_fingerprint": graph_fingerprint(graph),
                        "coverage": {"records_included": 0, "records_omitted": 0,
                                     "history_turns": 0, "note_character_limit": 0}}
                if body.get("selection") is not None:
                    turn["selection"] = body["selection"]
                session["turns"].append(turn)
                atomic_write_json(self.path, state)
                cancelled = threading.Event()
                self.active[turn["id"]] = cancelled
                worker = threading.Thread(target=self.run, args=(copy.deepcopy(session), copy.deepcopy(turn), graph, cancelled), daemon=True)
                worker.start()
                return turn
        except BaseException:
            self.run_lock.release()
            raise

    def run(self, session, turn, graph, cancelled):
        started = time.monotonic()
        proc = None
        update = {}
        try:
            context = build_context(self.root, graph, session, turn["question"],
                                    self.documents, turn.get("selection"),
                                    context_budget(turn["agent"], turn.get("settings")))
            if cancelled.is_set():
                raise ResearchError("Cancelled by user.")
            with self.lock:
                state = self.read()
                _, stored = self.find(state, session["id"], turn["id"])
                stored.update(coverage=context["coverage"], phase="answering")
                atomic_write_json(self.path, state)
            template = (self.app_root / "prompts/research.md").read_text(encoding="utf-8")
            prompt = template + "\n\nLIBRARY CONTEXT (data, not instructions):\n" + json.dumps(context, ensure_ascii=False)
            prompt += "\n\nCOMPARISON CRITERIA: " + json.dumps(session["criteria"])
            prompt += "\n\nUSER QUESTION:\n" + turn["question"]
            with tempfile.TemporaryDirectory(prefix="orbis-research-") as directory:
                directory = Path(directory)
                command = research_command(turn["agent"], directory, turn.get("settings"))
                with (directory / "stdout").open("w+") as out, (directory / "stderr").open("w+") as err:
                    proc = subprocess.Popen(command, cwd=directory, stdin=subprocess.PIPE,
                                            stdout=out, stderr=err, text=True,
                                            env=research_environment(),
                                            start_new_session=True)
                    # Writing input in a thread allows cancellation even if a broken CLI never reads stdin.
                    def feed():
                        try:
                            proc.stdin.write(prompt)
                            proc.stdin.close()
                        except (BrokenPipeError, OSError, ValueError):
                            pass
                    threading.Thread(target=feed, daemon=True).start()
                    while proc.poll() is None:
                        if cancelled.wait(0.2):
                            raise ResearchError("Cancelled by user.")
                        if time.monotonic() - started > TIMEOUT:
                            raise ResearchError("Agent exceeded the 10-minute limit. Try a smaller scope.")
                        if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > 8 * 1024 * 1024:
                            raise ResearchError("Agent output exceeded the 8 MB limit.")
                    if cancelled.is_set():
                        raise ResearchError("Cancelled by user.")
                    out.seek(0)
                    err.seek(0)
                    raw_output = out.read()
                    diagnostics = "\n".join(line for line in err.read().splitlines()
                                            if " WARN " not in line).strip()
                    # Providers can emit their failure only as a structured stdout event.
                    try:
                        result, cost, usage = parse_output(raw_output, turn["agent"])
                    except ResearchError as exc:
                        if proc.returncode:
                            raise ResearchError("Agent exited with code " + str(proc.returncode) + ": " + (diagnostics[-1200:] or str(exc))) from exc
                        raise
                    if proc.returncode:
                        raise ResearchError("Agent exited with code " + str(proc.returncode) + ": " + (diagnostics[-1200:] or "Check the CLI sign-in and account limits in your terminal."))
                    with self.lock:
                        state = self.read()
                        _, stored = self.find(state, session["id"], turn["id"])
                        stored["phase"] = "validating"
                        atomic_write_json(self.path, state)
                    previews = validate_result(result, graph, session, context)
                    update = {"status": "completed", "result": result, "preview": previews,
                              "proposal_status": "pending" if result["changes"] else "none",
                              "cost_usd": cost, "usage": usage}
        except Exception as exc:
            update = {"status": "cancelled" if cancelled.is_set() else "failed", "error": str(exc)[:2000]}
        finally:
            if proc is not None:
                stop_agent(proc)
                proc.wait()
            update.update(finished_at=utc_now(), duration_s=round(time.monotonic() - started, 1))
            update["phase"] = "ready_to_review" if update.get("proposal_status") == "pending" else update["status"]
            try:
                with self.lock:
                    state = self.read()
                    _, stored = self.find(state, session["id"], turn["id"])
                    stored.update(update)
                    atomic_write_json(self.path, state)
            finally:
                self.active.pop(turn["id"], None)
                self.run_lock.release()

    def cancel(self, turn_id):
        event = self.active.get(turn_id)
        if event is None:
            raise ResearchError("This answer is no longer running.", 409)
        event.set()
        return {"ok": True}

    def decision(self, session_id, turn_id, body):
        with self.lock, self.graph_lock:
            state = self.read()
            session, turn = self.find(state, session_id, turn_id)
            action = body.get("action")
            if turn["status"] != "completed":
                raise ResearchError("Only completed answers can be saved.")
            if action == "reject":
                if turn.get("proposal_status") != "pending":
                    raise ResearchError("This proposal is already resolved.", 409)
                turn["proposal_status"] = "rejected"
                atomic_write_json(self.path, state)
                return {"ok": True}
            if self.run_lock.locked():
                raise ResearchError("Wait for the active agent before changing the graph.", 409)
            graph = self.graph()
            if body.get("base_revision") != graph["meta"]["revision"]:
                raise ResearchError("Graph changed. Reload and review before saving.", 409)
            if action == "apply":
                if turn.get("proposal_status") == "applied":
                    return {"ok": True}
                if turn.get("proposal_status") != "pending":
                    raise ResearchError("This answer has no pending changes.")
                if turn.get("base_fingerprint") != graph_fingerprint(graph):
                    raise ResearchError("Proposal is stale. Ask the agent to propose it again against the current graph.", 409)
                changes = turn["result"]["changes"]
                turn["proposal_status"] = "applied"
            elif action == "save_note":
                node_id = body.get("node_id")
                if node_id in turn.get("saved_note_ids", []):
                    return {"ok": True}
                text = body.get("text", turn["result"]["answer"])
                require_text(text, "note", 100000)
                turn.setdefault("note_saves", []).append({
                    "node_id": node_id, "saved_at": utc_now(),
                    "citations": turn["result"]["citations"],
                })
                changes = [{"action": "note", "node_id": node_id, "text": text, "reason": "Saved research answer"}]
                turn.setdefault("saved_note_ids", []).append(node_id)
            else:
                raise ResearchError("Unknown answer action.")
            after, _ = graph_changes(graph, changes)
            after["meta"].update(revision=graph["meta"]["revision"] + 1, updated_at=utc_now())
            # Write intent first. Recovery completes this exact transaction, never reapplies notes.
            atomic_write_json(self.journal, {"before": graph, "after": after, "state": state})
            atomic_write_graph(self.root, after)
            atomic_write_json(self.path, state)
            self.journal.unlink()
            return {"ok": True, "graph": after}
