# Your personal research workspace

Open the desktop app, or start the browser version with `sh start.sh`.
The launcher keeps your library separate
from the application. Use `--workspace /path/to/library` to open another library;
an empty directory becomes a new universe. Open the localhost URL printed by
the server. Browsing and manual editing need no agent. AI features require a
signed-in Codex or Claude Code CLI.

In compact windows, the toolbar uses icons with labels on hover. The library and
inspector take turns to leave room for the galaxy; use the tool rail or close the
inspector to switch between them. The PDF fits the reader width as you resize,
while zooming beyond Fit width still allows horizontal scrolling.

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
as you type. The desktop app saves accepted edits automatically; use **Save changes**
in the browser version to persist your work.
The Library panel also offers **Create cluster, method, or connection**. A manual
connection requires a source, target, relation, explanation, and evidence.
Use `belongs_to` from a paper to a cluster to add a secondary membership.

## Read originals and keep notes beside them

Select a paper and choose **Read**. Attach a PDF or retrieve an accessible
PDF/article from its source URL. The reader shows the original beside **Summary**,
**My notes**, **Discuss**, and **Connections**. Scroll through the whole PDF;
the page field follows your reading position. Use the page field or arrows for
quick jumps, search PDF text, zoom, and select a passage to highlight or discuss it.
Zoom keeps your place in the paper. Highlights link back
to their page; comments support Markdown and have an explicit **Save comment**.
Image-only PDFs remain readable but need a text version for source-grounded answers.

Choose **Highlight and comment** to open the new highlight's comment editor.
Hover a highlighted passage or its margin marker to preview a saved comment.
Click the marker to find its card under **My notes**.

Hover a linked citation inside the PDF, or focus it with the keyboard, to preview
its full reference. Click it to open the bibliography, then use **Back to citation**
to return to your reading position. Previews use the PDF's reference text.
Unlinked, scanned, or ambiguous references require manual navigation.

Your authored notes stay separate from summaries and imported source notes.
Desktop quit and navigation flush notes, reading position, and unsent discussion
and comment drafts. Saved notes/highlights sync; unsent drafts stay on this device.
The resizable side panel and optional library let you move between papers without
losing the galaxy canvas, camera, selection, lens, or filters.

In the desktop app, originals sync through encrypted Google Drive storage.
Download an original when you open it, or enable **Keep offline**. **Remove download**
removes only the verified local cache after checking Drive; it keeps notes and
highlights. GitHub carries application changes, not new reading-library content.

## Discuss and edit through an agent

Select **Discuss** in an inspector, or open **Discuss** and choose up
to 20 papers, methods, or clusters. A cluster includes its members; methods include
their neighbors. An unscoped question uses a bounded overview, not the entire
full-text library. The answer's **Sources and context** reports coverage.

Examples:

- “Explain this method and suggest a note describing its limitations.”
- “Rename this cluster to Action Generation and move this paper into it.”
- “Create a cluster for my sim-to-real reading and propose connections to it.”
- “How do these two papers relate? Propose an edge with supporting evidence.”

Answers use bounded passages from locally available originals, selected text,
saved summaries, and source notes. Original citations open the supplied page or
section; **Sources and context** distinguishes originals from notes-only evidence.
Download a missing original before asking about its full text. Review cited
evidence: validating a quotation does not prove the answer's interpretation.
Proposed changes show before/after values
and require **Accept all changes**. Reject a bundle or ask for a revised one.
If authored graph content changed since the proposal, ask for a fresh proposal.
This also applies after import or sync; a coincidentally matching revision number
cannot make a stale proposal safe. **Save answer
as note** appends the answer and citations to the chosen record without replacing
its original Markdown source notes.

## Compare papers

Open **Compare**, choose 2–20 papers, and select columns such as input,
architecture, training objective/loss, training data, evaluation, or limitations.
Add custom columns (up to 12 total). Each table cell includes expandable evidence;
missing information must be stated rather than guessed. Export a table as CSV,
or the conversation as Markdown or JSON. Ask follow-up questions in the same
comparison. Start a new comparison to change its papers or columns.
Original-backed cells need evidence from the corresponding paper. Missing originals
or unsupported claims appear as missing evidence or quality warnings.

## Sessions, limits, and backups

Conversations belong to Orbis and live in `data/research.json` inside the
selected workspace. Each CLI invocation is ephemeral; it does not accumulate
an unbounded provider conversation. Refreshing or leaving the view does not
cancel a server-side run. Reopen it from the saved conversation list. Stopping
the server interrupts active work; completed answers survive a restart.

The context includes at most eight previous completed answers, bounded source
passages and notes, a catalog of up to 2,000 records, and up to 300 relevant edges.
Its final UTF-8 payload is capped at 96 KB, or a lower supported model budget.
Narrow the scope when coverage is incomplete. Each workspace allows 100 saved
conversations and 100 turns per conversation. Runs share one agent slot, have a
10-minute timeout and an 8 MB output limit. Archive conversations to hide them;
export and delete old conversations to reclaim capacity. Deleting a conversation
does not undo accepted graph edits or saved notes.

For a complete backup, stop the app/server and copy the entire workspace, including
`data/`, `papers/`, `attachments/`, and independent `graphs/`. A local backup contains
only originals downloaded on that device. Keep the recovery key in your password
manager for encrypted Drive copies. Toolbar graph export contains only graph data.

Open **Activity** to follow imports, original retrieval, discussions, and comparisons.
Closing a view leaves work running. Cancel from Activity; interrupted work offers
retry after a restart. Proposals still need review before changing your library.

## Troubleshooting

- Run `sh start.sh --doctor` to inspect prerequisites.
- If an agent is missing, install and sign in to its CLI, then restart the server.
  Set `ORBIS_CODEX` or `ORBIS_CLAUDE` for a custom executable path.
- A provider usage limit or authentication failure comes from that CLI's account.
  Retry after resolving it; Orbis does not purchase credits or reset limits.
- Save local drafts before asking an agent or accepting a proposal. Reload after
  another client changes the graph.
- Only one server can open a workspace at once. Use different workspace paths
  and ports for separate libraries.
- Source builds use Node.js 22 and npm. Terminal builds use Python 3.12 and uv;
  the desktop app bundles its local runtime. AI features need a signed-in CLI.
  macOS and Linux are supported;
  native Windows is not supported by the current process and file-lock code.

## Keep separate graphs

Click the folder beside **Orbis**, name a graph, and choose **Create empty graph**.
Click **Open graph** on its card. Your existing library remains available in the
same chooser. Save unsaved graph edits first; switching is blocked until you do.

Every graph owns its graph data, paper files, original metadata, highlights,
conversations, proposals, and import queue. A run in one graph does not share another graph's write lock. Locally each
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

## Choose your agent, model, and effort

**Add source**, the import queue, **Discuss**, and **Compare** all include Model
and Effort controls. Install and sign in to Codex or Claude Code first. Orbis
automatically discovers their local installations and reads their current models
and supported effort levels. New selections use the CLI's configured model and
**medium** effort when supported. If both CLIs are installed, Codex is the initial
agent unless you saved another choice or set `ORBIS_DEFAULT_AGENT`.

Codex choices come from its app-server model list; Claude choices come from its SDK
initialization. The picker shows the installed version, resolved default, and
provider-specific model IDs. Older unprefixed Sol preferences are matched to the
configured provider's current ID. If metadata cannot be read, the picker explains
the problem and keeps **CLI default** available without inventing model choices.
Choose **Custom model ID…** to enter another exact deployment ID supported by your
CLI. The provider/account determines permission and capacity; Orbis does not
silently switch models when a request fails.

**CLI default** omits that override, so the CLI's configured value takes effect.
Your selections are remembered per agent across workflows. Desktop preferences
survive restarts and graph switches; browser preferences belong to that browser
address. They do not change your global CLI configuration or a run already in
progress. Research answers and Markdown exports include the requested settings;
when CLI default is selected, the resolved model is managed by that CLI.
Low effort is faster; medium balances speed and depth. High, max, and similar
levels can take substantially longer, especially with a large evidence context.
The picker labels your CLI's configured default effort so this is visible.

Cluster galaxies use softly scattered stardust and a faint central glow.
Their decoration dims when another field is focused, preserving the visibility
of paper markers and evidence paths. Wider spacing and dynamic field sizing
remain in place.
On software graphics, rotation starts paused and the idle galaxy stops redrawing.
Hovering, orbiting, zooming, and changing the view wake it. Use **Resume universe
rotation** when desired. Rendering also pauses while another workspace or Add
source covers the galaxy and when the window is minimized.

## Default paper summaries

Every newly imported research paper gets a full-text-grounded Markdown summary
with five sections: **Motivation and problem**, **Background and prior work**,
**Proposal and framework**, **Key results**, and **Limitations**. Multi-stage
frameworks explain each stage in order, including inputs, outputs, and training
versus deployment roles. Results identify evaluation conditions and source
references; limitations distinguish the authors' claims from labeled inference.

Use **Additional instructions** when importing to request extra explanations or
comparisons. These supplement the five sections. Requests unsupported by the
source should be identified as such. The import validator rejects missing or
empty sections; it cannot mechanically guarantee factual correctness, so review
the proposed content against the paper. Existing summaries are preserved.

For an existing paper with a readable original, choose **Regenerate with review**
in its Summary tab. This prepares a discussion request and preserves any question
draft already there. Send it, inspect the five-section replacement, and accept
only if useful. Acceptance changes that paper's summary/findings; authored notes,
connections, source identity, and discussion history stay separate.
