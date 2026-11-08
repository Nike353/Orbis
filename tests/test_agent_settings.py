import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.agent_settings import model_catalog, normalize_settings, settings_arguments
from tools.agent_bridge import build_agent_command, codex_tool_restrictions, BridgeContractError
from tools.research import research_command


class AgentSettingsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {'CODEX_HOME': temp.name})
        env.start()
        self.addCleanup(env.stop)
        self.profiles = {
            'codex': {
                'models': [
                    {'id': 'gpt-5.6-sol', 'label': 'Sol', 'efforts': ['low', 'medium', 'high', 'ultra']},
                    {'id': 'gpt-5.5', 'label': 'Example', 'efforts': ['low', 'medium', 'high', 'xhigh']},
                ], 'default_efforts': ['low', 'medium', 'high'], 'model_source': 'cli',
            },
            'claude': {
                'models': [{'id': 'opus', 'label': 'Opus', 'efforts': ['low', 'medium', 'high']},
                           {'id': 'haiku', 'label': 'Haiku', 'efforts': []}],
                'default_efforts': ['low', 'medium', 'high'], 'model_source': 'cli',
                'startup_arguments': ['--safe-mode'],
            },
        }
        for target in ('tools.agent_settings.agent_profile', 'tools.agent_bridge.agent_profile',
                       'tools.research.agent_profile'):
            probe = patch(target, side_effect=lambda agent, command=None: self.profiles[agent])
            probe.start()
            self.addCleanup(probe.stop)

    def test_defaults_and_explicit_cli_defaults(self):
        self.assertEqual(normalize_settings('codex'), {'model': '', 'effort': 'medium'})
        self.assertEqual(settings_arguments('codex', {}), [])
        self.assertEqual(settings_arguments('claude', {}), [])

    def test_settings_reject_invalid_arguments_and_combinations(self):
        for value in ({'model': '--dangerously-bypass'}, {'model': 'x; echo bad'},
                      {'model': 'gpt-5.5', 'effort': 'ultra'}, {'effort': 'everything'},
                      {'command': 'echo'}, [], {'model': 5}):
            with self.assertRaises(ValueError):
                normalize_settings('codex', value)
        with self.assertRaises(ValueError):
            normalize_settings('claude', {'model': 'haiku', 'effort': 'high'})
        with self.assertRaises(ValueError):
            normalize_settings('claude', {'effort': 'ultra'})

    def test_uses_reported_efforts_and_repairs_legacy_provider_ids(self):
        self.profiles['codex']['models'] = [
            {'id': 'global.openai.gpt-5.6-sol', 'label': 'Sol', 'efforts': ['medium', 'high'],
             'aliases': ['gpt-5.6-sol']}]
        self.assertEqual(model_catalog('codex'), self.profiles['codex']['models'])
        self.assertEqual(normalize_settings('codex', {'model': 'gpt-5.6-sol', 'effort': 'medium'}),
                         {'model': 'global.openai.gpt-5.6-sol', 'effort': 'medium'})
        with self.assertRaises(ValueError):
            normalize_settings('codex', {'model': 'gpt-5.6-sol', 'effort': 'low'})
        self.profiles['claude']['models'][1]['efforts'] = ['low', 'medium']
        self.assertEqual(settings_arguments('claude', {'model': 'haiku', 'effort': 'medium'}),
                         ['--model', 'haiku', '--effort', 'medium'])

    @patch('tools.agent_bridge.shutil.which', side_effect=lambda p: '/usr/bin/' + p)
    @patch('tools.research.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout='[{"name":"fixture-mcp"}]'))
    def test_both_workflows_pass_selected_settings_without_changing_sandbox(self, _probe, _which):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for agent, model, effort in [('codex', 'gpt-5.5', 'high'), ('claude', 'opus', 'medium')]:
                settings = {'model': model, 'effort': effort}
                for command in [build_agent_command(agent, 'Read it', root, settings=settings),
                                research_command(agent, root, settings)]:
                    self.assertEqual(command[command.index('--model') + 1], model)
                    if agent == 'codex':
                        self.assertIn('model_reasoning_effort="high"', command)
                        self.assertIn('--sandbox', command)
                        if command[command.index('--sandbox') + 1] == 'read-only':
                            self.assertIn('features.shell_tool=false', command)
                            self.assertIn('mcp_servers.fixture-mcp.enabled=false', command)
                    else:
                        self.assertEqual(command[command.index('--effort') + 1], effort)

    def test_mcp_names_cannot_change_the_override_path(self):
        for name in ('nested.server', '"quoted"', 'space name', ''):
            with self.subTest(name=name), patch('tools.agent_bridge.subprocess.run',
                    return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps([{'name': name}]))):
                with self.assertRaisesRegex(BridgeContractError, 'Cannot restrict Codex'):
                    codex_tool_restrictions(['codex'], read_only=True)
