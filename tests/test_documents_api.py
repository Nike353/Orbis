import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from tools import serve
from tools.agent_bridge import atomic_write_graph
from tools.documents import DocumentStore
from tools.research import ResearchStore
from tools.workspace import initialize_workspace
from fixtures.reader_pdf import pdf_bytes


class DocumentsApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        initialize_workspace(root)
        graph = {"meta": {"schema_version": 2, "title": "API fixture", "revision": 0,
                          "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [{
            "id": "paper:test", "type": "paper", "label": "Reader fixture", "status": "accepted",
            "origin": "user", "paper": {"title": "Fixture", "authors": [], "year": 2026,
                                      "venue": "Test", "url": "https://example.org/fixture",
                                      "summary": "Summary", "key_findings": []}}], "edges": []}
        atomic_write_graph(root, graph)
        documents = DocumentStore(root)
        research = ResearchStore(root, threading.Lock(), threading.Lock())
        self.patch = patch.multiple(serve, ROOT=root, document_store=documents, research_store=research)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, route, body=None, content_type="application/json", headers=None):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        return urlopen(Request(self.base + route, data=payload, headers={
            "Content-Type": content_type, **(headers or {})}), timeout=5)

    def test_attach_read_search_annotate_and_reopen(self):
        with self.request("/api/documents/attach?node_id=paper%3Atest&filename=fixture.pdf",
                          pdf_bytes(), "application/pdf") as response:
            document = json.load(response)
        with self.request(f"/api/documents/{document['id']}/original") as response:
            self.assertEqual(response.headers["Content-Type"], "application/pdf")
            self.assertEqual(response.read(), pdf_bytes())
        with self.request(f"/api/documents/{document['id']}/pages?query=82") as response:
            self.assertEqual(json.load(response)["pages"][0]["page"], 3)
        with self.request("/api/annotations", {
            "document_id": document["id"], "page": 3,
            "quote": "The synthetic benchmark reaches 82 percent accuracy on 50 trials."}) as response:
            annotation = json.load(response)
        with self.request("/api/documents?node_id=paper%3Atest") as response:
            listing = json.load(response)
            self.assertEqual(listing["documents"][0]["id"], document["id"])
            self.assertEqual(listing["annotations"][0]["id"], annotation["id"])

    def test_cross_origin_invalid_identifiers_and_unknown_actions_are_rejected(self):
        for route, body, headers, status in (
            ("/api/documents?node_id=paper:test", None, {"Origin": "https://evil.example"}, 403),
            ("/api/documents/../../../etc/passwd/original", None, {}, 404),
            ("/api/documents/fetch", {"node_id": "paper:missing"}, {}, 404),
            ("/api/annotations", {"document_id": "../outside"}, {}, 400),
            ("/api/annotations", {"document_id": []}, {}, 400),
        ):
            with self.subTest(route=route):
                with self.assertRaises(HTTPError) as error:
                    self.request(route, body, headers=headers)
                self.assertEqual(error.exception.code, status)
                error.exception.close()
