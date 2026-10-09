import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal, unseal, mergeSnapshots, mergeCommits, hash } from '../sync-core.mjs';
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
  async list(kind, vault) {
    if (this.offline) throw new Error('offline');
    return this.files.filter(
      (f) =>
        f.appProperties.orbisKind === kind && (!vault || f.appProperties.vault === vault),
    );
  }
  async create(name, properties, bytes) {
    if (this.offline) throw new Error('offline');
    const file = {
      id: String(this.files.length + 1),
      name,
      appProperties: properties,
      bytes,
    };
    this.files.push(file);
    return file;
  }
  async download(id) {
    return this.files.find((f) => f.id === id).bytes;
  }
}
async function device(t, drive, state = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = { snapshot: empty(), failApply: false, saves: 0, changes: 0 };
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
