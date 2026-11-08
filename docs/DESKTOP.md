# Orbis desktop preview

Open Orbis like a normal application. The desktop shell starts its bundled local
service, opens your library, and stops the service when you quit. Python and Node
are bundled; users do not need a terminal to launch it. AI features still use your
own installed, signed-in Codex or Claude Code CLI and its account limits.

Install and sign in to at least one current Codex or Claude Code CLI before using
AI features. Orbis checks your executable search path, common user-local install
locations, and Node installations managed by nvm, fnm, or mise automatically.
On macOS it also detects the Codex CLI bundled inside Codex or ChatGPT, including
apps installed in your home Applications folder. Explicit `ORBIS_CODEX` and
`ORBIS_CLAUDE` settings take precedence. Restart Orbis after installing an agent.

Model and effort options come from the installed CLI, including provider-specific
model IDs. New choices use that CLI's configured model and medium effort when
supported. Orbis uses your existing CLI authentication and does not edit its global
settings. If discovery fails, the picker explains the problem and keeps CLI default
available. Your provider/account determines whether an advertised model can run.

Desktop executable discovery is in `desktop/agent-environment.mjs`. Read-only
model queries live in `tools/agent_discovery.py`, and per-run validation is in
`tools/agent_settings.py`. The shared picker is `AgentModelSettings.tsx`.
Check these paths with `npm run test:desktop`, `npm run test:python`, and
`npm run test:unit`.

The 2.1.0-beta.1 Apple Silicon macOS preview passed packaged native smoke,
existing-profile upgrade, live Google sync, and an isolated original-backed Codex
discussion. Ubuntu native reading and Drive-original checks were exercised during
upstream development. See [macOS verification](MAC_VERIFICATION.md) for the exact
coverage and limits. This is an unsigned, unnotarized preview; automatic updates
are not included.

## Your first launch

1. On macOS, copy `Orbis.app` from the disk image to Applications and open it.
   On Ubuntu, make the AppImage executable and open it, or install the Debian
   package. Development previews must use their own `ORBIS_USER_DATA` directory.
2. A fresh installation starts with an empty library. To bring an existing library,
   open **Local library → Import existing Orbis library** and select the folder
   containing `data/graph.json` and `papers/`. Import copies all graphs, notes,
   conversations, highlights, and verified local originals. Import is available
   only from Main, before sync is paired and while the app library is empty.
   Stop any running agents in the source library first.
3. Add sources and edit your graph as usual. Accepted graph edits are saved
   automatically in the desktop app. Editor drafts and agent proposals still need
   their normal **Apply** or **Save** action before becoming library changes.
4. Open the cloud button to connect Google Drive, or keep using Orbis locally.

Application updates do not replace the library. **Open local library folder**
shows the authoritative path:

- macOS: `~/Library/Application Support/Orbis/Profile/Library`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Orbis/Profile/Library`

Upgrading from an earlier preview copies the existing library and sync history
automatically, then re-encrypts the saved Google connection and recovery key under
the Orbis app identity. Close the previous app before upgrading. The previous
profile remains a backup; an interrupted upgrade does not replace it. Subsequent
launches use the Orbis profile without copying the old data again.

The terminal launcher has separate workspace defaults; importing does not make
it share the desktop app's library. Back up the whole library folder with Orbis
closed. Never put the credential file or recovery key in a public repository.

## Connect Google Drive

With an app-owner Google configuration bundled, users simply select **Sign in
with Google**. During consent, allow **See, create, and delete its own
configuration data in your Google Drive**. Signing in without selecting that
permission cannot enable sync. Orbis requests only identity, email, and
`drive.appdata`, not access to other Drive files.

On the first device, select **Enable encrypted sync**. Store the displayed
recovery key in your password manager. On another device, sign in to the same
Google account, select the existing library, and enter that key. Google sign-in
alone cannot recover it. **Show recovery key** retrieves it on a paired device.
Use the same Orbis Google application configuration on every installation.

Orbis keeps a local library on each laptop, so you can read and edit while the
other laptop is asleep or while offline. While open, it checks Drive every
30 seconds. **Sync now** performs an immediate check. There is no Git push/pull
step and no always-on Orbis server. Quitting the app stops background sync.

Sync includes every graph's records, Markdown notes, saved conversations, original
metadata, and saved highlights/comments. Original PDFs and readable articles are
separately encrypted immutable files in the same private Drive area. They upload
before a snapshot references them and download on demand. **Keep offline** retains
a local copy; **Remove download** checks the Drive copy before removing local bytes.
Neither action deletes saved notes or highlights.

Agent credentials, process locks, local drafts, pins, reading position, running jobs,
and text caches stay on the device. Model/effort and navigation preferences persist
across native restarts and local port changes without changing global CLI settings.
Upgrade all devices before adding originals: older clients can read legacy snapshots
but cannot safely edit attachment-enabled libraries.

The galaxy pauses behind the reader, discussion, or Add source, and while the
window is minimized. With software graphics it also stops redrawing while idle;
rotation starts paused and can be enabled with **Resume universe rotation**.
Hover, selection, orbit, and zoom wake the scene when needed.

## One-time setup for the app owner

Google Cloud is used to register the sign-in integration; files are stored in
each user's Google Drive. This setup does not provision a VM or storage bucket.

1. Create a Google Cloud project and enable **Google Drive API**.
2. In **Google Auth Platform**, configure Orbis branding, a support email, an
   **External** audience, and developer contact information. Accept Google's
   applicable developer policies yourself.
3. While publishing status is **Testing**, add each tester's Google account to
   **Audience → Test users**. Complete branding and Google's applicable production
   requirements before distributing broadly. Testing authorizations can require
   reconnection.
4. In **Data Access**, declare `openid`,
   `https://www.googleapis.com/auth/userinfo.email`, and
   `https://www.googleapis.com/auth/drive.appdata`.
5. In **Clients**, create a **Desktop app** client and download its JSON.
6. In an unconfigured Orbis installation, choose **Choose Google client JSON**.
   For distributable builds, place that JSON at `desktop/google-client.json`
   before packaging. Git ignores this file. Never bundle user refresh tokens or
   recovery keys. An installed application's client configuration identifies the
   app; it is not a confidential server credential or permission to a user's Drive.

Sign-in opens the system browser and uses PKCE, a checked random state, and a
loopback callback. Passwords are never entered into Orbis. Consult Google's
[installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app),
[app-data documentation](https://developers.google.com/workspace/drive/api/guides/appdata),
and [current API limits and pricing](https://developers.google.com/workspace/drive/api/guides/limits).
Review current API terms and quotas before a broad launch. Uploaded files count
against each user’s Drive storage quota.

## Encryption, conflicts, and recovery

Orbis compresses snapshots and encrypts them with AES-256-GCM before uploading
them into Drive's hidden app-data area. Originals use separate authenticated
encryption tied to the vault and their content hash. The recovery key stays on paired devices;
Google does not receive it. Local working notes remain ordinary readable files.
Credentials and the key use Electron's OS-backed secure storage. Linux sync
requires a supported Secret Service or KWallet backend and refuses the insecure
`basic_text` fallback.

Independent edits merge using their common saved version. Competing edits to the
same content open **Review conflicts**; choose the version to keep. Sync validates
graph structure, refuses to overwrite a concurrent save, and waits when an agent
is changing a library. Before applying incoming data, the backend saves a local
backup under `.orbis-backups/` and a recovery journal for interrupted writes.

This preview uploads immutable, compressed full snapshots. History grows with
changes; automatic history compaction is not implemented. Rare histories with
multiple incomparable merge bases stop for recovery instead of guessing a
winner. It is not yet an independently audited backup service: keep a separate
backup of valuable notes. **Disconnect Google** removes the local connection;
it does not delete Drive data or revoke the app in Google Account settings.

## Build installers

Build on the target OS and CPU architecture from a clean application export.
Python 3.12, uv, and Node 22 are the tested build tools. Exporting creates an empty
library without modifying the personal library in your source checkout:

```sh
python3 scripts/package_release.py --output /tmp/orbis-source.zip
unzip /tmp/orbis-source.zip -d /tmp/orbis-build
cd /tmp/orbis-build/orbis
uv sync --locked --python 3.12
npm ci
npm run test:desktop
npm run test
npm run desktop:build
```

Installers are written to `release/desktop/`: DMG/ZIP on macOS and AppImage/DEB on
Linux. The manual **Build Orbis desktop previews** GitHub Actions workflow provides
native runners for both platforms and performs the same clean export. The build
script rejects a populated graph. Private historical handoff documents, credentials,
and Git history are excluded from exports. Apple signing and notarization,
automatic updates, and a public OAuth rollout remain release work.
