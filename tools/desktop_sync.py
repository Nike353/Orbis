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
    from tools.workspace import initialize_workspace
except ModuleNotFoundError:
    from agent_bridge import atomic_write_graph, atomic_write_json, utc_now
    from build_data_js import validate
    from workspace import initialize_workspace


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def snapshot(root):
    root = Path(root)
    catalog = json.loads((root / "data/graphs.json").read_text()) if (root / "data/graphs.json").exists() else []
    graphs = {}
    for entry in [{"id": "main", "name": "Main"}, *catalog]:
        identifier = entry["id"]
        if identifier != "main" and not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid graph identifier")
        folder = root if identifier == "main" else root / "graphs" / identifier
        graph = json.loads((folder / "data/graph.json").read_text())
        meta = {k: v for k, v in graph["meta"].items() if k not in ("revision", "updated_at")}
        notes = {}
        for path in sorted((folder / "papers").glob("*.md")):
            if path.is_symlink():
                raise ValueError("Paper files cannot be symbolic links")
            notes[path.name] = path.read_text()
        history = folder / "data/research.json"
        sessions = json.loads(history.read_text()).get("sessions", []) if history.exists() else []
        graphs[identifier] = {"name": graph["meta"]["title"] if identifier == "main" else entry["name"],
            "meta": meta, "nodes": {n["id"]: n for n in graph["nodes"]},
            "edges": {e["id"]: e for e in graph["edges"]}, "notes": notes,
            "sessions": {s["id"]: s for s in sessions}}
    return {"version": 1, "graphs": graphs}


def validate_snapshot(value):
    if not isinstance(value, dict) or set(value) != {"version", "graphs"} or value["version"] != 1:
        raise ValueError("Unsupported sync format")
    graphs = value["graphs"]
    if not isinstance(graphs, dict) or "main" not in graphs or len(graphs) > 101:
        raise ValueError("Invalid synced library")
    for identifier, item in graphs.items():
        if identifier != "main" and not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid graph identifier")
        if not isinstance(item, dict) or set(item) != {"name", "meta", "nodes", "edges", "notes", "sessions"}:
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


def write_snapshot(root, value):
    """Replayable writes; caller journals before entering, under all workspace locks."""
    root = Path(root)
    for identifier, item in value["graphs"].items():
        folder = root if identifier == "main" else root / "graphs" / identifier
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

    def access(self, incoming=None, expected=None):
        with self.catalog.lock, ExitStack() as locks:
            modules = [self.main, *[m.__dict__ for _, m, _, _ in self.catalog.servers.values() if m]]
            for module in modules:
                if not module["insert_lock"].acquire(blocking=False):
                    raise ValueError("An agent is running; sync will retry when it finishes")
                locks.callback(module["insert_lock"].release)
                locks.enter_context(module["graph_lock"])
                locks.enter_context(module["research_store"].lock)
                if module["research_store"].journal.exists():
                    raise ValueError("A research transaction needs recovery")
            current = snapshot(self.root)
            if incoming is None:
                return {"snapshot": current, "digest": digest(current)}
            if digest(current) != expected:
                raise ValueError("Library changed during sync; retrying will preserve the newer edits")
            validate_snapshot(incoming)
            # Keep every displaced version available locally for recovery.
            backup = self.root / ".orbis-backups" / (digest(current) + ".json")
            atomic_write_json(backup, current)
            journal = self.root / ".orbis-sync-apply.json"
            atomic_write_json(journal, copy.deepcopy(incoming))
            write_snapshot(self.root, incoming)
            journal.unlink()
            return {"ok": True}
