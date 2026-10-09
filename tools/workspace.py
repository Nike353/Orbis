"""Personal data initialization, separate from the distributable application."""
import fcntl
import json
from pathlib import Path

try:
    from agent_bridge import atomic_write_graph, atomic_write_json, utc_now
except ModuleNotFoundError:
    from tools.agent_bridge import atomic_write_graph, atomic_write_json, utc_now


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
    handle = (Path(root) / ".server.lock").open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise SystemExit("This workspace is already open in another Orbis server.")
    return handle
