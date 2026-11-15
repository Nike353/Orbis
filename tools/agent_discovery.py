"""Read model metadata from installed CLIs without starting an agent turn."""
import copy
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager

try:
    from branding import env_setting
    from agent_process import command_parts, start_agent, stop_agent, run_agent
except ModuleNotFoundError:
    from tools.branding import env_setting
    from tools.agent_process import command_parts, start_agent, stop_agent, run_agent

EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
MODEL_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,159}\Z')
PROBE_TIMEOUT = 8
_cache = {}
_cache_lock = threading.RLock()


def agent_environment():
    return {key: value for key, value in os.environ.items()
            if key not in {"ORBIS_DESKTOP_TOKEN", "ORBIS_GOOGLE_CLIENT_JSON"}}


@contextmanager
def metadata_process(command, directory):
    proc = start_agent(command, cwd=directory, env=agent_environment(),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    messages = queue.Queue(maxsize=256)

    def read():
        try:
            for line in proc.stdout:
                if len(line) > 2 * 1024 * 1024:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    messages.put_nowait(message)
        except (OSError, ValueError, queue.Full):
            pass
        finally:
            try:
                messages.put_nowait(None)
            except queue.Full:
                pass

    reader = threading.Thread(target=read, daemon=True)
    reader.start()

    def exchange(request, identifier):
        proc.stdin.write(json.dumps(request) + '\n')
        proc.stdin.flush()
        deadline = time.monotonic() + PROBE_TIMEOUT
        while True:
            message = messages.get(timeout=max(0, deadline - time.monotonic()))
            if message is None:
                raise ValueError("CLI closed its metadata connection")
            if message.get('id') == identifier:
                if 'error' in message:
                    raise ValueError("CLI rejected model discovery")
                return message['result']
            response = message.get('response')
            if isinstance(response, dict) and response.get('request_id') == identifier:
                if response.get('subtype') == 'error':
                    raise ValueError("CLI rejected model discovery")
                return response['response']

    try:
        yield proc, exchange
    finally:
        stop_agent(proc)
        proc.wait(timeout=5)
        reader.join(timeout=1)
        proc.stdin.close()
        proc.stdout.close()


def model_record(identifier, label, efforts, description='', **extra):
    if not isinstance(identifier, str) or not MODEL_ID.fullmatch(identifier):
        raise ValueError("Invalid CLI model identifier")
    if not isinstance(efforts, list):
        raise ValueError("Invalid CLI reasoning levels")
    return {'id': identifier, 'label': str(label)[:250],
            'efforts': list(dict.fromkeys(e for e in efforts if e in EFFORTS)),
            'description': str(description)[:1000], **extra}


def codex_profile(command, directory):
    with metadata_process([*command, '-c', 'features.plugins=false',
                           '-c', 'features.apps=false', 'app-server'], directory) as (proc, exchange):
        exchange({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'orbis', 'version': '2.1.0'}, 'capabilities': {}}}, 1)
        proc.stdin.write(json.dumps({'method': 'initialized', 'params': {}}) + '\n')
        proc.stdin.flush()
        models, cursor = [], None
        for page in range(20):
            response = exchange({'id': page + 2, 'method': 'model/list',
                                 'params': {'limit': 100, 'includeHidden': False, 'cursor': cursor}}, page + 2)
            for item in response['data']:
                if item.get('hidden'):
                    continue
                models.append(model_record(
                    item.get('model', item.get('id')), item.get('displayName', item.get('id')),
                    [level.get('reasoningEffort') for level in item.get('supportedReasoningEfforts', [])],
                    item.get('description', ''), is_default=bool(item.get('isDefault')),
                    default_effort=item.get('defaultReasoningEffort', '')))
            cursor = response.get('nextCursor')
            if not cursor:
                break
        else:
            raise ValueError("CLI model catalog exceeds the discovery limit")
        config = exchange({'id': 30, 'method': 'config/read',
                           'params': {'includeLayers': False}}, 30)['config']
    default = config.get('model') or next((m['id'] for m in models if m['is_default']), '')
    selected = next((m for m in models if m['id'] == default), {})
    # Old Orbis preferences omitted Bedrock's inference-profile prefix.
    prefix = re.match(r'(.+\.openai\.)(gpt-.+)', default)
    if prefix:
        for model in models:
            if model['id'].startswith(prefix[1]):
                model['aliases'] = [model['id'][len(prefix[1]):]]
    version_text = run_agent([*command, '--version'], env=agent_environment(),
                                  stdin=subprocess.DEVNULL, capture_output=True,
                                  text=True, timeout=PROBE_TIMEOUT, check=True).stdout
    version = re.search(r'\d+\.\d+\.\d+[\w.-]*', version_text)
    return {'models': models, 'default_model': default,
            'default_model_label': selected.get('label', default),
            'default_efforts': selected.get('efforts', []),
            'default_effort': config.get('model_reasoning_effort') or selected.get('default_effort', ''),
            'cli_version': version[0] if version else ''}


def claude_profile(command, directory):
    help_text = run_agent([*command, '--help'], env=agent_environment(),
                               stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=PROBE_TIMEOUT, check=True).stdout
    # --bare skips OAuth/keychain auth, and --restricted ignores user settings.
    # Keep the user's signed-in provider while preventing customization hooks.
    startup = (['--safe-mode'] if '--safe-mode' in help_text else
               ['--settings', '{"disableAllHooks":true}'])
    with metadata_process([*command, *startup, '--print', '--input-format', 'stream-json',
                           '--output-format', 'stream-json', '--verbose',
                           '--no-session-persistence', '--strict-mcp-config',
                           '--mcp-config', '{"mcpServers":{}}', '--tools', ''], directory) as (_, exchange):
        response = exchange({'type': 'control_request', 'request_id': 'orbis-models',
                             'request': {'subtype': 'initialize', 'hooks': {}}}, 'orbis-models')
        try:
            settings = exchange({'type': 'control_request', 'request_id': 'orbis-settings',
                                 'request': {'subtype': 'get_settings', 'scope': 'effective'}},
                                'orbis-settings')['effective']
        except (ValueError, KeyError):
            settings = None
    models, default = [], {}
    for item in response['models']:
        if item['value'] == 'default':
            default = item
            continue
        models.append(model_record(item['value'], item['displayName'],
                                   item.get('supportedEffortLevels', []),
                                   item.get('description', '')))
    # session_state is opaque SDK state, not a configuration document.
    config = settings or {}
    configured = (os.environ.get('ANTHROPIC_MODEL') or config.get('model') or
                  config.get('env', {}).get('ANTHROPIC_MODEL') or '')
    selected = next((m for m in response['models']
                     if configured in (m['value'], m.get('resolvedModel'))), {} if configured else default)
    label = selected.get('displayName') or configured
    if selected.get('value') == 'default':
        label = next((m['displayName'] for m in response['models']
                      if selected.get('resolvedModel') and m['value'] != 'default'
                      and m.get('resolvedModel') == selected['resolvedModel']), '')
    if settings is None and not configured:
        label = ''
    return {'models': models, 'default_model': configured or selected.get('resolvedModel') or '',
            'default_model_label': label,
            'default_efforts': [e for e in selected.get('supportedEffortLevels', []) if e in EFFORTS],
            'default_effort': (os.environ.get('CLAUDE_CODE_EFFORT_LEVEL') or config.get('effortLevel') or
                               config.get('env', {}).get('CLAUDE_CODE_EFFORT_LEVEL') or ''),
            'cli_version': response.get('claude_code_version', ''),
            'startup_arguments': startup,
            'supports_effort': '--effort' in help_text}


def agent_profile(agent, command=None):
    if agent not in ('codex', 'claude', 'copilot'):
        raise ValueError('Unknown local agent.')
    if command is None:
        try:
            command = command_parts(env_setting(agent.upper(), agent))
        except ValueError:
            command = []
    executable = shutil.which(command[0]) if command else None
    empty = {'models': [], 'default_model': '', 'default_model_label': '',
             'default_efforts': [], 'default_effort': '', 'cli_version': '',
             'model_source': 'unavailable', 'startup_arguments':
             ['--settings', '{"disableAllHooks":true}'] if agent == 'claude' else [],
             'model_error': f'Install and sign in to {agent}, then restart Orbis.'}
    if not executable:
        return empty
    command = [executable, *command[1:]]
    key = (agent, tuple(command), os.environ.get('CODEX_HOME'), os.environ.get('CLAUDE_CONFIG_DIR'),
           os.environ.get('COPILOT_HOME'))
    with _cache_lock:
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < cached[1]:
            return copy.deepcopy(cached[2])
        try:
            with tempfile.TemporaryDirectory(prefix='orbis-models-') as directory:
                result = {'codex': codex_profile, 'claude': claude_profile,
                          'copilot': copilot_profile}[agent](command, directory)
            if not result['models']:
                raise ValueError('CLI returned no models')
            result.update(model_source='cli', model_error='')
            lifetime = 60
        except (OSError, ValueError, TypeError, AttributeError, KeyError, queue.Empty, subprocess.SubprocessError) as exc:
            message = 'Could not read this CLI’s models. Update/sign in to the CLI, then reopen the model picker. CLI default remains available.'
            if agent == 'copilot' and isinstance(exc, subprocess.CalledProcessError):
                try:
                    diagnostic = json.loads(exc.stdout)
                except (ValueError, TypeError):
                    diagnostic = {}
                if isinstance(diagnostic, dict) and isinstance(diagnostic.get("error"), str):
                    message = diagnostic["error"][:2000]
            result = {**empty, 'model_error': message}
            lifetime = 10
        _cache[key] = (time.monotonic(), lifetime, result)
        return copy.deepcopy(result)


def copilot_profile(command, directory):
    try:
        from copilot_adapter import worker_command
    except ModuleNotFoundError:
        from tools.copilot_adapter import worker_command
    completed = run_agent(worker_command(command, "metadata"), cwd=directory,
                          env=agent_environment(), capture_output=True, text=True,
                          timeout=65, check=True)
    result = json.loads(completed.stdout)
    result["models"] = [model_record(m["id"], m["label"], m["efforts"],
                                     default_effort=m.get("default_effort", ""))
                        for m in result["models"]]
    return result
