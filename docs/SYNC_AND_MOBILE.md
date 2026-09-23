# Device sync, mobile, and agent controls

Design proposal, 23 September 2026. Device sync and remote mobile access are not
implemented. Model and effort controls are now available locally; see below.
Orbis still serves only on loopback.

## Recommended direction: one library server, several clients

For a first release, run Orbis on one computer you own that can stay awake.
Your work laptop, personal laptop, and phone connect to that same library.
Changes become visible everywhere without a push/pull routine because there is
one authoritative copy. This is remote access, not independent offline replicas.

AgentsDock follows this pattern: an AgentsServer runs on an always-on macOS or
Linux machine, with agent CLIs installed and signed in there. Desktop and mobile
clients connect to that server; access outside the LAN can use Tailscale.
[AgentsDock setup](https://agentsdock.net/setup.html).

For personal use, Tailscale offers a free Personal plan. That can make an owned
computer reachable privately without paying for a separate host. It provides
network access, not compute or file synchronization. The host must be awake,
and agent usage remains subject to the user's provider account.
[Tailscale pricing](https://tailscale.com/pricing).

### What Orbis would need

1. One authenticated HTTPS gateway with device pairing and revocable sessions.
   Put graph selection behind stable routes such as `/graphs/<id>/`; do not
   expose the current per-graph loopback ports directly.
2. Keep graph writes and agent runs on the server. Preserve revision checks and
   isolated graph transactions. Send updates over a reconnectable event stream.
3. A background service with a status menu, start-at-login option, and clear
   connected/offline state. Closing a browser must not cancel a running job.
4. Automatic versioned backups, with a restore interface. Git can remain an
   optional backup destination rather than the daily synchronization workflow.
5. Explicit remote-access setup. The current local API has no remote login and
   must not simply be rebound to `0.0.0.0` as a substitute for this work.

This is the smallest practical path to an app that feels continuous across
several devices. It also keeps credentials on one chosen machine.

## If both laptops need to work independently offline

That is a different, larger feature. Each device needs a local database and an
operation log: stable entity IDs, device IDs, unique operation IDs, tombstones,
acknowledgments, and conflict handling. Non-conflicting edits can merge; editing
the same note or relationship needs a visible resolution flow (or a deliberate
collaborative-text design). Agent transactions must replay atomically.

A free-tier relay could store encrypted operations and encrypted attachments,
with quotas and availability limits. It should not store provider credentials.
A filesystem sync tool alone cannot understand graph relationships or safely
merge two simultaneous rewrites of `graph.json`. Automatic Git pull/push likewise
moves conflict handling into the application; it does not eliminate it.

Choose this architecture only if offline editing on both devices is essential.
Do not promise seamless multi-writer sync by synchronizing the current workspace
folder unchanged.

## Mobile: an installable web app first

Build an installable PWA against the same authenticated server before investing
in native apps. AgentsDock already demonstrates the server/client approach across
computer and phone clients. [AgentsDock FAQ](https://agentsdock.net/faq.html).

The initial phone experience should prioritize:

- Inbox: paste a paper/blog URL and queue it for the home agent.
- Reading: search, inspect a source, read Markdown and equations, and edit notes.
- Research: discuss a source, review answers, accept proposed changes, and see
  job completion without watching the whole agent run.
- Navigation: choose a graph and focus one cluster; use a readable list or 2D
  view by default, with 3D as an optional exploration view.
- Connection state: retain a local draft if a connection drops and clearly show
  pending versus saved edits. An offline draft is not a synchronized save.

A share-target integration for sending URLs from other apps should be tested per
mobile browser; retain paste-a-link as the portable fallback. Cached read-only
library views and offline drafts can come later. A native shell is justified if
background transfer, deeper sharing, or notifications outgrow the web app.

## Model and reasoning effort selection — implemented locally

Import, discuss, and compare now offer **Agent → Model → Effort**. Codex defaults
to GPT-5.6 Sol at medium effort. Claude uses CLI defaults until changed. Codex
suggestions use its local model catalog; Claude offers CLI aliases. Both support
a custom model ID and explicit CLI defaults.

Selections persist per agent in the browser's origin storage and are recorded
with research turns. They do not alter global CLI configuration. Account access
and custom-model effort support remain the CLI's responsibility. Provider
adapters pass validated argument arrays without invoking a shell.
[Codex configuration reference](https://developers.openai.com/codex/config-reference/),
[Claude Code model configuration](https://code.claude.com/docs/en/model-config).

Future server-backed graph defaults would carry preferences between devices and
across changing local graph ports. Credentials and execution should remain on the
user's selected server. Selecting a model does not make a cloud-backed agent fully
local: selected context still goes to that provider under the user's account.

## Suggested implementation order

1. Model/effort controls: implemented; server-backed preference sync can follow.
2. Authenticated single-server access, background launch, and automatic backups.
3. Mobile reading, URL capture, notes, and job review as a PWA.
4. Offline multi-writer replication only when a single always-on host is
   insufficient for actual usage.
