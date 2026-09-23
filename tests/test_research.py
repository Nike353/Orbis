import copy
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.agent_bridge import atomic_write_graph, atomic_write_json
from tools.research import (RESEARCH_SCHEMA, ResearchError, ResearchStore, build_context, graph_changes,
                            paper_note, research_command, validate_result)
from tools.workspace import initialize_workspace, lock_workspace

APP = Path(__file__).resolve().parent.parent


def graph_fixture():
    graph = {"meta": {"schema_version": 2, "title": "Test library", "revision": 0,
                      "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
    graph["nodes"].append({"id": "cluster:test", "type": "cluster", "label": "Test cluster", "status": "accepted", "origin": "user"})
    for suffix in ("a", "b"):
        graph["nodes"].append({"id": "paper:" + suffix, "type": "paper", "label": "Paper " + suffix,
            "cluster": "cluster:test", "status": "accepted", "origin": "user",
            "paper": {"title": "Paper " + suffix, "authors": ["Example"], "year": 2025,
                      "venue": "Test", "url": "https://example.org/" + suffix,
                      "summary": "Fixture contribution", "key_findings": ["Fixture finding"]}})
    return graph


class ResearchTests(unittest.TestCase):
    def test_strict_schema_declares_types_and_closes_objects(self):
        def check(schema):
            if isinstance(schema, dict):
                if 'const' in schema or 'enum' in schema:
                    self.assertIn('type', schema)
                if schema.get('type') == 'object':
                    self.assertFalse(schema['additionalProperties'])
                    self.assertEqual(set(schema['required']), set(schema['properties']))
                for value in schema.values():
                    check(value)
            elif isinstance(schema, list):
                for value in schema:
                    check(value)
        check(RESEARCH_SCHEMA)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        initialize_workspace(self.root)
        self.graph = graph_fixture()
        atomic_write_graph(self.root, self.graph)
        self.store = ResearchStore(self.root, threading.Lock(), threading.Lock(), APP)
        command = f'"{sys.executable}" "{APP / "tests/fixtures/research_agent.py"}"'
        self.env = patch.dict(os.environ, {"LITBENCH_CODEX": command, "LITBENCH_CLAUDE": command})
        self.env.start()

    def tearDown(self):
        for event in list(self.store.active.values()):
            event.set()
        if self.store.run_lock.acquire(timeout=5):
            self.store.run_lock.release()
        self.env.stop()
        self.temp.cleanup()

    def session(self, criteria=None):
        return self.store.create({"title": "Research", "scope_ids": ["paper:a", "paper:b"], "criteria": criteria or []})

    def run_turn(self, session, question="Explain", agent="codex"):
        turn = self.store.start(session["id"], {"question": question, "agent": agent, "base_revision": self.store.graph()["meta"]["revision"]})
        self.assertTrue(self.store.run_lock.acquire(timeout=10), "worker did not stop")
        self.store.run_lock.release()
        return self.store.find(self.store.read(), session["id"], turn["id"])[1]

    def test_both_cli_protocols_persist_complete_comparisons_without_changing_graph(self):
        for agent in ("codex", "claude"):
            session = self.session(["Input", "Custom criterion"])
            turn = self.run_turn(session, agent=agent)
            self.assertEqual(turn["status"], "completed", turn)
            self.assertEqual(len(turn["result"]["cells"]), 4)
            self.assertEqual(self.store.graph(), self.graph)
            reopened = ResearchStore(self.root, threading.Lock(), threading.Lock(), APP)
            self.assertEqual(reopened.find(reopened.read(), session["id"])["turns"][0], turn)

    def test_proposals_preserve_ids_until_explicit_acceptance_and_reject_stale_base(self):
        session = self.session()
        turn = self.run_turn(session, "TEST_RENAME")
        self.assertEqual(self.store.graph(), self.graph)
        self.store.decision(session["id"], turn["id"], {"action": "apply", "base_revision": 0})
        after = self.store.graph()
        self.assertEqual(after["nodes"][1]["id"], "paper:a")
        self.assertEqual(after["nodes"][1]["label"], "Reviewed cluster")
        self.assertEqual(after["meta"]["revision"], 1)
        stale = self.run_turn(session, "TEST_RENAME")
        modified = copy.deepcopy(after)
        modified["meta"]["revision"] = 2
        atomic_write_graph(self.root, modified)
        with self.assertRaisesRegex(ResearchError, "stale"):
            self.store.decision(session["id"], stale["id"], {"action": "apply", "base_revision": 2})

    def test_selected_run_settings_are_persisted_and_invalid_settings_do_not_start(self):
        session = self.session()
        settings = {'model': 'gpt-5.6-sol', 'effort': 'medium'}
        turn = self.store.start(session['id'], {'question': 'Explain', 'agent': 'codex',
            'settings': settings, 'base_revision': 0})
        self.assertTrue(self.store.run_lock.acquire(timeout=10))
        self.store.run_lock.release()
        stored = self.store.find(self.store.read(), session['id'], turn['id'])[1]
        self.assertEqual(stored['settings'], settings)
        before = self.store.read()
        with self.assertRaises(ResearchError):
            self.store.start(session['id'], {'question': 'Explain', 'agent': 'codex',
                'settings': {'effort': 'invalid'}, 'base_revision': 0})
        self.assertEqual(self.store.read(), before)
        self.assertFalse(self.store.run_lock.locked())

    def test_saved_note_is_editable_content_without_conversation_boilerplate(self):
        session = self.session()
        turn = self.run_turn(session)
        text = "## My conclusion\n\nThe loss is $L = x^2$."
        self.store.decision(session["id"], turn["id"], {
            "action": "save_note", "node_id": "paper:a", "base_revision": 0, "text": text})
        node = next(n for n in self.store.graph()["nodes"] if n["id"] == "paper:a")
        self.assertEqual(node["notes"], text)
        self.assertNotIn("Conversation:", node["notes"])
        stored = self.store.find(self.store.read(), session["id"])["turns"][-1]
        self.assertTrue(stored["note_saves"][0]["citations"])

    def test_note_saving_is_idempotent_and_survives_crash_between_graph_and_history(self):
        session = self.session()
        turn = self.run_turn(session)
        real_write = atomic_write_json
        def fail_history(path, value):
            if path == self.store.path:
                raise OSError("simulated power failure")
            real_write(path, value)
        body = {"action": "save_note", "node_id": "paper:a", "base_revision": 0}
        with patch("tools.research.atomic_write_json", side_effect=fail_history):
            with self.assertRaises(OSError):
                self.store.decision(session["id"], turn["id"], body)
        self.assertTrue(self.store.journal.exists())
        with self.assertRaisesRegex(ResearchError, 'needs recovery'):
            self.store.create({'title': 'Must not overwrite recovery state'})
        self.store.recover()
        saved = self.store.graph()
        self.store.decision(session["id"], turn["id"], {**body, "base_revision": 1})
        self.assertEqual(self.store.graph(), saved)
        self.assertEqual(saved["nodes"][1]["notes"].count("The library describes"), 1)
        self.assertFalse(self.store.journal.exists())

    def test_cancel_and_failure_release_single_run_slot_and_never_apply_changes(self):
        session = self.session()
        turn = self.store.start(session["id"], {"question": "TEST_WAIT", "agent": "codex", "base_revision": 0})
        with self.assertRaisesRegex(ResearchError, "Another agent"):
            self.store.start(session["id"], {"question": "Explain", "agent": "claude", "base_revision": 0})
        self.store.cancel(turn["id"])
        self.assertTrue(self.store.run_lock.acquire(timeout=5))
        self.store.run_lock.release()
        self.assertEqual(self.store.find(self.store.read(), session["id"], turn["id"])[1]["status"], "cancelled")
        for question in ("TEST_FAIL", "TEST_INVALID"):
            self.assertEqual(self.run_turn(session, question)["status"], "failed")
        self.assertEqual(self.store.graph(), self.graph)

    def test_restart_marks_only_unfinished_answers_interrupted(self):
        session = self.session()
        completed = self.run_turn(session)
        state = self.store.read()
        state["sessions"][0]["turns"].append({"id": "interrupted", "status": "running"})
        atomic_write_json(self.store.path, state)
        self.store.recover()
        turns = self.store.read()["sessions"][0]["turns"]
        self.assertEqual(turns[0], completed)
        self.assertEqual(turns[1]["status"], "interrupted")

    def test_change_contract_rejects_unknown_fields_invalid_references_and_duplicates(self):
        valid = {"action": "connect", "source_id": "paper:a", "target_id": "cluster:test", "relation": "belongs_to", "confidence": 0.8, "evidence": "Section 2", "reason": "Shared problem"}
        for changed in ({**valid, "confidence": True}, {**valid, "target_id": "missing"}, {**valid, "origin": "user"}):
            with self.assertRaises(ResearchError):
                graph_changes(self.graph, [changed])
        result, _ = graph_changes(self.graph, [valid])
        with self.assertRaisesRegex(ResearchError, "already exists"):
            graph_changes(result, [valid])
        self.assertEqual(len(self.graph["edges"]), 0)

    def test_create_move_note_bundle_validates_final_graph_and_rejects_nested_clusters(self):
        changes = [{"action": "create", "node_id": "cluster:new", "node_type": "cluster", "label": "New", "description": "A different problem", "cluster_id": "", "reason": "User taxonomy"},
                   {"action": "move", "node_id": "paper:a", "cluster_id": "cluster:new", "reason": "Closer fit"},
                   {"action": "note", "node_id": "paper:a", "text": "New insight", "reason": "Preserve insight"}]
        result, preview = graph_changes(self.graph, changes)
        self.assertEqual(result["nodes"][1]["cluster"], "cluster:new")
        self.assertEqual(len(preview), 3)
        with self.assertRaises(ResearchError):
            graph_changes(self.graph, [{**changes[1], "node_id": "cluster:test"}])

    def test_comparison_requires_exact_grid_and_real_citations(self):
        session = self.session(["Input"])
        turn = self.run_turn(session)
        result = turn["result"]
        for cells in (result["cells"][:1], result["cells"] * 2):
            with self.assertRaises(ResearchError):
                validate_result({**result, "cells": cells}, self.graph, session)
        with self.assertRaises(ResearchError):
            self.store.create({"title": "Invalid", "scope_ids": ["cluster:test", "paper:a"], "criteria": ["Input"]})

    def test_context_is_bounded_and_note_paths_cannot_escape_papers(self):
        session = self.session()
        session["turns"] = [{"question": "Q", "status": "completed", "result": {"answer": "A" * 20000}} for _ in range(30)]
        context = build_context(self.root, self.graph, session)
        self.assertEqual(len(context["history"]), 8)
        self.assertEqual(len(context["history"][0]["answer"]), 4000)
        private = self.root / "private.txt"
        private.write_text("secret")
        self.assertEqual(paper_note(self.root, {"notes_file": "private.txt"}), "")
        (self.root / "papers/link.md").symlink_to(private)
        self.assertEqual(paper_note(self.root, {"notes_file": "papers/link.md"}), "")

    def test_archive_delete_and_new_workspace_never_import_personal_data(self):
        session = self.session()
        self.store.manage(session["id"], {"action": "archive"})
        with self.assertRaises(ResearchError):
            self.store.start(session["id"], {"question": "Explain", "agent": "codex", "base_revision": 0})
        self.store.manage(session["id"], {"action": "delete"})
        self.assertEqual(self.store.read()["sessions"], [])
        other = self.root / "another-person"
        initialize_workspace(other)
        self.assertEqual(json.loads((other / "data/graph.json").read_text())["nodes"], [])
        handle = lock_workspace(other)
        with self.assertRaises(SystemExit):
            lock_workspace(other)
        handle.close()

    def test_cli_commands_use_temporary_sessions_and_constrained_modes(self):
        codex = research_command("codex", self.root)
        claude = research_command("claude", self.root)
        self.assertIn("--ephemeral", codex)
        self.assertIn("read-only", codex)
        self.assertIn("--no-session-persistence", claude)
        self.assertEqual(claude[claude.index("--tools") + 1], "")
