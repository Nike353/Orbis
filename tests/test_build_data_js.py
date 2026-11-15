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

    def graph_with_arxiv_metadata(self):
        graph = copy.deepcopy(self.graph)
        paper = next(node["paper"] for node in graph["nodes"] if node["type"] == "paper")
        paper["arxiv"] = {
            "id": "2603.13594",
            "canonical_url": "https://arxiv.org/abs/2603.13594",
            "submitted_at": "2026-03-13T21:09:39Z",
            "updated_at": "2026-03-13T21:09:39Z",
            "categories": ["cs.AI"],
            "primary_category": "cs.AI",
            "query_id": "test",
        }
        return graph, paper["arxiv"]

    def test_arxiv_dates_accept_timezone_aware_datetimes_without_rewriting(self):
        for value in ("2026-03-13T21:09:39Z", "2026-03-13T21:09:39.123456789Z",
                      "2026-03-14T02:39:39+05:30", "2026-03-13T17:09:39-0400",
                      "2024-02-29T12:34Z"):
            with self.subTest(value=value):
                graph, arxiv = self.graph_with_arxiv_metadata()
                arxiv.update(submitted_at=value, updated_at=value)
                before = copy.deepcopy(graph)
                self.assertEqual(validate(graph), [])
                self.assertEqual(graph, before)

    def test_arxiv_dates_reject_date_only_naive_and_invalid_datetimes(self):
        for field in ("submitted_at", "updated_at"):
            for value in ("2026-03-13", "2026-03-13T21:09:39", "2026-03-13 21:09:39Z",
                          "2026-02-29T21:09:39Z", "2026-03-13T25:09:39Z", "", None, 123):
                with self.subTest(field=field, value=value):
                    graph, arxiv = self.graph_with_arxiv_metadata()
                    arxiv[field] = value
                    errors = validate(graph)
                    self.assertTrue(any(f"arxiv.{field}" in error and "datetime" in error
                                        for error in errors), errors)

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
