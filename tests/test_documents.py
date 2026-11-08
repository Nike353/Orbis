import hashlib
import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from pypdf import PdfReader, PdfWriter, get_configuration
from pypdf.generic import DecodedStreamObject, NameObject

from tools.agent_bridge import atomic_write_graph, atomic_write_json
from tools.documents import (
    DocumentError, DocumentStore, ReadableHTML, extract_pages,
    original_url, public_download, source_identity, validate_annotation,
)
from tools.workspace import initialize_workspace
from fixtures.reader_pdf import PAGES, pdf_bytes


class DocumentsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        initialize_workspace(self.root)
        self.graph = {"meta": {"schema_version": 2, "title": "Reader test", "revision": 0,
                              "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
        for suffix in ("a", "b"):
            self.graph["nodes"].append({
                "id": "paper:" + suffix, "type": "paper", "label": "Paper " + suffix,
                "status": "accepted", "origin": "user", "notes": "Personal notes stay here.",
                "paper": {"title": "Synthetic paper", "authors": ["Fixture"], "year": 2026,
                          "venue": "Test", "url": "https://arxiv.org/abs/2610.12345v2",
                          "summary": "Existing summary.", "key_findings": []}})
        atomic_write_graph(self.root, self.graph)
        self.store = DocumentStore(self.root)

    def attach(self, node_id="paper:a", content=None, **kwargs):
        return self.store.attach(node_id, content or pdf_bytes(),
                                 source_url="https://arxiv.org/pdf/2610.12345v2", **kwargs)

    def test_identity_normalizes_versions_without_losing_exact_source(self):
        self.assertEqual(source_identity("https://arxiv.org/pdf/2610.12345v2.pdf"),
                         ("arxiv:2610.12345", "v2"))
        self.assertEqual(source_identity("https://arxiv.org/abs/2610.12345")[0],
                         "arxiv:2610.12345")
        self.assertEqual(original_url("https://arxiv.org/html/2610.12345v3"),
                         "https://arxiv.org/pdf/2610.12345v3")
        self.assertEqual(source_identity("https://arxiv.org/pdf/hep-th/9901001v2")[1], "v2")

    def test_original_and_page_mapping_survive_restart_without_changing_notes(self):
        record = self.attach()
        self.assertEqual(record["page_count"], 3)
        self.assertEqual(record["text_status"], "ready")
        self.assertEqual(record["source_version"], "v2")
        pages = self.store.pages(record["id"])["pages"]
        self.assertIn("local full-text index", pages[1]["text"])
        self.assertEqual(pages[1]["section"], "2 Method")
        self.assertIn("82 percent", pages[2]["text"])
        self.assertEqual(DocumentStore(self.root).listing("paper:a")["documents"][0], record)
        self.assertEqual(self.store.blob(record["sha256"]), pdf_bytes())
        self.assertEqual(self.store.node("paper:a")["notes"], "Personal notes stay here.")

    def test_duplicate_bytes_share_storage_but_keep_independent_paper_records(self):
        a = self.attach()
        repeated = self.attach()
        b = self.attach("paper:b")
        self.assertEqual(a["id"], repeated["id"])
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(a["sha256"], b["sha256"])
        self.assertEqual(len(list((self.root / "attachments").glob("*.blob"))), 1)

    def test_identical_bytes_retain_distinct_source_versions(self):
        first = self.attach()
        next_version = self.store.attach("paper:a", pdf_bytes(),
                                        source_url="https://arxiv.org/pdf/2610.12345v3")
        self.assertNotEqual(first["id"], next_version["id"])
        self.assertEqual(next_version["source_version"], "v3")
        self.assertEqual(first["sha256"], next_version["sha256"])
        self.assertEqual(len(list((self.root / "attachments").glob("*.blob"))), 1)

    def test_cached_evidence_cannot_attest_to_a_corrupt_original(self):
        record = self.attach()
        self.store.blob_path(record["sha256"]).write_bytes(b"corrupt")
        context = self.store.retrieve(["paper:a"], "accuracy")
        self.assertEqual(context["passages"], [])
        self.assertEqual(context["sources"][0]["text_status"], "error")
        with self.assertRaisesRegex(DocumentError, "integrity"):
            self.store.pages(record["id"])

    def test_pinned_availability_rechecks_changed_bytes_and_keeps_the_bad_file_for_repair(self):
        record = self.attach()
        sha = record["sha256"]
        self.store.local_state(sha, keep_offline=True, remote_available=True)
        self.assertTrue(self.store.availability()[sha]["available"])
        with patch.object(self.store, "blob", wraps=self.store.blob) as read:
            self.assertTrue(self.store.availability()[sha]["available"])
            read.assert_not_called()
        content = bytearray(pdf_bytes())
        content[30] ^= 1
        self.store.blob_path(sha).write_bytes(content)
        self.assertFalse(self.store.availability()[sha]["available"])
        self.assertTrue(self.store.availability()[sha]["keep_offline"])
        self.assertFalse(self.store.view(self.store.document(record["id"]))["available"])
        self.assertTrue(self.store.blob_path(sha).exists())
        self.store.store_blob(sha, pdf_bytes())
        self.assertTrue(self.store.availability()[sha]["available"])

    def test_relevant_evidence_beyond_the_page_prefix_is_retrieved(self):
        text = "Unrelated background sentence. " * 400
        doc = self.attach(content=pdf_bytes([[text, "The raremetric reaches 82 percent accuracy."]]))
        passages = self.store.retrieve(["paper:a"], "What raremetric accuracy?", budget=1000)["passages"]
        self.assertEqual(passages[0]["document_id"], doc["id"])
        self.assertIn("raremetric reaches 82", passages[0]["text"])

    def test_parsing_does_not_hold_graph_or_metadata_locks(self):
        graph_lock = threading.Lock()
        self.store = DocumentStore(self.root, graph_lock)
        entered, leave = threading.Event(), threading.Event()
        from tools.documents import extract_pages as real_extract
        def slow_extract(*args):
            entered.set()
            leave.wait(5)
            return real_extract(*args)
        errors = []
        def attach():
            try:
                self.attach()
            except Exception as exc:
                errors.append(exc)
        with patch("tools.documents.extract_pages", side_effect=slow_extract):
            worker = threading.Thread(target=attach)
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertTrue(graph_lock.acquire(timeout=.2))
                graph_lock.release()
                self.assertTrue(self.store.lock.acquire(timeout=.2))
                self.store.lock.release()
            finally:
                leave.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_comment_draft_survives_restart_and_keeps_its_conflict_base(self):
        doc = self.attach()
        annotation = self.store.annotate({"document_id": doc["id"], "page": 3, "quote": PAGES[2][1]})
        draft = {"comment": "An unsaved observation.", "color": "blue", "expected": annotation}
        self.store.annotation_draft(annotation["id"], draft)
        restarted = DocumentStore(self.root)
        self.assertEqual(restarted.annotation_draft(annotation["id"]), draft)
        self.store.edit_annotation(annotation["id"], {"comment": "Remote edit", "expected": annotation})
        self.store.annotation_draft(annotation["id"], draft)
        with self.assertRaisesRegex(DocumentError, "changed"):
            self.store.edit_annotation(annotation["id"], draft)
        self.assertEqual(self.store.annotation_draft(annotation["id"]), draft)

    def test_scanned_and_malformed_files_are_never_claimed_as_read(self):
        scanned = self.attach(content=pdf_bytes([[]]))
        self.assertEqual(scanned["text_status"], "no_text")
        self.assertIn("OCR", scanned["extraction_error"])
        broken = self.attach(content=b"%PDF-1.7\nbroken")
        self.assertEqual(broken["text_status"], "error")
        self.assertTrue(self.store.blob_path(broken["sha256"]).exists())
        with self.assertRaisesRegex(DocumentError, "not a PDF"):
            self.attach(content=b"not a document")
        self.assertEqual(len(self.store.records()), 2)

    def test_compressed_page_bomb_is_rejected_before_unbounded_extraction(self):
        configuration = get_configuration()
        writer = PdfWriter()
        page = writer.add_blank_page(612, 792)
        stream = DecodedStreamObject()
        stream.set_data(b" " * (9 * 1024 * 1024))
        page[NameObject("/Contents")] = writer._add_object(stream.flate_encode())
        output = io.BytesIO()
        writer.write(output)
        self.assertLess(len(output.getvalue()), 20000)
        original = self.attach(content=output.getvalue())
        self.assertEqual(original["text_status"], "error")
        self.assertTrue(self.store.blob_path(original["sha256"]).exists())
        self.assertEqual(get_configuration(), configuration)
        self.assertEqual(len(PdfReader(io.BytesIO(pdf_bytes())).pages), 3)

    def test_retrieval_ranks_results_preserves_anchors_and_never_crosses_graphs(self):
        a = self.attach()
        self.attach("paper:b", content=pdf_bytes([["Unrelated", "Different secret text."]]))
        context = self.store.retrieve(["paper:a"], "benchmark accuracy")
        self.assertEqual(context["passages"][0]["page"], 3)
        self.assertEqual(context["passages"][0]["document_id"], a["id"])
        self.assertIn("82 percent", context["passages"][0]["text"])
        self.assertTrue(all(p["node_id"] == "paper:a" for p in context["passages"]))
        self.assertNotIn("secret", str(context))
        other = self.root / "graphs" / ("a" * 32)
        initialize_workspace(other)
        self.assertEqual(DocumentStore(other).retrieve(["paper:a"], "accuracy")["passages"], [])
        bounded = self.store.retrieve(["paper:a"], "accuracy", budget=1000)
        self.assertLessEqual(sum(len(p["text"]) for p in bounded["passages"]), 1000)

    def test_highlights_validate_quote_page_geometry_and_preserve_comments(self):
        doc = self.attach()
        annotation = self.store.annotate({
            "document_id": doc["id"], "page": 3, "quote": PAGES[2][1],
            "comment": "Compare this baseline.", "rects": [{"x": .1, "y": .2, "width": .6, "height": .03}]})
        self.store.edit_annotation(annotation["id"], {"comment": "A reviewed thought.", "expected": annotation})
        self.assertEqual(DocumentStore(self.root).annotations()[annotation["id"]]["comment"], "A reviewed thought.")
        with self.assertRaisesRegex(DocumentError, "does not match"):
            self.store.annotate({"document_id": doc["id"], "page": 2, "quote": PAGES[2][1]})
        with self.assertRaises(DocumentError):
            validate_annotation({**annotation, "rects": [{"x": .9, "y": .2, "width": .6, "height": .1}]},
                                self.store.records())
        with self.assertRaisesRegex(DocumentError, "changed"):
            self.store.edit_annotation(annotation["id"], {"comment": "Stale edit.", "expected": annotation})
        self.store.edit_annotation(annotation["id"], {"action": "delete",
                                                      "expected": self.store.annotations()[annotation["id"]]})
        self.assertEqual(self.store.annotations(), {})

    def test_integrity_cache_removal_and_keep_offline_do_not_destroy_remote_metadata(self):
        doc = self.attach()
        with self.assertRaisesRegex(DocumentError, "Upload"):
            self.store.remove_local(doc["id"])
        self.store.local_state(doc["sha256"], remote_available=True, keep_offline=True)
        with self.assertRaisesRegex(DocumentError, "Keep offline"):
            self.store.remove_local(doc["id"])
        self.store.local_state(doc["sha256"], keep_offline=False)
        self.store.remove_local(doc["id"])
        self.assertIn(doc["id"], self.store.records())
        self.assertFalse(self.store.listing("paper:a")["documents"][0]["available"])
        self.store.store_blob(doc["sha256"], pdf_bytes())
        self.store.blob_path(doc["sha256"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(DocumentError, "integrity"):
            self.store.blob(doc["sha256"])
        with self.assertRaises(DocumentError):
            self.store.store_blob(doc["sha256"], b"wrong")

    def test_recovery_marks_dead_downloads_interrupted_and_cancellation_stops_fetch(self):
        atomic_write_json(self.store.jobs_path, [{"id": "old", "node_id": "paper:a", "status": "fetching"}])
        self.store.recover()
        self.assertEqual(self.store.jobs()[0]["status"], "interrupted")
        entered, leave = threading.Event(), threading.Event()
        def download(url, cancelled):
            entered.set()
            leave.wait(3)
            if cancelled.is_set():
                raise DocumentError("Cancelled")
            return pdf_bytes(), "application/pdf", url
        with patch("tools.documents.public_download", side_effect=download):
            job = self.store.fetch({"node_id": "paper:a"})
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.store.fetch({"node_id": "paper:a"})["id"], job["id"])
            self.store.cancel(job["id"])
            leave.set()
            for _ in range(100):
                if not self.store.active:
                    break
                threading.Event().wait(.01)
        self.assertEqual(self.store.jobs()[0]["status"], "cancelled")
        self.assertEqual(self.store.records(), {})

    def test_download_rejects_private_networks_and_url_credentials_before_connection(self):
        private = [(2, 1, 6, "", ("127.0.0.1", 443))]
        with patch("tools.documents.socket.getaddrinfo", return_value=private), \
                patch("tools.documents.socket.create_connection") as connect:
            with self.assertRaisesRegex(DocumentError, "private"):
                public_download("https://example.org/paper.pdf")
            connect.assert_not_called()
        for url in ("file:///etc/passwd", "http://example.org/x", "https://x:password@example.org/x"):
            with self.assertRaises(DocumentError):
                public_download(url)

    def test_readable_article_strips_active_content_and_retains_local_source_text(self):
        parser = ReadableHTML()
        parser.feed("<article><h1>Methods</h1><p>Safe source text.</p>"
                    "<script>reveal credentials()</script><p>More evidence.</p></article>")
        text = parser.text()
        self.assertNotIn("credentials", text)
        doc = self.store.attach("paper:a", text.encode(), "article.txt", media_type="text/plain")
        self.assertEqual(doc["text_status"], "ready")
        self.assertIn("Safe source text", self.store.pages(doc["id"])["pages"][0]["text"])

    def test_symlinks_and_missing_papers_are_rejected(self):
        with self.assertRaises(DocumentError):
            self.attach("paper:missing")
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "attachments").symlink_to(outside)
        with self.assertRaisesRegex(DocumentError, "symbolic"):
            self.store.store_blob(hashlib.sha256(pdf_bytes()).hexdigest(), pdf_bytes())
        with self.assertRaises(DocumentError):
            self.store.document([])
        (self.root / "attachments").unlink()
        (self.root / ".orbis").symlink_to(outside)
        with self.assertRaisesRegex(DocumentError, "symbolic"):
            self.store.local_state("a" * 64, keep_offline=True)
