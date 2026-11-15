"""Argument-safe agent commands and lifetime-owned process trees."""
import ctypes
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time


def command_parts(command):
    command = command.strip()
    if not command:
        return []
    if os.name != "nt":
        return shlex.split(command)
    from ctypes import wintypes
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    kernel.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel.LocalFree.restype = wintypes.HLOCAL
    count = ctypes.c_int()
    arguments = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not arguments:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return list(arguments[:count.value])
    finally:
        kernel.LocalFree(arguments)


def resolve_command(command):
    if not command:
        raise ValueError("An agent command is required.")
    executable = shutil.which(command[0])
    if executable is None:
        raise FileNotFoundError(f"Agent executable not found: {command[0]}")
    path = Path(executable)
    if os.name != "nt" or path.suffix.lower() not in {".cmd", ".bat"}:
        return [executable, *command[1:]]
    packages = {"claude": "@anthropic-ai/claude-code", "codex": "@openai/codex",
                "copilot": "@github/copilot"}
    package = packages.get(path.stem.lower())
    if package:
        import json
        root = path.parent / "node_modules" / package
        manifest = root / "package.json"
        if manifest.is_file():
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
            binaries = metadata.get("bin", {})
            entry = binaries.get(path.stem.lower()) if isinstance(binaries, dict) else binaries
            if isinstance(entry, str):
                script = (root / entry).resolve()
                if script.is_relative_to(root.resolve()) and script.is_file():
                    node = path.parent / "node.exe"
                    node = str(node) if node.is_file() else shutil.which("node")
                    if node:
                        return [node, str(script), *command[1:]]
    raise OSError("Cannot safely launch this Windows batch wrapper. Install a native "
                  "Claude/Codex/Copilot CLI or configure ORBIS_CLAUDE/ORBIS_CODEX/ORBIS_COPILOT with "
                  "a quoted executable and its arguments (for example node and a CLI script).")


class AgentProcess(subprocess.Popen):
    def __init__(self, command, **kwargs):
        self._job = None
        self._stop_lock = threading.Lock()
        command = resolve_command(command)
        kwargs.setdefault("stdin", subprocess.DEVNULL)
        if kwargs.get("text") or kwargs.get("universal_newlines"):
            kwargs.setdefault("encoding", "utf-8")
        if os.name != "nt":
            super().__init__(command, start_new_session=True, **kwargs)
            return

        import pywintypes
        import win32api
        import win32con
        import win32event
        import win32job

        job = win32job.CreateJobObject(None, "")
        self._job = job
        ready = None
        try:
            ready = win32event.CreateEvent(None, True, False, None)
            limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            limits["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
            win32api.SetHandleInformation(ready, win32con.HANDLE_FLAG_INHERIT, win32con.HANDLE_FLAG_INHERIT)
            startup = subprocess.STARTUPINFO()
            startup.lpAttributeList = {"handle_list": [int(ready)]}
            # The venv python.exe redirects through another process before Python runs.
            # Start the base interpreter so no child can escape before job assignment.
            bootstrap = ([sys.executable, "--orbis-agent-bootstrap"] if getattr(sys, "frozen", False)
                         else [str(Path(sys.base_prefix) / "python.exe"), "-I", "-S", "-u",
                               str(Path(__file__).resolve())])
            bootstrap += [str(int(ready)), *command]
            super().__init__(bootstrap, startupinfo=startup, close_fds=True,
                             creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
                             **kwargs)
            process = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE,
                                           False, self.pid)
            try:
                win32job.AssignProcessToJobObject(job, process)
            finally:
                process.Close()
            # Start the reaper before releasing the CLI, including fast-exiting wrappers.
            threading.Thread(target=self._reap_tree, daemon=True).start()
            win32event.SetEvent(ready)
        except BaseException as error:
            try:
                self.stop()
            finally:
                if hasattr(self, "_handle"):
                    self.kill()
                    self.wait(timeout=5)
                    for pipe in (self.stdin, self.stdout, self.stderr):
                        if pipe is not None:
                            pipe.close()
            if isinstance(error, pywintypes.error):
                raise OSError(f"Could not contain the Windows agent process: {error}") from error
            raise
        finally:
            if ready is not None:
                ready.Close()

    def _reap_tree(self):
        self.wait()
        self.stop()

    def __exit__(self, *args):
        try:
            self.stop()
        finally:
            super().__exit__(*args)

    def stop(self):
        if os.name != "nt":
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            return
        import win32job
        with self._stop_lock:
            if self._job is None:
                return
            job = self._job
            try:
                win32job.TerminateJobObject(job, 1)
                deadline = time.monotonic() + 5
                while win32job.QueryInformationJobObject(
                        job, win32job.JobObjectBasicAccountingInformation)["ActiveProcesses"]:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("The Windows agent process tree did not stop within five seconds.")
                    time.sleep(0.01)
            finally:
                job.Close()
                self._job = None


def start_agent(command, **kwargs):
    return AgentProcess(command, **kwargs)


def stop_agent(proc):
    proc.stop()


def run_agent(command, *, timeout, check=False, capture_output=False, **kwargs):
    if capture_output:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc = start_agent(command, **kwargs)
    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            stop_agent(proc)
            stdout, stderr = proc.communicate(timeout=5)
            raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr) from error
        result = subprocess.CompletedProcess(command, proc.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result
    finally:
        stop_agent(proc)
        proc.wait(timeout=5)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe is not None:
                pipe.close()


def _bootstrap(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    ready = int(arguments[0])
    try:
        if kernel.WaitForSingleObject(ready, 10000) != 0:
            raise OSError("Windows agent containment was not ready within ten seconds.")
    finally:
        kernel.CloseHandle(ready)
    try:
        return subprocess.call(arguments[1:], stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    except OSError as error:
        print(f"Agent launch failed: {error}", file=sys.stderr, flush=True)
        return 127


if __name__ == "__main__":
    raise SystemExit(_bootstrap())
