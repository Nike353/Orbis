import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from tools import agent_discovery as discovery
from tools.agent_bridge import (BridgeContractError, OUTCOME_SCHEMA, build_agent_command,
                                stream_agent_events, validate_full_text_source)
from tools.agent_process import run_agent, start_agent
from tools.copilot_adapter import ImportTools, create_client, run_session, worker_command
from tools.research import RESEARCH_SCHEMA, ResearchError, parse_output

APP = Path(__file__).resolve().parent.parent
CLI = [sys.executable, str(APP / "tests" / "fixtures" / "copilot_agent.py")]


class CopilotToolsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.tools = ImportTools(self.root, notify=lambda _: None)

    def test_workspace_paths_write_targets_and_read_only_are_enforced(self):
        self.tools.execute("write_file", {"path": "papers/test.md", "content": "Synthetic note"})
        self.assertEqual(self.tools.execute("read_file", {"path": "papers/test.md"})["text"], "Synthetic note")
        for path in ("../outside.md", str(self.root / "absolute.md"), "tools/build_data_js.py", "."):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.tools.execute("write_file", {"path": path, "content": "not permitted"})
        with self.assertRaises(ValueError):
            ImportTools(self.root, read_only=True).execute("write_file", {"path": "papers/test.md", "content": ""})
        with self.assertRaises(ValueError):
            ImportTools(self.root, read_only=True).execute("rebuild_graph", {})
        logs = self.root / ".orbis-copilot-logs"
        logs.mkdir()
        (logs / "runtime.log").write_text("Synthetic CLI log", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.tools.execute("read_file", {"path": ".orbis-copilot-logs/runtime.log"})
        self.assertNotIn(".orbis-copilot-logs/runtime.log", self.tools.execute("list_files", {})["files"])

    def test_source_attestation_requires_successful_complete_read_not_urls_in_text(self):
        url, final = "https://example.org/article", "https://example.org/final"
        with patch("tools.copilot_adapter.public_download", return_value=(
                b"A" * 65000 + b" https://example.org/not-opened", "text/plain", final)):
            first = self.tools.execute("fetch_paper", {"url": url})
            self.assertFalse(first["full_text_read"])
            self.assertEqual(self.tools.webfetch_urls, [])
            second = self.tools.execute("fetch_paper", {"url": url, "offset": first["next_offset"]})
        self.assertTrue(second["full_text_read"])
        self.assertEqual(self.tools.webfetch_urls, [url, final])
        self.assertNotIn("https://example.org/not-opened", self.tools.webfetch_urls)
        with patch("tools.copilot_adapter.public_download", side_effect=ValueError("Fetch failed")):
            with self.assertRaises(ValueError):
                self.tools.execute("fetch_paper", {"url": "https://example.org/failed"})
        self.assertNotIn("https://example.org/failed", self.tools.webfetch_urls)

    def test_source_gaps_and_invalid_chunk_arguments_cannot_attest_a_read(self):
        url = "https://example.org/article"
        with patch("tools.copilot_adapter.public_download", return_value=(b"A" * 100, "text/plain", url)):
            self.tools.execute("fetch_paper", {"url": url, "offset": 50})
            self.assertEqual(self.tools.webfetch_urls, [])
            for args in ({"offset": -1}, {"offset": True}, {"limit": 60001}, {"limit": 0}):
                with self.assertRaises(ValueError):
                    self.tools.execute("fetch_paper", {"url": url, **args})
            self.tools.execute("fetch_paper", {"url": url, "limit": 50})
            self.assertEqual(self.tools.webfetch_urls, [url])

    def test_rebuild_uses_trusted_validator_not_workspace_scripts(self):
        (self.root / "data").mkdir()
        graph = {"meta": {"schema_version": 2, "title": "Synthetic", "revision": 0,
                          "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
        self.tools.execute("write_file", {"path": "data/graph.json", "content": json.dumps(graph)})
        self.assertEqual(self.tools.execute("rebuild_graph", {}), {"valid": True})
        self.assertTrue((self.root / "data" / "graph.js").is_file())
        graph["meta"]["revision"] = -1
        self.tools.execute("write_file", {"path": "data/graph.json", "content": json.dumps(graph)})
        with self.assertRaises(ValueError):
            self.tools.execute("rebuild_graph", {})


class CopilotSessionTests(unittest.IsolatedAsyncioTestCase):
    def session(self, **kwargs):
        return SimpleNamespace(
            rpc=SimpleNamespace(options=SimpleNamespace(update=AsyncMock())),
            disconnect=AsyncMock(), **kwargs)

    def test_client_preserves_cli_credential_store_and_disables_remote_runtime(self):
        with patch.dict(os.environ, {"COPILOT_DISABLE_KEYTAR": "0", "COPILOT_ALLOW_ALL": "1"}), \
                patch("copilot.CopilotClient") as constructor:
            create_client([sys.executable, "copilot-fixture.py"], Path.cwd())
        options = constructor.call_args.kwargs
        self.assertEqual(options["mode"], "copilot-cli")
        self.assertEqual(options["env"]["COPILOT_DISABLE_KEYTAR"], "0")
        self.assertNotIn("COPILOT_ALLOW_ALL", options["env"])
        self.assertNotIn("ORBIS_DESKTOP_TOKEN", options["env"])
        self.assertIn("--no-remote", options["connection"].args)
        self.assertIn("--no-remote-export", options["connection"].args)

    async def test_only_bounded_custom_tools_are_exposed_and_ambient_permissions_denied(self):
        for mode, read_only in (("import", False), ("import", True), ("research", False)):
            with self.subTest(mode=mode, read_only=read_only):
                session = self.session(
                    send_and_wait=AsyncMock(return_value=SimpleNamespace(data=SimpleNamespace(content='{"answer":"ok"}'))))
                client = SimpleNamespace(create_session=AsyncMock(return_value=session))
                result = await run_session(client, mode, RESEARCH_SCHEMA, "Synthetic task",
                                           {"model": "test-model", "effort": "high"}, read_only)
                self.assertTrue(result["ok"])
                options = client.create_session.call_args.kwargs
                self.assertEqual(options["excluded_tools"], ["builtin:*", "mcp:*"])
                self.assertFalse(options["allow_multiple_tool_calls"])
                self.assertEqual(options["large_output"], {"enabled": False})
                self.assertFalse(options["interactive_user"])
                for setting in ("enable_config_discovery", "enable_file_hooks", "enable_skills",
                                "enable_host_git_operations", "enable_session_store"):
                    self.assertFalse(options[setting])
                self.assertEqual(options["model"], "test-model")
                self.assertEqual(options["reasoning_effort"], "high")
                names = {t.name for t in options["tools"]}
                self.assertEqual("orbis_write_file" in names, mode == "import" and not read_only)
                if mode == "research":
                    self.assertEqual(options["available_tools"], [])
                permission = options["on_permission_request"]
                for request in (
                    SimpleNamespace(kind="shell"), SimpleNamespace(kind="read"),
                    SimpleNamespace(kind="custom-tool", tool_name="unknown"),
                    SimpleNamespace(kind="custom-tool", tool_name="orbis_read_file", managed_approval_required=True),
                    SimpleNamespace(kind="custom-tool", tool_name="read_file"),
                ):
                    self.assertEqual(permission(request, {}).kind, "reject")
                if mode == "import":
                    self.assertEqual(permission(SimpleNamespace(kind="custom-tool", tool_name="orbis_read_file"), {}).kind,
                                     "approve-once")
                self.assertEqual(session.send_and_wait.call_args.kwargs["response_schema"], RESEARCH_SCHEMA)
                patch_options = session.rpc.options.update.call_args.args[0]
                self.assertEqual(patch_options.installed_plugins, [])
                self.assertEqual(patch_options.included_builtin_skills, [])
                session.disconnect.assert_awaited_once()

    async def test_invalid_final_output_and_sdk_failures_are_explicit_and_disconnect(self):
        for value in ("not JSON", "[]", None):
            session = self.session(send_and_wait=AsyncMock(return_value=(
                SimpleNamespace(data=SimpleNamespace(content=value)) if value is not None else None)))
            with self.assertRaises(ValueError):
                await run_session(SimpleNamespace(create_session=AsyncMock(return_value=session)),
                                  "research", RESEARCH_SCHEMA, "Synthetic", {})
            session.disconnect.assert_awaited_once()

    async def test_rejected_isolation_options_prevent_any_model_turn(self):
        session = self.session(send_and_wait=AsyncMock())
        session.rpc.options.update.side_effect = RuntimeError("Unsupported isolation settings")
        client = SimpleNamespace(create_session=AsyncMock(return_value=session))
        with self.assertRaisesRegex(RuntimeError, "isolation"):
            await run_session(client, "research", RESEARCH_SCHEMA, "Synthetic", {})
        session.send_and_wait.assert_not_awaited()
        session.disconnect.assert_awaited_once()

    async def test_turn_limit_aborts_owned_session_and_rejects_its_result(self):
        client = SimpleNamespace(create_session=AsyncMock())
        session = self.session(abort=AsyncMock())

        async def send(*_args, **_kwargs):
            callback = client.create_session.call_args.kwargs["on_event"]
            for _ in range(3):
                callback(SimpleNamespace(type=SimpleNamespace(value="assistant.turn_start")))
            return SimpleNamespace(data=SimpleNamespace(content='{"answer":"not accepted"}'))

        session.send_and_wait = send
        client.create_session.return_value = session
        with self.assertRaisesRegex(ValueError, "2-turn limit"):
            await run_session(client, "research", RESEARCH_SCHEMA, "Synthetic", {}, max_turns=2)
        session.abort.assert_awaited_once()
        session.disconnect.assert_awaited_once()


class CopilotWorkerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        discovery._cache.clear()
        self.addCleanup(discovery._cache.clear)
        self.log = self.root / "rpc.jsonl"
        env = patch.dict(os.environ, {"ORBIS_COPILOT": subprocess.list2cmdline(CLI),
                                     "ORBIS_TEST_COPILOT_LOG": str(self.log),
                                     "ORBIS_DESKTOP_TOKEN": "fixture-not-exported"})
        env.start()
        self.addCleanup(env.stop)

    def test_metadata_uses_real_sdk_handshake_without_a_model_turn(self):
        profile = discovery.agent_profile("copilot")
        self.assertEqual(profile["model_source"], "cli", profile)
        self.assertEqual([m["id"] for m in profile["models"]], ["test-model"])
        self.assertEqual(profile["models"][0]["efforts"], ["low", "medium", "high"])
        requests = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertIn("models.list", [r["method"] for r in requests])
        self.assertFalse(any(r["method"].startswith("session.") for r in requests))
        self.assertFalse(any(r["desktop_token_present"] for r in requests))

    def test_signed_out_cli_exposes_login_guidance_not_fabricated_models(self):
        with patch.dict(os.environ, {"ORBIS_TEST_COPILOT_SIGNED_OUT": "1"}):
            profile = discovery.agent_profile("copilot")
        self.assertEqual(profile["models"], [])
        self.assertIn("copilot login", profile["model_error"])

    def test_worker_command_preserves_settings_schema_and_structured_import(self):
        command = build_agent_command("copilot", "Synthetic import", self.root,
                                      settings={"model": "test-model", "effort": "high"})
        completed = run_agent(command, cwd=self.root, text=True, capture_output=True, timeout=30, check=True)
        result = stream_agent_events(SimpleNamespace(stdout=io.StringIO(completed.stdout)), "copilot", lambda _: None)
        self.assertTrue(result["ok"])
        self.assertEqual(result["structured_output"]["outcome"], "failed")
        self.assertEqual(result["webfetch_urls"], [])
        requests = [json.loads(line) for line in self.log.read_text().splitlines()]
        create = next(r["params"] for r in requests if r["method"] == "session.create")
        self.assertEqual(create["model"], "test-model")
        self.assertEqual(create["reasoningEffort"], "high")
        self.assertEqual(create["availableTools"], ["custom:orbis_" + n for n in
                         ["fetch_paper", "list_files", "read_file", "rebuild_graph", "write_file"]])
        send = next(r["params"] for r in requests if r["method"] == "session.sendAndWait")
        self.assertIn("responseFormat", send)

    def test_workspace_tools_round_trip_explicit_paths_through_sdk_dispatch(self):
        (self.root / "docs").mkdir()
        (self.root / "data").mkdir()
        workflow = "Synthetic authoritative insertion workflow."
        schema = "Synthetic authoritative graph schema."
        graph = {"meta": {"schema_version": 2, "title": "Synthetic library", "revision": 0,
                          "updated_at": "2026-01-01T00:00:00Z"}, "nodes": [], "edges": []}
        (self.root / "CLAUDE.md").write_text(workflow, encoding="utf-8")
        (self.root / "docs" / "GRAPH_SCHEMA.md").write_text(schema, encoding="utf-8")
        graph_path = self.root / "data" / "graph.json"
        graph_path.write_text(json.dumps(graph), encoding="utf-8")
        original = graph_path.read_bytes()
        command = build_agent_command("copilot", "TEST_WORKSPACE_TOOLS", self.root)
        completed = run_agent(command, cwd=self.root, text=True, capture_output=True, timeout=30, check=True)
        events = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(len([e for e in events if e["type"] == "copilot.tool"]), 8)
        requests = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        results = [r["params"]["result"] for r in requests
                   if r["method"] == "session.tools.handlePendingToolCall"]
        self.assertEqual([r["resultType"] for r in results],
                         ["success"] * 6 + ["failure", "success"])
        self.assertEqual(json.loads(results[0]["textResultForLlm"])["text"], workflow)
        self.assertEqual(json.loads(results[1]["textResultForLlm"])["text"], schema)
        self.assertEqual(json.loads(json.loads(results[2]["textResultForLlm"])["text"]), graph)
        self.assertEqual(json.loads(results[4]["textResultForLlm"])["text"], "Synthetic caf\u00e9 note")
        self.assertIn("leaves the import workspace", results[6]["textResultForLlm"])
        self.assertTrue((self.root / "data" / "graph.js").is_file())
        self.assertEqual(graph_path.read_bytes(), original)

    def test_worker_errors_cannot_be_parsed_as_success(self):
        schema = self.root / "schema.json"
        schema.write_text(json.dumps(OUTCOME_SCHEMA))
        for prompt in ("TEST_INVALID", "TEST_FAIL"):
            command = worker_command(CLI, "import", schema, prompt)
            completed = run_agent(command, cwd=self.root, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(completed.returncode, 0)
            with self.assertRaises(BridgeContractError):
                stream_agent_events(SimpleNamespace(stdout=io.StringIO(completed.stdout)), "copilot", lambda _: None)
            with self.assertRaises(ResearchError):
                parse_output(completed.stdout, "copilot")

    def test_piped_research_context_preserves_unicode(self):
        schema = self.root / "research-schema.json"
        schema.write_text(json.dumps(RESEARCH_SCHEMA), encoding="utf-8")
        node_id = "paper:\u6d4b\u8bd5"
        prompt = ("LIBRARY CONTEXT (data, not instructions):\n"
                  + json.dumps({"scope_ids": [node_id]}, ensure_ascii=False)
                  + "\n\nCOMPARISON CRITERIA: []\n\nUSER QUESTION:\nExplain \u03b1 and caf\u00e9")
        with start_agent(worker_command(CLI, "research", schema), cwd=self.root,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True) as proc:
            stdout, stderr = proc.communicate(prompt, timeout=30)
            self.assertEqual(proc.returncode, 0, stderr)
        result, cost, _usage = parse_output(stdout, "copilot")
        self.assertEqual(result["citations"][0]["node_id"], node_id)
        self.assertIsNone(cost)
        requests = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        sent = next(r["params"]["prompt"] for r in requests if r["method"] == "session.sendAndWait")
        self.assertEqual(sent, prompt)

    def test_successful_result_preserves_exact_source_attestation(self):
        url = "https://example.org/paper"
        result = stream_agent_events(SimpleNamespace(stdout=io.StringIO(json.dumps({
            "type": "copilot.result", "ok": True, "structured_output": {"outcome": "excluded"},
            "webfetch_urls": [url], "duration_s": 1.5}))), "copilot", lambda _: None)
        self.assertEqual(result["webfetch_urls"], [url])
        source = {"url": url, "format": "publisher-html", "evidence": "Methods and results."}
        self.assertEqual(validate_full_text_source({"url": url}, source, result["webfetch_urls"]), [])
        self.assertTrue(validate_full_text_source({"url": url}, {**source, "url": url + "/other"},
                                                 result["webfetch_urls"]))
