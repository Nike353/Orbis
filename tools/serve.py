#!/usr/bin/env python3
"""Local Orbis server with safe persistence and agent handoff."""

import argparse
import os
import hashlib
import json
import re
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

try:
    from research import ResearchStore, ResearchError, paper_note
except ModuleNotFoundError:
    from tools.research import ResearchStore, ResearchError, paper_note

try:
    from build_data_js import validate
    from agent_bridge import (
        BridgeContractError,
        IsolatedInsertion,
        QueueStateStore,
        agent_catalog,
        atomic_write_graph as write_graph_files,
        build_agent_command,
        build_prompt,
        canonical_paper_url,
        default_agent_id,
        graph_duplicate,
        load_batch,
        record_for,
        resolve_agent,
        normalize_settings,
        stream_agent_events,
        utc_now,
        validate_full_text_source,
    )
except ModuleNotFoundError:  # Imported as tools.serve by tests.
    from tools.build_data_js import validate
    from tools.agent_bridge import (
        BridgeContractError,
        IsolatedInsertion,
        QueueStateStore,
        agent_catalog,
        atomic_write_graph as write_graph_files,
        build_agent_command,
        build_prompt,
        canonical_paper_url,
        default_agent_id,
        graph_duplicate,
        load_batch,
        record_for,
        resolve_agent,
        normalize_settings,
        stream_agent_events,
        utc_now,
        validate_full_text_source,
    )


APP_ROOT = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get("LITBENCH_WORKSPACE", APP_ROOT)).expanduser().resolve()
DIST = APP_ROOT / "dist"
GRAPH_JSON = ROOT / "data" / "graph.json"
INSERT_TIMEOUT_S = 30 * 60
MAX_TURNS = 100
MAX_INSERT_BODY_BYTES = 16 * 1024
MAX_GRAPH_BODY_BYTES = 20 * 1024 * 1024
MAX_URL_LEN = 1000
MAX_HINT_LEN = 2000

insert_lock = threading.Lock()
graph_lock = threading.Lock()
active_run_lock = threading.Lock()
active_run = None
graph_catalog = None
active_graph_id = "main"
queue_store = QueueStateStore()
research_store = ResearchStore(ROOT, insert_lock, graph_lock, APP_ROOT)


def atomic_write_graph(data):
    """Compatibility wrapper used by persistence tests."""
    write_graph_files(ROOT, data)


def sanitize_line(text):
    return "".join(
        character if character.isprintable() else " "
        for character in str(text)
    ).strip()


def set_active_run(proc, cancel_event, arxiv_id, agent_id):
    global active_run
    with active_run_lock:
        active_run = {
            "proc": proc,
            "cancel_event": cancel_event,
            "arxiv_id": arxiv_id,
            "agent_id": agent_id,
        }


def clear_active_run(proc):
    global active_run
    with active_run_lock:
        if active_run and active_run["proc"] is proc:
            active_run = None


def cancel_active_run():
    with active_run_lock:
        current = active_run
        if not current:
            return False
        current["cancel_event"].set()
        current["proc"].kill()
        queue_finish(
            current["arxiv_id"],
            "cancelled",
            reason="Cancelled by user.",
        )
        return True


def queue_finish(arxiv_id, status, result=None, reason=None,
                 graph_node_id=None):
    if not arxiv_id:
        return
    result = result or {}
    queue_store.update(
        arxiv_id,
        status,
        finished_at=utc_now(),
        reason=reason,
        summary=result.get("summary"),
        graph_node_id=graph_node_id,
        duration_s=result.get("duration_s"),
        cost_usd=result.get("cost_usd"),
        full_text_source=result.get("full_text_source"),
        full_text_attested_at=(
            utc_now() if result.get("full_text_source") else None),
    )


def manual_record(url, source_kind="paper"):
    if source_kind not in ("paper", "blog", "website"):
        raise BridgeContractError("unknown source type")
    url = canonical_paper_url(url)
    parsed = urlparse(url)
    match = re.fullmatch(
        r"/(?:abs|html|pdf)/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?",
        parsed.path.rstrip("/"),
    )
    record = {
        "canonical_url": url,
        "source_kind": source_kind,
        "query_id": "manual",
        "retrieval_match": {"query_ids": ["manual"], "matched_terms": []},
    }
    if match and parsed.netloc == "arxiv.org":
        record["arxiv_id"] = match.group(1)
    return record


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        static_root = DIST if (DIST / "index.html").exists() else ROOT
        super().__init__(*args, directory=str(static_root), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write("[serve] %s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' "
            "'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; "
            "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'")
        super().end_headers()

    def send_json(self, code, value, extra_headers=None):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header(
            "Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        for name, header_value in (extra_headers or {}).items():
            self.send_header(name, header_value)
        self.end_headers()
        self.wfile.write(payload)

    def read_json_body(self, max_bytes):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if length <= 0 or length > max_bytes:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def same_origin_ok(self):
        host = self.headers.get("Host", "")
        if host.startswith("["):
            hostname = host[1:].split("]", 1)[0]
        else:
            hostname = host.rsplit(":", 1)[0] if ":" in host else host
        if hostname not in ("127.0.0.1", "localhost", "::1"):
            return False
        origin = self.headers.get("Origin", "")
        if origin:
            parsed = urlparse(origin)
            if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
                return False
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/graphs":
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            try:
                self.send_json(200, graph_catalog.listing(active_graph_id) if graph_catalog else {"graphs": []})
            except (OSError, ValueError) as exc:
                self.send_json(500, {"error": str(exc)})
            return
        if parsed.path.startswith("/api/research") or parsed.path == "/api/notes":
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            try:
                if parsed.path == "/api/research":
                    with research_store.lock:
                        state = research_store.read()
                    self.send_json(200, {"sessions": [{**s, "turns": [],
                        "turn_count": len(s["turns"]),
                        "running": any(t["status"] == "running" for t in s["turns"])}
                        for s in state["sessions"]]})
                elif parsed.path.startswith("/api/research/"):
                    with research_store.lock:
                        session = research_store.find(research_store.read(), parsed.path.split("/")[-1])
                    self.send_json(200, session)
                elif parsed.path == "/api/notes":
                    node_id = parse_qs(parsed.query).get("id", [""])[0]
                    node = next((n for n in research_store.graph()["nodes"] if n["id"] == node_id), None)
                    if node is None:
                        raise ResearchError("Record not found.", 404)
                    self.send_json(200, {"text": paper_note(ROOT, node)})
                else:
                    raise ResearchError("Unknown endpoint.", 404)
            except (ResearchError, OSError, ValueError) as exc:
                self.send_json(getattr(exc, "status", 500), {"error": str(exc)})
            return
        if self.path == "/api/health":
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            try:
                revision = json.loads(
                    GRAPH_JSON.read_text(encoding="utf-8"))["meta"]["revision"]
            except (OSError, json.JSONDecodeError, KeyError):
                revision = None
            with active_run_lock:
                active_record = (
                    active_run["arxiv_id"] if active_run else None)
                active_agent = (
                    active_run["agent_id"] if active_run else None)
            self.send_json(200, {
                "ok": True,
                "agents": agent_catalog(),
                "default_agent": default_agent_id(),
                "busy": insert_lock.locked(),
                "active_record": active_record,
                "active_agent": active_agent,
                "graph_revision": revision,
                "workspace_id": str(ROOT),
                "workspace_name": ROOT.name,
            })
            return
        if self.path == "/api/imports/state":
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            try:
                self.send_json(200, queue_store.payload())
            except BridgeContractError as exc:
                self.send_json(500, {"error": str(exc)})
            return
        if self.path == "/api/graph":
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            try:
                data = json.loads(
                    GRAPH_JSON.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                self.send_json(
                    500, {"error": f"could not read graph: {exc}"})
                return
            self.send_json(200, data, {
                "ETag": f'"revision-{data["meta"]["revision"]}"',
                "X-LitBench-Workspace": hashlib.sha256(str(ROOT).encode()).hexdigest()[:20],
            })
            return
        # Data belongs to the selected workspace, never the built-in static bundle.
        if parsed.path.startswith(("/data/", "/papers/")):
            relative = unquote(parsed.path).lstrip("/")
            target = (ROOT / relative).resolve()
            allowed = ((ROOT / "data").resolve(), (ROOT / "papers").resolve())
            if (not self.same_origin_ok() or not any(target.is_relative_to(p) for p in allowed)
                    or not target.is_file() or target.name in ("research.json", "research-apply.json")):
                self.send_error(404)
                return
            original = self.directory
            self.directory = str(ROOT)
            try:
                super().do_GET()
            finally:
                self.directory = original
            return
        super().do_GET()

    def do_PUT(self):
        if self.path != "/api/graph":
            self.send_json(404, {"error": "unknown endpoint"})
            return
        if not self.same_origin_ok():
            self.send_json(403, {"error": "cross-origin request rejected"})
            return
        if insert_lock.locked():
            self.send_json(409, {
                "error": (
                    "A local agent is updating the graph; save after it finishes")
            })
            return
        body = self.read_json_body(MAX_GRAPH_BODY_BYTES)
        if not isinstance(body, dict):
            self.send_json(400, {"error": "invalid JSON body"})
            return
        base_revision = body.get("base_revision")
        graph = body.get("graph")
        if not isinstance(base_revision, int) or not isinstance(graph, dict):
            self.send_json(
                400, {"error": "base_revision and graph are required"})
            return
        errors = validate(graph)
        if errors:
            self.send_json(422, {
                "error": "graph validation failed", "details": errors})
            return

        with graph_lock:
            if research_store.journal.exists():
                self.send_json(409, {"error": "A graph transaction needs recovery. Restart the server before saving."})
                return
            try:
                current = json.loads(
                    GRAPH_JSON.read_text(encoding="utf-8"))
                current_revision = current["meta"]["revision"]
            except (OSError, json.JSONDecodeError, KeyError) as exc:
                self.send_json(
                    500, {"error": f"could not read graph: {exc}"})
                return
            if current_revision != base_revision:
                self.send_json(409, {
                    "error": "revision conflict",
                    "current_revision": current_revision,
                })
                return
            if graph.get("meta", {}).get("revision") != base_revision + 1:
                self.send_json(422, {
                    "error": (
                        "saved graph revision must be base_revision + 1")
                })
                return
            try:
                atomic_write_graph(graph)
            except OSError as exc:
                self.send_json(
                    500, {"error": f"atomic save failed: {exc}"})
                return
        self.send_json(200, graph)

    def do_DELETE(self):
        if self.path != "/api/insert":
            self.send_json(404, {"error": "unknown endpoint"})
            return
        if not self.same_origin_ok():
            self.send_json(403, {"error": "cross-origin request rejected"})
            return
        cancelled = cancel_active_run()
        self.send_json(
            202 if cancelled else 409,
            {"ok": cancelled, "message": (
                "cancellation requested" if cancelled
                else "no local-agent run is active")},
        )

    def do_POST(self):
        if self.path == "/api/graphs" or self.path.startswith("/api/graphs/"):
            if not self.same_origin_ok():
                self.send_json(403, {"error": "cross-origin request rejected"})
                return
            if graph_catalog is None:
                self.send_json(503, {"error": "Graph management is unavailable."})
                return
            body = self.read_json_body(4096)
            if not isinstance(body, dict):
                self.send_json(400, {"error": "invalid JSON body"})
                return
            try:
                if self.path == "/api/graphs":
                    self.send_json(201, graph_catalog.create(body.get("name")))
                elif self.path.endswith("/open") and len(self.path.split("/")) == 5:
                    self.send_json(200, graph_catalog.open(self.path.split("/")[3]))
                else:
                    self.send_json(404, {"error": "Unknown graph action."})
            except (OSError, ValueError) as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if research_store.journal.exists():
            self.send_json(409, {"error": "A graph transaction needs recovery. Restart the server before continuing."})
            return
        if self.path.startswith("/api/research"):
            self.research_post()
            return
        if self.path != "/api/insert":
            self.send_json(404, {"error": "unknown endpoint"})
            return
        if not self.same_origin_ok():
            self.send_json(403, {"error": "cross-origin request rejected"})
            return
        body = self.read_json_body(MAX_INSERT_BODY_BYTES)
        if not isinstance(body, dict):
            self.send_json(400, {"error": "invalid JSON body"})
            return

        hint = sanitize_line(body.get("hint", ""))
        if len(hint) > MAX_HINT_LEN:
            self.send_json(400, {"error": "hint too long"})
            return
        agent_id = sanitize_line(body.get("agent", "")) or default_agent_id()
        known_agents = {agent["id"] for agent in agent_catalog()}
        if not agent_id or agent_id not in known_agents:
            self.send_json(400, {"error": "unknown local agent"})
            return
        try:
            agent = resolve_agent(agent_id)
        except BridgeContractError as exc:
            self.send_json(503, {"error": str(exc)})
            return

        try:
            settings = normalize_settings(agent_id, body.get("settings"))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        batch_id = sanitize_line(body.get("batch_id", ""))
        arxiv_id = sanitize_line(body.get("arxiv_id", ""))
        is_batch_record = bool(batch_id or arxiv_id)
        if is_batch_record and not (batch_id and arxiv_id):
            self.send_json(
                400, {"error": "batch_id and arxiv_id must be provided together"})
            return

        try:
            relevance_policy = None
            if is_batch_record:
                batch = load_batch(queue_store.batch_path)
                record = record_for(batch, batch_id, arxiv_id)
                relevance_policy = batch.get("relevance_policy")
                supplied_url = sanitize_line(body.get("url", ""))
                if supplied_url and canonical_paper_url(supplied_url) != (
                        canonical_paper_url(record["canonical_url"])):
                    raise BridgeContractError(
                        "paper URL does not match the verified batch")
            else:
                url = sanitize_line(body.get("url", ""))
                parsed = urlparse(url)
                if (parsed.scheme not in ("http", "https")
                        or not parsed.netloc or len(url) > MAX_URL_LEN):
                    self.send_json(
                        400, {"error": "url must be a valid http(s) URL"})
                    return
                record = manual_record(url, body.get("source_kind", "paper"))
        except BridgeContractError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        if not insert_lock.acquire(blocking=False):
            self.send_json(
                409, {"error": "a local-agent insertion is already running"})
            return

        try:
            if is_batch_record:
                queue_store.start(arxiv_id)
            self.run_insert(
                record,
                hint,
                arxiv_id if is_batch_record else None,
                relevance_policy,
                agent_id,
                agent["label"],
                settings,
            )
        except BridgeContractError as exc:
            queue_finish(arxiv_id if is_batch_record else None,
                         "failed", reason=str(exc))
            self.send_json(500, {"error": str(exc)})
        finally:
            insert_lock.release()

    def research_post(self):
        if not self.same_origin_ok():
            self.send_json(403, {"error": "cross-origin request rejected"})
            return
        body = self.read_json_body(128 * 1024)
        if not isinstance(body, dict):
            self.send_json(400, {"error": "invalid JSON body"})
            return
        parts = self.path.strip("/").split("/")
        try:
            if parts == ["api", "research"]:
                value = research_store.create(body)
            elif len(parts) == 4 and parts[3] == "turns":
                value = research_store.start(parts[2], body)
            elif len(parts) == 3:
                value = research_store.manage(parts[2], body)
            elif len(parts) == 5 and parts[3] == "cancel":
                value = research_store.cancel(parts[4])
            elif len(parts) == 5 and parts[3] == "decide":
                value = research_store.decision(parts[2], parts[4], body)
            else:
                raise ResearchError("Unknown research endpoint.", 404)
            self.send_json(200, value)
        except (BridgeContractError, ValueError, OSError) as exc:
            self.send_json(getattr(exc, "status", 400), {"error": str(exc)})

    def run_insert(
            self, record, hint, queue_arxiv_id, relevance_policy,
            agent_id, agent_label, settings=None):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        client_gone = threading.Event()
        cancel_requested = threading.Event()
        timed_out = threading.Event()
        url = record["canonical_url"]

        def emit(value):
            if client_gone.is_set():
                return
            try:
                self.wfile.write(
                    (json.dumps(value, ensure_ascii=False) + "\n").encode(
                        "utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                client_gone.set()

        emit({
            "type": "start",
            "url": url,
            "arxiv_id": record.get("arxiv_id"),
            "settings": settings,
        })
        duplicate_node = graph_duplicate(ROOT, record)
        if duplicate_node:
            reason = f"Already represented by {duplicate_node}."
            queue_finish(
                queue_arxiv_id, "duplicate", reason=reason,
                graph_node_id=duplicate_node)
            emit({
                "type": "done",
                "ok": True,
                "outcome": "duplicate",
                "reason": reason,
                "summary": reason,
                "graph_node_id": duplicate_node,
                "cost_usd": None,
                "duration_s": 0,
            })
            return

        self.log_message("%s insert started: %s", agent_label, url)
        with IsolatedInsertion(ROOT) as insertion:
            prompt = build_prompt(record, hint, relevance_policy)
            command = build_agent_command(
                agent_id, prompt, insertion.workspace, MAX_TURNS, settings=settings)
            try:
                proc = subprocess.Popen(
                    command,
                    cwd=str(insertion.workspace),
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except OSError as exc:
                reason = f"failed to launch {agent_label}: {exc}"
                queue_finish(queue_arxiv_id, "failed", reason=reason)
                emit({"type": "error", "message": reason})
                return

            set_active_run(
                proc, cancel_requested, queue_arxiv_id, agent_id)
            stderr_tail = []

            def drain_stderr():
                for line in proc.stderr:
                    stderr_tail.append(line)
                    del stderr_tail[:-20]

            def kill_for_timeout():
                timed_out.set()
                proc.kill()

            def watch_client():
                while proc.poll() is None:
                    if client_gone.wait(timeout=1.0):
                        cancel_requested.set()
                        proc.kill()
                        return

            stderr_thread = threading.Thread(
                target=drain_stderr, daemon=True)
            stderr_thread.start()
            watcher = threading.Thread(
                target=watch_client, daemon=True)
            watcher.start()
            killer = threading.Timer(
                INSERT_TIMEOUT_S, kill_for_timeout)
            killer.start()

            try:
                result = stream_agent_events(proc, agent_id, emit)
                code = proc.wait()
                stderr_thread.join(timeout=5)

                if cancel_requested.is_set() or client_gone.is_set():
                    reason = "Cancelled by user."
                    queue_finish(
                        queue_arxiv_id, "cancelled",
                        result=result, reason=reason)
                    emit({"type": "error", "message": reason})
                    self.log_message("%s insert cancelled", agent_label)
                    return
                if timed_out.is_set():
                    reason = f"{agent_label} exceeded the 30-minute limit."
                    queue_finish(
                        queue_arxiv_id, "failed",
                        result=result, reason=reason)
                    emit({"type": "error", "message": reason})
                    return
                if code != 0 or not result["ok"]:
                    tail = "".join(stderr_tail)[-1500:]
                    reason = result["summary"] or tail or (
                        f"{agent_label} exited with code {code}")
                    queue_finish(
                        queue_arxiv_id, "failed",
                        result=result, reason=reason)
                    emit({"type": "error", "message": reason})
                    return

                outcome = result["structured_output"]
                if not isinstance(outcome, dict):
                    raise BridgeContractError(
                        f"{agent_label} did not provide a structured outcome")
                outcome_name = outcome.get("outcome")
                reason = str(outcome.get("reason", "")).strip()
                summary = str(outcome.get("summary", "")).strip()
                graph_node_id = outcome.get("graph_node_id")
                full_text_source = outcome.get("full_text_source")
                if (outcome_name not in ("inserted", "excluded", "failed")
                        or not reason or not summary):
                    raise BridgeContractError(
                        f"{agent_label} returned an invalid structured outcome")
                result["summary"] = summary
                result["full_text_source"] = full_text_source

                if outcome_name in ("inserted", "excluded"):
                    attestation_errors = validate_full_text_source(
                        record,
                        full_text_source,
                        result["webfetch_urls"],
                    )
                    if attestation_errors:
                        raise BridgeContractError(
                            f"{agent_label} full-text attestation failed: "
                            + "; ".join(attestation_errors))

                if outcome_name == "inserted":
                    errors = insertion.verify_inserted(
                        record, graph_node_id)
                    if errors:
                        raise BridgeContractError(
                            f"{agent_label} output violated the graph contract: "
                            + "; ".join(errors[:10]))
                    with graph_lock:
                        insertion.apply()
                    queue_finish(
                        queue_arxiv_id, "inserted", result=result,
                        reason=reason, graph_node_id=graph_node_id)
                else:
                    errors = insertion.verify_unchanged()
                    if errors:
                        raise BridgeContractError(
                            f"{agent_label} changed files for a non-insertion "
                            "outcome: " + "; ".join(errors))
                    if outcome_name == "failed":
                        queue_finish(
                            queue_arxiv_id, "failed", result=result,
                            reason=reason)
                        emit({"type": "error", "message": reason})
                        return
                    queue_finish(
                        queue_arxiv_id, "excluded", result=result,
                        reason=reason)

                emit({
                    "type": "done",
                    "ok": True,
                    "outcome": outcome_name,
                    "reason": reason,
                    "summary": summary,
                    "graph_node_id": graph_node_id,
                    "cost_usd": result["cost_usd"],
                    "duration_s": result["duration_s"],
                    "full_text_source": full_text_source,
                })
                self.log_message(
                    "%s insert finished outcome=%s",
                    agent_label,
                    outcome_name,
                )
            except (BridgeContractError, OSError, ValueError) as exc:
                reason = str(exc)
                queue_finish(
                    queue_arxiv_id, "failed", reason=reason)
                emit({"type": "error", "message": reason})
                self.log_message(
                    "%s insert rejected: %s", agent_label, reason)
            finally:
                killer.cancel()
                if proc.poll() is None:
                    proc.kill()
                clear_active_run(proc)


def configure_workspace(root, use_environment=True):
    global ROOT, GRAPH_JSON, queue_store, research_store
    ROOT = Path(root).resolve()
    try:
        from workspace import initialize_workspace, lock_workspace
    except ModuleNotFoundError:
        from tools.workspace import initialize_workspace, lock_workspace
    initialize_workspace(ROOT)
    workspace_lock = lock_workspace(ROOT)
    GRAPH_JSON = ROOT / "data" / "graph.json"
    queue_store = QueueStateStore(
        (os.environ.get("LITBENCH_BATCH_PATH") if use_environment else None) or ROOT / "data/imports/adaptation-appendix-b-051-106.json",
        (os.environ.get("LITBENCH_STATE_PATH") if use_environment else None) or ROOT / "data/imports/adaptation-appendix-b-051-106-state.json")
    research_store = ResearchStore(ROOT, insert_lock, graph_lock, APP_ROOT)
    research_store.recover()
    return workspace_lock


def main():
    global ROOT, graph_catalog
    parser = argparse.ArgumentParser(description="Orbis local server")
    parser.add_argument("--port", type=int, help="Port to bind; defaults to an available port starting at 8000")
    parser.add_argument("--workspace", type=Path, help="Personal workspace directory; initializes an empty library when missing")
    args = parser.parse_args()

    if args.workspace:
        ROOT = args.workspace.expanduser().resolve()
    workspace_lock = configure_workspace(ROOT)

    if not (DIST / "index.html").exists():
        print(
            "WARNING: dist/ is missing. Run `npm run build` before opening "
            "the production server.")
    available_agents = [
        agent["label"] for agent in agent_catalog() if agent["available"]
    ]
    if not available_agents:
        print(
            "WARNING: no supported local agent was found on PATH; graph "
            "editing works, but semantic paper processing is unavailable.")
    else:
        print("Local agents: " + ", ".join(available_agents))
    try:
        if queue_store.batch_path.exists():
            queue_store.load(recover_interrupted=True)
    except BridgeContractError as exc:
        print(f"WARNING: arXiv queue state unavailable: {exc}")

    import errno
    ports = [args.port] if args.port is not None else range(8000, 8021)
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
    else:
        raise SystemExit("No requested port is available. Try ./start.sh --port 8100.")
    try:
        from graph_catalog import GraphCatalog
    except ModuleNotFoundError:
        from tools.graph_catalog import GraphCatalog
    graph_catalog = GraphCatalog(ROOT, Path(__file__))
    graph_catalog.register_main(server)
    print(
        "Orbis serving on http://127.0.0.1:%d  (Ctrl-C to stop)"
        % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        graph_catalog.close()
        cancel_active_run()
        for event in list(research_store.active.values()):
            event.set()
        # Give the worker time to kill its process group and persist cancellation.
        if insert_lock.acquire(timeout=5):
            insert_lock.release()
        server.server_close()
        workspace_lock.close()


if __name__ == "__main__":
    main()
