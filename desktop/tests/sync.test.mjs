import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  seal,
  unseal,
  mergeSnapshots,
  mergeCommits,
  hash,
  hashBytes,
  sealOriginal,
  unsealOriginal,
  normalizedSnapshot,
  snapshotsEqual,
} from '../sync-core.mjs';
import { SyncEngine } from '../sync-engine.mjs';
import { validateClient, requireDriveConsent, authorize } from '../google-drive.mjs';

const empty = () => ({
  version: 1,
  graphs: {
    main: {
      name: 'Library',
      meta: { title: 'Library', schema_version: 2 },
      nodes: {},
      edges: {},
      notes: {},
      sessions: {},
    },
  },
});
const root = (snapshot) => ({ id: 'a', parents: [], snapshot });
test('independent fields merge; competing edits preserve explicit choices', () => {
  const base = { note: 'before', title: 'Paper', other: 1 };
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        mergeSnapshots(base, [
          { id: 'a', value: { ...base, note: 'added note' } },
          { id: 'b', value: { ...base, title: 'New title' } },
        ]).snapshot,
      ),
    ),
    { note: 'added note', title: 'New title', other: 1 },
  );
  const branches = [
    { id: 'a', value: { ...base, note: 'A' } },
    { id: 'b', value: { ...base, note: 'B' } },
  ];
  const result = mergeSnapshots(base, branches);
  assert.equal(result.conflicts.length, 1);
  assert.equal(mergeSnapshots(base, branches, { '["note"]': 'b' }).snapshot.note, 'B');
});
test('deletion versus edit conflicts and single deletion is retained', () => {
  const base = { records: { p: { note: 'old' } } };
  assert.equal(
    mergeSnapshots(base, [
      { id: 'a', value: { records: {} } },
      { id: 'b', value: { records: { p: { note: 'new' } } } },
    ]).conflicts.length,
    1,
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        mergeSnapshots(base, [
          { id: 'a', value: { records: {} } },
          { id: 'b', value: base },
        ]).snapshot,
      ),
    ),
    { records: {} },
  );
});
test('same sequential edge ID created offline must not form a hybrid edge', () => {
  const base = empty(),
    a = empty(),
    b = empty();
  a.graphs.main.edges.e1 = { id: 'e1', source: 'a', target: 'b' };
  b.graphs.main.edges.e1 = { id: 'e1', source: 'c', target: 'd' };
  const merged = mergeSnapshots(base, [
    { id: 'a', value: a },
    { id: 'b', value: b },
  ]);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].path, 'graphs / main / edges / e1');
});
test('history merges branches and rejects missing parents/cycles', () => {
  const initial = root({ a: 1, b: 1 });
  const a = { id: 'b', parents: ['a'], snapshot: { a: 2, b: 1 } };
  const b = { id: 'c', parents: ['a'], snapshot: { a: 1, b: 2 } };
  assert.deepEqual(JSON.parse(JSON.stringify(mergeCommits([initial, a, b]).snapshot)), {
    a: 2,
    b: 2,
  });
  assert.throws(() => mergeCommits([a]));
  assert.throws(() => mergeCommits([{ ...a, parents: ['b'] }]));
});
test('encryption rejects a wrong key, modified bytes, and another library context', () => {
  const key = randomBytes(32),
    encrypted = seal({ notes: 'private' }, key, 'vault:commit');
  assert.deepEqual(unseal(encrypted, key, 'vault:commit'), { notes: 'private' });
  assert.throws(() => unseal(encrypted, randomBytes(32), 'vault:commit'));
  assert.throws(() => unseal(encrypted, key, 'other'));
  encrypted[30] ^= 1;
  assert.throws(() => unseal(encrypted, key, 'vault:commit'));
});
test('OAuth configuration requires a desktop client and never arbitrary endpoints', () => {
  assert.deepEqual(
    validateClient({
      installed: {
        client_id: '123.apps.googleusercontent.com',
        token_uri: 'https://evil.test',
      },
    }),
    { client_id: '123.apps.googleusercontent.com' },
  );
  assert.throws(() =>
    validateClient({ web: { client_id: '123.apps.googleusercontent.com' } }),
  );
});
test('partial Google consent is rejected before it can become a broken connection', () => {
  assert.throws(
    () => requireDriveConsent({ scope: 'openid email', refresh_token: 'test' }),
    /Drive permission was not selected/,
  );
  assert.throws(
    () => requireDriveConsent({ scope: 'https://www.googleapis.com/auth/drive.appdata' }),
    /offline access/,
  );
  assert.doesNotThrow(() =>
    requireDriveConsent({
      scope: 'openid email https://www.googleapis.com/auth/drive.appdata',
      refresh_token: 'test',
    }),
  );
});
test('OAuth loopback rejects incorrect state and uses PKCE without sending credentials', async () => {
  await assert.rejects(
    authorize({ client_id: 'test.apps.googleusercontent.com' }, async (address) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://accounts.google.com');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('code_challenge').length, 43);
      const callback = new URL(url.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'wrong');
      callback.searchParams.set('error', 'access_denied');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', url.searchParams.get('state'));
      assert.equal((await fetch(callback)).status, 200);
    }),
    /cancelled/,
  );
});
class FakeDrive {
  files = [];
  offline = false;
  quota = false;
  loseUploadResponse = false;
  lists = 0;
  downloads = [];
  async list(kind, vault) {
    this.lists++;
    if (this.offline) throw new Error('offline');
    return this.files.filter(
      (f) =>
        f.appProperties.orbisKind === kind && (!vault || f.appProperties.vault === vault),
    );
  }
  async create(name, properties, bytes) {
    if (this.offline) throw new Error('offline');
    if (this.quota && properties.orbisKind === 'original')
      throw new Error('Google Drive storage quota exceeded');
    const file = {
      id: String(this.files.length + 1),
      name,
      appProperties: properties,
      bytes,
    };
    this.files.push(file);
    if (this.loseUploadResponse && properties.orbisKind === 'original') {
      this.loseUploadResponse = false;
      throw new Error('Upload response interrupted');
    }
    return file;
  }
  async download(id) {
    if (this.offline) throw new Error('offline');
    this.downloads.push(id);
    return this.files.find((f) => f.id === id).bytes;
  }
}
async function device(t, drive, state = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = {
    snapshot: empty(),
    failApply: false,
    saves: 0,
    changes: 0,
    blobs: new Map(),
    states: {},
    writes: 0,
  };
  const engine = new SyncEngine({
    drive,
    state: { device: directory, ...state },
    save: async () => {
      local.saves++;
    },
    directory,
    backend: {
      get: async () => ({
        snapshot: structuredClone(local.snapshot),
        digest: hash(local.snapshot),
      }),
      apply: async (snapshot, expected) => {
        if (local.failApply || hash(local.snapshot) !== expected)
          throw new Error('CAS conflict');
        local.snapshot = structuredClone(snapshot);
      },
      originals: async () => ({
        graphs: Object.fromEntries(
          Object.entries(local.snapshot.graphs).map(([graph, item]) => [
            graph,
            Object.fromEntries(
              Object.values(item.documents ?? {}).map((record) => [
                record.sha256,
                {
                  size: record.size,
                  available:
                    local.blobs.has(`${graph}:${record.sha256}`) &&
                    hashBytes(local.blobs.get(`${graph}:${record.sha256}`)) ===
                      record.sha256,
                  ...(local.states[graph]?.[record.sha256] ?? {}),
                },
              ]),
            ),
          ]),
        ),
      }),
      readOriginal: async (graph, sha) => local.blobs.get(`${graph}:${sha}`),
      writeOriginal: async (graph, sha, bytes) => {
        const record = Object.values(local.snapshot.graphs[graph]?.documents ?? {}).find(
          (item) => item.sha256 === sha,
        );
        if (!record || hashBytes(bytes) !== sha || bytes.length !== record.size)
          throw new Error('Original metadata or integrity mismatch');
        local.blobs.set(`${graph}:${sha}`, bytes);
        local.writes++;
      },
      originalState: async (graph, sha, update) => {
        if (
          !Object.values(local.snapshot.graphs[graph]?.documents ?? {}).some(
            (item) => item.sha256 === sha,
          )
        )
          throw new Error('Unknown original');
        local.states[graph] ??= {};
        local.states[graph][sha] = { ...local.states[graph][sha], ...update };
      },
    },
    changed: () => local.changes++,
  });
  return { engine, local };
}
test('two laptops converge after independent offline edits and restart', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive);
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  a.local.snapshot.graphs.main.notes['a.md'] = 'work laptop';
  b.local.snapshot.graphs.main.notes['b.md'] = 'personal laptop';
  drive.offline = true;
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(a.engine.status.phase, 'error');
  drive.offline = false;
  await a.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  assert.deepEqual(a.local.snapshot, b.local.snapshot);
  assert.equal(a.local.snapshot.graphs.main.notes['a.md'], 'work laptop');
  assert.equal(a.local.snapshot.graphs.main.notes['b.md'], 'personal laptop');
  const count = drive.files.length;
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(drive.files.length, count);
  a.engine = new SyncEngine({
    ...a.engine,
    save: a.engine.save,
    backend: a.engine.backend,
    changed: a.engine.changed,
  });
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'synced');
});
function attach(
  local,
  text = 'Synthetic original with a result of 12 percent.',
  graph = 'main',
  id = 'a'.repeat(32),
) {
  local.snapshot = normalizedSnapshot(local.snapshot);
  if (!local.snapshot.graphs[graph])
    local.snapshot.graphs[graph] = structuredClone(empty().graphs.main);
  const item = local.snapshot.graphs[graph],
    bytes = Buffer.from(text);
  const record = {
    id,
    node_id: 'paper',
    sha256: hashBytes(bytes),
    size: bytes.length,
    media_type: 'text/plain',
    filename: 'original.txt',
    source_url: 'https://example.com/paper',
    source_version: '',
    retrieved_at: '2026-11-07T20:00:00Z',
  };
  item.nodes.paper = { id: 'paper', type: 'paper', notes: 'Personal note' };
  item.documents = { ...item.documents, [id]: record };
  item.annotations ??= {};
  local.blobs.set(`${graph}:${record.sha256}`, bytes);
  return record;
}
test('encrypted originals authenticate vault, bytes, content hash, and size', () => {
  const bytes = Buffer.from('Private synthetic original'),
    key = randomBytes(32);
  const encrypted = sealOriginal(bytes, key, 'vault-a:original');
  assert.equal(encrypted.includes(bytes), false);
  assert.deepEqual(
    unsealOriginal(encrypted, key, 'vault-a:original', hashBytes(bytes), bytes.length),
    bytes,
  );
  assert.throws(() =>
    unsealOriginal(encrypted, key, 'vault-b:original', hashBytes(bytes), bytes.length),
  );
  assert.throws(() =>
    unsealOriginal(encrypted, key, 'vault-a:original', 'a'.repeat(64), bytes.length),
  );
  assert.throws(() =>
    unsealOriginal(encrypted, key, 'vault-a:original', hashBytes(bytes), bytes.length + 1),
  );
  encrypted[30] ^= 1;
  assert.throws(() =>
    unsealOriginal(encrypted, key, 'vault-a:original', hashBytes(bytes), bytes.length),
  );
});
test('originals upload before snapshots, deduplicate across graphs, and download on demand', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive);
  const record = attach(a.local),
    child = 'c'.repeat(32);
  attach(a.local, undefined, child, 'b'.repeat(32));
  a.local.snapshot.graphs.main.annotations.highlight = {
    id: 'highlight',
    document_id: record.id,
    page: 1,
    quote: '12 percent',
    comment: 'Useful finding',
  };
  const key = await a.engine.createVault();
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'synced');
  const originals = drive.files.filter((f) => f.appProperties.orbisKind === 'original');
  assert.equal(originals.length, 1);
  assert.ok(
    drive.files.indexOf(originals[0]) <
      drive.files.findIndex((f) => f.appProperties.orbisKind === 'commit'),
  );
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  assert.deepEqual(b.local.snapshot, a.local.snapshot);
  assert.equal(b.local.blobs.size, 0);
  assert.equal(b.local.states.main[record.sha256].transfer_status, 'available_on_drive');
  await Promise.all([
    b.engine.downloadOriginal('main', record),
    b.engine.downloadOriginal('main', record),
  ]);
  assert.equal(b.local.writes, 1);
  assert.deepEqual(
    b.local.blobs.get(`main:${record.sha256}`),
    a.local.blobs.get(`main:${record.sha256}`),
  );
  assert.equal(b.local.states.main[record.sha256].remote_available, true);
  assert.equal(b.local.blobs.has(`${child}:${record.sha256}`), false);
  await b.engine.sync();
  assert.equal(
    drive.files.filter((f) => f.appProperties.orbisKind === 'original').length,
    1,
  );
});
test('legacy snapshots merge with attachment snapshots without deleting newer records', () => {
  const base = empty(),
    local = { snapshot: structuredClone(base), blobs: new Map() };
  const record = attach(local);
  const other = structuredClone(base);
  other.graphs.main.notes['other.md'] = 'An offline note from the older schema';
  const merged = mergeCommits([
    root(base),
    { id: 'b', parents: ['a'], snapshot: local.snapshot },
    { id: 'c', parents: ['a'], snapshot: other },
  ]);
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.snapshot.version, 2);
  assert.equal(merged.snapshot.graphs.main.documents[record.id].sha256, record.sha256);
  assert.equal(
    merged.snapshot.graphs.main.notes['other.md'],
    other.graphs.main.notes['other.md'],
  );
  assert.equal(snapshotsEqual(base, normalizedSnapshot(base)), true);
});
test('quota and interrupted uploads preserve originals, back off, and retry after restart', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  await a.engine.createVault();
  drive.quota = true;
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'error');
  assert.match(a.engine.status.message, /quota/);
  assert.equal(
    drive.files.some((f) => f.appProperties.orbisKind === 'commit'),
    false,
  );
  assert.equal(a.local.blobs.size, 1);
  assert.equal(a.local.states.main[record.sha256].transfer_status, 'error');
  const lists = drive.lists;
  await a.engine.sync({}, null, true);
  assert.equal(drive.lists, lists);
  drive.quota = false;
  drive.loseUploadResponse = true;
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'error');
  assert.equal(
    drive.files.filter((f) => f.appProperties.orbisKind === 'original').length,
    1,
  );
  a.engine = new SyncEngine({ ...a.engine });
  assert.match(a.engine.status.message, /interrupted/);
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'synced');
  assert.equal(
    drive.files.filter((f) => f.appProperties.orbisKind === 'original').length,
    1,
  );
  assert.equal(a.engine.state.nextRetry, null);
});
test('offline pinned originals download after reconnect and corrupt remote bytes cannot replace a cache', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  b.local.states.main[record.sha256].keep_offline = true;
  drive.offline = true;
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'error');
  assert.equal(b.local.blobs.size, 0);
  drive.offline = false;
  await b.engine.sync();
  assert.equal(b.local.blobs.size, 1);
  const original = drive.files.find((f) => f.appProperties.orbisKind === 'original'),
    preserved = b.local.blobs.get(`main:${record.sha256}`);
  original.bytes = Buffer.from(original.bytes);
  original.bytes[30] ^= 1;
  await assert.rejects(b.engine.downloadOriginal('main', record));
  assert.deepEqual(b.local.blobs.get(`main:${record.sha256}`), preserved);
  await assert.rejects(b.engine.confirmRemoteOriginal('main', record));
  assert.equal(b.local.states.main[record.sha256].remote_available, false);
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'synced');
  assert.equal(
    drive.files.filter((f) => f.appProperties.orbisKind === 'original').length,
    2,
  );
  await b.engine.confirmRemoteOriginal('main', record);
  assert.equal(b.local.states.main[record.sha256].remote_available, true);
  drive.downloads = [];
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'synced');
  assert.equal(
    drive.downloads.filter(
      (id) =>
        drive.files.find((file) => file.id === id).appProperties.orbisKind === 'original',
    ).length,
    0,
  );
});
test('a missing original blocks syncing and safe cache removal without losing metadata', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  await a.engine.createVault();
  a.local.blobs.clear();
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'error');
  assert.match(a.engine.status.message, /no local or Drive copy/);
  await assert.rejects(
    a.engine.confirmRemoteOriginal('main', record),
    /missing from Drive/,
  );
  assert.equal(a.local.snapshot.graphs.main.documents[record.id].sha256, record.sha256);
});
test('failed remote-only downloads stay failed until the remote original is repaired', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  const original = drive.files.find((f) => f.appProperties.orbisKind === 'original');
  const valid = Buffer.from(original.bytes);
  original.bytes = Buffer.from(original.bytes);
  original.bytes[30] ^= 1;
  await assert.rejects(b.engine.downloadOriginal('main', record));
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'error');
  assert.equal(b.local.states.main[record.sha256].transfer_status, 'error');
  assert.equal(b.local.blobs.size, 0);
  original.bytes = valid;
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'synced');
  await b.engine.downloadOriginal('main', record);
  assert.equal(b.local.states.main[record.sha256].transfer_status, 'downloaded');
});
test('a damaged pinned cache is replaced from the verified Drive original', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  await a.engine.createVault();
  await a.engine.sync();
  a.local.states.main[record.sha256].keep_offline = true;
  a.local.blobs.set(`main:${record.sha256}`, Buffer.from('corrupted local cache'));
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'synced');
  assert.equal(a.local.writes, 1);
  assert.equal(hashBytes(a.local.blobs.get(`main:${record.sha256}`)), record.sha256);
});
test('failed transfer initialization is retryable and cannot leave a stuck download', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive),
    record = attach(a.local);
  await a.engine.createVault();
  await a.engine.sync();
  const setState = a.engine.backend.originalState;
  let fail = true;
  a.engine.backend.originalState = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('Local service restarted');
    }
    return setState(...args);
  };
  await assert.rejects(a.engine.downloadOriginal('main', record), /restarted/);
  assert.equal(a.engine.downloads.size, 0);
  await a.engine.downloadOriginal('main', record);
  assert.equal(a.engine.downloads.size, 0);
});
test('conflicting notes stay intact until explicit resolution reaches both devices', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive);
  a.local.snapshot.graphs.main.notes['paper.md'] = 'original';
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  a.local.snapshot.graphs.main.notes['paper.md'] = 'version A';
  b.local.snapshot.graphs.main.notes['paper.md'] = 'version B';
  await a.engine.sync();
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'conflict');
  assert.equal(b.local.snapshot.graphs.main.notes['paper.md'], 'version B');
  const c = b.engine.status.conflicts[0];
  await b.engine.sync(
    { [c.id]: c.choices.find((v) => v.value === 'version A').id },
    b.engine.status.heads,
  );
  await a.engine.sync();
  assert.deepEqual(a.local.snapshot, b.local.snapshot);
  assert.equal(b.local.snapshot.graphs.main.notes['paper.md'], 'version A');
});
test('failed local application does not overwrite a device or falsely mark synced', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive);
  a.local.snapshot.graphs.main.notes['paper.md'] = 'remote';
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  b.local.failApply = true;
  await b.engine.sync();
  assert.equal(b.engine.status.phase, 'error');
  assert.deepEqual(b.local.snapshot, empty());
  b.local.failApply = false;
  await b.engine.sync();
  assert.equal(b.local.snapshot.graphs.main.notes['paper.md'], 'remote');
});
test('a rejected merge is never published after a restart and newer edits survive', async (t) => {
  const drive = new FakeDrive(),
    a = await device(t, drive);
  a.local.snapshot.graphs.main.notes['base.md'] = 'original';
  const key = await a.engine.createVault();
  await a.engine.sync();
  const b = await device(t, drive);
  await b.engine.unlock(drive.files[0].id, key);
  await b.engine.sync();
  a.local.snapshot.graphs.main.notes['a.md'] = 'remote addition';
  b.local.snapshot.graphs.main.notes['b.md'] = 'local addition';
  await a.engine.sync();
  b.local.failApply = true;
  await b.engine.sync();
  const rejected = b.engine.state.pending.id;
  assert.equal(b.engine.state.pending.createdLocally, true);
  b.local.snapshot.graphs.main.notes['b.md'] = 'newer local edit';
  b.local.failApply = false;
  b.engine = new SyncEngine({ ...b.engine });
  await b.engine.sync();
  await a.engine.sync();
  assert.equal(b.engine.status.phase, 'synced');
  assert.equal(
    drive.files.some((f) => f.appProperties.commit === rejected),
    false,
  );
  assert.equal(a.local.snapshot.graphs.main.notes['b.md'], 'newer local edit');
  assert.deepEqual(a.local.snapshot, b.local.snapshot);
});
