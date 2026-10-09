import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from tools.desktop_sync import snapshot, digest, validate_snapshot, write_snapshot, recover, DesktopStore
from tools.workspace import initialize_workspace
from tools.agent_bridge import atomic_write_json


class DesktopSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        initialize_workspace(self.root)
        self.module = {"insert_lock": threading.Lock(), "graph_lock": threading.Lock(),
            "research_store": SimpleNamespace(lock=threading.RLock(), journal=self.root/'missing-journal')}
        self.catalog = SimpleNamespace(lock=threading.RLock(), servers={})
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
