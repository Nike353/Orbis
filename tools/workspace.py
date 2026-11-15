"""Personal data initialization, separate from the distributable application."""
import json
import re
from pathlib import Path

import portalocker

try:
    from agent_bridge import atomic_write_graph, atomic_write_json, utc_now
    from file_lock import lock_file
except ModuleNotFoundError:
    from tools.agent_bridge import atomic_write_graph, atomic_write_json, utc_now
    from tools.file_lock import lock_file


def initialize_workspace(root):
    root = Path(root)
    (root / "data/imports").mkdir(parents=True, exist_ok=True)
    (root / "papers").mkdir(exist_ok=True)
    graph_path = root / "data/graph.json"
    if not graph_path.exists():
        atomic_write_graph(root, {"meta": {"schema_version": 2,
            "title": "My paper universe", "revision": 0, "updated_at": utc_now()},
            "nodes": [], "edges": []})
    elif not (root / "data/graph.js").exists():
        atomic_write_graph(root, json.loads(graph_path.read_text(encoding="utf-8")))


def lock_workspace(root):
    try:
        return lock_file(Path(root) / ".server.lock", blocking=False)
    except portalocker.AlreadyLocked as error:
        raise SystemExit("This workspace is already open in another Orbis server.") from error


def ensure_library_writable(root):
    root = Path(root)
    library = root.parent.parent if root.parent.name == "graphs" and re.fullmatch(r"[a-f0-9]{32}", root.name) else root
    if (library / ".orbis-sync-apply.json").exists():
        raise ValueError("A sync transaction needs recovery. Restart Orbis before saving; your edits are preserved.")
    if library != root:
        catalog = library / "data/graphs.json"
        entries = json.loads(catalog.read_text()) if catalog.exists() else []
        if not isinstance(entries, list) or not any(isinstance(entry, dict) and entry.get("id") == root.name for entry in entries):
            raise ValueError("This graph is no longer in the library. Return to Main before saving; its saved files are preserved.")
