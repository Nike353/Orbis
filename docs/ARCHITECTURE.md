# Orbis Architecture

## Boundaries

- `src/domain/`: Zod schemas, v1-to-v2 migration, graph operations, and the
  arXiv queue contract.
- `src/store/`: Zustand workspace state. Manual content edits always transfer
  ownership to `user`; layout-only changes can preserve ownership.
- `src/services/`: canonical graph loading/saving, Markdown export, arXiv
  manifest/state loading, and streamed local-agent bridge events.
- `src/components/`: responsive application shell, full-bleed Three.js graph,
  review tools, filters, inspector, Add Paper dialog, and import queue.
- `tools/serve.py`: localhost-only production server, revision-safe atomic
  persistence, durable queue state, cancellation, and transactional
  local-agent execution.
- `tools/agent_bridge.py`: Claude Code and Codex command construction,
  disposable processing workspaces, output contract validation, and guarded
  apply.
- `tools/retrieve_arxiv.py`: metadata-only arXiv retrieval. It never reads a
  PDF, assesses semantic relevance, summarizes, clusters, or edits the graph.

## Data Flow

`data/graph.json` remains canonical. The browser prefers `GET /api/graph`,
falls back to static JSON, then to generated `data/graph.js`. API saves include
the loaded base revision; stale writes receive HTTP 409. Successful writes
atomically replace JSON and its mirror.

Schema v1 files migrate in memory to v2. Zod validates required fields,
ownership/status values, duplicate IDs, cluster membership, edge endpoints,
paper cards, and confidence bounds before data enters application state.

## Local Agent Boundary

Users choose an installed Claude Code or Codex CLI. The selected local process
reads papers, assesses relevance, summarizes, clusters, and proposes graph
changes inside a disposable workspace. No agent process edits the canonical
repository directly. Valid inserted output is copied back only after schema,
provenance, ownership, revision, edge, note, and stale-base checks.
Excluded and failed outcomes must leave every owned file byte-identical.
Inserted and excluded outcomes must additionally attest an exact arXiv
HTML/PDF source that the bridge observed the agent fetch; the source and
reviewed sections/pages are retained in the portable queue ledger.
Legacy outcomes can be audited with
`tools/revalidate_arxiv_outcomes.py`; the audit has no write/edit tools,
rejects any disposable-workspace mutation, and updates only attestation fields
after the prior classification is independently confirmed.

`data/imports/humanoid-loco-manipulation-2026-state.json` is the portable
server-owned processing ledger. Browser storage is not authoritative.

## Verification

- Vitest: schema, migration, domain behavior, repository fallbacks/conflicts,
  Markdown export, queue contract, and NDJSON streaming/cancellation.
- Python unittest: graph validator, Atom parsing, version deduplication,
  offline 50-record fixture build, atomic persistence, and rollback.
- Playwright: desktop/mobile rendering, WebGL pixel distribution, search,
  filters, inspection, review, Add Paper, export, malformed import, revision
  conflict, and token-free agent cancellation.
