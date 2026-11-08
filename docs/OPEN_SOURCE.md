# Distributing Orbis

The public repository distributes the Orbis desktop application with an empty
library and optional encrypted Google Drive sync. Personal library repositories
are separate from the public application history.

Publish macOS and Linux installers as GitHub Release downloads after platform
verification. Each user runs the local application and can connect their own
Google Drive and agent account; no shared Orbis library server is required.
See [desktop builds and Google setup](DESKTOP.md) for the current preview status.

Publish application code, prompts, schema/architecture documentation, launcher,
release tooling, dependency lockfile, tests with synthetic fixtures, CI, and the
MIT license. No separately installed agent skill is needed: the app ships its
insertion and research prompts and the validated CLI bridge.

Do not publish a personal workspace or reuse Git history that contains private
paper notes, sessions, imports, or credentials. A `.gitignore` does not remove
already tracked files or historical commits.

Create a clean source archive:

```sh
python3 scripts/package_release.py --output release/orbis-source.zip
```

Use the existing public application repository for release work. If an archive
comes from a private checkout, audit its documentation and screenshots before
publishing it and never copy the private Git history. The packager uses an application file allowlist and
creates an empty default graph. It excludes personal data, source PDFs, sessions,
temporary runs, credentials, dependencies, and Git history. Test fixtures contain
synthetic notes and feed records; familiar public paper metadata is used only to
exercise display and relationships.

For users who should not need Node.js:

```sh
npm run build
python3 scripts/package_release.py --runtime --output release/orbis-runtime.zip
```

The runtime includes compiled frontend assets, Python tools, documentation, and
prompts. Users unzip it and run `sh start.sh`; the launcher prepares Python and
prints the localhost URL to open in their browser. AI features require a separately
installed and signed-in agent CLI. This archive is an alternative to the desktop
installer, which launches in its own window.
To upgrade, unpack new application files and point the launcher at the existing
personal workspace. Stop the previous server and back up that workspace first.

The source contains a macOS/Linux CI matrix. Hosted CI and live Claude Code
verification require those environments/accounts; local fixture tests do not
claim a successful live provider call. Keep an explicit release verification
record identifying the platforms and providers actually exercised.
