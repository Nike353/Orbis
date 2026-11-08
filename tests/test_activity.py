import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

from tools import serve
from tools.activity import ActivityStore
from tools.documents import DocumentStore
from tools.research import ResearchStore
from tools.workspace import initialize_workspace
from tools.agent_bridge import QueueStateStore


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        initialize_workspace(self.root)
        documents = DocumentStore(self.root)
        self.store = ActivityStore(documents)
        insert_lock, graph_lock = threading.Lock(), threading.Lock()
        self.insert_lock = insert_lock
        self.patch = patch.multiple(serve, ROOT=self.root, GRAPH_JSON=self.root / "data/graph.json",
                                   document_store=documents, activity_store=self.store,
                                   research_store=ResearchStore(self.root, insert_lock, graph_lock),
                                   queue_store=QueueStateStore(self.root / "missing-batch.json", self.root / "missing-state.json"),
                                   insert_lock=insert_lock, graph_lock=graph_lock, active_run=None)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        fixture = Path(__file__).parent / "fixtures/import_agent.py"
        self.env = patch.dict(os.environ, {"ORBIS_CLAUDE": f'"{sys.executable}" "{fixture}"',
                                          "ORBIS_CODEX": f'"{sys.executable}" "{fixture}"',
                                          "ORBIS_DESKTOP_TOKEN": "synthetic-capability"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        serve.cancel_active_run()
        if self.insert_lock.acquire(timeout=5):
            self.insert_lock.release()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, route, body=None, method=None):
        return urlopen(Request(self.base + route, data=json.dumps(body).encode() if body else None,
                       method=method, headers={"Content-Type": "application/json",
                       "X-Orbis-Desktop": "synthetic-capability"}), timeout=5)

    def wait(self, identifier):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = next(j for j in self.store.read() if j["id"] == identifier)
            if job["status"] != "running" and not self.insert_lock.locked():
                return job
            time.sleep(.02)
        self.fail("Import did not finish")

    def start(self, agent="claude", hint=""):
        response = self.request("/api/insert", {"agent": agent, "url": "https://example.org/synthetic",
                                              "source_kind": "website", "hint": hint})
        first = json.loads(response.readline())
        self.assertEqual(first["type"], "start")
        return response, first["job_id"]

    def test_disconnected_ui_does_not_cancel_a_durable_import_and_both_adapters_strip_capabilities(self):
        for agent in ("claude", "codex"):
            response, identifier = self.start(agent, "TEST_ENV")
            response.close()
            job = self.wait(identifier)
            self.assertEqual(job["status"], "excluded", job)
            self.assertEqual(job["summary"], "Desktop capability: absent")
            self.assertEqual(ActivityStore(DocumentStore(self.root)).read()[0], job)
        with self.request("/api/activity") as response:
            self.assertTrue(any(j["id"] == identifier for j in json.load(response)["jobs"]))
        self.assertEqual(json.loads((self.root / "data/graph.json").read_text())["nodes"], [])

    def test_stale_cancel_cannot_kill_a_newer_import_and_retry_keeps_history(self):
        response, identifier = self.start(hint="TEST_WAIT")
        response.close()
        with self.assertRaises(HTTPError) as failure:
            self.request("/api/insert?job_id=old-job", method="DELETE")
        self.assertEqual(failure.exception.code, 409)
        failure.exception.close()
        with self.request(f"/api/insert?job_id={identifier}", method="DELETE") as cancelled:
            self.assertEqual(cancelled.status, 202)
        self.assertEqual(self.wait(identifier)["status"], "cancelled")
        response, retried = self.start()
        response.close()
        self.assertEqual(self.wait(retried)["status"], "excluded")
        self.assertNotEqual(retried, identifier)
        self.assertEqual(len(self.store.read()), 2)

    def test_timeout_and_restart_are_recorded_honestly(self):
        with patch("tools.serve.INSERT_TIMEOUT_S", .1):
            response, identifier = self.start(hint="TEST_WAIT")
            response.close()
            job = self.wait(identifier)
            self.assertEqual(job["status"], "failed")
            self.assertIn("exceeded", job["error"])
        interrupted = self.store.start({"canonical_url": "https://example.org/synthetic"}, "", "claude", None)
        self.store.recover()
        self.assertEqual(self.wait(interrupted)["status"], "interrupted")
        self.assertEqual(self.wait(identifier)["status"], "failed")
