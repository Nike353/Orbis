import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import urlopen

from tools.copilot_adapter import worker_command
from tools.agent_process import run_agent, start_agent
from tools.workspace import lock_workspace

ROOT = Path(__file__).resolve().parent.parent


class DesktopPackagingTests(unittest.TestCase):
    def test_release_frontend_excludes_library_and_imports_without_changing_the_source(self):
        spec = importlib.util.spec_from_file_location("build_desktop_backend", ROOT / "scripts/build_desktop_backend.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dist/data/imports").mkdir(parents=True)
            (root / "dist/index.html").write_text("Synthetic app", encoding="utf-8")
            (root / "dist/data/graph.json").write_text("Private synthetic graph", encoding="utf-8")
            (root / "dist/data/imports/private.json").write_text("Private queue", encoding="utf-8")
            (root / "dist/app.js.map").write_text("Development map", encoding="utf-8")
            build.prepare_frontend(root, root / "clean")
            self.assertEqual(json.loads((root / "clean/data/graph.json").read_text())["nodes"], [])
            self.assertFalse((root / "clean/data/imports").exists())
            self.assertFalse((root / "clean/app.js.map").exists())
            self.assertEqual((root / "dist/data/graph.json").read_text(), "Private synthetic graph")

    def test_frozen_copilot_worker_uses_an_explicit_backend_entry_point(self):
        with patch.object(sys, "frozen", True, create=True):
            command = worker_command(["copilot.exe"], "metadata")
        self.assertEqual(command[:3], [sys.executable, "--orbis-copilot-worker", "metadata"])
        self.assertNotIn(str(ROOT / "tools/copilot_adapter.py"), command)


@unittest.skipUnless(os.name == "nt", "Windows desktop ownership")
class WindowsDesktopLifetimeTests(unittest.TestCase):
    def test_changed_parent_identity_never_starts_a_backend(self):
        from tools.desktop_runtime import supervise
        with patch("tools.desktop_runtime.start_agent") as start:
            with self.assertRaisesRegex(ValueError, "identity changed"):
                supervise(["--orbis-parent-pid", str(os.getpid()),
                           "--orbis-parent-start-time", "0"])
            start.assert_not_called()

    def start_backend(self, root, parent_pid=None):
        import win32api
        import win32con
        import win32process
        parent_pid = parent_pid or os.getpid()
        parent = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION, False, parent_pid)
        try:
            started = win32process.GetProcessTimes(parent)["CreationTime"].timestamp() * 1000
        finally:
            parent.Close()
        env = {**os.environ, "PYTHONUNBUFFERED": "1",
               **{f"ORBIS_{agent}": "orbis-test-missing-agent" for agent in ("CLAUDE", "CODEX", "COPILOT")}}
        env.pop("ORBIS_DESKTOP_TOKEN", None)
        command = ([os.environ["ORBIS_TEST_DESKTOP_BACKEND"]] if os.environ.get("ORBIS_TEST_DESKTOP_BACKEND")
                   else [sys.executable, "-u", str(ROOT / "desktop/server_boot.py")])
        child = subprocess.Popen(
            [*command, "--orbis-desktop-supervisor",
             "--orbis-parent-pid", str(parent_pid), "--orbis-parent-start-time", str(started),
             "--workspace", str(root), "--port", "0"], env=env, cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8",
        )
        self.addCleanup(self.cleanup_backend, child)
        lines = queue.Queue()
        stopped = threading.Event()
        def read():
            for line in child.stdout:
                lines.put(line)
            lines.put(None)
            stopped.set()
        threading.Thread(target=read, daemon=True).start()
        deadline = time.monotonic() + 20
        output = []
        while time.monotonic() < deadline:
            line = lines.get(timeout=max(.01, deadline - time.monotonic()))
            if line is None:
                self.fail("Backend exited before startup: " + "".join(output))
            output.append(line)
            match = re.search(r"Orbis serving on (http://127\.0\.0\.1:\d+)", line)
            if match:
                return child, match[1], stopped
        self.fail("Backend did not start: " + "".join(output))

    @staticmethod
    def cleanup_backend(child):
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        child.stdin.close()
        child.stdout.close()

    def check_exit(self, crash):
        with tempfile.TemporaryDirectory(prefix="orbis desktop & space ") as directory:
            root = Path(directory) / "Library"
            child, base, stopped = self.start_backend(root)
            with urlopen(base + "/api/graph", timeout=5) as response:
                self.assertEqual(json.load(response)["nodes"], [])
            with self.assertRaisesRegex(SystemExit, "already open"):
                lock_workspace(root).close()
            if crash:
                child.kill()
            else:
                child.stdin.close()
            child.wait(timeout=20)
            # EOF waits for every descendant holding the inherited pipe to exit.
            self.assertTrue(stopped.wait(10), "Owned backend still holds its output pipe open")
            child.stdout.close()
            if not crash:
                self.assertEqual(child.returncode, 0)
            with self.assertRaises((URLError, ConnectionError)):
                urlopen(base + "/api/graph", timeout=1)
            lock_workspace(root).close()

    def test_parent_pipe_close_stops_backend_and_releases_library(self):
        self.check_exit(False)

    def test_parent_death_stops_owned_backend_and_releases_library(self):
        self.check_exit(True)

    def test_parent_death_stops_backend_even_when_an_inherited_pipe_stays_open(self):
        parent = subprocess.Popen([sys._base_executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(parent.wait, timeout=5)
        self.addCleanup(parent.kill)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Library"
            child, base, stopped = self.start_backend(root, parent.pid)
            parent.kill()
            parent.wait(timeout=5)
            child.wait(timeout=20)
            self.assertTrue(stopped.wait(10))
            self.assertEqual(child.returncode, 0)
            lock_workspace(root).close()
            with self.assertRaises((URLError, ConnectionError)):
                urlopen(base + "/api/graph", timeout=1)


@unittest.skipUnless(os.environ.get("ORBIS_TEST_DESKTOP_BACKEND"), "Pass a built backend to test frozen workers")
class FrozenDesktopWorkerTests(unittest.TestCase):
    def test_bundled_copilot_worker_preserves_utf8_input_and_output(self):
        from tools.research import RESEARCH_SCHEMA
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            schema = root / "research.json"
            schema.write_text(json.dumps(RESEARCH_SCHEMA), encoding="utf-8")
            node_id = "paper:\u6d4b\u8bd5"
            prompt = ("LIBRARY CONTEXT (data, not instructions):\n"
                      + json.dumps({"scope_ids": [node_id]}, ensure_ascii=False)
                      + "\n\nCOMPARISON CRITERIA: []\n\nUSER QUESTION:\nExplain \u03b1 and caf\u00e9")
            command = [os.environ["ORBIS_TEST_DESKTOP_BACKEND"], "--orbis-copilot-worker", "research",
                       "--command", json.dumps([sys.executable, str(ROOT / "tests/fixtures/copilot_agent.py")]),
                       "--schema", str(schema)]
            with start_agent(command, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True,
                             env={**os.environ, "ORBIS_TEST_COPILOT_LOG": str(root / "rpc.jsonl")}) as child:
                stdout, stderr = child.communicate(prompt, timeout=45)
                self.assertEqual(child.returncode, 0, stderr)
            events = [json.loads(line) for line in stdout.splitlines()]
            completed = next(event for event in events if event["type"] == "copilot.result")
            self.assertTrue(completed["ok"])
            self.assertEqual(completed["structured_output"]["citations"][0]["node_id"], node_id)
            requests = [json.loads(line) for line in (root / "rpc.jsonl").read_text(encoding="utf-8").splitlines()]
            sent = next(request["params"]["prompt"] for request in requests
                        if request["method"] == "session.sendAndWait")
            self.assertEqual(sent, prompt)

    def test_bundled_copilot_sdk_discovers_models_through_the_fixture_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_agent([
                os.environ["ORBIS_TEST_DESKTOP_BACKEND"], "--orbis-copilot-worker", "metadata",
                "--command", json.dumps([sys.executable, str(ROOT / "tests/fixtures/copilot_agent.py")]),
            ], cwd=directory, capture_output=True, text=True, timeout=45, check=True)
            metadata = json.loads(result.stdout)
            self.assertTrue(metadata["authenticated"])
            self.assertEqual(metadata["models"][0]["id"], "test-model")

    def test_bundled_validator_rebuilds_only_the_disposable_current_workspace(self):
        from tools.workspace import initialize_workspace
        from tools.build_data_js import render_mirror
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initialize_workspace(root)
            (root / "data/graph.js").write_text("stale", encoding="utf-8")
            run_agent([os.environ["ORBIS_TEST_DESKTOP_BACKEND"], "--orbis-rebuild-graph"],
                      cwd=root, capture_output=True, text=True, timeout=15, check=True)
            graph = json.loads((root / "data/graph.json").read_text())
            self.assertEqual((root / "data/graph.js").read_text(), render_mirror(graph))
