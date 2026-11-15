#!/usr/bin/env python3
"""Prepare and start Orbis through start.sh or start.ps1 and uv."""
import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

import portalocker

APP = Path(__file__).resolve().parent.parent
NODE_VERSION = "22.23.2"
sys.path.insert(0, str(APP))
from tools.branding import env_setting
from tools.file_lock import lock_file


def default_workspace():
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "Orbis/default"


def migrate_default_workspace():
    target = default_workspace()
    previous = target.parent.parent / "LitBench/default"
    if target.exists() or not previous.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock = lock_file(previous / ".server.lock", blocking=False)
    except portalocker.AlreadyLocked as error:
        raise SystemExit("Close the previous Orbis server before upgrading your library.") from error
    with lock:
        with tempfile.TemporaryDirectory(prefix=".library-upgrade-", dir=target.parent) as staging:
            copied = Path(staging) / "default"
            shutil.copytree(previous, copied, ignore=shutil.ignore_patterns(".server.lock"))
            copied.rename(target)
    return target


def source_digest():
    paths = [APP / name for name in ("package.json", "package-lock.json", "index.html", "vite.config.ts", "scripts/copy-static.mjs")]
    paths += sorted((APP / "src").rglob("*"))
    digest = hashlib.sha256()
    for path in paths:
        if path.is_file():
            digest.update(str(path.relative_to(APP)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def npm_command(node_home):
    if sys.platform == "win32":
        binaries = node_home / "Scripts"
        # Run the CLI directly rather than passing paths through cmd.exe.
        return [str(binaries / "node.exe"), str(binaries / "node_modules/npm/bin/npm-cli.js")]
    return [str(node_home / "bin/npm")]


def prepare_frontend(force=False):
    cache = APP / ".orbis"
    previous = APP / ".litbench"
    if not cache.exists() and previous.is_dir():
        previous.rename(cache)
    cache.mkdir(exist_ok=True)
    # Serialize setup so simultaneous starts cannot damage shared dependencies.
    with lock_file(cache / "setup.lock"):
        built = (APP / "dist/index.html").is_file()
        if not (APP / "src").is_dir():
            if built and not force:
                return
            raise SystemExit("This runtime archive has no frontend source. Download the source to rebuild it.")
        digest = source_digest()
        stamp = cache / "frontend.sha256"
        if built and not force and stamp.exists() and stamp.read_text() == digest:
            return
        node_home = cache / f"node-{NODE_VERSION}"
        npm = npm_command(node_home)
        if not all(Path(part).is_file() for part in npm):
            print("Setting up the frontend build tools (one time)…", flush=True)
            with tempfile.TemporaryDirectory(dir=cache, prefix="node-setup-") as temporary:
                target = Path(temporary) / "node"
                subprocess.run([sys.executable, "-m", "nodeenv", "--prebuilt",
                                f"--node={NODE_VERSION}", str(target)], check=True)
                target.rename(node_home)
        env = dict(os.environ)
        binaries = node_home / ("Scripts" if sys.platform == "win32" else "bin")
        env["PATH"] = str(binaries) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
        print("Building Orbis. First launch may take a few minutes…", flush=True)
        subprocess.run([*npm, "ci", "--no-audit", "--no-fund"], cwd=APP, env=env, check=True)
        subprocess.run([*npm, "run", "build"], cwd=APP, env=env, check=True)
        stamp.write_text(digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--port", type=int, help="Use a specific port (otherwise choose an available port starting at 8000)")
    parser.add_argument("--build", action="store_true", help="Force a frontend rebuild")
    parser.add_argument("--doctor", action="store_true", help="Show setup information without starting")
    parser.add_argument("--prepare-only", action="store_true", help="Set up dependencies and frontend without starting")
    args = parser.parse_args()
    launcher = ".\\start.ps1" if sys.platform == "win32" else "./start.sh"
    if args.workspace is None:
        args.workspace = default_workspace() if args.doctor or args.prepare_only else migrate_default_workspace()
    print(f"Orbis · Python {sys.version.split()[0]}", flush=True)
    print(f"Library: {args.workspace.expanduser().resolve()}", flush=True)
    if sys.platform == "win32":
        print("Windows browser mode. For the desktop preview, see docs/DESKTOP.md.", flush=True)
    if args.doctor:
        for name in ("codex", "claude", "copilot"):
            print(f"{name}: {env_setting(name.upper()) or shutil.which(name) or 'not installed (optional)'}")
        print(f"Run {launcher} to set up and launch. AI features need one signed-in agent CLI.")
        return
    try:
        prepare_frontend(args.build)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Setup could not finish (exit {error.returncode}). Check your connection and retry {launcher}.") from error
    if args.prepare_only:
        print("Orbis is ready.")
        return
    command = [sys.executable, "-u", str(APP / "tools/serve.py"), "--workspace", str(args.workspace)]
    if args.port is not None:
        command += ["--port", str(args.port)]
    if sys.platform == "win32":
        try:
            raise SystemExit(subprocess.call(command))
        except KeyboardInterrupt:
            raise SystemExit(130)
    os.execv(sys.executable, command)


if __name__ == "__main__":
    main()
