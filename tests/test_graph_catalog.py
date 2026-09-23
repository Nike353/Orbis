import json
import tempfile
import unittest
import urllib.request
from pathlib import Path
from tools.graph_catalog import GraphCatalog
from tools.workspace import initialize_workspace
from tools.agent_bridge import atomic_write_graph

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
