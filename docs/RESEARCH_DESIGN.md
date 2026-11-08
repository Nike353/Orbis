# Research and clustering design

The canonical library is a typed graph, not a fixed taxonomy. A paper can have
one primary cluster for stable layout, explicit secondary `belongs_to` edges,
and links to methods, claims, representations, and other papers. Accepted
secondary memberships are preserved. The universe can also infer up to three
additional memberships from graph evidence; these are a view over the graph,
not automatic rewrites of your organization.

For a personal research library, keep curated clusters as the default. People
organize literature around research questions that can overlap and change.
An agent can propose renaming, moving, creating, and connecting records, but the
user reviews the exact bundle. Manual controls provide the same ownership.

Embedding similarity or graph community detection would be useful future
suggestion mechanisms as libraries grow. They should produce reviewable proposed
groups, with evidence and an explanation of why the papers belong together.
Similarity alone does not establish a scientific relationship, and automatic
global reclustering would disrupt a user's existing mental map. No embedding
service, vector database, or clustering model is required by this release.

## Implementation

- React renders Discuss, Compare, graph inspection, and manual editing.
- The Python server selects the personal workspace independently of code/assets.
- `tools/research.py` assembles bounded library context and invokes the selected
  CLI with a strict output schema and read-only capabilities. Provider invocations
  are ephemeral. `tools/documents.py` supplies searched passages from verified
  local originals; selected text is checked against the original page.
- Answers, citations, comparison cells, and proposed graph operations are
  validated before storage. Comparisons must contain the complete requested grid.
- Original citations must resolve to a supplied passage, document/hash, and page
  or section. Each original-backed comparison cell cites its own source.
  Notes-only coverage and missing evidence remain visible. Quote/anchor validation
  and numeric warnings do not establish semantic correctness.
- Applying a proposal validates the current graph revision, the portable authored
  graph fingerprint from its creation, and the entire change bundle.
  Import/sync revision collisions cannot authorize stale operations. Legacy
  proposals without a fingerprint require regeneration.
  An intent journal recovers graph and conversation state together after a crash.
- Research and insertion share a run lock. Cancellation terminates the process
  group; temporary invocation files are removed. The server recovers interrupted
  turns without silently restarting paid model calls.

Notes generated during research live on graph records; original paper Markdown
remains available. Selective summary regeneration uses a separately reviewed
operation with the five required headings, leaving personal notes and connections
intact. Graph drafts are keyed by workspace identity to avoid mixing libraries
served from the same origin. Native model/effort preferences use the profile rather
than the temporary loopback port.
