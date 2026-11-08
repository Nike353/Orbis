import json
import tempfile
import unittest
import urllib.request
from urllib.error import HTTPError
from pathlib import Path
from tools.graph_catalog import GraphCatalog
from tools.workspace import initialize_workspace
from tools.agent_bridge import atomic_write_graph, atomic_write_json

APP = Path(__file__).resolve().parent.parent


def request(url, body=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


class GraphCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        initialize_workspace(self.root)
        self.catalog = GraphCatalog(self.root, APP / 'tools/serve.py')

    def tearDown(self):
        self.catalog.close()
        self.temp.cleanup()

    def test_graphs_have_independent_data_history_queues_and_locks(self):
        a, b = self.catalog.create('World models'), self.catalog.create('Blogs')
        first = self.catalog.open(a['id'])['url']
        second = self.catalog.open(b['id'])['url']
        self.assertNotEqual(first, second)
        graph = request(first + 'api/graph')
        self.assertEqual(graph['nodes'], [])
        graph['meta']['revision'] = 1
        graph['nodes'] = [{"id": "cluster:test", "type": "cluster", "label": "Only in A",
                           "status": "accepted", "origin": "user", "notes": "## My notes"}]
        request(first + 'api/graph', {'base_revision': 0, 'graph': graph}, 'PUT')
        self.assertEqual(request(first + 'api/graph')['nodes'][0]['notes'], '## My notes')
        self.assertEqual(request(second + 'api/graph')['nodes'], [])
        request(first + 'api/research', {'title': 'Only A', 'scope_ids': [], 'criteria': []})
        self.assertEqual(len(request(first + 'api/research')['sessions']), 1)
        self.assertEqual(request(second + 'api/research')['sessions'], [])
        module_a, module_b = self.catalog.servers[a['id']][1], self.catalog.servers[b['id']][1]
        self.assertNotEqual(module_a.queue_store.state_path, module_b.queue_store.state_path)
        with module_a.insert_lock:
            self.assertTrue(request(first + 'api/health')['busy'])
            self.assertFalse(request(second + 'api/health')['busy'])
        self.assertEqual(self.catalog.open(a['id'])['url'], first)
        fresh = GraphCatalog(self.root, APP / 'tools/serve.py')
        self.assertEqual([g['name'] for g in fresh.listing('main')['graphs']][1:], ['World models', 'Blogs'])
        self.assertEqual(json.loads((self.root / 'data/graph.json').read_text())['nodes'], [])

    def test_catalog_rejects_unknown_graphs_and_invalid_names(self):
        for identifier in ('../outside', 'missing', ''):
            with self.assertRaises(ValueError):
                self.catalog.open(identifier)
        for name in ('', '   ', 'x' * 101, None):
            with self.assertRaises(ValueError):
                self.catalog.create(name)

    def test_pending_library_sync_blocks_child_edits_and_new_graphs(self):
        child = self.catalog.create("Independent")
        url = self.catalog.open(child["id"])["url"]
        graph = request(url + "api/graph")
        graph["meta"]["revision"] += 1
        atomic_write_json(self.root / ".orbis-sync-apply.json", {})
        with self.assertRaises(HTTPError) as failure:
            request(url + "api/graph", {"base_revision": 0, "graph": graph}, "PUT")
        self.assertEqual(failure.exception.code, 409)
        failure.exception.close()
        with self.assertRaisesRegex(ValueError, "sync transaction"):
            self.catalog.create("Must wait")
        self.assertEqual(len(self.catalog.read()), 1)
        (self.root / ".orbis-sync-apply.json").unlink()

    def test_removed_graph_rejects_edits_without_deleting_saved_files(self):
        child = self.catalog.create("Independent")
        url = self.catalog.open(child["id"])["url"]
        graph = request(url + "api/graph")
        graph["meta"]["revision"] += 1
        root = self.root / "graphs" / child["id"]
        original = (root / "data/graph.json").read_bytes()
        atomic_write_json(self.root / "data/graphs.json", [])
        with self.assertRaises(HTTPError) as failure:
            request(url + "api/graph", {"base_revision": 0, "graph": graph}, "PUT")
        self.assertEqual(failure.exception.code, 409)
        self.assertIn("no longer in the library", failure.exception.read().decode())
        failure.exception.close()
        with self.assertRaises(HTTPError) as failure:
            request(url + "api/research", {"title": "Unsynced", "scope_ids": [], "criteria": []})
        self.assertEqual(failure.exception.code, 409)
        failure.exception.close()
        self.assertEqual((root / "data/graph.json").read_bytes(), original)
        self.assertEqual(self.catalog.listing(child["id"])["graphs"][0]["id"], "main")
