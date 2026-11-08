"""Validated per-run overrides using the installed CLI's model metadata."""
import json
try:
    from agent_discovery import EFFORTS, MODEL_ID, agent_profile
except ModuleNotFoundError:
    from tools.agent_discovery import EFFORTS, MODEL_ID, agent_profile


def model_catalog(agent):
    return agent_profile(agent)['models']


def normalize_settings(agent, value=None):
    profile = agent_profile(agent)
    if value is None:
        value = {'model': '', 'effort': 'medium' if 'medium' in profile['default_efforts'] else ''}
    if not isinstance(value, dict) or set(value) - {'model', 'effort'}:
        raise ValueError('Agent settings must contain only model and effort.')
    model, effort = value.get('model', ''), value.get('effort', '')
    if not isinstance(model, str) or (model and not MODEL_ID.fullmatch(model)):
        raise ValueError('Use a model ID or CLI alias, without spaces or command flags.')
    if not isinstance(effort, str) or effort not in ['', *EFFORTS]:
        raise ValueError('Unknown reasoning effort.')
    if agent == 'claude' and effort not in ['', 'low', 'medium', 'high', 'xhigh', 'max']:
        raise ValueError('Claude Code does not support that effort level.')
    known = next((m for m in profile['models']
                  if m['id'] == model or model in m.get('aliases', [])), None)
    if known:
        model = known['id']
    levels = known['efforts'] if known else profile['default_efforts'] if not model else None
    if levels is not None and profile['model_source'] == 'cli' and effort and effort not in levels:
        raise ValueError(f'{model or "CLI default"} does not support {effort} effort. Choose a supported level or CLI default.')
    if agent == 'claude' and effort and profile.get('supports_effort') is False:
        raise ValueError('Update Claude Code to use reasoning effort, or choose CLI default.')
    return {'model': model, 'effort': effort}


def settings_arguments(agent, value=None):
    settings = normalize_settings(agent, value)
    args = ['--model', settings['model']] if settings['model'] else []
    if settings['effort']:
        args += (['-c', 'model_reasoning_effort=' + json.dumps(settings['effort'])]
                 if agent == 'codex' else ['--effort', settings['effort']])
    return args
