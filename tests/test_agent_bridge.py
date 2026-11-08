import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.agent_bridge import (
    BridgeContractError,
    IsolatedInsertion,
    QueueStateStore,
    atomic_write_graph,
    build_agent_command,
    build_prompt,
    PAPER_SUMMARY_SECTIONS,
    validate_paper_summary,
    build_revalidation_prompt,
    comparable_title,
    canonical_paper_url,
    graph_duplicate,
    load_batch,
    validate_full_text_source,
)


ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/library"
BATCH = FIXTURE / "data" / "imports" / "humanoid-loco-manipulation-2026.json"


class PaperUrlTests(unittest.TestCase):

    def test_arxiv_forms_share_versionless_identity(self):
        for host in ("arxiv.org", "www.arxiv.org"):
            for scheme in ("http", "https"):
                for path in ("abs/2609.07002", "pdf/2609.07002v1",
                             "pdf/2609.07002v1.pdf", "html/2609.07002",
                             "abs/2609.07002v2/?download=1#section"):
                    url = f"{scheme}://{host}/{path}"
                    with self.subTest(url=url):
                        self.assertEqual(canonical_paper_url(url),
                                         "https://arxiv.org/abs/2609.07002")
        self.assertEqual(canonical_paper_url(
            "https://arxiv.org/pdf/hep-th/9901001v2.pdf"),
            "https://arxiv.org/abs/hep-th/9901001")

    def test_other_hosts_and_nonpaper_paths_are_preserved(self):
        for url in ("https://example.org/pdf/2609.07002v1.pdf",
                    "https://arxiv.org.evil.example/pdf/2609.07002v1",
                    "https://arxiv.org/list/cs.AI/recent",
                    "https://arxiv.org/abs/not-a-paper"):
            with self.subTest(url=url):
                self.assertEqual(canonical_paper_url(url), url)

    def test_attestation_still_requires_the_observed_full_text_url(self):
        record = {"arxiv_id": "2609.07002",
                  "canonical_url": "https://arxiv.org/abs/2609.07002"}
        source = {"url": "https://arxiv.org/pdf/2609.07002v1",
                  "format": "arxiv-pdf",
                  "evidence": "Methods, experiments, and limitations sections."}
        self.assertEqual(validate_full_text_source(
            record, source, [source["url"]]), [])
        for observed in (record["canonical_url"],
                         "https://arxiv.org/html/2609.07002"):
            with self.subTest(observed=observed):
                self.assertIn("not observed", "; ".join(
                    validate_full_text_source(record, source, [observed])))


class PaperSummaryTests(unittest.TestCase):
    def test_five_sections_and_extra_instructions(self):
        summary = "\n\n".join("## " + name + "\n\n" +
            "A substantive explanation grounded in the paper, naming the actual method, evaluation setting, evidence, and remaining uncertainty."
            for name in PAPER_SUMMARY_SECTIONS)
        self.assertEqual(validate_paper_summary(summary), [])
        self.assertEqual(validate_paper_summary(summary + "\n\n## Additional requested analysis\n\nUser-requested details."), [])
        for bad in ('Just an abstract.', summary.replace('## Limitations', '## Other'),
                    summary + '\n## Key results\nDuplicated',
                    '```markdown\n' + summary + '\n```',
                    summary.replace('## Motivation and problem', '## Background and prior work')):
            self.assertTrue(validate_paper_summary(bad))
        empty = "\n\n".join("## " + name + "\nTBD" for name in PAPER_SUMMARY_SECTIONS)
        self.assertEqual(len(validate_paper_summary(empty)), 5)
        hint = 'Explain the training stages and compare hardware versus simulation.'
        prompt = build_prompt({'canonical_url': 'https://arxiv.org/abs/2606.05160'}, hint)
        self.assertIn(hint, prompt)
        self.assertIn('ADDITIONAL USER INSTRUCTIONS', prompt)
        self.assertIn('supplement', prompt)
        self.assertIn('every stage', prompt)


class IsolatedInsertionTests(unittest.TestCase):

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for relative in (
            "data/graph.json",
            "data/graph.js",
            "docs/SCHEMA.md",
            "prompts/insert_paper.md",
            "tools/build_data_js.py",
        ):
            source = (FIXTURE if relative.startswith("data/") else ROOT) / relative
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        shutil.copytree(FIXTURE / "papers", self.root / "papers")
        self.record = json.loads(
            BATCH.read_text(encoding="utf-8"))["records"][0]

    def tearDown(self):
        self.temporary.cleanup()

    def test_rejects_short_new_paper_summary_without_mutating_library(self):
        before = (self.root / 'data/graph.json').read_bytes()
        with IsolatedInsertion(self.root) as insertion:
            _, paper_id = self.write_valid_output(insertion)
            data = json.loads((insertion.workspace / 'data/graph.json').read_text())
            paper = next(n for n in data['nodes'] if n['id'] == paper_id)
            paper['paper']['summary'] = 'A one-sentence abstract does not explain the paper.'
            atomic_write_graph(insertion.workspace, data)
            errors = insertion.verify_inserted(self.record, paper_id)
            self.assertTrue(any('five required sections' in e for e in errors), errors)
        self.assertEqual((self.root / 'data/graph.json').read_bytes(), before)

    def write_valid_output(self, insertion):
        graph = copy.deepcopy(insertion.graph)
        graph["meta"]["revision"] += 1
        graph["meta"]["updated_at"] = "2026-07-23T23:59:00Z"
        paper_id = "paper:test2026-isolated"
        graph["nodes"].append({
            "id": paper_id,
            "type": "paper",
            "label": "Isolated Test Paper",
            "status": "proposed",
            "origin": "agent",
            "cluster": next(
                node["id"] for node in graph["nodes"]
                if node["type"] == "cluster"),
            "notes_file": "papers/test2026-isolated.md",
            "paper": {
                "title": self.record["title"],
                "authors": self.record["authors"][:6],
                "year": 2026,
                "venue": "arXiv 2026",
                "url": self.record["canonical_url"],
                "summary": "\n\n".join("## " + heading + "\n\n" + "This is a synthetic explanation of the fixture method and its evaluation, with sufficient detail to exercise the summary contract." for heading in PAPER_SUMMARY_SECTIONS),
                "key_findings": ["A test-only finding."],
                "arxiv": {
                    "id": self.record["arxiv_id"],
                    "canonical_url": self.record["canonical_url"],
                    "submitted_at": self.record["submitted_at"],
                    "updated_at": self.record["updated_at"],
                    "categories": self.record["categories"],
                    "primary_category": self.record["primary_category"],
                    "query_id": self.record["query_id"],
                },
            },
        })
        next_edge = max(
            int(edge["id"][1:]) for edge in graph["edges"]) + 1
        targets = [
            node["id"] for node in graph["nodes"]
            if node["id"] != paper_id and node["type"] != "cluster"
        ][:2]
        for offset, target in enumerate(targets):
            graph["edges"].append({
                "id": f"e{next_edge + offset:03d}",
                "source": paper_id,
                "target": target,
                "relation": "compares_to",
                "transition_note": (
                    "The fixture uses a concrete comparison solely to verify "
                    "the insertion transaction."
                ),
                "confidence": 0.7,
                "evidence": "Integration-test fixture.",
                "status": "proposed",
                "origin": "agent",
            })
        atomic_write_graph(insertion.workspace, graph)
        (insertion.workspace / "papers" / "test2026-isolated.md").write_text(
            "# Isolated Test Paper\n", encoding="utf-8")
        return graph, paper_id

    def test_valid_output_is_applied_only_after_contract_verification(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            self.assertEqual(
                insertion.verify_inserted(self.record, paper_id), [])
            self.assertEqual(
                json.loads(
                    (self.root / "data" / "graph.json").read_text(
                        encoding="utf-8"))["meta"]["revision"],
                insertion.graph["meta"]["revision"],
            )
            insertion.apply()
        applied = json.loads(
            (self.root / "data" / "graph.json").read_text(encoding="utf-8"))
        self.assertEqual(applied, graph)
        self.assertTrue(
            (self.root / "papers" / "test2026-isolated.md").exists())

    def test_blog_insertion_with_unknown_metadata_and_source_attestation(self):
        record = {"canonical_url": "https://example.org/blog/world-models", "source_kind": "blog"}
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            node = next(n for n in graph["nodes"] if n["id"] == paper_id)
            node["paper"].pop("arxiv")
            node["paper"].update(url=record["canonical_url"], source_kind="blog", authors=[], year=None)
            atomic_write_graph(insertion.workspace, graph)
            self.assertEqual(insertion.verify_inserted(record, paper_id), [])
            source = {"url": record["canonical_url"], "format": "publisher-html",
                      "evidence": "Article body: architecture and limitations sections."}
            self.assertEqual(validate_full_text_source(record, source, [source["url"]]), [])
            self.assertTrue(validate_full_text_source(record, source, []))
            self.assertIn("article/page body", build_prompt(record, ""))

    def test_insertion_accepts_equivalent_urls_but_rejects_other_papers(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            node = next(n for n in graph["nodes"] if n["id"] == paper_id)
            node["paper"]["url"] = "https://arxiv.org/abs/2609.07002"
            atomic_write_graph(insertion.workspace, graph)
            for url in (
                "https://arxiv.org/pdf/2609.07002v1",
                "https://www.arxiv.org/pdf/2609.07002v1.pdf",
                "http://arxiv.org/html/2609.07002",
            ):
                with self.subTest(url=url):
                    self.assertEqual(insertion.verify_inserted(
                        {"canonical_url": url}, paper_id), [])
            self.assertIn("new paper URL does not match the queue record",
                          insertion.verify_inserted(
                              {"canonical_url": "https://arxiv.org/abs/2609.07003"},
                              paper_id))

    def test_duplicate_detection_matches_urls_without_arxiv_metadata(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            node = next(n for n in graph["nodes"] if n["id"] == paper_id)
            node["paper"].pop("arxiv")
            node["paper"]["url"] = "https://www.arxiv.org/pdf/2609.07002v1.pdf"
            atomic_write_graph(insertion.workspace, graph)
            self.assertEqual(graph_duplicate(insertion.workspace, {
                "canonical_url": "https://arxiv.org/abs/2609.07002",
            }), paper_id)
            self.assertIsNone(graph_duplicate(insertion.workspace, {
                "canonical_url": "https://arxiv.org/abs/2609.07003",
            }))

    def test_empty_library_can_receive_its_first_paper_and_cluster(self):
        with IsolatedInsertion(self.root) as reference:
            populated, paper_id = self.write_valid_output(reference)
        empty = copy.deepcopy(populated)
        empty['nodes'], empty['edges'] = [], []
        empty['meta']['revision'] = 0
        atomic_write_graph(self.root, empty)
        with IsolatedInsertion(self.root) as insertion:
            graph = copy.deepcopy(empty)
            paper = next(n for n in populated['nodes'] if n['id'] == paper_id)
            cluster = {'id': paper['cluster'], 'type': 'cluster', 'label': 'First field',
                       'status': 'proposed', 'origin': 'agent'}
            graph['nodes'] = [cluster, paper]
            graph['meta']['revision'] = 1
            atomic_write_graph(insertion.workspace, graph)
            (insertion.workspace / paper['notes_file']).write_text('# First paper\n')
            self.assertEqual(insertion.verify_inserted(self.record, paper_id), [])
            insertion.apply()
        self.assertEqual(len(json.loads((self.root / 'data/graph.json').read_text())['nodes']), 2)

    def test_protected_content_change_is_rejected(self):
        with IsolatedInsertion(self.root) as insertion:
            _, paper_id = self.write_valid_output(insertion)
            changed = json.loads(
                (insertion.workspace / "data" / "graph.json").read_text())
            protected = next(
                node for node in changed["nodes"]
                if node["origin"] == "user")
            protected["label"] = "Changed by model"
            atomic_write_graph(insertion.workspace, changed)
            errors = insertion.verify_inserted(self.record, paper_id)
            self.assertTrue(any(
                "protected node modified" in error for error in errors))

    def test_verified_paper_card_metadata_cannot_drift(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            paper = next(
                node for node in graph["nodes"] if node["id"] == paper_id)
            paper["paper"]["title"] = "A different title"
            paper["paper"]["authors"] = ["A different author"]
            paper["paper"]["year"] = 2025
            atomic_write_graph(insertion.workspace, graph)

            errors = insertion.verify_inserted(self.record, paper_id)

            self.assertTrue(any(
                "title does not match" in error for error in errors))
            self.assertTrue(any(
                "authors do not match" in error for error in errors))
            self.assertTrue(any(
                "year does not match" in error for error in errors))

    def test_verified_ledger_year_overrides_arxiv_submission_year(self):
        self.record["ledger_year"] = 2025
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            paper = next(
                node for node in graph["nodes"] if node["id"] == paper_id)
            paper["paper"]["year"] = 2025
            atomic_write_graph(insertion.workspace, graph)

            errors = insertion.verify_inserted(self.record, paper_id)

            self.assertFalse(any(
                "year does not match" in error for error in errors))

    def test_unclustered_paper_and_unrelated_edge_are_rejected(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            paper = next(
                node for node in graph["nodes"] if node["id"] == paper_id)
            paper.pop("cluster")
            unrelated = graph["edges"][-1]
            unrelated["source"] = insertion.graph["edges"][0]["source"]
            unrelated["target"] = insertion.graph["edges"][0]["target"]
            atomic_write_graph(insertion.workspace, graph)

            errors = insertion.verify_inserted(self.record, paper_id)

            self.assertTrue(any(
                "must belong to" in error for error in errors))
            self.assertTrue(any(
                "unrelated to the insertion" in error for error in errors))

    def test_insertion_can_create_a_cluster_for_a_new_topic(self):
        with IsolatedInsertion(self.root) as insertion:
            graph, paper_id = self.write_valid_output(insertion)
            cluster_id = "cluster:new-topic"
            graph["nodes"].append({
                "id": cluster_id,
                "type": "cluster",
                "label": "New Topic",
                "description": "A distinct research topic introduced by the paper.",
                "status": "proposed",
                "origin": "agent",
            })
            paper = next(
                node for node in graph["nodes"] if node["id"] == paper_id)
            paper["cluster"] = cluster_id
            atomic_write_graph(insertion.workspace, graph)

            self.assertEqual(
                insertion.verify_inserted(self.record, paper_id), [])

    def test_excluded_outcome_must_leave_every_owned_file_unchanged(self):
        with IsolatedInsertion(self.root) as insertion:
            graph = copy.deepcopy(insertion.graph)
            graph["meta"]["revision"] += 1
            atomic_write_graph(insertion.workspace, graph)
            self.assertIn(
                "graph.json changed", "; ".join(insertion.verify_unchanged()))

    def test_atomic_graph_write_rolls_back_if_mirror_replace_fails(self):
        graph_path = self.root / "data" / "graph.json"
        mirror_path = self.root / "data" / "graph.js"
        original_graph = graph_path.read_bytes()
        original_mirror = mirror_path.read_bytes()
        graph = json.loads(original_graph)
        graph["meta"]["revision"] += 1
        real_replace = os.replace
        mirror_failed = False

        def replace_with_failure(source, target):
            nonlocal mirror_failed
            if Path(target) == mirror_path and not mirror_failed:
                mirror_failed = True
                raise OSError("simulated mirror failure")
            return real_replace(source, target)

        with patch("tools.agent_bridge.os.replace",
                   side_effect=replace_with_failure):
            with self.assertRaises(OSError):
                atomic_write_graph(self.root, graph)

        self.assertEqual(graph_path.read_bytes(), original_graph)
        self.assertEqual(mirror_path.read_bytes(), original_mirror)


class QueueStateTests(unittest.TestCase):

    def test_state_is_durable_and_recovers_interrupted_processing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            batch_path = root / "batch.json"
            state_path = root / "state.json"
            shutil.copy2(BATCH, batch_path)
            store = QueueStateStore(batch_path, state_path)
            state = store.load(persist=True)
            arxiv_id = next(iter(state["records"]))
            store.start(arxiv_id)
            recovered = store.payload(recover_interrupted=True)
            self.assertEqual(
                recovered["records"][arxiv_id]["status"], "failed")
            self.assertEqual(
                recovered["records"][arxiv_id]["attempts"], 1)
            store.update(
                arxiv_id,
                "excluded",
                finished_at="2026-07-23T23:59:00Z",
                reason="Outside the semantic scope.",
            )
            reloaded = QueueStateStore(batch_path, state_path).payload()
            self.assertEqual(reloaded["excluded_count"], 1)

    def test_status_reads_do_not_recover_active_processing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            batch_path = root / "batch.json"
            state_path = root / "state.json"
            shutil.copy2(BATCH, batch_path)
            store = QueueStateStore(batch_path, state_path)
            state = store.load(persist=True)
            arxiv_id = next(iter(state["records"]))
            store.start(arxiv_id)

            status = store.payload()

            self.assertEqual(
                status["records"][arxiv_id]["status"], "processing")
            self.assertEqual(status["counts"]["processing"], 1)

    def test_malformed_queue_fields_are_normalized(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            batch_path = root / "batch.json"
            state_path = root / "state.json"
            shutil.copy2(BATCH, batch_path)
            store = QueueStateStore(batch_path, state_path)
            state = store.load(persist=True)
            arxiv_id = next(iter(state["records"]))
            state["records"][arxiv_id].update({
                "attempts": "many",
                "duration_s": -4,
                "reason": {"not": "text"},
                "finished_at": "2026-07-23T23:59:00Z",
                "full_text_source": {
                    "url": "https://arxiv.org/html/2607.20399",
                    "format": "arxiv-html",
                    "evidence": "Methods and experiments sections.",
                },
            })
            state_path.write_text(json.dumps(state), encoding="utf-8")

            normalized = store.load(persist=True)

            self.assertEqual(
                normalized["records"][arxiv_id]["attempts"], 0)
            self.assertIsNone(
                normalized["records"][arxiv_id]["duration_s"])
            self.assertIsNone(normalized["records"][arxiv_id]["reason"])
            self.assertEqual(
                normalized["records"][arxiv_id]["full_text_attested_at"],
                "2026-07-23T23:59:00Z",
            )

    def test_malformed_or_duplicate_batch_records_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "batch.json"
            batch = json.loads(BATCH.read_text(encoding="utf-8"))
            batch["records"].append(copy.deepcopy(batch["records"][0]))
            path.write_text(json.dumps(batch), encoding="utf-8")

            with self.assertRaises(BridgeContractError):
                load_batch(path)

    def test_full_text_attestation_must_match_observed_arxiv_fetch(self):
        record = json.loads(
            BATCH.read_text(encoding="utf-8"))["records"][0]
        source = {
            "url": f"https://arxiv.org/html/{record['arxiv_id']}",
            "format": "arxiv-html",
            "evidence": "Methods, experiments, and limitations sections.",
        }
        self.assertEqual(
            validate_full_text_source(record, source, [source["url"]]),
            [],
        )
        self.assertIn(
            "not observed",
            "; ".join(validate_full_text_source(record, source, [])),
        )
        wrong = {
            **source,
            "url": "https://arxiv.org/abs/" + record["arxiv_id"],
        }
        self.assertIn(
            "does not match its URL",
            "; ".join(validate_full_text_source(
                record, wrong, [wrong["url"]])),
        )

    def test_publisher_attestation_must_match_observed_full_text_fetch(self):
        record = {
            "canonical_url": "https://example.org/papers/adaptation",
        }
        source = {
            "url": "https://example.org/papers/adaptation.pdf",
            "format": "publisher-pdf",
            "evidence": "Methods, experiments, and limitations sections.",
        }

        self.assertEqual(
            validate_full_text_source(record, source, [source["url"]]),
            [],
        )
        self.assertIn(
            "not observed",
            "; ".join(validate_full_text_source(record, source, [])),
        )
        self.assertIn(
            "requires publisher",
            "; ".join(validate_full_text_source(
                record,
                {**source, "format": "arxiv-pdf"},
                [source["url"]],
            )),
        )

    def test_title_comparison_allows_readable_latex_math(self):
        self.assertEqual(
            comparable_title(
                r"Robust Policies with $\mathcal{L}_{1}$ Adaptive Control"),
            comparable_title("Robust Policies with L1 Adaptive Control"),
        )
        self.assertNotEqual(
            comparable_title("A Different Paper"),
            comparable_title("Robust Policies with L1 Adaptive Control"),
        )

    def test_batch_prompt_uses_manifest_policy_instead_of_legacy_filter(self):
        record = json.loads(
            BATCH.read_text(encoding="utf-8"))["records"][0]
        policy = {
            "description": "Verified adaptation ledger.",
            "evaluated_by": "selected-local-agent",
            "hard_requirements": [
                "Treat ledger membership as sufficient qualification.",
            ],
        }

        prompt = build_prompt(record, "queue run", policy)

        self.assertIn("Verified adaptation ledger.", prompt)
        self.assertIn(
            "Treat ledger membership as sufficient qualification.", prompt)
        self.assertIn("supersedes older domain-specific", prompt)

    def test_manual_prompt_treats_user_request_as_qualification(self):
        record = json.loads(
            BATCH.read_text(encoding="utf-8"))["records"][0]

        prompt = build_prompt(record, "manual import")

        self.assertIn(
            "Treat the user's request as sufficient topical qualification.",
            prompt,
        )
        self.assertIn("Insert every readable, non-duplicate paper.", prompt)

    @patch(
        "tools.agent_bridge.shutil.which",
        side_effect=lambda command: f"/usr/bin/{command}",
    )
    @patch("tools.agent_bridge.agent_profile", return_value={"startup_arguments": ["--safe-mode"]})
    def test_claude_command_uses_safe_mode_and_structured_output(self, _profile, _which):
        with tempfile.TemporaryDirectory() as workspace:
            command = build_agent_command(
                "claude", "test prompt", workspace, max_turns=12)
        self.assertEqual(command[0], "/usr/bin/claude")
        self.assertIn("--safe-mode", command)
        self.assertIn("--json-schema", command)
        self.assertIn("--no-session-persistence", command)
        self.assertNotIn("--restricted", command)

    @patch(
        "tools.agent_bridge.shutil.which",
        side_effect=lambda command: f"/usr/bin/{command}",
    )
    @patch("tools.agent_bridge.subprocess.run",
           return_value=subprocess.CompletedProcess([], 0, stdout='[{"name":"fixture-mcp"}]'))
    def test_codex_command_uses_local_sandbox_and_schema(self, _probe, _which):
        with tempfile.TemporaryDirectory() as workspace:
            command = build_agent_command(
                "codex", "test prompt", workspace, max_turns=12)
        self.assertEqual(command[:2], ["/usr/bin/codex", "exec"])
        self.assertIn("--ephemeral", command)
        self.assertIn("--output-schema", command)
        self.assertIn("sandbox_workspace_write.network_access=true", command)
        self.assertIn('mcp_servers.fixture-mcp.enabled=false', command)
        self.assertIn("features.plugins=false", command)
        probe = _probe.call_args.args[0]
        self.assertIn("features.plugins=false", probe)
        self.assertIn("features.apps=false", probe)
        self.assertEqual(probe[-3:], ["mcp", "list", "--json"])

    @patch(
        "tools.agent_bridge.shutil.which",
        side_effect=lambda command: f"/usr/bin/{command}",
    )
    def test_revalidation_command_is_read_only_for_claude(self, _which):
        with tempfile.TemporaryDirectory() as workspace:
            command = build_agent_command(
                "claude",
                build_revalidation_prompt(
                    self_record := json.loads(
                        BATCH.read_text(encoding="utf-8"))["records"][0],
                    "inserted",
                    "paper:test",
                ),
                workspace,
                read_only=True,
            )
        tools = command[command.index("--tools") + 1]
        self.assertEqual(tools, "WebFetch,Read,Glob,Grep")
        self.assertNotIn("Edit", command)
        self.assertNotIn("Write", command)
        prompt = command[command.index("-p") + 1]
        self.assertIn(self_record["arxiv_id"], prompt)
        self.assertIn("Do not edit, write, or create any file", prompt)


if __name__ == "__main__":
    unittest.main()
