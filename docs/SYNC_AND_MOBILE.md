# Device sync and future mobile support

## Current desktop design

Orbis runs independently on each macOS or Linux laptop. It keeps the library
locally and uses optional encrypted Google Drive snapshots and attachment blobs
for synchronization. Neither laptop needs to stay awake for the other to work.
There is no shared Orbis compute server and no daily Git push/pull requirement.

Each device uses its own signed-in agent CLI. A larger allowance on another
machine/account is not automatically shared. Sync moves saved library content,
not running jobs, agent credentials, or provider quotas.

Original PDFs/articles download on demand; notes, graph records, annotations, and
conversations sync separately. Keep offline retains chosen originals locally.
Conflicting edits require review. See [DESKTOP.md](DESKTOP.md) for setup, storage,
recovery keys, and the current preview limitations.

## Future mobile direction

A mobile reader could use the same encrypted library format for browsing,
annotations, and offline reading. It would need native secure key storage, Google
sign-in, attachment downloads, a small-screen reading interface, and compatibility
with desktop merge and recovery rules. Mobile support is not implemented today.

Running a desktop CLI from a phone would require a separate, explicitly paired
agent host or another supported inference integration. Such a host would need
authenticated encrypted transport, device revocation, job isolation, and a clear
indication of where content is sent. The current localhost server must not be
exposed publicly to approximate this design.

A read-and-annotate mobile client can be developed independently of remote agent
execution. Keeping those concerns separate preserves independent desktop use
and avoids making an always-on computer a requirement for reading the library.
