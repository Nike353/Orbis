# Contributing

Run `sh start.sh --prepare-only` on macOS or Linux to install the managed tools.
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

Tests use `tests/fixtures/library` and disposable workspaces, not a contributor's
personal library. CLI fixtures cover both provider protocols without credentials
or paid model calls. For manual provider testing, create a separate workspace.

Keep graph schema validation, revision checks, evidence, and explicit review of
agent changes intact. Add behavior tests for new contracts and failure recovery.
Check desktop and narrow-screen UI when changing layouts. Never commit private
notes, source PDFs, agent output, account configuration, or personal queue state.
See `docs/RESEARCH_DESIGN.md` and `docs/OPEN_SOURCE.md` for design and packaging.
