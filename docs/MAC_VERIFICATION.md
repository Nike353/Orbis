# macOS preview verification — 2026-11-08

Version: 2.1.0-beta.1, Apple Silicon, Electron 44.7.0, Python 3.12.14.

The application was built from an empty-library export, installed over the prior
preview, and launched using the existing profile after backing up the application
and profile. Existing Google pairing survived the upgrade and live Drive sync
completed. Original-file metadata synchronized; downloading those remote originals
on a second physical device was not verified in this session.

Validation completed:

- 125 UI unit tests, 137 Python tests, and 44 desktop unit tests.
- Lint, TypeScript checking, production frontend and frozen backend builds.
- 17 applicable browser scenarios passed across the initial suite and the layout
  regression rerun; one mobile-only scenario was skipped in the desktop project.
- Packaged native smoke: empty startup, library import, multiple graphs, original
  reading, annotations, fixture discussion, note drafts, preferences, close/reopen,
  renderer-requested close, Keychain encryption round trip, and renderer isolation.
- In an isolated library, a real Codex discussion retrieved the original 26-page
  DreamerV2 paper, cited pages 4 and 9, and left the graph unchanged. This was a
  live Codex check, not a live Claude Code check.

Corrections included in the verified build:

- Python dependencies use public PyPI rather than a workstation-specific registry.
- macOS native smoke uses platform-appropriate secure storage and graphics flags.
- The compact header activates before controls overflow at intermediate widths.
- Application shutdown waits for the local backend to release library locks.
- Codex MCP discovery uses the same plugin restrictions as the subsequent run,
  avoiding overrides for plugin servers that are no longer present.

The macOS preview is unsigned and unnotarized. Linux packaging and native behavior
were exercised during upstream development; these Mac-specific verification runs
do not constitute a new Linux installation test. Automated browser and fixture
checks do not prove that every live agent/provider or every sync conflict works.

## Public source and installer verification

The clean public export was independently checked on the same Mac:

- `npm run verify`: formatting, lint, types, 125 UI tests, 137 Python tests,
  production build, and empty graph/mirror validation passed.
- `npm run test:desktop`: 44 tests passed.
- `npm run test:e2e`: 18 scenarios passed; 18 platform-inapplicable cases skipped.
  The narrow browser layout check is not a claim of a supported mobile app.
- DMG and ZIP built from the empty source export, without a Google client JSON.
- Packaged native smoke passed against that public build using a disposable
  synthetic library, including import, reading, notes/drafts, discussion fixtures,
  restart persistence, and clean shutdown.
- Export and unpushed application history were checked for empty library data;
  the new source archive contains no source PDFs, personal records, OAuth client
  configuration, recovery data, or private Git history.

Live Google sync and the real Codex discussion were verified in the private Mac
checks above. The public native smoke uses fixtures and does not sign into Google
or a model provider. Public Linux installer checks remain the responsibility of
the native Linux build/verification workflow and subsequent installation testing.
