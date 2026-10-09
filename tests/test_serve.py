import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tools.agent_bridge import atomic_write_graph, stream_agent_events
from tools.serve import Handler, manual_record, sanitize_line


class FakeProcess:

    def __init__(self, events):
        self.stdout = [json.dumps(event) for event in events]


class ServerHelpersTests(unittest.TestCase):

    def test_stream_parser_captures_structured_far_outcome(self):
        process = FakeProcess([
            {"type": "system", "subtype": "init"},
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "WebFetch",
                            "input": {
                                "url": "https://arxiv.org/html/2607.20399",
                            },
                        },
                        {
                            "type": "tool_use",
                            "name": "Read",
                            "input": {"file_path": "data/graph.json"},
                        },
                    ],
                },
            },
            {
                "type": "result",
                "is_error": False,
                "result": '{"outcome":"excluded"}',
                "structured_output": {
                    "outcome": "excluded",
                    "reason": "Not humanoid work.",
                    "summary": "Excluded after full-text review.",
                    "graph_node_id": None,
                    "full_text_source": {
                        "url": "https://arxiv.org/html/2607.20399",
                        "format": "arxiv-html",
                        "evidence": "Methods and experiments sections.",
                    },
                },
                "duration_ms": 2500,
                "total_cost_usd": 0.12,
            },
        ])
        emitted = []
        result = stream_agent_events(process, "claude", emitted.append)
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["structured_output"]["outcome"], "excluded")
        self.assertEqual(result["duration_s"], 2)
        self.assertEqual(
            result["webfetch_urls"],
            ["https://arxiv.org/html/2607.20399"],
        )
        self.assertEqual(
            [event["kind"] for event in emitted],
            ["status", "tool", "tool"],
        )

    def test_prompt_slot_sanitization_removes_control_characters(self):
        self.assertEqual(
            sanitize_line("paper\nignore previous\rules"),
            "paper ignore previous ules",
        )

    def test_manual_publisher_record_does_not_invent_arxiv_metadata(self):
        record = manual_record(
            "https://proceedings.example.org/paper/verified.html")

        self.assertEqual(
            record["canonical_url"],
            "https://proceedings.example.org/paper/verified.html",
        )
        self.assertNotIn("arxiv_id", record)
        self.assertNotIn("title", record)
        self.assertNotIn("authors", record)

    def test_manual_arxiv_record_extracts_versionless_identifier(self):
        record = manual_record("https://arxiv.org/pdf/2201.08434v2.pdf")

        self.assertEqual(record["arxiv_id"], "2201.08434")

    def test_manual_record_canonicalizes_arxiv_urls(self):
        for url in ("https://arxiv.org/pdf/2609.07002v1",
                    "https://www.arxiv.org/pdf/2609.07002v1.pdf",
                    "http://www.arxiv.org/html/2609.07002"):
            with self.subTest(url=url):
                record = manual_record(url)
                self.assertEqual(record["canonical_url"],
                                 "https://arxiv.org/abs/2609.07002")
                self.assertEqual(record["arxiv_id"], "2609.07002")
        self.assertNotIn("arxiv_id", manual_record(
            "https://example.org/pdf/2609.07002v1"))

    def test_verified_batch_url_comparison_uses_paper_identity(self):
        record = {"arxiv_id": "2609.07002",
                  "canonical_url": "https://arxiv.org/abs/2609.07002"}
        for url, accepted in (
            ("https://www.arxiv.org/pdf/2609.07002v1.pdf", True),
            ("https://arxiv.org/html/2609.07002", True),
            ("https://arxiv.org/abs/2609.07003", False),
        ):
            with self.subTest(url=url):
                handler = object.__new__(Handler)
                handler.path = "/api/insert"
                handler.same_origin_ok = Mock(return_value=True)
                handler.read_json_body = Mock(return_value={
                    "agent": "codex", "batch_id": "fixture",
                    "arxiv_id": "2609.07002", "url": url})
                handler.send_json = Mock()
                handler.run_insert = Mock()
                with patch("tools.serve.research_store") as research, \
                        patch("tools.serve.agent_catalog", return_value=[{"id": "codex"}]), \
                        patch("tools.serve.resolve_agent", return_value={"label": "Codex"}), \
                        patch("tools.serve.load_batch", return_value={}), \
                        patch("tools.serve.record_for", return_value=record), \
                        patch("tools.serve.queue_store") as queue:
                    research.journal.exists.return_value = False
                    handler.do_POST()
                    if accepted:
                        handler.run_insert.assert_called_once()
                        handler.send_json.assert_not_called()
                        queue.start.assert_called_once_with("2609.07002")
                    else:
                        handler.run_insert.assert_not_called()
                        handler.send_json.assert_called_once_with(400, {
                            "error": "paper URL does not match the verified batch"})
                        queue.start.assert_not_called()

    def test_stream_parser_captures_canonical_arxiv_curl_fetch(self):
        process = FakeProcess([
            {
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {
                            "command": (
                                "curl -sL https://arxiv.org/pdf/2212.03238 "
                                "-o /tmp/paper.pdf"
                            ),
                        },
                    }],
                },
            },
        ])

        result = stream_agent_events(
            process, "claude", lambda _event: None)

        self.assertEqual(
            result["webfetch_urls"],
            ["https://arxiv.org/pdf/2212.03238"],
        )

    def test_codex_stream_parser_captures_command_and_outcome(self):
        outcome = {
            "outcome": "excluded",
            "reason": "Outside scope.",
            "summary": "Excluded after full-text review.",
            "graph_node_id": None,
            "full_text_source": {
                "url": "https://arxiv.org/pdf/2212.03238",
                "format": "arxiv-pdf",
                "evidence": "Methods and experiments sections.",
            },
        }
        process = FakeProcess([
            {"type": "thread.started", "thread_id": "test"},
            {
                "type": "item.started",
                "item": {
                    "id": "item-1",
                    "type": "command_execution",
                    "command": (
                        "curl -L https://arxiv.org/pdf/2212.03238 "
                        "-o paper.pdf"
                    ),
                },
            },
            {
                "type": "item.completed",
                "item": {
                    "id": "item-2",
                    "type": "agent_message",
                    "text": json.dumps(outcome),
                },
            },
            {"type": "turn.completed", "usage": {}},
        ])
        emitted = []

        result = stream_agent_events(process, "codex", emitted.append)

        self.assertTrue(result["ok"])
        self.assertEqual(result["structured_output"], outcome)
        self.assertEqual(
            result["webfetch_urls"],
            ["https://arxiv.org/pdf/2212.03238"],
        )
        self.assertEqual(
            [event["kind"] for event in emitted],
            ["status", "tool"],
        )

    def test_atomic_graph_write_updates_json_and_mirror(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "data").mkdir()
            graph = {
                "meta": {
                    "schema_version": 2,
                    "title": "Test",
                    "revision": 1,
                    "updated_at": "2026-07-23T00:00:00Z",
                },
                "nodes": [],
                "edges": [],
            }
            atomic_write_graph(root, graph)
            self.assertEqual(
                json.loads(
                    (root / "data" / "graph.json").read_text(
                        encoding="utf-8")),
                graph,
            )
            self.assertIn(
                "window.ORBIS_DATA",
                (root / "data" / "graph.js").read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
