import copy
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.agent_bridge import atomic_write_graph
from tools.documents import DocumentStore
from tools.research import ResearchError, ResearchStore, build_context, validate_result, parse_output, context_budget
from tools.workspace import initialize_workspace
from fixtures.reader_pdf import PAGES, pdf_bytes
from test_research import graph_fixture

APP = Path(__file__).resolve().parent.parent


class OriginalResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        initialize_workspace(self.root)
        self.graph = graph_fixture()
        atomic_write_graph(self.root, self.graph)
        self.documents = DocumentStore(self.root)
        self.document = self.documents.attach("paper:a", pdf_bytes())
        self.store = ResearchStore(self.root, threading.Lock(), threading.Lock(), APP, self.documents)
        command = f'"{sys.executable}" "{APP / "tests/fixtures/research_agent.py"}"'
        environment = patch.dict(os.environ, {"ORBIS_CODEX": command, "ORBIS_CLAUDE": command})
        environment.start()
        self.addCleanup(environment.stop)

    def session(self, comparison=False):
        return self.store.create({"title": "Read source", "scope_ids": ["paper:a", "paper:b"],
                                  "criteria": ["Method", "Results"] if comparison else []})

    def turn(self, session, question, agent="codex", selection=None):
        body = {"question": question, "agent": agent, "base_revision": self.store.graph()["meta"]["revision"]}
        if selection is not None:
            body["selection"] = selection
        turn = self.store.start(session["id"], body)
        self.assertTrue(self.store.run_lock.acquire(timeout=10))
        self.store.run_lock.release()
        return self.store.find(self.store.read(), session["id"], turn["id"])[1]

    def test_real_page_evidence_reaches_both_cli_adapters_and_persistent_answers(self):
        for agent in ("codex", "claude"):
            turn = self.turn(self.session(), "Explain benchmark accuracy", agent)
            self.assertEqual(turn["status"], "completed", turn)
            self.assertEqual(turn["result"]["source_mode"], "originals")
            citation = turn["result"]["citations"][0]
            self.assertEqual(citation["document_id"], self.document["id"])
            self.assertEqual(citation["page"], 3)
            self.assertEqual(citation["sha256"], self.document["sha256"])
            self.assertIn(citation["evidence"], self.documents.pages(self.document["id"])["pages"][2]["text"])
            self.assertEqual(turn["coverage"]["original_sources"][1]["status"], "no_original")
            self.assertEqual(self.store.graph(), self.graph)

    def test_fabricated_page_or_quote_fails_before_becoming_a_saved_answer(self):
        for question in ("TEST_BAD_SOURCE", "TEST_BAD_QUOTE"):
            turn = self.turn(self.session(), question)
            self.assertEqual(turn["status"], "failed", turn)
            self.assertNotIn("result", turn)
        self.assertEqual(self.store.graph(), self.graph)

    def test_unanswerable_question_stays_an_explicit_gap_and_comparisons_keep_full_grid(self):
        turn = self.turn(self.session(), "TEST_UNANSWERABLE: What happens on the Moon?")
        self.assertEqual(turn["status"], "completed", turn)
        self.assertIn("Not established", turn["result"]["answer"])
        comparison = self.turn(self.session(True), "Compare method and results")
        self.assertEqual(len(comparison["result"]["cells"]), 4)
        self.assertEqual(comparison["status"], "completed", comparison)

    def test_selected_text_is_source_scoped_and_supplied_with_surrounding_context(self):
        selection = {"document_id": self.document["id"], "page": 3, "text": PAGES[2][1]}
        context = build_context(self.root, self.graph, self.session(), "Explain selection",
                                self.documents, selection)
        self.assertEqual(context["originals"]["selected_text"], PAGES[2][1])
        self.assertEqual(context["originals"]["passages"][0]["page"], 3)
        self.assertIn("baseline", context["originals"]["passages"][0]["text"])
        invalid = {**selection, "text": "A fabricated passage"}
        turn = self.turn(self.session(), "Explain selection", selection=invalid)
        self.assertEqual(turn["status"], "failed")
        self.assertIn("no longer matches", turn["error"])
        other = self.store.create({"title": "Other paper", "scope_ids": ["paper:b"]})
        with self.assertRaisesRegex(ResearchError, "belong"):
            build_context(self.root, self.graph, other, "Explain", self.documents, selection)

    def test_numeric_warning_does_not_claim_semantic_verification(self):
        session = self.session()
        context = build_context(self.root, self.graph, session, "accuracy", self.documents)
        passage = context["originals"]["passages"][0]
        result = {"answer": "The system achieves 99 percent accuracy.",
                  "citations": [{"node_id": "paper:a", "passage_id": passage["id"],
                                 "evidence": passage["text"].splitlines()[0]}],
                  "changes": [], "cells": []}
        validate_result(result, self.graph, session, context)
        self.assertTrue(any("99%" in message for message in result["quality_warnings"]))
        broken = copy.deepcopy(result)
        broken.pop("source_mode")
        broken.pop("quality_warnings")
        broken["citations"] = [{"node_id": "paper:b", "passage_id": passage["id"],
                                "evidence": passage["text"].splitlines()[0]}]
        with self.assertRaises(ResearchError):
            validate_result(broken, self.graph, session, context)

    def test_selective_summary_needs_an_original_and_explicit_review_and_preserves_notes(self):
        session = self.session()
        graph = self.store.graph()
        graph["nodes"][1].update(notes="Keep my personal note.", origin="agent", status="proposed")
        atomic_write_graph(self.root, graph)
        before = copy.deepcopy(self.store.graph())
        turn = self.turn(session, "TEST_SUMMARY")
        self.assertEqual(turn["status"], "completed", turn)
        self.assertEqual(turn["proposal_status"], "pending")
        self.assertEqual(self.store.graph(), before)
        self.store.decision(session["id"], turn["id"], {"action": "apply", "base_revision": 0})
        after = self.store.graph()
        paper_before = next(n for n in before["nodes"] if n["id"] == "paper:a")
        paper_after = next(n for n in after["nodes"] if n["id"] == "paper:a")
        self.assertIn("## Motivation and problem", paper_after["paper"]["summary"])
        for field in ("notes", "origin", "status", "id"):
            self.assertEqual(paper_after.get(field), paper_before.get(field))
        self.assertEqual(next(n for n in after["nodes"] if n["id"] == "paper:b"),
                         next(n for n in before["nodes"] if n["id"] == "paper:b"))
        self.assertEqual(len(self.store.find(self.store.read(), session["id"])["turns"]), 1)
        self.assertEqual(after["edges"], before["edges"])
        unsupported = self.store.create({"title": "No original", "scope_ids": ["paper:b"], "criteria": []})
        rejected = self.turn(unsupported, "TEST_SUMMARY")
        self.assertEqual(rejected["status"], "failed")
        self.assertIn("readable original", rejected["error"])

    def test_each_comparison_cell_validates_its_own_evidence_and_numbers(self):
        session = self.session(True)
        context = build_context(self.root, self.graph, session, "accuracy", self.documents)
        passage = context["originals"]["passages"][0]
        result = {"answer": "Compare these findings.",
                  "citations": [{"node_id": "paper:a", "passage_id": passage["id"],
                                 "evidence": passage["text"].splitlines()[0]}],
                  "changes": [], "cells": [
                      {"paper_id": node, "criterion": criterion, "value": "99.9 percent accuracy.",
                       "evidence": passage["text"].splitlines()[0] if node == "paper:a" else "Library notes",
                       "passage_id": passage["id"] if node == "paper:a" else ""}
                      for node in session["scope_ids"] for criterion in session["criteria"]]}
        bad = copy.deepcopy(result)
        bad["cells"][2]["passage_id"] = passage["id"]
        with self.assertRaisesRegex(ResearchError, "not supplied"):
            validate_result(bad, self.graph, session, context)
        validate_result(result, self.graph, session, context)
        self.assertEqual(result["source_mode"], "mixed")
        self.assertEqual(result["cells"][0]["page"], 3)
        self.assertEqual(result["cells"][2]["source_mode"], "notes_only")
        self.assertTrue(any("99.9%" in message for message in result["quality_warnings"]))

    def test_large_notes_and_connections_keep_all_selected_cards_within_total_budget(self):
        for paper in self.graph["nodes"][1:]:
            paper["notes"] = "Personal note. " * 7000
            paper["description"] = "Large description. " * 30000
        self.graph["edges"] = [{"id": "e001", "source": "paper:a", "target": "paper:b",
            "relation": "extends", "transition_note": "Long relationship notes. " * 50000,
            "evidence": "Large evidence. " * 50000, "status": "accepted", "origin": "user"}]
        context = build_context(self.root, self.graph, self.session(), "accuracy", self.documents, budget=24000)
        self.assertTrue({"paper:a", "paper:b"}.issubset({n["id"] for n in context["records"]}))
        self.assertLessEqual(len(json.dumps(context, ensure_ascii=False).encode()), 24000)
        self.assertIn("82 percent", str(context["originals"]["passages"]))

    def test_adapter_ignores_malformed_events_and_hides_desktop_capability(self):
        for agent in ("codex", "claude"):
            with patch.dict(os.environ, {"ORBIS_DESKTOP_TOKEN": "synthetic-secret"}):
                turn = self.turn(self.session(), "TEST_ENV", agent)
            self.assertEqual(turn["status"], "completed", turn)
            self.assertNotIn("synthetic-secret", str(turn))
            for question in ("TEST_STDOUT_ERROR", "TEST_WHITESPACE_ERROR", "TEST_EMPTY_EXIT"):
                failed = self.turn(self.session(), question, agent)
                self.assertEqual(failed["status"], "failed")
                self.assertIn("code 9" if question == "TEST_EMPTY_EXIT" else "unavailable in this region", failed["error"])
        raw = '[]\nnot-json\n{"type":"item.completed","item":null}\n'
        with self.assertRaisesRegex(ResearchError, "No structured answer"):
            parse_output(raw, "codex")

    def test_context_budget_uses_installed_model_metadata_without_changing_preferences(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, "models_cache.json").write_text(json.dumps({"models": [
                {"slug": "fixture-model", "context_window": 48000}]}))
            with patch.dict(os.environ, {"CODEX_HOME": home}):
                self.assertEqual(context_budget("codex", {"model": "fixture-model"}), 24000)
