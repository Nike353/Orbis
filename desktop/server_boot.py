"""Frozen application entry point; modules and runtime assets ship together."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    if sys.platform == "win32":
        # Frozen interpreters ignore Python's UTF-8 environment switches.
        for stream in (sys.stdin, sys.stdout, sys.stderr):
            stream.reconfigure(encoding="utf-8")
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--orbis-agent-bootstrap":
        from tools.agent_process import _bootstrap
        return _bootstrap(sys.argv[2:])
    if mode == "--orbis-copilot-worker":
        from tools.copilot_adapter import main as worker
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        return worker()
    if mode == "--orbis-desktop-supervisor":
        from tools.desktop_runtime import supervise
        return supervise(sys.argv[2:])
    if mode == "--orbis-rebuild-graph":
        from tools import build_data_js
        build_data_js.ROOT = Path.cwd()
        build_data_js.GRAPH_JSON = Path.cwd() / "data/graph.json"
        build_data_js.GRAPH_JS = Path.cwd() / "data/graph.js"
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        return build_data_js.main()
    from tools.serve import main as server
    supervised = mode == "--orbis-desktop-server"
    if supervised:
        sys.argv = [sys.argv[0], *sys.argv[2:]]
    server(parent_pipe=supervised)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
