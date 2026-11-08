"""Validated, compare-and-swap desktop sync boundary. No Google credentials here."""
import copy
import hashlib
import json
import re
from contextlib import ExitStack
from pathlib import Path

try:
    from tools.agent_bridge import atomic_write_graph, atomic_write_json, utc_now
    from tools.build_data_js import validate
    from tools.workspace import initialize_workspace, ensure_library_writable
    from tools.documents import DocumentStore, validate_document, validate_annotation, HASH_RE
except ModuleNotFoundError:
    from agent_bridge import atomic_write_graph, atomic_write_json, utc_now
    from build_data_js import validate
    from workspace import initialize_workspace, ensure_library_writable
    from documents import DocumentStore, validate_document, validate_annotation, HASH_RE


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()

def graph_folder(root, identifier):
    folder = root if identifier == "main" else root / "graphs" / identifier
    for path in (root, root / "graphs", folder, folder / "data", folder / "papers"):
        if path.is_symlink():
            raise ValueError("Library folders cannot be symbolic links")
    return folder


def snapshot(root):
    root = Path(root)
    if (root / "data/graphs.json").is_symlink():
        raise ValueError("Graph catalog cannot be a symbolic link")
    catalog = json.loads((root / "data/graphs.json").read_text()) if (root / "data/graphs.json").exists() else []
    graphs = {}
    for entry in [{"id": "main", "name": "Main"}, *catalog]:
        identifier = entry["id"]
        if identifier != "main" and not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid graph identifier")
        folder = graph_folder(root, identifier)
        graph = json.loads((folder / "data/graph.json").read_text())
        meta = {k: v for k, v in graph["meta"].items() if k not in ("revision", "updated_at")}
        notes = {}
        for path in sorted((folder / "papers").glob("*.md")):
            if path.is_symlink():
                raise ValueError("Paper files cannot be symbolic links")
            notes[path.name] = path.read_text()
        history = folder / "data/research.json"
        sessions = json.loads(history.read_text()).get("sessions", []) if history.exists() else []
        store = DocumentStore(folder)
        papers = {n["id"] for n in graph["nodes"] if n["type"] == "paper"}
        documents = {k: v for k, v in store.records().items() if v["node_id"] in papers}
        annotations = {k: v for k, v in store.annotations().items() if v["document_id"] in documents}
        graphs[identifier] = {"name": graph["meta"]["title"] if identifier == "main" else entry["name"],
            "meta": meta, "nodes": {n["id"]: n for n in graph["nodes"]},
            "edges": {e["id"]: e for e in graph["edges"]}, "notes": notes,
            "sessions": {s["id"]: s for s in sessions},
            "documents": documents, "annotations": annotations}
    version = 2 if any(g["documents"] or g["annotations"] for g in graphs.values()) else 1
    if version == 1:
        for graph in graphs.values():
            del graph["documents"], graph["annotations"]
    return {"version": version, "graphs": graphs}


def validate_snapshot(value):
    if (not isinstance(value, dict) or set(value) != {"version", "graphs"}
            or type(value["version"]) is not int or value["version"] not in (1, 2)):
        raise ValueError("Unsupported sync format")
    graphs = value["graphs"]
    if not isinstance(graphs, dict) or "main" not in graphs or len(graphs) > 101:
        raise ValueError("Invalid synced library")
    for identifier, item in graphs.items():
        if identifier != "main" and not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid graph identifier")
        fields = {"name", "meta", "nodes", "edges", "notes", "sessions"}
        if value["version"] == 2:
            fields |= {"documents", "annotations"}
        if not isinstance(item, dict) or set(item) != fields:
            raise ValueError("Invalid graph snapshot")
        if not isinstance(item["name"], str) or not 1 <= len(item["name"]) <= 250:
            raise ValueError("Invalid graph name")
        if not all(isinstance(item[k], dict) for k in ("meta", "nodes", "edges", "notes", "sessions")):
            raise ValueError("Invalid graph records")
        for kind in ("nodes", "edges", "sessions"):
            if any(not isinstance(v, dict) or v.get("id") != k for k, v in item[kind].items()):
                raise ValueError("Record IDs do not match sync keys")
        graph = {"meta": {**item["meta"], "revision": 0, "updated_at": utc_now()},
                 "nodes": list(item["nodes"].values()), "edges": list(item["edges"].values())}
        errors = validate(graph)
        if errors:
            raise ValueError("Sync would create an invalid graph: " + "; ".join(errors[:3]))
        if value["version"] == 2:
            documents, annotations = item["documents"], item["annotations"]
            if (not isinstance(documents, dict) or len(documents) > 10000
                    or not isinstance(annotations, dict) or len(annotations) > 50000):
                raise ValueError("Invalid originals or highlights catalog")
            papers = {k for k, n in item["nodes"].items() if n["type"] == "paper"}
            for key, record in documents.items():
                validate_document(record, papers)
                if key != record["id"]:
                    raise ValueError("Original IDs do not match sync keys")
            for key, annotation in annotations.items():
                validate_annotation(annotation, documents)
                if key != annotation["id"]:
                    raise ValueError("Highlight IDs do not match sync keys")
        for name, text in item["notes"].items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]+\.md", name) or name.startswith(".") or not isinstance(text, str) or len(text) > 250000:
                raise ValueError("Invalid paper note")
        for session in item["sessions"].values():
            if (not isinstance(session.get("turns"), list) or not isinstance(session.get("title"), str)
                    or not isinstance(session.get("scope_ids"), list) or not isinstance(session.get("criteria"), list)):
                raise ValueError("Invalid conversation")
            if any(t.get("status") == "running" for t in session["turns"]):
                raise ValueError("Wait for agent conversations to finish before syncing")
    return value


def preserve_paper_drafts(root, value, current=None):
    current = current or snapshot(root)
    for identifier, graph in current["graphs"].items():
        documents = DocumentStore(graph_folder(Path(root), identifier))
        drafts = documents.read(documents.draft_path, {})
        if not isinstance(drafts, dict):
            raise ValueError("Invalid highlight draft state. Draft file is preserved.")
        incoming = value["graphs"].get(identifier, {}).get("annotations", {})
        if any(key in drafts and key not in incoming for key in graph.get("annotations", {})):
            raise ValueError("Sync would delete an unsaved highlight comment. Save or discard the comment before syncing.")
        research = documents.read(documents.root / ".orbis/research-drafts.json", {})
        if not isinstance(research, dict):
            raise ValueError("Invalid discussion draft state. Draft file is preserved.")
        incoming_nodes = value["graphs"].get(identifier, {}).get("nodes", {})
        if any(key in graph["nodes"] and key not in incoming_nodes and
               (draft.get("question") or draft.get("selection"))
               for key, draft in research.items() if isinstance(draft, dict)):
            raise ValueError("Sync would delete a paper with an unsent discussion draft. Clear or send the draft before syncing.")


def write_snapshot(root, value):
    """Replayable writes; caller journals before entering, under all workspace locks."""
    root = Path(root)
    for identifier in value["graphs"]:
        graph_folder(root, identifier)
    if (root / "data/graph.json").exists():
        preserve_paper_drafts(root, value)
    for identifier, item in value["graphs"].items():
        folder = graph_folder(root, identifier)
        initialize_workspace(folder)
        old = json.loads((folder / "data/graph.json").read_text())
        for name, text in item["notes"].items():
            path = folder / "papers" / name
            if path.is_symlink():
                raise ValueError("Paper files cannot be symbolic links")
            temporary = path.with_suffix(".sync-tmp")
            temporary.write_text(text)
            temporary.replace(path)
        for path in (folder / "papers").glob("*.md"):
            if path.name not in item["notes"]:
                path.unlink()
        atomic_write_json(folder / "data/research.json", {"schema_version": 1,
            "sessions": list(item["sessions"].values())})
        documents = DocumentStore(folder)
        documents.write(documents.path, item.get("documents", {}), sync=True)
        documents.write(documents.annotation_path, item.get("annotations", {}), sync=True)
        atomic_write_graph(folder, {"meta": {**item["meta"], "revision": old["meta"]["revision"] + 1,
                                           "updated_at": utc_now()},
            "nodes": list(item["nodes"].values()), "edges": list(item["edges"].values())})
    atomic_write_json(root / "data/graphs.json", [{"id": k, "name": v["name"]}
        for k, v in value["graphs"].items() if k != "main"])


def recover(root):
    journal = Path(root) / ".orbis-sync-apply.json"
    if journal.exists():
        value = validate_snapshot(json.loads(journal.read_text()))
        write_snapshot(root, value)
        journal.unlink()


class DesktopStore:
    def __init__(self, root, catalog, main):
        self.root, self.catalog, self.main = Path(root), catalog, main

    def documents(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"main|[a-f0-9]{32}", identifier):
            raise ValueError("Invalid graph identifier")
        graph_folder(self.root, identifier)
        if identifier == "main":
            return self.main["document_store"]
        with self.catalog.lock:
            self.catalog.open(identifier)
            return self.catalog.servers[identifier][1].document_store

    def availability(self):
        with self.catalog.lock:
            identifiers = ["main", *[entry["id"] for entry in self.catalog.read()]]
            return {"graphs": {identifier: self.documents(identifier).availability()
                              for identifier in identifiers}}

    def blob(self, identifier, sha, content=None):
        store = self.documents(identifier)
        with store.lock:
            records = [r for r in store.records().values() if r["sha256"] == sha]
            if not records or not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
                raise ValueError("Original is not part of this graph")
            if content is not None:
                if any(r["size"] != len(content) for r in records):
                    raise ValueError("Original size does not match metadata")
                store.store_blob(sha, content)
                store.local_state(sha, transfer_status="downloaded", transfer_error="")
        if content is None:
            return store.blob(sha)
        # Rebuild only this device's cache; the original remains if extraction fails.
        return store.index(records[0])

    def transfer(self, identifier, sha, body):
        store = self.documents(identifier)
        allowed = {"transfer_status", "transfer_error", "remote_available", "remote_id"}
        if not isinstance(body, dict) or set(body) - allowed:
            raise ValueError("Invalid original transfer state")
        if "remote_available" in body and type(body["remote_available"]) is not bool:
            raise ValueError("Invalid original availability")
        for field in ("transfer_status", "transfer_error", "remote_id"):
            if field in body and (not isinstance(body[field], str) or len(body[field]) > 1500):
                raise ValueError("Invalid original transfer state")
        if body.get("transfer_status", "pending_upload") not in {
                "pending_upload", "uploading", "uploaded", "available_on_drive",
                "downloading", "downloaded", "interrupted", "error"}:
            raise ValueError("Invalid original transfer status")
        if not any(r["sha256"] == sha for r in store.records().values()):
            raise ValueError("Original is not part of this graph")
        return store.local_state(sha, **body)

    def access(self, incoming=None, expected=None):
        with self.catalog.lock, ExitStack() as locks:
            ensure_library_writable(self.root)
            modules = [self.main, *[m.__dict__ for _, m, _, _ in self.catalog.servers.values() if m]]
            for module in modules:
                if not module["insert_lock"].acquire(blocking=False):
                    raise ValueError("An agent is running; sync will retry when it finishes")
                locks.callback(module["insert_lock"].release)
                locks.enter_context(module["research_store"].lock)
                locks.enter_context(module["graph_lock"])
                if "document_store" in module:
                    locks.enter_context(module["document_store"].lock)
                if module["research_store"].journal.exists():
                    raise ValueError("A research transaction needs recovery")
            current = snapshot(self.root)
            if incoming is None:
                return {"snapshot": current, "digest": digest(current)}
            if digest(current) != expected:
                raise ValueError("Library changed during sync; retrying will preserve the newer edits")
            validate_snapshot(incoming)
            preserve_paper_drafts(self.root, incoming, current)
            # Keep every displaced version available locally for recovery.
            backup = self.root / ".orbis-backups" / (digest(current) + ".json")
            atomic_write_json(backup, current)
            journal = self.root / ".orbis-sync-apply.json"
            atomic_write_json(journal, copy.deepcopy(incoming))
            write_snapshot(self.root, incoming)
            journal.unlink()
            return {"ok": True}
