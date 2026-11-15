# Orbis

**Read. Take notes. Discuss. Connect. Your research, yours to keep.**

An open-source research workspace for **macOS and Linux**. Bring together papers,
blogs, and web pages; work with your own AI agent; and build a universe of ideas.
Your library lives on your computer, with optional encrypted Google Drive sync.

**[Watch the two-minute demo →](docs/media/orbis-demo.mp4)**

![Orbis showing a personal research library as a 3D universe](docs/images/orbis-universe.jpg)

**Explore your research universe.** Rotate the galaxy, focus or filter a cluster,
and hover over connections to see why ideas belong together. Switch to 2D
lineages or keep different projects in independent graphs.

_Images show an example library. Fresh installations start empty; personal
papers and notes are not included._

## The original and your thinking, together

![A paper open beside personal Markdown notes, an equation, and a highlighted passage](docs/images/orbis-reading-notes.jpg)

Read the PDF or article beside its summary. Highlight passages, leave comments,
and write your own notes with **Markdown and LaTeX**. Your authored notes stay
separate from generated summaries.

## Ask questions where you read

![The paper's Discuss tab showing an agent answer beside the original PDF](docs/images/orbis-discussion.jpg)

Use **Codex or Claude Code**, choose your model and effort, and discuss a paper
or selected passage. Answers draw on available original text and show page or
section citations; the app tells you when only stored notes were available.
Review answers before saving them to your notes.

## Compare papers with evidence

![Two papers compared side by side with expandable source evidence](docs/images/orbis-comparison.jpg)

Choose papers and comparison criteria, inspect the evidence behind each cell,
ask follow-up questions, and export your table.

### More than a paper reader

- **Add papers, blogs, and web pages.** Review proposed summaries and connections.
  Paper summaries cover the problem, background, framework, results, and limitations.
  **Read & add** opens the reader immediately and downloads the original while the
  summary is prepared. Notes, highlights, and discussion unlock after validation.
  With unsaved graph edits, **Save & add** saves them before starting the import.
- **Shape your own library.** Create clusters, methods, and relationships. Keep
  separate graphs for separate projects.
- **Follow agent work.** Activity shows progress and helps recover failed tasks;
  proposed changes need review before application.
- **Keep laptops in sync.** Optional encrypted Drive sync includes notes, graphs,
  discussions, and highlights. Originals download on demand; choose **Keep offline**
  for papers you need without a connection.

## Get started

**Desktop preview · 2.1.0-beta.1.** Windows x64, macOS Apple Silicon, and Ubuntu
have been exercised during development. Builds are unsigned, with no automatic
updates. [Windows verification →](docs/WINDOWS_PORT.md) ·
[macOS verification →](docs/MAC_VERIFICATION.md)

### Build the desktop app

Install **Git, Node.js 22, and uv** on the computer you will use:

```sh
git clone https://github.com/Nike353/Orbis.git
cd Orbis
npm ci
npm run desktop:build
```

Open the installer in `release/desktop/`: on macOS, drag Orbis from the DMG into
Applications; on Linux, install the DEB or make the AppImage executable and open
it. On Windows, run `Orbis-2.1.0-beta.1-win-x64.exe`; the installer is per-user.
Windows may warn because this preview is unsigned. After installation, launch
Orbis with a click—no terminal needed. Build for
your own OS and CPU architecture. [Desktop setup and troubleshooting →](docs/DESKTOP.md)

The Windows app keeps its own library in `%APPDATA%\Orbis\Profile\Library`.
Import your browser library through **Local library → Import existing Orbis
library**; the original folder is not moved or shared with the app.
Quit Orbis before updating or uninstalling; setup will not force-close it.
Uninstall keeps your local library so reinstalling can reopen it.

<details>
<summary><strong>Prefer to try the browser version?</strong></summary>

```sh
git clone https://github.com/Nike353/Orbis.git
cd Orbis
sh start.sh
```

Open the local URL printed in the terminal. First launch prepares managed tools
and can take several minutes. Your library stays outside the application checkout.
Use `sh start.sh --workspace /path/to/my-library` to choose its location.
Google sign-in and encrypted sync require the desktop app.

**Windows browser preview**

From the existing checkout in PowerShell:

```powershell
.\start.ps1
```

The launcher sets up uv, Python 3.12, and Node.js 22 locally if needed. Open the
printed localhost URL. The default library is `%LOCALAPPDATA%\Orbis\default`;
choose another with `.\start.ps1 --workspace "D:\Libraries\Research"`.
Use `--doctor` to inspect setup or `--prepare-only` to build without starting.
No administrator access or shell-profile changes are needed.

For AI features, install and sign in to [Claude Code](https://code.claude.com/docs/en/setup)
or [Codex](https://developers.openai.com/codex/cli/), or use
[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli)
with an account that has Copilot access. Sign in in your terminal, then restart
PowerShell and Orbis. Native executables and standard Claude/Codex/Copilot
npm launchers are supported. Each run has its own Windows process tree; stopping
a run, timing out, or closing its server also stops its children.

For Copilot, run:

```powershell
copilot login
.\start.ps1
```

Choose **GitHub Copilot** in the import or research agent picker. Orbis uses the
installed CLI through the official Copilot SDK; no API key needs to be entered
into Orbis. CLI authentication is separate from signing in to VS Code or the
Copilot desktop app. Models and reasoning levels come from your CLI account;
select a model before overriding its reasoning effort.

Copilot keeps the existing import and review workflow. It can read public HTTPS
HTML/PDF papers and edit only the disposable import graph and Markdown notes.
It has no shell, user plugins, hooks, skills, or MCP tools. Research conversations
use the supplied library context without file or network tools. Account access,
quotas, and model charges still apply.

If you used the earlier preview's AI-disabling settings, clear them first:

```powershell
Remove-Item Env:\ORBIS_CODEX, Env:\ORBIS_CLAUDE -ErrorAction SilentlyContinue
.\start.ps1
```

For a CLI outside PATH, quote its full path inside the environment setting, for
example `$env:ORBIS_CLAUDE = '"C:\Tools\Claude Code\claude.exe"'`.
Use `ORBIS_COPILOT` for a custom Copilot executable and optionally set
`$env:ORBIS_DEFAULT_AGENT = 'copilot'` to prefer it. Existing defaults stay unchanged.
Custom batch scripts are not executed through a shell; configure their native
executable or `node "C:\path\to\cli.js"` command instead.

Windows also has a local-first desktop preview and x64 installer. Live Google
sign-in and sync have not been verified on Windows.
See [Windows changes and verification](docs/WINDOWS_PORT.md).

</details>

### Your first paper

A first-launch tour highlights the main controls. Skip it anytime, or replay it
with the **? Tutorial** button in the toolbar.

1. Install and sign in to **GitHub Copilot CLI, Codex, or Claude Code** for AI features, then restart Orbis.
2. Choose **Add source**, paste a URL, and review the agent's proposal.
3. Choose **Read**, attach or retrieve the original, and try **My notes** or **Discuss**.

Reading and manual editing need no agent. Already have an Orbis library? Import
it through **Local library → Import existing Orbis library** in an empty desktop
installation. [Full user guide →](docs/USER_GUIDE.md)

## Your data, your choices

**Local first.** Each laptop has an independent library and works while the other
is asleep. No Orbis-hosted account or always-on server is required.

**Optional Drive sync.** Files use your Google Drive quota; originals download
on demand, so every device need not store every paper. Sync runs while Orbis is
open and presents conflicting edits for review. Self-built apps need a
[one-time Google configuration](docs/DESKTOP.md#one-time-setup-for-the-app-owner).
Save your recovery key: Google sign-in alone cannot decrypt your library.

**Your agent account.** Orbis uses your installed CLI's provider and account limits.
Passages and notes used in AI requests may be sent to that provider; local agent
integration does not mean on-device inference. Check important claims against
the original. Local working files are not encrypted by Orbis; keep a separate backup.

Windows has browser and local-first desktop previews. Mobile clients are not
currently supported.
[Security](SECURITY.md) · [Sync and recovery](docs/DESKTOP.md)

## Contribute

[Development guide](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Data format](docs/SCHEMA.md) · [Release packaging](docs/OPEN_SOURCE.md) ·
[MIT license](LICENSE)
