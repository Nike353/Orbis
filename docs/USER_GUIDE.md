# Your personal research workspace

Start with `sh start.sh`. The launcher keeps your library separate
from the application. Use `--workspace /path/to/library` to open another library;
an empty directory becomes a new universe. Open the localhost URL printed by
the server. Browsing and manual editing need no agent. AI features require a
signed-in Codex or Claude Code CLI.

## Add and connect papers

Use **Add source**, choose Research paper, Blog post, or Web page, paste a URL,
and choose an agent. Blogs and websites use the actual article body as full text;
unknown authors or dates remain unknown rather than being invented. The insertion workflow
retrieves full text in a disposable workspace and proposes a paper, concepts,
cluster placement, and evidence-backed relationships. Review the proposals in
the queue. An empty library can accept its first paper without existing links.

Select a record to inspect its original Markdown source notes and your personal
notes. Personal notes offer **Write** and **Preview**, with a formatting toolbar,
Markdown tables and code blocks, inline math (`$E=mc^2$`), and display math
(`$$` on lines before and after an equation). Raw HTML is not rendered.
Edit names or primary cluster with **Apply edits**; notes update the working graph
as you type. Use **Save changes** to persist your work.
The Library panel also offers **Create cluster, method, or connection**. A manual
connection requires a source, target, relation, explanation, and evidence.
Use `belongs_to` from a paper to a cluster to add a secondary membership.

## Discuss and edit through an agent

Select **Discuss this node** in an inspector, or open **Discuss** and choose up
to 20 papers, methods, or clusters. A cluster includes its members; methods include
their neighbors. An unscoped question uses a bounded overview, not the entire
full-text library. The answer's **Sources and context** reports coverage.

Examples:

- “Explain this method and suggest a note describing its limitations.”
- “Rename this cluster to Action Generation and move this paper into it.”
- “Create a cluster for my sim-to-real reading and propose connections to it.”
- “How do these two papers relate? Propose an edge with supporting evidence.”

Answers use saved summaries and source notes; this workflow does not retrieve
new full text. Review cited evidence. Proposed changes show before/after values
and require **Accept all changes**. Reject a bundle or ask for a revised one.
If the graph changed since the proposal, ask for a fresh proposal. **Save answer
as note** appends the answer and citations to the chosen record without replacing
its original Markdown source notes.

## Compare papers

Open **Compare**, choose 2–20 papers, and select columns such as input,
architecture, training objective/loss, training data, evaluation, or limitations.
Add custom columns (up to 12 total). Each table cell includes expandable evidence;
missing information must be stated rather than guessed. Export a table as CSV,
or the conversation as Markdown or JSON. Ask follow-up questions in the same
comparison. Start a new comparison to change its papers or columns.

## Sessions, limits, and backups

Conversations belong to LitBench and live in `data/research.json` inside the
selected workspace. Each CLI invocation is ephemeral; it does not accumulate
an unbounded provider conversation. Refreshing or leaving the view does not
cancel a server-side run. Reopen it from the saved conversation list. Stopping
the server interrupts active work; completed answers survive a restart.

The context includes at most eight previous completed answers, with bounded
history and source excerpts (90,000 characters of detailed records, up to 10,000
per source note), a catalog of up to 2,000 records, and up to 300 relevant edges.
Narrow the scope when coverage is incomplete. Each workspace allows 100 saved
conversations and 100 turns per conversation. Runs share one agent slot, have a
10-minute timeout and an 8 MB output limit. Archive conversations to hide them;
export and delete old conversations to reclaim capacity. Deleting a conversation
does not undo accepted graph edits or saved notes.

For a complete backup, stop the server and copy the entire workspace, including
`data/graph.json`, `data/graph.js`, `papers/`, `data/research.json`, and
`data/imports/`. The toolbar graph export does not include conversation history.

## Troubleshooting

- Run `sh start.sh --doctor` to inspect prerequisites.
- If an agent is missing, install and sign in to its CLI, then restart the server.
  Set `LITBENCH_CODEX` or `LITBENCH_CLAUDE` for a custom executable path.
- A provider usage limit or authentication failure comes from that CLI's account.
  Retry after resolving it; LitBench does not purchase credits or reset limits.
- Save local drafts before asking an agent or accepting a proposal. Reload after
  another client changes the graph.
- Only one server can open a workspace at once. Use different workspace paths
  and ports for separate libraries.
- Source builds need Node.js 20.19+ and npm. Prebuilt runtime archives only need
  Python 3.10+ plus an agent for AI features. macOS and Linux are supported;
  native Windows is not supported by the current process and file-lock code.

## Keep separate graphs

Click the folder beside **Orbis**, name a graph, and choose **Create empty graph**.
Click **Open graph** on its card. Your existing library remains available in the
same chooser. Save unsaved graph edits first; switching is blocked until you do.

Every graph owns its graph data, paper files, conversations, proposals, and import
queue. A run in one graph does not share another graph's write lock. Locally each
open graph uses a separate loopback port; return through the chooser rather than
bookmarking those temporary ports. Restart from the main workspace's launch URL.

## Keep useful answers without conversation clutter

Choose **Review answer as note**, select the destination record, and edit the
draft before choosing **Save edited note**. Only the draft text is appended to
your personal notes. The conversation, citations, and saved-note provenance
remain in research history. Saving the same turn to the same record is idempotent.

## Explore a larger universe

Paper markers no longer have permanent orbital rings. Cluster spacing grows with
membership and field boundaries grow to fit their contents. Select a field to
focus it, or filter to that field to explore just its sources and relationships.
The focus camera fits the field's current extent. Switch to 2D Lineages for a
chronological view; web sources without dates appear under **Undated**.
