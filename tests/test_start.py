import tempfile
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts import start
from tools.branding import env_setting
from tools.file_lock import lock_file
from tools.workspace import lock_workspace
import os


class LauncherTests(unittest.TestCase):
    def test_windows_default_library_uses_local_application_data(self):
        with patch.object(start.sys, "platform", "win32"), patch.dict(os.environ, {"LOCALAPPDATA": str(Path.home() / "local-data")}):
            self.assertEqual(start.default_workspace(), Path.home() / "local-data/Orbis/default")
        with patch.object(start.sys, "platform", "win32"), patch.dict(os.environ, {"LOCALAPPDATA": ""}):
            self.assertEqual(start.default_workspace(), Path.home() / "AppData/Local/Orbis/default")

    def test_unix_default_library_locations_are_unchanged(self):
        with patch.object(start.sys, "platform", "darwin"):
            self.assertEqual(start.default_workspace(), Path.home() / "Library/Application Support/Orbis/default")
        with patch.object(start.sys, "platform", "linux"), patch.dict(os.environ, {"XDG_DATA_HOME": str(Path.home() / "xdg")}):
            self.assertEqual(start.default_workspace(), Path.home() / "xdg/Orbis/default")

    def test_windows_build_uses_managed_node_and_npm_without_a_shell(self):
        with tempfile.TemporaryDirectory(prefix="orbis setup ") as directory, patch.object(start, "APP", Path(directory)), patch.object(start.sys, "platform", "win32"), patch.object(start.subprocess, "run") as run:
            root = Path(directory)
            (root / "src").mkdir()
            binaries = root / ".orbis" / f"node-{start.NODE_VERSION}" / "Scripts"
            (binaries / "node_modules/npm/bin").mkdir(parents=True)
            (binaries / "node.exe").touch()
            (binaries / "node_modules/npm/bin/npm-cli.js").touch()
            start.prepare_frontend()
            self.assertEqual(run.call_count, 2)
            command = [str(binaries / "node.exe"), str(binaries / "node_modules/npm/bin/npm-cli.js")]
            self.assertEqual(run.call_args_list[0].args[0], [*command, "ci", "--no-audit", "--no-fund"])
            self.assertEqual(run.call_args_list[1].args[0], [*command, "run", "build"])
            self.assertEqual(run.call_args.kwargs["env"]["PATH"].split(os.pathsep)[0], str(binaries))

    def test_workspace_lock_is_exclusive_across_processes_and_released_by_close(self):
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, "-c",
                       "import sys; from tools.workspace import lock_workspace; lock = lock_workspace(sys.argv[1]); lock.close()",
                       directory]
            with lock_workspace(directory):
                refused = subprocess.run(command, cwd=start.APP, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn("already open", refused.stderr)
            reopened = subprocess.run(command, cwd=start.APP, capture_output=True, text=True, timeout=15)
            self.assertEqual(reopened.returncode, 0, reopened.stderr)

    def test_windows_server_uses_current_python_and_propagates_exit_status(self):
        library = start.APP / "test library"
        with patch.object(start.sys, "platform", "win32"), patch.object(start.sys, "argv", ["start.py", "--workspace", str(library), "--port", "8765"]), patch.object(start, "prepare_frontend"), patch.object(start.subprocess, "call", return_value=7) as call, patch.object(start.os, "execv") as execv:
            with self.assertRaises(SystemExit) as stopped:
                start.main()
            self.assertEqual(stopped.exception.code, 7)
            self.assertEqual(call.call_args.args[0], [
                sys.executable, "-u", str(start.APP / "tools/serve.py"),
                "--workspace", str(library), "--port", "8765"])
            execv.assert_not_called()

    def test_concurrent_frontend_setup_waits_for_the_live_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dist").mkdir()
            (root / "dist/index.html").write_text("ready")
            (root / ".orbis").mkdir()
            lock = lock_file(root / ".orbis/setup.lock")
            command = [sys.executable, "-u", "-c",
                       "import sys; from pathlib import Path; from scripts import start; "
                       "start.APP = Path(sys.argv[1]); print('waiting'); start.prepare_frontend(); print('ready')",
                       directory]
            proc = subprocess.Popen(command, cwd=start.APP, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(proc.stdout.readline().strip(), "waiting")
                with self.assertRaises(subprocess.TimeoutExpired):
                    proc.communicate(timeout=0.3)
                lock.close()
                stdout, stderr = proc.communicate(timeout=15)
                self.assertEqual(proc.returncode, 0, stderr)
                self.assertIn("ready", stdout)
            finally:
                lock.close()
                if proc.poll() is None:
                    proc.kill()
                proc.communicate()

    def test_previous_default_library_is_copied_and_never_overwrites_new_work(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            old = base / "LitBench/default"
            old.mkdir(parents=True)
            (old / "notes.md").write_text("private notes")
            new = base / "Orbis/default"
            with patch.object(start, "default_workspace", return_value=new):
                self.assertEqual(start.migrate_default_workspace(), new)
                self.assertEqual((new / "notes.md").read_text(), "private notes")
                self.assertEqual((old / "notes.md").read_text(), "private notes")
                (new / "notes.md").write_text("later edit")
                start.migrate_default_workspace()
                self.assertEqual((new / "notes.md").read_text(), "later edit")

    def test_running_previous_library_blocks_the_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            old = base / "LitBench/default"
            old.mkdir(parents=True)
            new = base / "Orbis/default"
            with lock_file(old / ".server.lock", blocking=False), patch.object(start, "default_workspace", return_value=new):
                with self.assertRaisesRegex(SystemExit, "Close the previous"):
                    start.migrate_default_workspace()
                self.assertFalse(new.exists())

    def test_new_agent_settings_take_precedence_without_breaking_existing_setup(self):
        with patch.dict(os.environ, {"LITBENCH_CODEX": "previous-cli"}, clear=True):
            self.assertEqual(env_setting("CODEX"), "previous-cli")
            os.environ["ORBIS_CODEX"] = "new-cli"
            self.assertEqual(env_setting("CODEX"), "new-cli")

    def test_source_changes_invalidate_cached_frontend(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(start, "APP", Path(directory)):
            source = Path(directory) / "src"
            source.mkdir()
            (source / "app.ts").write_text("first version")
            before = start.source_digest()
            (source / "app.ts").write_text("updated version")
            self.assertNotEqual(before, start.source_digest())

    def test_runtime_archive_starts_without_installing_node(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(start, "APP", Path(directory)), patch.object(start.subprocess, "run") as run:
            dist = Path(directory) / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("ready")
            start.prepare_frontend()
            run.assert_not_called()

    def test_repeat_start_reuses_matching_build(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(start, "APP", Path(directory)), patch.object(start.subprocess, "run") as run:
            root = Path(directory)
            for name in ["dist", "src", ".orbis"]:
                (root / name).mkdir()
            (root / "dist/index.html").write_text("ready")
            (root / ".orbis/frontend.sha256").write_text(start.source_digest())
            start.prepare_frontend()
            run.assert_not_called()
