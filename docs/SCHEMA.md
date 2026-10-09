# Orbis Graph Schema

This document is the contract for `data/graph.json`. The browser UI and the
local-agent prompt (`prompts/insert_paper.md`) both conform to it. If you
change this file, update both sides.

## Top-level structure

```json
{
  "meta": { ... },
  "nodes": [ ... ],
  "edges": [ ... ]
}
```

### `meta`

| Field            | Type   | Notes                                                              |
| ---------------- | ------ | ------------------------------------------------------------------ |
| `schema_version` | int    | Currently `2`; v1 is migrated in memory on load.                   |
| `title`          | string | Workspace title shown in the UI header.                            |
| `revision`       | int    | Increment on every UI or agent save. Used for staleness detection. |
| `updated_at`     | string | ISO 8601 timestamp of the last save.                               |

## Nodes

Papers, clusters, and concepts all live in the single `nodes` array.

### Node types

`paper` · `cluster` · `method` · `representation` · `assumption` ·
`experiment` · `claim` · `open_question`

### Common node fields

| Field         | Required | Type   | Notes                                                                                                                                                                                                    |
| ------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | string | `<type>:<kebab-slug>`. Immutable once created. See ID conventions.                                                                                                                                       |
| `type`        | yes      | string | One of the node types above.                                                                                                                                                                             |
| `label`       | yes      | string | Short display name.                                                                                                                                                                                      |
| `status`      | yes      | string | `proposed` \| `accepted` \| `rejected` \| `uncertain`                                                                                                                                                    |
| `origin`      | yes      | string | `user` \| `agent`; legacy graphs may contain `claude`. Any manual UI edit flips it to `user`.                                                                                                            |
| `description` | no       | string | Longer prose for concept/cluster nodes.                                                                                                                                                                  |
| `cluster`     | no       | string | ID of the cluster this node belongs to. **At most ONE** (rendering constraint — express cross-cluster relationships as edges, never as dual membership). Cluster nodes themselves never have this field. |
| `created_at`  | no       | string | `YYYY-MM-DD`.                                                                                                                                                                                            |
| `position`    | no       | object | `{"x": number, "y": number}` — saved layout position.                                                                                                                                                    |

### Paper nodes — extra fields

| Field        | Required | Type   | Notes                                                     |
| ------------ | -------- | ------ | --------------------------------------------------------- |
| `paper`      | yes      | object | The paper card (below).                                   |
| `notes_file` | no       | string | Relative path, e.g. `papers/chi2023-diffusion-policy.md`. |

The `paper` card:

```json
{
  "title": "Full paper title",
  "authors": ["First Author", "Second Author", "..."],
  "year": 2023,
  "venue": "RSS 2023",
  "url": "https://arxiv.org/abs/2303.04137",
  "summary": "Markdown explanation: motivation, background, framework, results, and limitations.",
  "key_findings": ["finding one", "finding two"],
  "arxiv": {
    "id": "2303.04137",
    "canonical_url": "https://arxiv.org/abs/2303.04137",
    "submitted_at": "2023-03-07T17:55:41Z",
    "updated_at": "2023-03-07T17:55:41Z",
    "categories": ["cs.RO"],
    "primary_category": "cs.RO",
    "query_id": "direct-loco-manipulation"
  }
}
```

`authors` lists the first ~6 authors; append `"..."` (the literal string) for
longer lists. `arxiv` is optional for existing/manual records. It is required
for retrieved batch insertions and must exactly match the verified manifest.

## Edges

| Field             | Required | Type   | Notes                                                                                                                                 |
| ----------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | yes      | string | `eNNN`, zero-padded sequential (`e001`, `e002`…). New edges take max+1.                                                               |
| `source`          | yes      | string | Node ID.                                                                                                                              |
| `target`          | yes      | string | Node ID.                                                                                                                              |
| `relation`        | yes      | string | See relation vocabulary.                                                                                                              |
| `transition_note` | yes      | string | 1–2 sentences explaining WHY the two nodes connect. Must name the specific shared or contrasting idea. Never vague ("is related to"). |
| `confidence`      | yes      | number | 0.0–1.0. See rubric below.                                                                                                            |
| `evidence`        | yes      | string | Quote, section reference, or reasoning basis.                                                                                         |
| `status`          | yes      | string | `proposed` \| `accepted` \| `rejected` \| `uncertain`                                                                                 |
| `origin`          | yes      | string | `user` \| `agent`; legacy graphs may contain `claude`                                                                                 |
| `created_at`      | no       | string | `YYYY-MM-DD`.                                                                                                                         |

### Relation vocabulary (recommended, not closed)

`builds_on` · `extends` · `contradicts` · `supports` · `uses_method` ·
`uses_representation` · `assumes` · `addresses` · `evaluates_on` ·
`compares_to` · `inspired_by` · `questions`

Prefer an existing relation over inventing a new one.

### Confidence rubric

| Range   | Meaning                                                         |
| ------- | --------------------------------------------------------------- |
| 0.9–1.0 | Explicitly stated or cited in the paper itself.                 |
| 0.6–0.8 | Clear methodological/conceptual overlap inferred by the reader. |
| 0.3–0.5 | Thematic speculation — consider `status: "uncertain"`.          |

## ID conventions

- Pattern: `<type>:<kebab-slug>` — e.g. `cluster:diffusion-policies`,
  `method:action-chunking`, `open_question:cross-embodiment-transfer`.
- Papers: `paper:<firstauthorlastname><year>-<short-title>` —
  e.g. `paper:chi2023-diffusion-policy`.
- IDs are immutable. Never reuse an ID after deletion.

## Status lifecycle and edit-protection contract

- New items added by a local agent are always `status: "proposed"`,
  `origin: "agent"`.
- Only the user (via the UI) accepts, rejects, or marks items uncertain.
  Doing so flips `origin` to `"user"`.
- A local agent may modify only unreviewed proposals whose origin is `agent`
  or the legacy value `claude`. It never deletes anything and never rewrites
  the file wholesale.
- `rejected` items stay in the file (hidden in the UI by default) so future
  runs can see what was already considered and turned down.

## The `data/graph.js` mirror

`data/graph.js` is a GENERATED copy of `graph.json` wrapped in
`window.ORBIS_DATA = ...;` so the UI works when `index.html` is opened
directly from disk (`file://`), where `fetch()` is blocked. Never edit it by
hand — regenerate with:

```sh
python3 tools/build_data_js.py
```

## Web sources and note provenance

The optional `paper.source_kind` is `paper`, `blog`, or `website`; omission retains
research-paper semantics. All three use a `paper` graph node so existing links,
cluster membership, discussion, and comparison work unchanged. For blog/website
records, unknown authors may be `[]` and unknown `year` may be `null`. Research
papers still require authors and a valid publication year. `paper.url` identifies
the source, while full-text attestation preserves the actual fetched page URL.

`node.notes` is Markdown with dollar-delimited LaTeX. Saving an answer stores the
user-edited draft here. A research turn's `note_saves` array records destination
`node_id`, `saved_at`, and `citations` separately from the visible note. Existing
saved notes are not automatically rewritten.

`data/graphs.json` is a catalog of `{id, name}` entries. IDs are UUID hex strings;
each entry's independent workspace is `graphs/<id>/`. The original workspace is
exposed as the implicit `main` graph. The complete workspace folder is the backup
unit. Additional personal graphs and their catalog are Git-ignored by default.

New research-paper imports require `paper.summary` to contain these five exact
Markdown H2 headings in order: `Motivation and problem`, `Background and prior
work`, `Proposal and framework`, `Key results`, and `Limitations`. Each needs at
least 80 characters of explanation. Additional analysis may follow. This
insertion-only contract does not invalidate legacy saved graphs or impose
research-paper sections on blogs and websites. The full note file should retain
the same explanation, alongside graph relations and open questions.
