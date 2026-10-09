"""Build on the target OS/architecture; bundle Python, never a personal library."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
graph = json.loads((root / "data/graph.json").read_text())
if graph["nodes"] or graph["edges"]:
    raise SystemExit("Build desktop releases from an empty-library application checkout.")
subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--name", "orbis-server",
    "--distpath", str(root / "build/desktop-backend"), "--workpath", str(root / "build/pyinstaller"),
    "--specpath", str(root / "build"), "--paths", str(root), "--collect-submodules", "tools",
    "--add-data", f"{root / 'tools'}:tools", "--add-data", f"{root / 'prompts'}:prompts",
    "--add-data", f"{root / 'docs/SCHEMA.md'}:docs", "--add-data", f"{root / 'dist'}:dist",
    str(root / "desktop/server_boot.py")], check=True, cwd=root)
