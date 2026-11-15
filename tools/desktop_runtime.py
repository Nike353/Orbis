"""Own the backend until Electron quits, even if a child inherits its pipe."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import threading

from tools.agent_process import start_agent, stop_agent


def supervise(arguments, grace_seconds=15):
    import win32api
    import win32con
    import win32event
    import win32process

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--orbis-parent-pid", type=int, required=True)
    parser.add_argument("--orbis-parent-start-time", type=float, required=True)
    options, arguments = parser.parse_known_args(arguments)
    parent = win32api.OpenProcess(win32con.SYNCHRONIZE | win32con.PROCESS_QUERY_INFORMATION,
                                  False, options.orbis_parent_pid)
    finished = threading.Event()
    parent_closed = threading.Event()
    watcher = None
    child = None

    def watch_parent():
        try:
            while not finished.is_set():
                if win32event.WaitForSingleObject(parent, 250) == win32event.WAIT_OBJECT_0:
                    return
        finally:
            parent_closed.set()

    def pipe_closed():
        while os.read(sys.stdin.fileno(), 4096):
            pass
        parent_closed.set()

    def stop_backend():
        parent_closed.wait()
        child.stdin.close()
        try:
            child.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            stop_agent(child)

    command = ([sys.executable] if getattr(sys, "frozen", False)
               else [sys.executable, "-u", str(Path(__file__).resolve().parent.parent / "desktop/server_boot.py")])
    try:
        started = win32process.GetProcessTimes(parent)["CreationTime"].timestamp() * 1000
        if not started - 1 <= options.orbis_parent_start_time <= started + 1:
            raise ValueError("Desktop parent identity changed before backend startup.")
        if win32event.WaitForSingleObject(parent, 0) != win32event.WAIT_TIMEOUT:
            raise ValueError("Desktop parent exited before backend startup.")
        child = start_agent([*command, "--orbis-desktop-server", *arguments], stdin=subprocess.PIPE)
        watcher = threading.Thread(target=watch_parent, daemon=True)
        watcher.start()
        threading.Thread(target=pipe_closed, daemon=True).start()
        threading.Thread(target=stop_backend, daemon=True).start()
        return child.wait()
    finally:
        finished.set()
        if child is not None:
            stop_agent(child)
            child.wait(timeout=5)
            child.stdin.close()
        if watcher is not None:
            watcher.join()
        parent.Close()
