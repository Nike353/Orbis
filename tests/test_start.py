import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts import start
from tools.branding import env_setting
import fcntl
import os


class LauncherTests(unittest.TestCase):
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
            with (old / ".server.lock").open("a") as lock, patch.object(start, "default_workspace", return_value=new):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
