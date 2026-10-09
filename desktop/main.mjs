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
import { readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { atomic, SyncEngine } from './sync-engine.mjs';
import { Drive, authorize, validateClient } from './google-drive.mjs';
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
  shuttingDown = false;
const origins = new Set(),
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
async function request(route, body) {
  const r = await fetch(base + route, {
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
  const env = {
    ...process.env,
    ORBIS_DESKTOP_TOKEN: token,
    PYTHONUNBUFFERED: '1',
    PATH: [
      path.join(os.homedir(), '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      process.env.PATH || '',
    ].join(path.delimiter),
  };
  // Existing custom CLI locations keep working during the rename.
  env.ORBIS_CODEX ||= env.LITBENCH_CODEX;
  env.ORBIS_CLAUDE ||= env.LITBENCH_CLAUDE;
  for (const candidate of [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ]) {
    if (!env.ORBIS_CODEX)
      try {
        await access(candidate);
        env.ORBIS_CODEX = JSON.stringify(candidate);
      } catch {
        /* optional */
      }
  }
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
    if (engine.busy || loggingIn)
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
  handle('openGraph', async (id) => {
    if (typeof id !== 'string' || !/^(main|[a-f0-9]{32})$/.test(id))
      throw new Error('Invalid graph');
    const result = await request(`/api/graphs/${id}/open`, {}),
      url = new URL(result.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
      throw new Error('Invalid graph URL');
    origins.add(url.origin);
    await window.loadURL(result.url);
  });
  handle('importLibrary', async () => {
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
    const imported = await readImport(picked.filePaths[0]);
    await request('/api/desktop/apply', { snapshot: imported, expected: local.digest });
    window.webContents.send('orbis:libraryChanged');
  });
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
    if (!loggingIn) void engine.sync();
  }, 30000);
}

async function readImport(root) {
  const json = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  let catalog = [];
  try {
    catalog = await json('data/graphs.json');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!Array.isArray(catalog) || catalog.length > 100)
    throw new Error('Invalid library catalog');
  const graphs = {};
  for (const entry of [{ id: 'main' }, ...catalog]) {
    if (!/^(main|[a-f0-9]{32})$/.test(entry.id)) throw new Error('Invalid library graph');
    const prefix = entry.id === 'main' ? '' : `graphs/${entry.id}/`,
      graph = await json(`${prefix}data/graph.json`);
    const { revision: _r, updated_at: _u, ...meta } = graph.meta;
    const notes = {};
    const { readdir, lstat } = await import('node:fs/promises');
    for (const name of await readdir(path.join(root, prefix, 'papers')))
      if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(name)) {
        const file = path.join(root, prefix, 'papers', name),
          stat = await lstat(file);
        if (stat.isSymbolicLink() || stat.size > 250000)
          throw new Error('Invalid paper note in import');
        notes[name] = await readFile(file, 'utf8');
      }
    let sessions = [];
    try {
      sessions = (await json(`${prefix}data/research.json`)).sessions || [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (sessions.some((s) => s.turns.some((t) => t.status === 'running')))
      throw new Error('Stop running agents before importing this library.');
    graphs[entry.id] = {
      name: entry.name || meta.title,
      meta,
      notes,
      nodes: Object.fromEntries(graph.nodes.map((n) => [n.id, n])),
      edges: Object.fromEntries(graph.edges.map((e) => [e.id, e])),
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    };
  }
  return { version: 1, graphs };
}
app.on('before-quit', () => {
  shuttingDown = true;
  clearInterval(interval);
  backend?.kill('SIGINT');
});
app.on('window-all-closed', () => app.quit());
const launch = transferring ? serveLegacyProfile({ app, safeStorage, legacyHome }) : main();
launch.catch((error) => {
  dialog.showErrorBox('Orbis could not start', error.message);
  app.quit();
});
