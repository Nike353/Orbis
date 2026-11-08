# Orbis

**Your papers, your notes, your research universe.**

Orbis is an open-source research workspace for macOS and Linux. Read papers,
write your own notes, ask questions beside the original, and connect ideas in
an interactive galaxy. Bring your own Codex or Claude Code installation; you
choose the agent, model, and effort, and review its proposed changes.

Your library lives on your computer. Optional encrypted Google Drive sync keeps
independent laptops up to date without a Git push/pull routine or an always-on
Orbis server. Every fresh installation starts with an empty library.

![Orbis universe view](docs/images/universe.png)

_Example visualization. The application does not ship with the pictured library._

## What you can do

- **Read the original beside your thinking.** Attach or retrieve PDFs and readable
  web articles. Scroll a continuous PDF, search its text, follow linked references,
  highlight passages, and add comments.
- **Make notes your own.** Keep authored notes separate from generated summaries.
  Write Markdown and LaTeX, resize the reading panel, and review an answer before
  saving it as a note.
- **Discuss a paper where you read it.** Ask questions in the paper's Discuss tab
  or about a selected passage. Answers use bounded passages from available
  originals and include page/section citations. Sources and context shows when
  only notes were available.
- **Compare evidence.** Compare 2–20 papers using standard or custom criteria,
  inspect each cell's evidence, ask follow-ups, and export the table.
- **Build a connected library.** Add research papers, blog posts, and web pages.
  Research summaries cover motivation, background, the complete framework,
  results, and limitations. Additional instructions supplement this structure.
- **Explore your universe.** Switch between the 3D galaxy and chronological 2D
  lineages. Focus a cluster or filter down to it, inspect connection notes, and
  create your own methods, clusters, and evidence-backed relationships.
- **Keep projects independent.** Create multiple graphs with their own sources,
  notes, discussions, and import queues. Follow work and recover failed tasks
  through Activity; review agent proposals before applying them.
- **Use your own agent account.** Orbis discovers installed Codex and Claude Code
  CLIs and their model/effort options. It uses their existing authentication and
  account limits. Browsing, reading, and manual editing need no agent.

AI summaries and citations still need your judgment. Original retrieval improves
context; it does not guarantee that an answer interprets the paper correctly.

## Get started

**Current version: 2.1.0-beta.1 — desktop preview.** macOS Apple Silicon and Ubuntu
have been exercised during development. This preview is unsigned, is not notarized,
and does not include automatic updates. See [verification details](docs/MAC_VERIFICATION.md).

### Desktop app

Build on the computer you will use, with **Git, Node.js 22, and uv** installed:

```sh
git clone https://github.com/Nike353/Orbis.git
cd Orbis
npm ci
npm run desktop:build
```

The build downloads Python 3.12 and packages the local service. Outputs appear
in `release/desktop/`: a DMG/ZIP on macOS, or an AppImage/DEB on Linux. Open the
DMG and copy Orbis to Applications; on Linux, install the DEB or make the AppImage
executable and open it. Subsequent launches require no terminal, Node, or Python.
Installers are built for the host OS and CPU architecture.

The repository also includes a manually triggered
[desktop build workflow](https://github.com/Nike353/Orbis/actions/workflows/desktop.yml).
Successful runs provide preview installers as Actions artifacts; downloading those
artifacts requires a GitHub sign-in. Release downloads, when published, appear on
[Releases](https://github.com/Nike353/Orbis/releases). Do not assume that every source
commit has a prebuilt installer.

On first launch:

1. Add a source, or use **Local library → Import existing Orbis library** to copy
   an existing library into an empty installation.
2. Open a paper with **Read** and attach or retrieve its original.
3. Install and sign in to Codex or Claude Code if you want AI assistance, then
   restart Orbis and select your agent/model in Add source, Discuss, or Compare.
4. Optionally connect Google Drive using the setup below.

See the [desktop guide](docs/DESKTOP.md) for paths, upgrades, agent detection,
builds, and troubleshooting, and the [user guide](docs/USER_GUIDE.md) for workflows.

### Try the browser version

```sh
git clone https://github.com/Nike353/Orbis.git
cd Orbis
sh start.sh
```

The launcher prepares its managed tools, builds the frontend, and prints a local
URL. First launch needs internet access and can take several minutes. Your
workspace is stored separately from the application checkout. To choose another:

```sh
sh start.sh --workspace /path/to/my-library
```

The browser version supports local research workflows. Google Drive sign-in,
encrypted sync, and native operating-system integration require the desktop app.

## Optional Google Drive sync

Each laptop keeps its own library and works while the other is asleep. When Orbis
is open, it syncs graph records, notes, saved discussions, highlights, and original
metadata through Drive. Original PDFs/articles upload as separately encrypted
files and download on demand. Use **Keep offline** for papers you want available
without a connection. You do not have to download the whole collection on every
computer. Storage counts against your Google Drive quota.

This source distribution does **not** contain a Google OAuth client configuration.
For a self-built app, follow the [one-time Google setup](docs/DESKTOP.md#one-time-setup-for-the-app-owner)
and choose the downloaded **Desktop app** client JSON in Orbis. Use the same
configuration on every device. A distributor can bundle its app configuration
so end users only need to sign in; it must never bundle personal tokens or keys.

On the first laptop, sign in and enable encrypted sync. Save the recovery key.
On the second, sign in to the same Google account, select the existing library,
and enter that key. Google sign-in alone cannot decrypt or recover your library.
Linux needs a working Secret Service or KWallet for secure credential storage.

Sync checks for changes while the app is open and presents conflicting edits for
review. It stops when you quit. Local working files are not encrypted by Orbis;
keep an independent backup. See [sync, conflicts, and recovery](docs/DESKTOP.md).

## Your data and your agents

- The public repository contains app code, an empty graph, and test fixtures.
  Your working library belongs outside the application checkout.
- Desktop upgrades preserve the separate library. **Open local library folder**
  shows its location. Back it up with Orbis closed, including downloaded originals.
- Agent credentials remain on each device. AI runs use the selected CLI's configured
  provider; selected notes and source passages may leave your machine for inference.
  Local orchestration does not mean the model itself runs locally.
- Agent changes are validated and reviewed before application. The app does not
  silently replace your personal notes with a conversation transcript.
- Orbis serves only on localhost. Do not expose its local API to the internet.

Read the [security notes](SECURITY.md) before adapting the app for shared hosting.
Windows and mobile clients are not currently supported.

## Develop and contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification commands and disposable test
workspaces. Architecture, schema, and release packaging are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SCHEMA.md](docs/SCHEMA.md), and
[docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md). The code is available under the
[MIT license](LICENSE).
