"""Bundle the backend on the target OS without packaging a personal library."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def prepare_frontend(root, destination):
    source = root / "dist"
    if not (source / "index.html").is_file():
        raise ValueError("Run npm run build before packaging the backend.")
    shutil.copytree(source, destination, ignore=lambda directory, names:
                    [name for name in names if name.endswith(".map")
                     or (Path(directory) == source and name == "data")])
    graph = {"meta": {"schema_version": 2, "title": "My paper universe", "revision": 0,
                      "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
    from tools.build_data_js import render_mirror
    (destination / "data").mkdir()
    (destination / "data" / "graph.json").write_text(json.dumps(graph), encoding="utf-8")
    (destination / "data" / "graph.js").write_text(render_mirror(graph), encoding="utf-8")


def main():
    sys.path.insert(0, str(ROOT))
    with tempfile.TemporaryDirectory(prefix="orbis-desktop-assets-") as directory:
        frontend = Path(directory) / "dist"
        prepare_frontend(ROOT, frontend)
        command = [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--name", "orbis-server",
            "--distpath", str(ROOT / "build" / "desktop-backend"),
            "--workpath", str(ROOT / "build" / "pyinstaller"), "--specpath", str(ROOT / "build"),
            "--paths", str(ROOT), "--collect-submodules", "tools",
            "--collect-submodules", "copilot", "--copy-metadata", "github-copilot-sdk",
        ]
        if sys.platform == "win32":
            command += ["--hidden-import", "win32timezone"]
        for source, target in [(ROOT / "tools", "tools"), (ROOT / "prompts", "prompts"),
                               (ROOT / "docs" / "SCHEMA.md", "docs"), (frontend, "dist")]:
            command += ["--add-data", f"{source}{';' if sys.platform == 'win32' else ':'}{target}"]
        subprocess.run([*command, str(ROOT / "desktop" / "server_boot.py")], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
