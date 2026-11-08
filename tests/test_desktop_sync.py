import copy
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from tools.desktop_sync import snapshot, digest, validate_snapshot, write_snapshot, recover, DesktopStore
from tools.workspace import initialize_workspace
from tools.agent_bridge import atomic_write_json, atomic_write_graph
from tools.documents import DocumentStore
from tools.research import ResearchStore, ResearchError
from tools import serve
from fixtures.reader_pdf import pdf_bytes, PAGES


class DesktopSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        initialize_workspace(self.root)
        self.module = {"insert_lock": threading.Lock(), "graph_lock": threading.Lock(),
            "research_store": SimpleNamespace(lock=threading.RLock(), journal=self.root/'missing-journal'),
            "document_store": DocumentStore(self.root)}
        self.catalog = SimpleNamespace(lock=threading.RLock(), servers={}, read=lambda: [])
        self.store = DesktopStore(self.root, self.catalog, self.module)

    def test_roundtrip_multiple_graphs_and_history(self):
        value = snapshot(self.root)
        child = 'a' * 32
        value['graphs'][child] = copy.deepcopy(value['graphs']['main'])
        value['graphs'][child]['name'] = 'Second graph'
        value['graphs']['main']['notes']['paper.md'] = '# Full note\n$E=mc^2$'
        value['graphs']['main']['sessions']['session'] = {'id': 'session', 'title': 'Q&A', 'scope_ids': [], 'criteria': [], 'turns': []}
        self.store.access(value, digest(snapshot(self.root)))
        self.assertEqual(snapshot(self.root), value)
        self.assertTrue(list((self.root/'.orbis-backups').glob('*.json')))

    def test_rejects_stale_apply_without_losing_changes(self):
        old = self.store.access()
        fresh = copy.deepcopy(old['snapshot'])
        fresh['graphs']['main']['notes']['new.md'] = 'local edit'
        write_snapshot(self.root, fresh)
        with self.assertRaisesRegex(ValueError, 'changed during sync'):
            self.store.access(old['snapshot'], old['digest'])
        self.assertEqual(snapshot(self.root), fresh)

    def test_rejects_path_traversal_and_invalid_graph(self):
        value = snapshot(self.root)
        value['graphs']['main']['notes']['../../escape.md'] = 'bad'
        with self.assertRaises(ValueError): validate_snapshot(value)
        value = snapshot(self.root)
        value['graphs']['../escape'] = copy.deepcopy(value['graphs']['main'])
        with self.assertRaises(ValueError): validate_snapshot(value)
        value = snapshot(self.root)
        value['graphs']['main']['edges']['e1'] = {'id': 'e1', 'source': 'missing', 'target': 'missing'}
        with self.assertRaises(ValueError): validate_snapshot(value)

    def test_sync_waits_for_agents_and_replays_interrupted_transaction(self):
        with self.module['insert_lock']:
            with self.assertRaisesRegex(ValueError, 'agent is running'): self.store.access()
        value = snapshot(self.root)
        value['graphs']['main']['notes']['recovered.md'] = 'recovered'
        atomic_write_json(self.root/'.orbis-sync-apply.json', value)
        recover(self.root)
        self.assertEqual(snapshot(self.root), value)
        self.assertFalse((self.root/'.orbis-sync-apply.json').exists())

    def test_revisions_are_local_and_not_spurious_sync_changes(self):
        value = snapshot(self.root)
        write_snapshot(self.root, value)
        self.assertEqual(snapshot(self.root), value)
        self.assertEqual(json.loads((self.root/'data/graph.json').read_text())['meta']['revision'], 1)

    def test_snapshot_cannot_deadlock_a_research_save_waiting_for_graph(self):
        failures = []
        def read():
            try:
                self.store.access()
            except Exception as exc:
                failures.append(exc)
        with self.module["research_store"].lock:
            worker = threading.Thread(target=read)
            worker.start()
            deadline = time.monotonic() + 2
            while not self.module["insert_lock"].locked() and time.monotonic() < deadline:
                time.sleep(.01)
            acquired = self.module["graph_lock"].acquire(timeout=.2)
            if acquired:
                self.module["graph_lock"].release()
        worker.join(3)
        self.assertTrue(acquired, "snapshot held graph while waiting for research")
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])

    def original(self):
        graph = json.loads((self.root / "data/graph.json").read_text())
        graph["nodes"] = [{"id": "paper:fixture", "type": "paper", "label": "Sync fixture",
            "status": "accepted", "origin": "user", "notes": "My personal note",
            "paper": {"title": "Synthetic source", "authors": ["Fixture"], "year": 2026, "venue": "Fixture",
                "url": "https://example.org/paper", "summary": "Generated summary", "key_findings": []}}]
        atomic_write_graph(self.root, graph)
        return self.module["document_store"].attach("paper:fixture", pdf_bytes())

    def test_original_metadata_and_annotations_sync_without_files_caches_or_local_preferences(self):
        doc = self.original()
        documents = self.module["document_store"]
        annotation = documents.annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1],
                                         "comment": "This comment belongs to the user."})
        value = self.store.access()["snapshot"]
        self.assertEqual(value["version"], 2)
        validate_snapshot(value)
        documents.local_state(doc["sha256"], keep_offline=True, last_page=3, remote_id="local-only")
        self.assertEqual(self.store.access()["snapshot"], value)
        self.assertNotIn("document-text", json.dumps(value))
        self.assertNotIn("local-only", json.dumps(value))
        with tempfile.TemporaryDirectory() as other:
            write_snapshot(Path(other), value)
            destination = DocumentStore(other)
            self.assertEqual(destination.records()[doc["id"]]["sha256"], doc["sha256"])
            self.assertEqual(destination.annotations()[annotation["id"]], annotation)
            self.assertFalse(destination.blob_path(doc["sha256"]).exists())
            self.assertFalse(destination.local_path.exists())

    def test_download_checks_metadata_hash_and_size_before_overwriting_a_file(self):
        doc = self.original()
        documents = self.module["document_store"]
        before = documents.blob(doc["sha256"])
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.store.blob("main", doc["sha256"], b"X" * len(before))
        self.assertEqual(documents.blob(doc["sha256"]), before)
        documents.local_state(doc["sha256"], remote_available=True)
        documents.remove_local(doc["id"])
        self.assertFalse(self.store.availability()["graphs"]["main"][doc["sha256"]]["available"])
        self.assertEqual(self.store.blob("main", doc["sha256"], before)["text_status"], "ready")
        self.assertTrue(self.store.availability()["graphs"]["main"][doc["sha256"]]["available"])
        self.assertEqual(documents.pages(doc["id"])["pages"][2]["page"], 3)
        with self.assertRaisesRegex(ValueError, "part of this graph"):
            self.store.blob("main", "b" * 64, before)
        with self.assertRaises(ValueError):
            self.store.transfer("main", doc["sha256"], {"keep_offline": True})
        with self.assertRaises(ValueError):
            self.store.transfer("main", doc["sha256"], {"transfer_status": "pretend_synced"})

    def test_invalid_synced_originals_cannot_write_outside_the_library(self):
        doc = self.original()
        value = snapshot(self.root)
        value["graphs"]["main"]["documents"][doc["id"]]["node_id"] = "paper:missing"
        with self.assertRaisesRegex(ValueError, "missing paper"):
            validate_snapshot(value)
        value = snapshot(self.root)
        child = "c" * 32
        value["graphs"][child] = copy.deepcopy(value["graphs"]["main"])
        with tempfile.TemporaryDirectory() as outside:
            (self.root / "graphs").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symbolic"):
                write_snapshot(self.root, value)
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_remote_highlight_deletion_preserves_an_unsaved_local_comment(self):
        doc = self.original()
        documents = self.module["document_store"]
        annotation = documents.annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1]})
        draft = {"comment": "Unique unsaved local comment", "color": "yellow", "expected": annotation}
        documents.annotation_draft(annotation["id"], draft)
        before = self.store.access()
        incoming = copy.deepcopy(before["snapshot"])
        incoming["graphs"]["main"]["annotations"] = {}
        with self.assertRaisesRegex(ValueError, "unsaved highlight comment"):
            self.store.access(incoming, before["digest"])
        self.assertEqual(documents.annotation_draft(annotation["id"]), draft)
        self.assertEqual(self.store.access(), before)
        self.assertFalse((self.root / ".orbis-sync-apply.json").exists())
        documents.annotation_draft(annotation["id"], {"action": "discard"})
        self.store.access(incoming, before["digest"])
        self.assertEqual(documents.annotations(), {})

    def test_failed_sync_apply_blocks_later_writes_until_recovery(self):
        doc = self.original()
        current = self.store.access()
        incoming = copy.deepcopy(current["snapshot"])
        incoming["graphs"]["main"]["nodes"]["paper:fixture"]["label"] = "Incoming remote label"
        def fail_catalog(path, value):
            if path == self.root / "data/graphs.json":
                raise OSError("Synthetic disk interruption")
            atomic_write_json(path, value)
        with patch("tools.desktop_sync.atomic_write_json", side_effect=fail_catalog):
            with self.assertRaisesRegex(OSError, "disk interruption"):
                self.store.access(incoming, current["digest"])
        self.assertTrue((self.root / ".orbis-sync-apply.json").exists())
        graph = json.loads((self.root / "data/graph.json").read_text())
        proposed = copy.deepcopy(graph)
        proposed["nodes"][0]["label"] = "Newer edit must not be silently accepted"
        proposed["meta"]["revision"] += 1
        handler = object.__new__(serve.Handler)
        handler.path = "/api/graph"
        handler.same_origin_ok = Mock(return_value=True)
        handler.read_json_body = Mock(return_value={"base_revision": graph["meta"]["revision"], "graph": proposed})
        handler.send_json = Mock()
        with patch.multiple(serve, ROOT=self.root, GRAPH_JSON=self.root / "data/graph.json",
                            insert_lock=self.module["insert_lock"], graph_lock=self.module["graph_lock"]):
            handler.do_PUT()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        self.assertIn("sync transaction", handler.send_json.call_args.args[1]["error"])
        with self.assertRaisesRegex(ValueError, "sync transaction"):
            self.store.access()
        with self.assertRaisesRegex(ValueError, "sync transaction"):
            self.module["document_store"].annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1]})
        with self.assertRaisesRegex(ResearchError, "sync transaction"):
            ResearchStore(self.root, threading.Lock(), threading.Lock()).create(
                {"title": "Later discussion", "scope_ids": [], "criteria": []})
        recover(self.root)
        self.assertFalse((self.root / ".orbis-sync-apply.json").exists())
        self.assertEqual(self.store.access()["snapshot"], incoming)

    def test_pending_sync_cannot_accept_a_new_draft_that_would_block_restart(self):
        doc = self.original()
        documents = self.module["document_store"]
        annotation = documents.annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1]})
        before = self.store.access()
        incoming = copy.deepcopy(before["snapshot"])
        incoming["graphs"]["main"]["annotations"] = {}
        def fail_history(path, value):
            if path == self.root / "data/research.json":
                raise OSError("Synthetic partial apply")
            atomic_write_json(path, value)
        with patch("tools.desktop_sync.atomic_write_json", side_effect=fail_history):
            with self.assertRaises(OSError):
                self.store.access(incoming, before["digest"])
        with self.assertRaisesRegex(ValueError, "sync transaction"):
            documents.annotation_draft(annotation["id"], {"comment": "Late draft", "color": "yellow", "expected": annotation})
        research = ResearchStore(self.root, threading.Lock(), threading.Lock())
        with self.assertRaisesRegex(ResearchError, "sync transaction"):
            research.draft("paper:fixture", {"question": "Late question", "selection": None})
        documents.annotation_draft(annotation["id"], {"action": "discard"})
        recover(self.root)
        self.assertEqual(self.store.access()["snapshot"], incoming)

    def test_remote_paper_deletion_preserves_an_unsent_discussion_draft(self):
        self.original()
        research = ResearchStore(self.root, threading.Lock(), threading.Lock())
        research.draft("paper:fixture", {"question": "My unsent question", "selection": None})
        before = self.store.access()
        incoming = copy.deepcopy(before["snapshot"])
        incoming["graphs"]["main"].update(nodes={}, documents={}, annotations={})
        with self.assertRaisesRegex(ValueError, "unsent discussion draft"):
            self.store.access(incoming, before["digest"])
        self.assertEqual(research.draft("paper:fixture")["question"], "My unsent question")
        research.draft("paper:fixture", {"question": "", "selection": None})
        self.store.access(incoming, before["digest"])
