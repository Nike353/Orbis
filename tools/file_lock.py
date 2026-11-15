"""Exclusive OS locks released when their live file handles are closed."""
from pathlib import Path

import portalocker


def lock_file(path, *, blocking=True):
    handle = Path(path).open("a+b")
    flags = portalocker.LOCK_EX
    if not blocking:
        flags |= portalocker.LOCK_NB
    try:
        portalocker.lock(handle, flags)
    except BaseException:
        handle.close()
        raise
    return handle
