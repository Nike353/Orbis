# Orbis desktop preview

Open Orbis like a normal application. The desktop shell starts its bundled local
service, opens your library, and stops the service when you quit. Python and Node
are bundled; users do not need a terminal to launch it. AI features still use your
own installed, signed-in Codex or Claude Code CLI and its account limits.

The Apple Silicon macOS preview has been built and tested locally, including a
real Google sign-in and encrypted Drive upload. Linux AppImage and Debian package
builds are configured, but Linux installation has not yet been verified. This is
a preview, not a signed or notarized general release. No installer has been
published automatically by this repository.

## Your first launch

1. On macOS, copy `Orbis.app` from the disk image to Applications and open it.
2. A fresh installation starts with an empty library. To bring an existing library,
   open **Local library → Import existing Orbis library** and select the folder
   containing `data/graph.json` and `papers/`. Import copies it; the original stays
   intact. Import is available only before sync is paired and while the app library
   is empty. Stop any running agents in the source library first.
3. Add sources and edit your graph as usual. Accepted graph edits are saved
   automatically in the desktop app. Editor drafts and agent proposals still need
   their normal **Apply** or **Save** action before becoming library changes.
4. Open the cloud button to connect Google Drive, or keep using Orbis locally.

Application updates do not replace the library. **Open local library folder**
shows the authoritative path. This preview retains the internal `litbench` name
for compatibility with its credential store:

- macOS: `~/Library/Application Support/litbench/Library`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/litbench/Library`

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

Sync includes every graph's records, Markdown notes, and saved conversations.
It excludes agent credentials, process locks, running import queues, and caches.
This version does **not** download or sync original PDFs, nor add full-paper
retrieval to discussions. Those are separate future features.

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
Standard use currently has no additional API charge; do not assume unlimited
free usage when planning a large public launch. Drive storage limits also apply.

## Encryption, conflicts, and recovery

Orbis compresses snapshots and encrypts them with AES-256-GCM before uploading
them into Drive's hidden app-data area. The recovery key stays on paired devices;
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

Build on the target OS and CPU architecture from an application checkout with an
empty graph. Python 3.12 and Node 22 are the tested build tools.

```sh
npm ci
node node_modules/electron/install.js
python3 -m pip install pyinstaller==6.22.3
npm run test:desktop
npm run test
npm run desktop:build
```

Installers are written to `release/desktop/`: DMG/ZIP on macOS and AppImage/DEB on
Linux. The manual **Build Orbis desktop previews** GitHub Actions workflow provides
native runners for both platforms. The build script rejects a populated graph;
personal libraries are never intentionally bundled. Apple signing and notarization,
Linux runtime verification, automatic updates, and a public OAuth rollout remain
release work.
