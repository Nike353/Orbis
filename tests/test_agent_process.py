import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from tools.agent_process import command_parts, run_agent, start_agent, stop_agent


TREE = '''
import json, os, subprocess, sys, time
leaf = subprocess.Popen([sys.executable, "-u", "-c",
    "import os,time; print(os.getpid(), flush=True); time.sleep(60)"],
    stdout=subprocess.PIPE, text=True)
leaf_pid = int(leaf.stdout.readline())
print(json.dumps([os.getpid(), leaf_pid]), flush=True)
if sys.argv[1] == "exit":
    sys.stdin.readline()
    sys.exit(7)
time.sleep(60)
'''


class AgentCommandTests(unittest.TestCase):
    def test_prompts_paths_unicode_and_empty_arguments_do_not_go_through_a_shell(self):
        arguments = ['a & b | c < d > e', '"quotes"', '%PATH%!^', '', 'caf\u00e9', 'C:\\path with spaces\\']
        result = run_agent([sys.executable, '-c', 'import json,sys; print(json.dumps(sys.argv[1:]))',
                            *arguments], capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout), arguments)
        if os.name == 'nt':
            self.assertEqual(command_parts(subprocess.list2cmdline([sys.executable, *arguments])),
                             [sys.executable, *arguments])
        else:
            self.assertEqual(command_parts('"/a path/python" "script file.py"'), ['/a path/python', 'script file.py'])

    def test_timeout_and_nonzero_exit_are_reported(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            run_agent([sys.executable, '-c', 'import time; time.sleep(60)'], timeout=0.3,
                      capture_output=True, text=True)
        with self.assertRaises(subprocess.CalledProcessError) as failed:
            run_agent([sys.executable, '-c', 'import sys; print("diagnostic", file=sys.stderr); sys.exit(9)'],
                      timeout=10, capture_output=True, text=True, check=True)
        self.assertEqual(failed.exception.returncode, 9)
        self.assertIn('diagnostic', failed.exception.stderr)


@unittest.skipUnless(os.name == 'nt', 'Windows Job object contracts')
class WindowsAgentTreeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='orbis agent & space ')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.script = self.root / 'tree.py'
        self.script.write_text(TREE, encoding='utf-8')

    def command(self, mode='wait'):
        return [sys.executable, '-u', str(self.script), mode]

    def track(self, identifier):
        import win32api
        import win32con
        import win32event
        handle = win32api.OpenProcess(win32con.SYNCHRONIZE | win32con.PROCESS_TERMINATE, False, identifier)

        def cleanup():
            try:
                if win32event.WaitForSingleObject(handle, 0) == win32event.WAIT_TIMEOUT:
                    win32api.TerminateProcess(handle, 1)
                    win32event.WaitForSingleObject(handle, 5000)
            finally:
                handle.Close()
        self.addCleanup(cleanup)
        return handle

    def assert_stopped(self, handles):
        import win32event
        for handle in handles:
            self.assertEqual(win32event.WaitForSingleObject(handle, 5000), win32event.WAIT_OBJECT_0)

    def tree(self, mode='wait'):
        proc = start_agent(self.command(mode), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.close_process, proc)
        identifiers = json.loads(proc.stdout.readline())
        return proc, [self.track(identifier) for identifier in identifiers]

    @staticmethod
    def close_process(proc):
        stop_agent(proc)
        proc.wait(timeout=5)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe is not None:
                pipe.close()

    def test_concurrent_cancellation_kills_only_the_owned_tree(self):
        sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(lambda: (sentinel.kill(), sentinel.wait(timeout=5)))
        proc, handles = self.tree()
        errors = []

        def stop():
            try:
                stop_agent(proc)
            except Exception as error:
                errors.append(error)
        workers = [threading.Thread(target=stop) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=8)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assert_stopped(handles)
        self.assertIsNone(sentinel.poll(), 'An unrelated process must remain running')
        stop_agent(proc)

    def test_wrapper_exit_preserves_its_status_and_closes_descendant_pipes(self):
        proc, handles = self.tree('exit')
        stdout, stderr = proc.communicate('exit\n', timeout=10)
        self.assertEqual(proc.returncode, 7, (stdout, stderr))
        self.assert_stopped(handles)

    def test_timeout_stops_the_owned_descendants(self):
        handles = []

        def capture_started_tree(*args, **kwargs):
            proc = start_agent(*args, **kwargs)
            self.addCleanup(self.close_process, proc)
            handles.extend(self.track(identifier) for identifier in json.loads(proc.stdout.readline()))
            return proc
        with patch("tools.agent_process.start_agent", side_effect=capture_started_tree):
            with self.assertRaises(subprocess.TimeoutExpired):
                run_agent(self.command(), timeout=0.2, capture_output=True, text=True)
        self.assert_stopped(handles)

    def test_parent_death_closes_the_job_and_kills_descendants(self):
        code = ("import subprocess,time; from tools.agent_process import start_agent; "
                f"proc=start_agent({self.command()!r}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); "
                "print(proc.stdout.readline(), end='', flush=True); time.sleep(60)")
        parent = subprocess.Popen([sys.executable, '-u', '-c', code],
                                  cwd=Path(__file__).resolve().parent.parent,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (parent.kill() if parent.poll() is None else None,
                                 parent.communicate(timeout=5)))
        identifiers = json.loads(parent.stdout.readline())
        handles = [self.track(identifier) for identifier in identifiers]
        parent.kill()
        parent.wait(timeout=5)
        self.assert_stopped(handles)

    def test_failed_containment_never_launches_the_cli(self):
        marker = self.root / 'must-not-exist'
        command = [sys.executable, '-c', f'from pathlib import Path; Path({str(marker)!r}).touch()']
        for target in ('win32job.AssignProcessToJobObject', 'tools.agent_process.threading.Thread.start'):
            with self.subTest(target=target), patch(target, side_effect=OSError('containment failed')):
                with self.assertRaisesRegex(OSError, 'containment failed'):
                    start_agent(command)
            self.assertFalse(marker.exists())

    def test_supported_npm_shim_runs_its_entry_without_cmd_exe(self):
        arguments = ['a & b', '"quoted"', '', '%PATH%', 'caf\u00e9']
        for name, module in (('claude', '@anthropic-ai/claude-code'), ('copilot', '@github/copilot')):
            with self.subTest(name=name):
                shim = self.root / (name + '.cmd')
                shim.write_text('@echo This batch file must not run\n', encoding='utf-8')
                package = self.root / 'node_modules' / module
                package.mkdir(parents=True)
                (package / 'package.json').write_text(json.dumps({'bin': {name: 'cli.js'}}), encoding='utf-8')
                (package / 'cli.js').write_text('console.log(JSON.stringify(process.argv.slice(2)))', encoding='utf-8')
                result = run_agent([str(shim), *arguments], timeout=10, capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(result.stdout), arguments)
        custom = self.root / 'custom.cmd'
        custom.write_text('@echo unsupported', encoding='utf-8')
        with self.assertRaisesRegex(OSError, 'Cannot safely launch'):
            start_agent([str(custom)])

    def test_copilot_sdk_worker_and_owned_cli_descendant_stop_together(self):
        from tools.copilot_adapter import worker_command
        from tools.agent_bridge import OUTCOME_SCHEMA

        schema = self.root / 'schema.json'
        schema.write_text(json.dumps(OUTCOME_SCHEMA), encoding='utf-8')
        marker = self.root / 'started.json'
        fixture = Path(__file__).parent / 'fixtures' / 'copilot_agent.py'
        command = worker_command([sys.executable, str(fixture)], 'import', schema, 'TEST_WAIT')
        with patch.dict(os.environ, {'ORBIS_TEST_COPILOT_STARTED': str(marker)}):
            proc = start_agent(command, cwd=self.root, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.close_process, proc)
        deadline = time.monotonic() + 15
        while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertTrue(marker.exists(), 'Copilot fixture never reached its running turn')
        handles = [self.track(pid) for pid in json.loads(marker.read_text())]
        stop_agent(proc)
        stop_agent(proc)
        proc.wait(timeout=5)
        self.assert_stopped(handles)
