import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.agent_settings import model_catalog, normalize_settings, settings_arguments
from tools.agent_bridge import build_agent_command
from tools.research import research_command


class AgentSettingsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {'CODEX_HOME': temp.name})
        env.start()
        self.addCleanup(env.stop)

    def test_defaults_and_explicit_cli_defaults(self):
        self.assertEqual(normalize_settings('codex'), {'model': 'gpt-5.6-sol', 'effort': 'medium'})
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

    def test_reads_only_visible_models_and_supported_efforts_from_codex_cache(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'CODEX_HOME': root}):
            Path(root, 'models_cache.json').write_text(json.dumps({'models': [
                {'slug': 'example-model', 'display_name': 'Example', 'visibility': 'list',
                 'supported_reasoning_levels': [{'effort': 'medium'}, {'effort': 'high'}]},
                {'slug': 'hidden', 'visibility': 'hide'}]}))
            self.assertEqual(model_catalog('codex'), [{'id': 'example-model', 'label': 'Example', 'efforts': ['medium', 'high']}])
            with self.assertRaises(ValueError):
                normalize_settings('codex', {'model': 'example-model', 'effort': 'low'})

    @patch('tools.agent_bridge.shutil.which', side_effect=lambda p: '/usr/bin/' + p)
    def test_both_workflows_pass_selected_settings_without_changing_sandbox(self, _which):
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
                    else:
                        self.assertEqual(command[command.index('--effort') + 1], effort)
