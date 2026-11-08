# Local execution and data handling

Orbis is a single-user localhost application. Do not expose its server to the
internet or place an unauthenticated proxy in front of it. Workspaces contain
graphs, notes, saved conversations, import state, originals, and annotations.

## Storage and sync

Local working files and downloaded originals are readable files; Orbis does not
encrypt the local library. The desktop app optionally syncs compressed library
snapshots and separate immutable original-file blobs to Google Drive's app-private
storage. Uploads use authenticated AES-256-GCM encryption. Paired devices hold
the recovery key; Google sign-in alone cannot recover it.

Google tokens and the recovery key use Electron's OS-backed secure storage and
are not synced or committed. Linux refuses the insecure basic_text fallback.
Source distributions exclude OAuth client configuration; distributors may bundle
an app's Desktop OAuth configuration, but never user tokens or recovery keys.
The native local API also requires a per-launch secret. See [DESKTOP.md](docs/DESKTOP.md)
for consent scopes, conflict handling, backup behavior, and preview limitations.

## Agents and untrusted content

AI operations use the selected CLI's authentication and account limits. Selected
notes, source passages, and questions are sent to its configured provider; models
are not necessarily local. Import and original retrieval can access external
URLs. Research uses bounded, locally retrieved original passages with notes-only
fallback, and restricts external tools where supported by the CLI.

Paper content and agent output are untrusted. Orbis checks schemas, citation
anchors, source identity, and revision/ownership constraints, and requires review
of proposed library edits. These checks do not establish factual correctness.
Disposable execution directories and CLI sandbox settings reduce access; they
are not OS isolation against a compromised executable. Configure only agent
binaries you trust.

The preview has not received an independent security audit. Keep a separate
backup of valuable library content and protect your recovery key. Report
vulnerabilities privately to the repository maintainer; do not post credentials,
personal notes, or exploits against someone else's machine in a public issue.
