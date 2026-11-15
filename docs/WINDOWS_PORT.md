# Windows port change log

## 2026-11-14 - Phases 1 and 2

The agent limitation recorded in this section is addressed by Phase 3 below.

### Done

- Used the existing `D:\Orbis` checkout. It was clean on `main`; created
  `windows-support` without replacing another branch.
- Kept `origin` pointing to `gokulmk-12/Orbis`; added `upstream` pointing to
  `Nike353/Orbis`. No commits, pushes, pull requests, or releases.
- Added `start.ps1` for native browser setup. It reuses uv or installs a local
  copy, selects Python 3.12, builds with managed Node 22, and forwards arguments.
- Fixed Windows Node/npm paths and launched npm through `node.exe`, avoiding
  batch-file quoting problems. The server uses the same Python environment.
- Put the default Windows library in `%LOCALAPPDATA%\Orbis\default`, falling back
  to the user's `AppData\Local`. macOS/Linux location rules stay unchanged.
- Replaced direct `fcntl` calls with pinned `portalocker`. A library stays locked
  until its handle closes; frontend setup waits for any earlier setup to finish.
- Kept old-library migration exclusive and skipped copying `.server.lock`,
  since Windows prevents reading that file while it is locked.
- Updated browser setup instructions and added startup/locking regression cases.

Changed files: `start.ps1`, `scripts/start.py`, `tools/file_lock.py`,
`tools/workspace.py`, `tests/test_start.py`, `pyproject.toml`, `uv.lock`,
`README.md`, `CONTRIBUTING.md`, and this log.

### Verification

| Check               | Result                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original startup    | Failed importing Unix-only `fcntl` on Windows.                                                                                                                                                    |
| Original build      | Missing `tsc`; passed after restoring dependencies.                                                                                                                                               |
| Native bootstrap    | Passed `--doctor`, first-run local uv installation, and managed Node 22 `--prepare-only` build.                                                                                                   |
| Python checks       | 35 startup, server, graph-library, document API, and schema tests passed.                                                                                                                         |
| Frontend checks     | 130 tests and lint passed with managed Node 22. Global Node 26 failed localStorage tests; use Node 22.                                                                                            |
| Browser persistence | Opened a fresh disposable library; saved a synthetic graph through the API and edited/saved personal notes in the browser. Restarted the launcher and confirmed both on disk and through the API. |
| Exclusive ownership | A second native launcher refused the same library. Reopening worked after stopping its owner. Separate tests also confirmed blocking setup and release on handle close.                           |
| Cleanup             | Stopped disposable servers and their probe children. No personal libraries were used.                                                                                                             |

Python package downloads initially failed TLS negotiation with
`files.pythonhosted.org`. A temporary public PyPI mirror allowed installation;
artifact hashes were checked against official PyPI metadata and the committed
lockfile uses official PyPI URLs. No mirror setting or TLS bypass was retained.

Nodeenv printed a permission warning for its optional `nodejs.exe` symlink.
The launcher uses `node.exe` directly; setup and build succeeded without elevation.

### Deferred or unverified

- Windows AI support is deferred. Installed Claude was detected, but model
  discovery reported unavailable metadata and left a probe running: cleanup still
  uses `os.killpg`. Manual browser editing worked; the probe was stopped.
  The README shows temporary environment overrides to avoid these probes.
- No agent process-tree adapter, Electron port/shutdown changes, sync port,
  Copilot support, Windows CI, or installer was added.
- macOS/Linux behavior was preserved in code and location tests, but not run on
  those operating systems. Other Windows architectures remain unverified.
- The full Python/Playwright suites were not claimed as Windows-compatible;
  existing broader checks include Unix commands and CLI fixtures.

## 2026-11-14 - Phase 3

### Done

- Added one shared launcher for discovery, CLI checks, imports, revalidation,
  and research conversations. macOS/Linux still use their own process groups.
- Each Windows run gets a private Job object. A small waiting launcher keeps
  the CLI from starting before containment is ready. If setup fails, no CLI runs.
- Cancellation, timeout, normal wrapper exit, and server exit stop owned children,
  including npm wrappers. Cleanup uses owned handles, not process names or stale
  PIDs. Concurrent stop requests are safe.
- Supported native executables and standard Claude/Codex npm launchers without
  sending prompts through `cmd.exe`. Windows command settings retain quoted paths,
  backslashes, empty arguments, and Unicode.
- Research runs stop before their temporary files are removed. Their streams use
  UTF-8. Windows import instructions use the managed `python` command.
- Declared the existing Windows `pywin32` dependency directly and updated setup
  instructions. The earlier AI-disabling environment settings can be removed.

### Verification and limits

- 99 focused Python regressions passed, covering startup, process ownership,
  discovery, settings, imports, research, original-source reading, and HTTP helpers.
- Native localhost checks passed for both fixture protocols: model discovery,
  research completion/cancellation, streamed imports, unchanged library data,
  and temporary-file cleanup. No provider calls or personal libraries were used.
- Process tests cover descendant cleanup on cancellation, timeout, wrapper exit,
  and parent death; failed containment never starts the CLI. An unrelated process
  stays running.
- Installed Claude returned three models through real metadata discovery.
  Authenticated Claude/Codex turns and real Codex installation remain unverified;
  deterministic fixtures cover both protocols without spending provider credits.
- One existing research test requires Windows symlink privileges and fails with
  error 1314 here. No privileges or system policies were changed to bypass it.
- Windows desktop packaging, sync, installers, and CI remain deferred.

## 2026-11-14 - Copilot CLI connection

### Done

- Added GitHub Copilot beside Claude Code and Codex without changing the import,
  source-evidence, graph validation, or explicit review workflow.
- Pinned the official Copilot SDK. It launches the installed CLI and reuses its
  sign-in; Orbis does not collect API keys or attach to another app's conversation.
- Added real model discovery, account errors, per-model reasoning settings,
  import/research commands, progress, and structured result/error handling.
- Copilot imports use bounded read, write, full-text fetch, and graph-validation
  tools. Writes stay inside the disposable graph and paper notes. Downloads reuse
  the existing public-network checks; incomplete reads cannot attest full text.
- Disabled ambient hooks, instructions, skills, plugins, shell, and MCP tools.
  Research receives its existing context and no tools.
- Reused Windows Job ownership for the SDK worker, CLI, and descendants.
  Added standard Copilot npm launcher support, UI selection/labels/retry, doctor
  reporting, batch choices, and setup instructions.

### Verification and limits

- Installed Copilot CLI `1.0.89-0` reported an authenticated account and 20 models.
  It accepted isolated import/research session settings without a model turn.
- 116 focused Python checks passed, covering credential-free SDK protocol,
  structured errors, source attestation, research persistence, and descendant
  cleanup. The earlier symlink-privilege exception remains unchanged.
- 131 frontend tests, lint, type-checking, and production build passed with managed
  Node 22.
- The native PowerShell launcher served the UI and Copilot model picker data.
  Localhost fixtures completed/persisted research, cancelled a running CLI, and
  surfaced a structured missing-source import failure without changing the graph.
  Disposable servers and libraries were removed afterward.
- No paid Copilot turn or real-paper import was performed. Actual model access,
  paper quality, account quotas, and provider billing remain unverified.
- Desktop packaging and macOS/Linux execution remain unverified; this connection
  is intended for the existing native browser launcher.

### Copilot file-reading fix

- The CLI intercepted the generic `read_file` name before Orbis received its
  arguments. Renamed the workspace tools with an `orbis_` prefix to avoid this
  collision, without changing file permissions or the insertion workflow.
- Added an SDK round-trip regression that passes explicit workflow, schema,
  and graph paths through tool requests and checks the returned contents.
- Verified reads, note saving, graph rebuilding, and rejected out-of-workspace
  reads/unauthorized writes through the installed CLI using a disposable library.
  No model turn or personal library was used; a real-paper retry remains unverified.
- Restart Orbis with `.\start.ps1` before retrying the import.

### arXiv timestamp fix

- The backend accepted date-only arXiv metadata that the UI could not load.
  Graph validation now requires timezone-aware ISO 8601 datetimes before an
  import or save can reach the library.
- Clarified the schema and insertion instructions: preserve verified timestamps,
  never invent missing times, and omit optional unverified arXiv metadata.
- With permission, repaired the affected saved timestamps using official arXiv
  metadata and Orbis's revision-checked API. Notes and connections were preserved.
- 70 focused Python checks passed, including rejection before import apply.
  Confirmed the accepted timestamp formats against the UI's datetime validator.
- Restart Orbis to load the updated backend validation. No model turn was used.

## 2026-11-14 - Read while a paper is being added

### Done

- Matched the Source type dropdown's font and height to the other form controls.
- **Read & add** opens the reader straight away. The original downloads separately
  while the agent prepares the summary and connections; progress stays visible.
- Added a pending Library entry, cancellation, and clear failure/exclusion states.
  Reading remains available if the import fails. Notes, highlights, and discussion
  wait until the paper passes validation.
- Kept previews in the local cache, outside the graph and shared document catalog.
  A validated import reuses the same original only when its source matches the
  verified full text. Its page position is preserved.

### Verification and limits

- 138 frontend tests, lint, type-checking, and production build passed on Node 22.
  104 related Python tests passed; the existing document symlink test still needs
  Windows privileges unavailable on this account.
- In a disposable native browser session, opened a three-page PDF while the
  synthetic agent was paused. After completion, the summary appeared without
  replacing the reader, changing its document ID, or moving it from page 3.
- Confirmed the dropdown and URL input use the same computed font and height.
  No paid model turn or personal library was used.
- If an original cannot be downloaded, the reader reports the problem rather
  than claiming it is ready. Restart Orbis and refresh to load these changes.

### Disabled add-button fix

- Unsaved notes or review changes disabled **Read & add**, with no save action in
  the dialog. It now offers **Save & add** and saves those edits first.
- Kept revision checks and draft protection. A failed save or newer unsaved edit
  stops the import instead of discarding changes or using an outdated graph.
- 141 frontend tests, lint, type-checking, and production build passed. A native
  browser check confirmed a pending review decision was saved before the import
  request reached the server. No real agent or personal library was used.

## 2026-11-14 - Phase 4: Windows desktop preview

### Done

- Adapted the existing Electron app for Windows x64. Installed copies include
  Python and the local service; no separate browser server is needed.
- Added packaged Copilot workers and graph validation, plus Windows CLI/Node
  discovery for desktop launches. Agent sign-in still belongs to each CLI.
- Kept the backend and agents in owned Windows Jobs. Closing the app requests
  a clean stop; a checked parent-process handle also detects crashes when
  inherited pipes remain open. No process-name or stale-PID termination.
- Fixed frozen-worker UTF-8 input/output so Unicode prompts survive packaging.
- Built an unsigned, per-user NSIS installer. It requests no elevation and keeps
  app data on uninstall. The desktop library is separate from the browser library.
- Packaging stages an empty graph and omits import queues and source maps,
  without changing the source checkout's data. Source exports include `start.ps1`.

### Verification

- Source and packaged native windows passed the reader smoke: empty startup,
  sandbox isolation, Windows-backed encryption, two-graph import, PDF reading,
  notes/highlights, saved drafts/settings, graph isolation, and clean quit/reopen.
- The packaged Copilot SDK completed a fixture-backed discussion and cancelled
  a waiting CLI with descendants. Seven compiled protocol checks also covered
  file tools, graph rebuilding, Unicode, login errors, and structured failures.
- The packaged SDK also read the installed Copilot CLI's authenticated status
  and 20 models using desktop executable discovery, without a model turn.
- An actual packaged Electron crash closed its backend and released the library.
  Source/frozen lifetime checks also covered parent loss with a pipe still open,
  exclusive ownership, and rejection of a changed parent identity.
- 90 focused Python checks, four isolated graph API checks, 141 frontend tests,
  43 desktop Node tests, lint, and TypeScript checks passed. Two existing desktop
  symlink tests need unavailable Windows privileges and were excluded; one
  POSIX executable-permission test is skipped on Windows.

### Files and limits

- Installer: `release\desktop\Orbis-2.1.0-beta.1-win-x64.exe`.
  No-install app: `release\desktop\win-unpacked\Orbis.exe` (keep its folder intact).
- Main changes: `desktop/main.mjs`, `desktop/backend-lifecycle.mjs`,
  `desktop/agent-environment.mjs`, `desktop/server_boot.py`,
  `tools/desktop_runtime.py`, agent launcher/adapter/validator entry points,
  desktop build/export scripts, `package.json`, related tests, and setup guides.
- Build-tool downloads initially failed TLS negotiation. Verified wheel hashes
  against official PyPI metadata and installed build-only wheels locally;
  no certificate bypass, mirror setting, or lockfile URL change was retained.
- At this milestone, no installer was installed into the user's profile. Installed shortcuts,
  upgrade/uninstall, paid model turns, live Windows Google sync, Windows CI,
  signing, automatic updates, and other Windows architectures remain unverified
  or deferred. macOS/Linux were not executed here.
- Used disposable libraries and stopped verification processes. No personal
  library, running browser server, commit, push, or published release was changed.

### User confirmation after the preview build

- The user installed the preview, launched it from the desktop, added a real
  paper, and received an answer about highlighted text.
- The user also confirmed the work persisted after closing and reopening.
  These are user-reported checks; the selected provider was not recorded.

## 2026-11-14 - Windows installer maintenance

### Done

- Setup now refuses upgrades and removal while Orbis is running, rather than
  forcing it closed. Save work and quit before continuing.
- Added `npm run test:installer`: two temporary versions, a separate app identity,
  synthetic libraries, and automatic removal of successful test installations.
- Added a manual Windows x64 workflow with clean-source builds, installer checks,
  and SHA-256 checksums. It uploads build artifacts, not published releases.
- Included the NSIS safety hook in clean source exports and updated setup guides.

### Verified locally

- Installed into a path containing spaces, `&`, and Chinese characters; checked
  both shortcuts through Windows's Unicode shell-link interface.
- Upgraded version 1 to 2, uninstalled, and reinstalled. Every library file kept
  its hash across setup/removal; PDF position, notes, highlights, saved drafts,
  and discussion history reopened correctly.
- Running-app upgrade and direct uninstall both returned refusal code 2 without
  terminating the app. Normal uninstall removed application files, registration,
  and shortcuts while retaining the synthetic library.
- The installed native reader and fixture-backed Copilot discussion/cancellation
  passed. The real Orbis registration and shortcuts were unchanged.
- 43 desktop Node tests passed with the existing symlink exclusions; one POSIX
  case was skipped. The 90 targeted Python checks completed with three skips;
  all nine frozen-service checks passed. Lint and clean-export checks passed.
- Rebuilt `release\desktop\Orbis-2.1.0-beta.1-win-x64.exe` and
  `release\desktop\SHA256SUMS.txt`. Evidence is in `build\installer-check`.

### Still separate

- Google sign-in/sync was skipped as requested. No paid model calls were made.
- Publisher signing, a branded application icon, and automatic updates remain
  pending. The new Windows workflow has not been run on GitHub.
- Work stays in `D:\Orbis` on `windows-support`. The installed personal app and
  library were not replaced; no commit, push, or release was made.
