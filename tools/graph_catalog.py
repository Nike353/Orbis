"""Persistent independent libraries, each served with its own transaction state."""
import importlib.util
import json
import threading
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

try:
    from agent_bridge import atomic_write_json, atomic_write_graph
    from workspace import initialize_workspace, ensure_library_writable
except ModuleNotFoundError:
    from tools.agent_bridge import atomic_write_json, atomic_write_graph
    from tools.workspace import initialize_workspace, ensure_library_writable


class GraphCatalog:
    def __init__(self, root, serve_path):
        self.root = Path(root)
        self.path = self.root / "data/graphs.json"
        self.serve_path = Path(serve_path)
        self.lock = threading.RLock()
        self.servers = {}
        self.closed = False
        self.read()

    def read(self):
        if not self.path.exists():
            return []
        entries = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(entries, list) or len(entries) > 100:
            raise ValueError("Invalid graph catalog")
        seen = set()
        for entry in entries:
            if (not isinstance(entry, dict) or set(entry) != {"id", "name"}
                    or not isinstance(entry["name"], str) or not entry["name"].strip()
                    or len(entry["name"]) > 100):
                raise ValueError("Invalid graph catalog entry")
            identifier = entry["id"]
            if (not isinstance(identifier, str) or uuid.UUID(identifier).hex != identifier
                    or identifier in seen):
                raise ValueError("Invalid graph identifier")
            seen.add(identifier)
        return entries

    def register_main(self, server):
        self.servers["main"] = (server, None, None, None)

    def listing(self, active):
        with self.lock:
            graph = json.loads((self.root / "data/graph.json").read_text())
            entries = [{"id": "main", "name": graph["meta"]["title"]}, *self.read()]
            result = []
            for entry in entries:
                root = self.root if entry["id"] == "main" else self.root / "graphs" / entry["id"]
                data = json.loads((root / "data/graph.json").read_text())
                result.append({**entry, "sources": sum(n["type"] == "paper" for n in data["nodes"]),
                               "active": entry["id"] == active})
            return {"graphs": result, "active": active}

    def create(self, name):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            raise ValueError("Choose a graph name between 1 and 100 characters.")
        with self.lock:
            ensure_library_writable(self.root)
            entries = self.read()
            if len(entries) >= 100:
                raise ValueError("This workspace has reached its 100-graph limit.")
            entry = {"id": uuid.uuid4().hex, "name": name.strip()}
            root = self.root / "graphs" / entry["id"]
            initialize_workspace(root)
            data = json.loads((root / "data/graph.json").read_text())
            data["meta"]["title"] = entry["name"]
            atomic_write_graph(root, data)
            atomic_write_json(self.path, [*entries, entry])
            return entry

    def open(self, identifier):
        with self.lock:
            if self.closed:
                raise ValueError("Server is shutting down.")
            if identifier not in {"main", *(entry["id"] for entry in self.read())}:
                raise ValueError("Graph not found.")
            if identifier not in self.servers:
                root = self.root / "graphs" / identifier
                # Separate module namespaces keep every queue, lock, active run and
                # research store independent, while reusing the audited HTTP handler.
                spec = importlib.util.spec_from_file_location("orbis_graph_" + identifier, self.serve_path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                workspace_lock = module.configure_workspace(root, use_environment=False)
                try:
                    module.graph_catalog = self
                    module.active_graph_id = identifier
                    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    self.servers[identifier] = (server, module, workspace_lock, thread)
                except Exception:
                    workspace_lock.close()
                    raise
            port = self.servers[identifier][0].server_address[1]
            return {"url": f"http://127.0.0.1:{port}/"}

    def close(self):
        with self.lock:
            self.closed = True
            children = list(self.servers.items())
        for identifier, (server, module, workspace_lock, thread) in children:
            if identifier == "main":
                continue
            module.cancel_active_run()
            for event in list(module.research_store.active.values()):
                event.set()
            for event in list(module.document_store.active.values()):
                event.set()
            if module.insert_lock.acquire(timeout=5):
                module.insert_lock.release()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            workspace_lock.close()
