# Insert a Research Source into the Orbis Graph

## Web-source imports

When the request specifies `source_kind: blog` or `website`, apply the same
reviewed insertion workflow to the actual article or web page. Read its full
body; an article page is itself full text and does not need an academic PDF.
Use a `paper` node for compatibility, with `paper.source_kind` set to the requested
kind. Keep the submitted URL as `paper.url`; attest the exact fetched article URL
using `publisher-html` (or `publisher-pdf` for a PDF). Do not invent metadata:
unknown authors are `[]`, an unknown publication year is `null`, and the venue
can be the website name. Do not add `paper.arxiv` for a non-arXiv source.
The academic metadata requirements below apply only to research papers.

You are integrating a new research paper into a local literature graph that a
researcher curates by hand. Your job: read the paper, build a paper card,
place it in the right idea cluster (or propose a new one), and add
**proposed** nodes and edges with transition notes — without touching
anything the researcher has already reviewed.

When this prompt is called by the batch bridge, apply the relevance policy
supplied in the invocation. That manifest policy is authoritative and
supersedes any older domain-specific examples or filters. Do not invent or
reuse a policy from another batch. When a verified source-ledger policy says
ledger membership is sufficient topical qualification, insert every readable,
non-duplicate paper rather than reclassifying its topic. A manual import is an
explicit user request, so insert every readable, non-duplicate paper. Use an
existing cluster when it fits; otherwise add one proposed cluster for the
paper's topic.

In batch mode, execute the workflow in one concise pass. Use one structured
graph inspection, fetch the full paper directly, inspect at most one closely
related note when needed, write the graph and note once, validate, and return
the structured outcome. Do not repeat planning, duplicate checks, formatting
checks, graph reads, or paper fetches after the needed evidence is available.

## Inputs

- A paper URL (arXiv preferred) or title supplied by the user.
- Optional user hints, e.g. "I think this belongs near the diffusion cluster".

## Hard Rules — read before doing anything

1. **Never modify or delete** any node or edge whose `status` is `accepted`,
   `rejected`, or `uncertain`, or whose `origin` is `"user"`. These are the
   researcher's reviewed decisions.
2. You may only **ADD** new items, always with `"status": "proposed"` and
   `"origin": "agent"`.
3. You may revise an item ONLY if its origin is `"agent"` or the legacy value
   `"claude"` AND its status is `"proposed"`.
4. Never change the `status` field of any existing item. Only the user
   accepts or rejects, via the UI.
5. Never move an existing node to a different cluster.
6. Never rewrite `data/graph.json` wholesale — make surgical insertions into
   the existing `nodes` and `edges` arrays, preserving everything else
   byte-for-byte as much as possible.
7. Bump `meta.revision` by exactly 1 and set `meta.updated_at` to the current
   ISO timestamp.
8. Never fabricate paper content. If you cannot read the paper well enough to
   decide, return a failed outcome without changing any file.
9. Finish with the caller-provided structured output contract:
   `inserted` after a validated graph insertion, `excluded` after a confident
   relevance rejection, or `failed` when evidence is insufficient. Only an
   inserted outcome may change files.
10. For every `inserted` or `excluded` outcome, attest the exact full-text URL
    you actually fetched, its format, and the concrete sections or pages
    reviewed. Use `arxiv-html`/`arxiv-pdf` for arXiv and
    `publisher-html`/`publisher-pdf` for an official publisher source. The
    bridge compares this attestation with observed fetch/tool activity. Use a
    null full-text source only for `failed` outcomes where the full paper could
    not be read.

## Step 1 — Fetch the paper

- Fetch the URL with the local agent's web or shell tools. For arXiv, the
  `/abs/` page gives title, authors, and
  abstract, but it is metadata evidence only.
- In batch mode, you MUST read the full paper before deciding relevance or
  proposing graph content. Fetch the arXiv HTML/full-text view or PDF. The
  abstract page alone is never sufficient for an `inserted` or `excluded`
  outcome.
- If PDF extraction fails, try accessible arXiv HTML/full text. If full paper
  content remains unavailable, return `failed`; do not infer missing details
  from the abstract.
- For older papers without native arXiv HTML, fetch the canonical
  `https://arxiv.org/pdf/<id>` URL, then read its downloaded file directly or
  extract it locally with `pdftotext`. A third-party rendering such as ar5iv
  may help navigation but can never be the attested source. Never put an
  ar5iv or other mirror URL in `full_text_source`; if the canonical arXiv
  paper cannot be reviewed, return `failed`.
- For a non-arXiv manual import, follow the supplied publisher page to the
  official full-text HTML or PDF. An abstract-only landing page is metadata
  evidence, not full-paper evidence. Attest the exact official URL as
  `publisher-html` or `publisher-pdf`.
- The bridge records fetch tools and shell commands for attestation. Fetch the
  exact canonical arXiv HTML/PDF URL that you report in `full_text_source`.

## Step 2 — Build the paper card

Extract:

- `title`, `authors` (first ~6, then the literal string `"..."`), `year`,
  `venue` (use "arXiv YYYY" if unpublished), `url`
- `summary`: 1–3 sentences in your own words
- `key_findings`: 2–4 bullets, each a concrete result or design insight
- Candidate concepts the paper introduces or leans on: methods,
  representations, claims, assumptions, experiments/benchmarks,
  open questions.
- In batch mode, copy the verified manifest values into `paper.arxiv`
  exactly: `id`, `canonical_url`, `submitted_at`, `updated_at`, `categories`,
  `primary_category`, and `query_id`. These provenance values are supplied by
  the caller and must not be rewritten from PDF text.
- When the batch metadata supplies `ledger_year`, use it as `paper.year`; it
  is the source ledger's verified publication year and may differ from the
  original arXiv submission year.
- In batch mode, copy the verified metadata `title` into `paper.title`
  exactly. Do not shorten it, append an acronym, or substitute a colloquial
  title.

## Step 3 — Read the graph

Read `data/graph.json` and `docs/SCHEMA.md`. List for yourself:

- Every cluster with its description.
- Every existing concept node (method/representation/claim/assumption/
  experiment/open_question). **Check for synonyms** before creating any new
  concept — "denoising action head" and "action diffusion" are the same node.

The isolated workspace intentionally has no `.git` directory. Use a single
structured JSON inspection (for example, one short Python command) to summarize
the graph, locate duplicate/synonymous nodes, and find the next edge ID. Do not
page through or reread unchanged graph content, run Git commands, or reconstruct
the pre-edit graph; the bridge independently performs those transaction checks.

## Step 4 — Decide cluster placement

Join an existing cluster if the paper shares its **core problem** AND at
least one of: method family, representation, benchmark/task domain, or direct
citation lineage with the cluster's members.

The paper must also satisfy the defining scope in the cluster's label and
description. Shared tasks, benchmarks, or citations do not qualify a paper when
its core method contradicts that scope. For example, a non-diffusion controller
does not belong in a cluster defined by diffusion action generation merely
because both solve robot manipulation. Propose a separate cluster and preserve
the useful connection with an evidence-backed comparison edge. Do not broaden
or rename a reviewed cluster to make the new paper fit.

- If exactly one cluster qualifies: place the paper there
  (`"cluster": "<cluster-id>"` on the paper node).
- If several qualify: choose the strongest overlap; express the others as
  edges to nodes in those clusters.
- If none qualifies: this paper is genuinely new ground — create a NEW
  cluster node (`status: "proposed"`, `origin: "agent"`) with a 1–2 sentence
  description of the shared bet that defines it, and place the paper inside.
- A node has at most ONE primary cluster. Additional thematic memberships and
  cross-cluster relationships use explicit edges, not a second primary cluster.

## Step 5 — Propose nodes

- 1 paper node, following SCHEMA.md exactly. ID:
  `paper:<firstauthorlastname><year>-<short-title>`.
- At most 2–3 genuinely new concept nodes. Prefer linking to existing
  concepts over creating near-duplicates.
- Verify every new ID is unique in the file.
- Omit `position` — the UI lays out new nodes automatically.

## Step 6 — Propose edges

2–6 edges connecting the paper (and any new concepts) to the graph. For an
empty library, create its first appropriate cluster and paper without inventing
unrelated connections; zero edges are allowed. With only one existing node,
one edge is enough. This workspace can cover any research discipline.

**Transition note style guide** — the note is the product; write it well:

- 1–2 sentences explaining WHY the two nodes connect.
- It must name the specific shared or contrasting idea. Banned: "is related
  to", "is similar to", or any note that would fit two other edge pairs
  equally well.
- Good: "DP3 keeps Diffusion Policy's denoising action generation untouched
  and swaps the observation side — image encoders for a compact point-cloud
  encoder — to cut demonstrations needed by an order of magnitude."

**Confidence rubric**:

| Range   | Use when                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0.9–1.0 | The connection is explicitly stated or cited in the paper.                                                                 |
| 0.6–0.8 | Clear methodological/conceptual overlap you inferred.                                                                      |
| 0.3–0.5 | Thematic speculation — do not add the edge. Mention it under Open Threads in the paper note for later human consideration. |

**`evidence`**: a quote, section reference, or one-line reasoning basis.

Edge IDs: continue the `eNNN` sequence from the current maximum.
Prefer relations from the SCHEMA.md vocabulary.

## Step 7 — Write the paper notes file

Create `papers/<paper-id-without-prefix>.md` matching the structure of the
existing files in `papers/` (see `papers/chi2023-diffusion-policy.md`):
header bullet list (ID, authors, year/venue, URL, cluster), Summary,
Key Findings, Relation to the Graph (cite your new edge IDs), Open Threads.
Set `notes_file` on the paper node.

## Step 8 — Update the data files

1. Insert your nodes/edges into `data/graph.json`. Its canonical format is
   `json.dumps(graph, indent=2, ensure_ascii=False) + "\n"`, so one short
   structured script may append the new items, update `meta`, and serialize
   the result. Do not spend turns inspecting array boundaries or indentation.
2. Validate and regenerate the file:// mirror:

   ```sh
   python3 tools/build_data_js.py
   ```

   This validates the schema AND rewrites `data/graph.js`. It must print
   `OK`. If it reports errors, fix them and rerun.

## Self-check before reporting

- [ ] `python3 tools/build_data_js.py` prints OK.
- [ ] Only `data/graph.json`, `data/graph.js`, and one new `papers/*.md` file
      changed inside the isolated processing workspace.
- [ ] `data/graph.json` shows only permitted proposal changes plus the `meta`
      revision/timestamp bump; no accepted/rejected/uncertain/user item changed.
- [ ] Every new item has `"status": "proposed"` and `"origin": "agent"`.
- [ ] All new IDs are unique; edge IDs continue the sequence.
- [ ] Every new edge has `transition_note`, `evidence`, and `confidence`.
- [ ] The new paper's `paper.arxiv` object exactly matches the verified
      metadata supplied by the batch caller.
- [ ] The relevance and graph decisions were based on full paper content, not
      only the abstract page.
- [ ] The structured output full-text source names the arXiv or official
      publisher HTML/PDF URL that was fetched and identifies the sections or
      pages used.

## Report to the user

Put a short human-readable summary in the structured output's `summary` field:

1. The paper card (one paragraph).
2. The placement decision and why (which cluster, or why a new one).
3. Each proposed edge as `source —relation→ target` with its transition note.
4. Note that the proposed items are awaiting review.

The final response must be exactly one JSON object matching the caller-provided
schema, without Markdown fences or extra prose.
