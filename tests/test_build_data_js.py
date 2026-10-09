import copy
import json
import unittest
from pathlib import Path

from tools.build_data_js import render_mirror, validate


class GraphValidatorTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.graph = json.loads((Path(__file__).parent / "fixtures/library/data/graph.json").read_text(encoding="utf-8"))

    def test_canonical_graph_is_valid(self):
        self.assertEqual(validate(self.graph), [])

    def test_duplicate_and_dangling_references_are_rejected(self):
        graph = copy.deepcopy(self.graph)
        graph["nodes"].append(copy.deepcopy(graph["nodes"][0]))
        graph["edges"][0]["target"] = "paper:missing"
        errors = validate(graph)
        self.assertTrue(any("duplicate node id" in item for item in errors))
        self.assertTrue(any("unknown target" in item for item in errors))

    def test_rendered_mirror_is_deterministic(self):
        self.assertEqual(render_mirror(self.graph), render_mirror(self.graph))
        self.assertIn(
            "window.ORBIS_DATA = ", render_mirror(self.graph))

    def test_malformed_nested_values_are_reported_without_crashing(self):
        graph = copy.deepcopy(self.graph)
        graph["nodes"][0]["id"] = []
        paper = next(
            node for node in graph["nodes"] if node["type"] == "paper")
        paper["paper"]["authors"] = "not-an-array"
        graph["edges"][0]["confidence"] = True
        graph["edges"][0]["transition_note"] = ""

        errors = validate(graph)

        self.assertTrue(any("id must be a non-empty string" in item
                            for item in errors))
        self.assertTrue(any("authors must be" in item for item in errors))
        self.assertTrue(any("confidence must be" in item for item in errors))
        self.assertTrue(any("transition_note must be" in item
                            for item in errors))


if __name__ == "__main__":
    unittest.main()
