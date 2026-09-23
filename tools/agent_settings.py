"""Validated per-run model overrides. Never invokes a shell or reads credentials."""
import json
import os
import re
from pathlib import Path

EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
MODEL_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,159}\Z')


def model_catalog(agent):
    if agent == 'codex':
        # Codex refreshes this catalog itself. Do not initiate an agent run merely
        # to populate a selector; fresh account availability is checked by the CLI.
        path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'models_cache.json'
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            models = []
            for item in data.get('models', []):
                slug = item.get('slug', '')
                if item.get('visibility') != 'list' or not MODEL_ID.fullmatch(slug):
                    continue
                levels = [v['effort'] for v in item.get('supported_reasoning_levels', [])
                          if v.get('effort') in EFFORTS]
                models.append({'id': slug, 'label': item.get('display_name', slug), 'efforts': levels})
            if models:
                return models
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            pass
        return [
            {'id': 'gpt-5.6-sol', 'label': 'GPT-5.6 Sol', 'efforts': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']},
            {'id': 'gpt-5.5', 'label': 'GPT-5.5', 'efforts': ['low', 'medium', 'high', 'xhigh']},
        ]
    if agent == 'claude':
        # Stable CLI aliases. Account and model-specific support is checked by Claude.
        return [
            {'id': 'sonnet', 'label': 'Sonnet (CLI alias)', 'efforts': ['low', 'medium', 'high']},
            {'id': 'opus', 'label': 'Opus (CLI alias)', 'efforts': ['low', 'medium', 'high', 'xhigh', 'max']},
            {'id': 'haiku', 'label': 'Haiku (CLI alias)', 'efforts': []},
        ]
    raise ValueError('Unknown local agent.')


def normalize_settings(agent, value=None):
    if value is None:
        value = {'model': 'gpt-5.6-sol', 'effort': 'medium'} if agent == 'codex' else {}
    if not isinstance(value, dict) or set(value) - {'model', 'effort'}:
        raise ValueError('Agent settings must contain only model and effort.')
    model, effort = value.get('model', ''), value.get('effort', '')
    if not isinstance(model, str) or (model and not MODEL_ID.fullmatch(model)):
        raise ValueError('Use a model ID or CLI alias, without spaces or command flags.')
    if not isinstance(effort, str) or effort not in ['', *EFFORTS]:
        raise ValueError('Unknown reasoning effort.')
    if agent == 'claude' and effort not in ['', 'low', 'medium', 'high', 'xhigh', 'max']:
        raise ValueError('Claude Code does not support that effort level.')
    known = next((m for m in model_catalog(agent) if m['id'] == model), None)
    if known and effort and effort not in known['efforts']:
        raise ValueError(f'{model} does not support {effort} effort. Choose a supported level or CLI default.')
    return {'model': model, 'effort': effort}


def settings_arguments(agent, value=None):
    settings = normalize_settings(agent, value)
    args = ['--model', settings['model']] if settings['model'] else []
    if settings['effort']:
        args += (['-c', 'model_reasoning_effort=' + json.dumps(settings['effort'])]
                 if agent == 'codex' else ['--effort', settings['effort']])
    return args
