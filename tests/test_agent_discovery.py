import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools import agent_discovery as discovery

CLI = r'''
import json, os, pathlib, sys
log = pathlib.Path(__file__).with_suffix(".requests")
if "--version" in sys.argv:
    print("codex-cli 0.167.42")
    sys.exit()
if "--help" in sys.argv:
    print("--effort --safe-mode" if pathlib.Path(__file__).stem == "claude" else "--effort")
    sys.exit()
for line in sys.stdin:
    request = json.loads(line)
    with log.open("a") as out:
        out.write(json.dumps({"request": request, "args": sys.argv[1:],
                              "desktop_token_present": "ORBIS_DESKTOP_TOKEN" in os.environ}) + "\n")
    method = request.get("method")
    if method == "initialize":
        result = {"userAgent": "orbis/2.1.0"}
    elif method == "initialized":
        continue
    elif method == "model/list":
        second = bool(request["params"].get("cursor"))
        model = {
            "id": ("us" if second else "global") + ".openai.gpt-example",
            "model": ("us" if second else "global") + ".openai.gpt-example",
            "displayName": "Example", "isDefault": not second,
            "defaultReasoningEffort": "low",
            "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}],
        }
        result = {"data": [model, {"hidden": True}], "nextCursor": None if second else "page-two"}
    elif method == "config/read":
        result = {"config": {"model": "global.openai.gpt-example", "model_reasoning_effort": "medium",
                             "private_credential": "do-not-export"}}
    elif request.get("type") == "control_request":
        subtype = request["request"]["subtype"]
        if subtype == "initialize":
            result = {
                "models": [
                    {"value": "default", "resolvedModel": "claude-opus-example", "displayName": "Default",
                     "supportedEffortLevels": ["low", "medium", "high"]},
                    {"value": "sonnet", "resolvedModel": "claude-sonnet-example", "displayName": "Sonnet",
                     "supportedEffortLevels": ["low", "medium"]},
                    {"value": "fable", "displayName": "Fable", "supportedEffortLevels": ["high", "max"]},
                ],
                "claude_code_version": "2.1.319",
                "session_state": "opaque-do-not-import",
                "account": {"private_credential": "do-not-export"},
            }
        elif subtype == "get_settings":
            result = {"effective": {"model": "sonnet", "effortLevel": "low",
                                   "env": {"PRIVATE_API_KEY": "do-not-export"}}}
        else:
            raise AssertionError("No agent turn may be started")
        print(json.dumps({"type": "control_response", "response": {
            "subtype": "success", "request_id": request["request_id"], "response": result}}), flush=True)
        continue
    else:
        raise AssertionError("No agent turn may be started")
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
'''


class AgentDiscoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        discovery._cache.clear()
        self.addCleanup(discovery._cache.clear)

    def cli(self, name):
        file = self.root / name
        file.write_text(f"#!{sys.executable}\n" + CLI)
        file.chmod(0o700)
        return str(file)

    def requests(self, command):
        return [json.loads(line) for line in Path(command).with_suffix('.requests').read_text().splitlines()]

    def test_codex_handshake_pagination_provider_ids_and_cache_without_turns(self):
        command = self.cli('codex')
        with patch.dict(os.environ, {'ORBIS_DESKTOP_TOKEN': 'fixture-secret'}):
            profile = discovery.agent_profile('codex', [command])
        self.assertEqual(profile['model_source'], 'cli')
        self.assertEqual(profile['cli_version'], '0.167.42')
        self.assertEqual([m['id'] for m in profile['models']],
                         ['global.openai.gpt-example', 'us.openai.gpt-example'])
        self.assertEqual(profile['models'][0]['aliases'], ['gpt-example'])
        self.assertNotIn('aliases', profile['models'][1])
        self.assertEqual(profile['default_effort'], 'medium')
        self.assertEqual(profile['default_efforts'], ['low', 'medium'])
        requests = self.requests(command)
        self.assertEqual([r['request']['method'] for r in requests],
                         ['initialize', 'initialized', 'model/list', 'model/list', 'config/read'])
        self.assertTrue(all(not r['desktop_token_present'] for r in requests))
        self.assertNotIn('do-not-export', json.dumps(profile))
        profile['models'].clear()
        cached = discovery.agent_profile('codex', [command])
        self.assertEqual(len(cached['models']), 2)
        self.assertEqual(len(self.requests(command)), len(requests))

    def test_claude_reports_new_aliases_and_effective_settings_without_opaque_state(self):
        command = self.cli('claude')
        with patch.dict(os.environ, {'ANTHROPIC_MODEL': '', 'CLAUDE_CODE_EFFORT_LEVEL': ''}):
            profile = discovery.agent_profile('claude', [command])
        self.assertEqual(profile['model_source'], 'cli')
        self.assertEqual([m['id'] for m in profile['models']], ['sonnet', 'fable'])
        self.assertEqual(profile['default_model'], 'sonnet')
        self.assertEqual(profile['default_model_label'], 'Sonnet')
        self.assertEqual(profile['default_effort'], 'low')
        self.assertEqual(profile['default_efforts'], ['low', 'medium'])
        self.assertEqual(profile['startup_arguments'], ['--safe-mode'])
        self.assertNotIn('do-not-export', json.dumps(profile))
        self.assertNotIn('opaque', json.dumps(profile))
        for request in self.requests(command):
            self.assertNotIn('--bare', request['args'])
            self.assertNotIn('--restricted', request['args'])
            self.assertEqual(request['request']['type'], 'control_request')

    def test_stock_claude_without_safe_mode_keeps_auth_and_disables_hooks(self):
        command = self.cli('stock-claude')
        profile = discovery.agent_profile('claude', [command])
        self.assertEqual(profile['model_source'], 'cli')
        self.assertEqual(profile['startup_arguments'], ['--settings', '{"disableAllHooks":true}'])
        self.assertNotIn('--safe-mode', self.requests(command)[0]['args'])

    def test_custom_default_does_not_borrow_another_models_effort_levels(self):
        command = self.cli('claude')
        with patch.dict(os.environ, {'ANTHROPIC_MODEL': 'my-deployment'}):
            profile = discovery.agent_profile('claude', [command])
        self.assertEqual(profile['default_model'], 'my-deployment')
        self.assertEqual(profile['default_model_label'], 'my-deployment')
        self.assertEqual(profile['default_efforts'], [])

    def test_missing_or_unresponsive_cli_returns_no_invented_models(self):
        missing = discovery.agent_profile('codex', [str(self.root / 'missing')])
        self.assertEqual(missing['models'], [])
        hanging = self.root / 'hanging'
        hanging.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(60)\n')
        hanging.chmod(0o700)
        with patch.object(discovery, 'PROBE_TIMEOUT', 0.2):
            failed = discovery.agent_profile('codex', [str(hanging)])
        self.assertEqual(failed['models'], [])
        self.assertEqual(failed['model_source'], 'unavailable')
        self.assertIn('CLI default remains available', failed['model_error'])


if __name__ == '__main__':
    unittest.main()
