# Contributing

Run `sh start.sh --prepare-only` on macOS or Linux to install the managed tools.
On Windows, run `.\start.ps1 --prepare-only` from PowerShell instead.
For development commands below, use Node.js 22+ on PATH and the uv environment.

```sh
uv sync --locked --python 3.12
export PATH="$PWD/.venv/bin:$PATH"
npm ci
npm run verify
npm run test:desktop
npx playwright install chromium
npm run test:e2e
```

For Windows browser development, use the managed Node 22 and Python paths:

```powershell
$env:PATH = "$PWD\.orbis\node-22.23.2\Scripts;$PWD\.venv\Scripts;$env:PATH"
uv run --locked --python 3.12 python -m unittest discover -s tests -p test_start.py
uv run --locked --python 3.12 python -m unittest tests.test_agent_process tests.test_agent_discovery
uv run --locked --python 3.12 python -m unittest tests.test_copilot_adapter tests.test_agent_settings
npm run test:unit
npm run lint
npm run build
```

The full `verify` command and Playwright server configuration still include Unix
commands or fixtures; they are not Windows verification commands yet. Windows
agent tests use disposable CLI fixtures, not paid turns or a personal library.
For Windows desktop development, use a separate `ORBIS_USER_DATA` profile and
follow [desktop setup](docs/DESKTOP.md#windows-development-and-packaging).
Local desktop packaging is supported; live Windows sync remains unverified.
After a frontend/backend build, `npm run test:installer` checks install, upgrade,
uninstall, and retained-library reinstall under a separate temporary app identity.
The manual desktop workflow includes a Windows x64 build and these checks.
See [Windows changes and verification](docs/WINDOWS_PORT.md) for known limits.

Tests use `tests/fixtures/library` and disposable workspaces, not a contributor's
personal library. CLI fixtures cover Claude, Codex, and Copilot without credentials
or paid model calls. The Copilot fixture exercises the pinned official SDK's
stdio protocol, not a mock API service. Keep Copilot import tools bounded to the
disposable workspace and research tools disabled. For manual provider testing,
create a separate workspace.

Keep graph schema validation, revision checks, evidence, and explicit review of
agent changes intact. Add behavior tests for new contracts and failure recovery.
Check desktop and narrow-screen UI when changing layouts. Never commit private
notes, source PDFs, agent output, account configuration, or personal queue state.
See `docs/RESEARCH_DESIGN.md` and `docs/OPEN_SOURCE.md` for design and packaging.
