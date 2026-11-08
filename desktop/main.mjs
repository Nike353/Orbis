import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  safeStorage,
  session,
  Menu,
} from 'electron';
import { spawn } from 'node:child_process';
import { readFile, mkdir, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { atomic, SyncEngine } from './sync-engine.mjs';
import { hashBytes } from './sync-core.mjs';
import { Drive, authorize, validateClient } from './google-drive.mjs';
import { agentEnvironment } from './agent-environment.mjs';
import { stopBackend } from './backend-lifecycle.mjs';
import { readLibraryImport, copyImportOriginals } from './library-import.mjs';
import { readUiPreferences, writeUiPreference } from './ui-preferences.mjs';
import {
  LEGACY_APP_NAME,
  TRANSFER_FLAG,
  acquireLegacyProfile,
  migrateProfile,
  serveLegacyProfile,
} from './profile-migration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const transferring =
  process.argv.includes(TRANSFER_FLAG) && typeof process.send === 'function';
app.setName(transferring ? LEGACY_APP_NAME : 'Orbis');
const legacyHome = transferring
  ? process.argv[process.argv.indexOf(TRANSFER_FLAG) + 1]
  : process.env.ORBIS_USER_DATA
    ? path.resolve(process.env.ORBIS_USER_DATA)
    : path.join(app.getPath('appData'), LEGACY_APP_NAME);
const home = transferring
  ? legacyHome
  : process.env.ORBIS_USER_DATA
    ? path.resolve(process.env.ORBIS_USER_DATA)
    : path.join(app.getPath('appData'), 'Orbis');
app.setPath('userData', home);
const profile = path.join(home, 'Profile');
const library = path.join(profile, 'Library');
const secretPath = path.join(profile, 'desktop-secrets.bin');
let state = { device: randomUUID() },
  engine,
  window,
  backend,
  base,
  interval,
  loggingIn = false;
let vaults = [],
  startupError = '',
  shuttingDown = false,
  closing = false,
  backendStopping,
  changingLibrary = false,
  closeTimer;
const origins = new Set(),
  graphOrigins = new Map(),
  token = randomBytes(32).toString('hex');

function storageReady() {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
    throw new Error(
      'Google sync needs an OS credential store. On Linux, enable Secret Service or KWallet, then reopen Orbis. Local libraries still work.',
    );
}
async function save() {
  storageReady();
  await atomic(secretPath, safeStorage.encryptString(JSON.stringify(state)));
}
async function request(route, body, origin = base) {
  const r = await fetch(origin + route, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(30000),
    headers: {
      'X-Orbis-Desktop': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || 'Local library is unavailable');
  return result;
}
async function originalBytes(graph, sha, content) {
  const response = await fetch(`${base}/api/desktop/documents/${graph}/${sha}/blob`, {
    method: content ? 'POST' : 'GET',
    headers: { 'X-Orbis-Desktop': token },
    signal: AbortSignal.timeout(60000),
    ...(content ? { body: content } : {}),
  });
  if (!response.ok)
    throw new Error((await response.json()).error || 'Original is unavailable');
  return content ? response.json() : Buffer.from(await response.arrayBuffer());
}
async function currentOriginal(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
    throw new Error('Invalid original');
  const origin = new URL(window.webContents.getURL()).origin,
    graph = graphOrigins.get(origin);
  if (!graph) throw new Error('Open a graph before using an original');
  return {
    graph,
    origin,
    record: await request(`/api/documents/${id}`, undefined, origin),
  };
}
function makeEngine() {
  engine = new SyncEngine({
    drive:
      state.credentials && state.client ? new Drive(state.client, state.credentials) : null,
    state,
    save,
    directory: path.join(profile, 'Sync'),
    backend: {
      get: () => request('/api/desktop/snapshot'),
      apply: (snapshot, expected) => request('/api/desktop/apply', { snapshot, expected }),
      originals: () => request('/api/desktop/documents'),
      readOriginal: (graph, sha) => originalBytes(graph, sha),
      writeOriginal: (graph, sha, bytes) => originalBytes(graph, sha, bytes),
      originalState: async (graph, sha, update) => {
        await request(`/api/desktop/documents/${graph}/${sha}/state`, update);
        window?.webContents.send('orbis:documentsChanged');
      },
    },
    changed: () => window?.webContents.send('orbis:libraryChanged'),
  });
}
function status() {
  return {
    configured: Boolean(state.client),
    connected: Boolean(state.credentials),
    email: state.credentials?.email || '',
    paired: Boolean(state.vault && state.key),
    library,
    signingIn: loggingIn,
    vaults: vaults.map((v) => ({ id: v.id, name: v.name })),
    ...(engine?.status || { phase: 'local', conflicts: [] }),
    error: startupError,
  };
}
async function startBackend() {
  await mkdir(library, { recursive: true });
  const source = path.resolve(here, '..');
  const env = await agentEnvironment({
    ...process.env,
    ORBIS_DESKTOP_TOKEN: token,
    PYTHONUNBUFFERED: '1',
  });
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'backend/orbis-server/orbis-server')
    : path.join(source, '.venv/bin/python');
  const args = [
    ...(app.isPackaged ? [] : [path.join(source, 'desktop/server_boot.py')]),
    '--workspace',
    library,
    '--port',
    '0',
  ];
  backend = spawn(executable, args, {
    cwd: app.isPackaged ? home : source,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('Orbis could not start its local service.')),
      30000,
    );
    backend.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    backend.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-4000);
      const match = output.match(/Orbis serving on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    backend.stderr.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-4000);
    });
    backend.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Local service exited: ' + output.slice(-1200)));
      if (!shuttingDown && window)
        dialog.showErrorBox(
          'Orbis service stopped',
          'Restart Orbis to continue. Your saved library is on disk.',
        );
    });
  });
  origins.add(base);
  graphOrigins.set(base, 'main');
}

function handle(name, action) {
  ipcMain.handle(`orbis:${name}`, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !origins.has(new URL(event.senderFrame.url).origin)
    )
      throw new Error('Untrusted desktop request');
    return action(...args);
  });
}
function requestClose() {
  if (closing || shuttingDown) return;
  closing = true;
  window.webContents.send('orbis:beforeClose');
  closeTimer = setTimeout(() => {
    closing = false;
    dialog.showErrorBox(
      'Orbis kept your window open',
      'Draft saving did not finish. Check the local service and try closing again.',
    );
  }, 15000);
}
async function changeLibraryView(action) {
  if (changingLibrary)
    throw new Error('Wait for the current graph or library to finish opening.');
  changingLibrary = true;
  try {
    return await action();
  } finally {
    changingLibrary = false;
  }
}
async function main() {
  await app.whenReady();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  await migrateProfile({
    home,
    legacyHome,
    acquire: () =>
      acquireLegacyProfile({
        executable: process.execPath,
        appPath: app.getAppPath(),
        packaged: app.isPackaged,
        legacyHome,
        parentOwnsLock: home === legacyHome,
      }),
    encrypt: (secrets) => {
      storageReady();
      return safeStorage.encryptString(secrets);
    },
  });
  try {
    storageReady();
    state = JSON.parse(safeStorage.decryptString(await readFile(secretPath)));
  } catch (error) {
    if (error.code !== 'ENOENT')
      startupError =
        'Stored Google credentials could not be opened. Local library remains available. ' +
        error.message;
  }
  if (!state.client) {
    try {
      state.client = validateClient(
        JSON.parse(
          await readFile(
            path.join(app.isPackaged ? process.resourcesPath : here, 'google-client.json'),
            'utf8',
          ),
        ),
      );
    } catch {
      /* Developer config can also be selected in the UI. */
    }
  }
  await startBackend();
  makeEngine();
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (origins.has(new URL(details.url).origin))
      details.requestHeaders['X-Orbis-Desktop'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    title: 'Orbis',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const publishVisibility = (visible) => {
    if (window && !window.isDestroyed())
      window.webContents.send('orbis:windowVisibility', visible);
  };
  // Visibility getters can lag the restore event on Linux.
  for (const [event, visible] of [
    ['minimize', false],
    ['restore', true],
    ['hide', false],
    ['show', true],
  ])
    window.on(event, () => publishVisibility(visible));
  window.webContents.on('did-finish-load', () => {
    if (window && !window.isDestroyed())
      publishVisibility(window.isVisible() && !window.isMinimized());
  });
  window.on('close', (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      requestClose();
    }
  });
  window.on('closed', () => {
    window = null;
    clearTimeout(closeTimer);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!origins.has(new URL(url).origin)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Google sync setup',
            click: () =>
              shell.openExternal('https://console.cloud.google.com/auth/clients'),
          },
        ],
      },
    ]),
  );
  handle('status', status);
  handle('closeReady', (error) => {
    if (!closing) throw new Error('No close request is pending');
    clearTimeout(closeTimer);
    closing = false;
    if (error) {
      dialog.showErrorBox(
        'Your drafts need attention',
        `Orbis kept this window open because a draft could not be saved. ${String(error).slice(0, 1500)}`,
      );
      return;
    }
    shuttingDown = true;
    app.quit();
  });
  handle('configureGoogle', async () => {
    if (state.credentials)
      throw new Error('Disconnect Google before changing the OAuth client.');
    const selected = await dialog.showOpenDialog(window, {
      title: 'Select Google Desktop OAuth client JSON',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!selected.canceled) {
      const bytes = await readFile(selected.filePaths[0]);
      if (bytes.length > 64000) throw new Error('Client file is too large');
      state.client = validateClient(JSON.parse(bytes.toString()));
      await save();
      makeEngine();
      startupError = '';
    }
    return status();
  });
  handle('connect', async () => {
    if (loggingIn || engine.busy) throw new Error('Another sign-in or sync is running.');
    if (!state.client) throw new Error('Configure the Google Desktop OAuth client first.');
    storageReady();
    loggingIn = true;
    try {
      const credentials = await authorize(state.client, (url) => shell.openExternal(url));
      if (state.account && state.account !== credentials.sub)
        throw new Error(
          'This library belongs to a different Google account. Sign in with the original account.',
        );
      state.account = credentials.sub;
      state.credentials = credentials;
      await save();
      makeEngine();
      vaults = await engine.vaults();
      startupError = '';
      if (state.vault) await engine.sync();
    } finally {
      loggingIn = false;
    }
    return status();
  });
  handle('disconnect', async () => {
    if (engine.busy || loggingIn || engine.downloads.size)
      throw new Error('Wait for the current sync or sign-in to finish.');
    delete state.credentials;
    await save();
    makeEngine();
    vaults = [];
    return status();
  });
  handle('createVault', async () => {
    if (!state.credentials || state.vault || engine.busy)
      throw new Error('Connect Google first, or finish the current operation.');
    vaults = await engine.vaults();
    if (vaults.length)
      throw new Error('A library already exists. Unlock it using its recovery key.');
    const key = await engine.createVault();
    await engine.sync();
    return key;
  });
  handle('unlock', async (id, key) => {
    if (!state.credentials || engine.busy)
      throw new Error('Connect Google and wait for sync first.');
    await engine.unlock(id, key.trim());
    await engine.sync();
    return status();
  });
  handle('recoveryKey', () => {
    storageReady();
    return state.key || '';
  });
  handle('sync', async (resolutions = {}, heads = null) => {
    if (
      typeof resolutions !== 'object' ||
      resolutions === null ||
      Object.keys(resolutions).length > 1000
    )
      throw new Error('Invalid conflict choices');
    await engine.sync(resolutions, heads);
    return status();
  });
  handle('openLibrary', () => shell.openPath(library));
  handle('getPreferences', () => readUiPreferences(profile));
  handle('setPreference', (key, value) => writeUiPreference(profile, key, value));
  handle('downloadDocument', async (id) => {
    const { graph, record } = await currentOriginal(id);
    await engine.downloadOriginal(graph, record);
  });
  handle('openDocument', async (id) => {
    const { graph, record } = await currentOriginal(id);
    if (!record.available) await engine.downloadOriginal(graph, record);
    const bytes = await originalBytes(graph, record.sha256);
    if (hashBytes(bytes) !== record.sha256)
      throw new Error('Original failed its integrity check');
    const file = path.join(
      profile,
      'OpenedOriginals',
      `${record.sha256}.${record.media_type === 'application/pdf' ? 'pdf' : 'txt'}`,
    );
    await atomic(file, bytes);
    await chmod(file, 0o400);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
  handle('removeDocument', async (id) => {
    const { graph, origin, record } = await currentOriginal(id);
    await engine.confirmRemoteOriginal(graph, record);
    await request(`/api/documents/${id}/local`, { action: 'remove_download' }, origin);
    await unlink(
      path.join(
        profile,
        'OpenedOriginals',
        `${record.sha256}.${record.media_type === 'application/pdf' ? 'pdf' : 'txt'}`,
      ),
    ).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  });
  handle('openGraph', (id) =>
    changeLibraryView(async () => {
      if (typeof id !== 'string' || !/^(main|[a-f0-9]{32})$/.test(id))
        throw new Error('Invalid graph');
      const result = await request(`/api/graphs/${id}/open`, {}),
        url = new URL(result.url);
      if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
        throw new Error('Invalid graph URL');
      origins.add(url.origin);
      graphOrigins.set(url.origin, id);
      await window.loadURL(result.url);
    }),
  );
  handle('importLibrary', () =>
    changeLibraryView(async () => {
      if (graphOrigins.get(new URL(window.webContents.getURL()).origin) !== 'main')
        throw new Error('Open your Main graph before importing a library.');
      if (engine.busy || state.vault)
        throw new Error('Import before connecting a synced library.');
      const local = await request('/api/desktop/snapshot');
      if (
        Object.values(local.snapshot.graphs).some(
          (g) =>
            Object.keys(g.nodes).length ||
            Object.keys(g.sessions).length ||
            Object.keys(g.notes).length,
        )
      )
        throw new Error(
          'Import is available only for an empty app library. Your existing data will not be replaced.',
        );
      const picked = await dialog.showOpenDialog(window, {
        title: 'Choose existing Orbis library folder',
        properties: ['openDirectory'],
      });
      if (picked.canceled) return;
      const imported = await readLibraryImport(picked.filePaths[0]);
      await copyImportOriginals(picked.filePaths[0], library, imported);
      await request('/api/desktop/apply', { snapshot: imported, expected: local.digest });
      window.webContents.send('orbis:libraryChanged');
    }),
  );
  await window.loadURL(base);
  if (state.credentials) {
    engine
      .vaults()
      .then((v) => {
        vaults = v;
      })
      .catch((e) => {
        startupError = e.message;
      });
    void engine.sync();
  }
  interval = setInterval(() => {
    if (!loggingIn) void engine.sync({}, null, true);
  }, 30000);
}

app.on('before-quit', (event) => {
  if (window && !shuttingDown) {
    event.preventDefault();
    requestClose();
    return;
  }
  shuttingDown = true;
  clearInterval(interval);
  if (backend?.pid && backend.exitCode === null && backend.signalCode == null) {
    event.preventDefault();
    backendStopping ??= stopBackend(backend).then(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
const launch = transferring ? serveLegacyProfile({ app, safeStorage, legacyHome }) : main();
launch.catch((error) => {
  dialog.showErrorBox('Orbis could not start', error.message);
  shuttingDown = true;
  app.quit();
});
