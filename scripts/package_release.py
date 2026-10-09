#!/usr/bin/env python3
"""Export distributable source/runtime without personal libraries or git history."""
import argparse
import json
import sys
import zipfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP / "tools"))
from build_data_js import render_mirror  # noqa: E402

ROOT_FILES = ["start.sh", "pyproject.toml", "uv.lock", "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md",
              "package.json", "package-lock.json", "index.html", "vite.config.ts",
              "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "eslint.config.js",
              "playwright.config.ts", ".gitignore", ".prettierignore", ".prettierrc.json"]


def package(output, runtime=False):
    folders = ["tools", "prompts", "docs", "scripts"]
    if runtime:
        if not (APP / "dist/index.html").exists():
            raise SystemExit("Run npm run build before packaging the runtime.")
        folders.append("dist")
    else:
        folders.extend(["src", "tests", ".github", "desktop"])
    paths = [APP / name for name in ROOT_FILES if (APP / name).exists()]
    for folder in folders:
        paths.extend(p for p in (APP / folder).rglob("*") if p.is_file()
                     and "__pycache__" not in p.parts and p.suffix not in (".pyc", ".map")
                     and not p.relative_to(APP).as_posix().startswith("dist/data/")
                     and (folder != "desktop" or p.suffix in (".mjs", ".cjs", ".py"))
                     and not p.is_symlink())
    graph = {"meta": {"schema_version": 2, "title": "My paper universe", "revision": 0,
                      "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(set(paths)):
            archive.write(path, "orbis/" + path.relative_to(APP).as_posix())
        archive.writestr("orbis/data/graph.json", json.dumps(graph, indent=2) + "\n")
        archive.writestr("orbis/data/graph.js", render_mirror(graph))
        archive.writestr("orbis/papers/.gitkeep", "")
    print(f"Created {output} ({output.stat().st_size:,} bytes). Personal data and git history are excluded.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=APP / "release/orbis-source.zip")
    parser.add_argument("--runtime", action="store_true")
    args = parser.parse_args()
    package(args.output, args.runtime)
