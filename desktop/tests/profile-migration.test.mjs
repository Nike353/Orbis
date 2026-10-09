import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateProfile } from '../profile-migration.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbis-upgrade-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'Orbis'),
    legacyHome = path.join(root, 'previous');
  await mkdir(path.join(legacyHome, 'Library/data'), { recursive: true });
  await mkdir(path.join(legacyHome, 'Sync'));
  await writeFile(path.join(legacyHome, 'Library/data/graph.json'), '{"nodes":["kept"]}');
  await writeFile(path.join(legacyHome, 'Sync/commit'), 'encrypted history');
  await writeFile(path.join(legacyHome, 'desktop-secrets.bin'), 'old ciphertext');
  let released = false;
  return {
    home,
    legacyHome,
    get released() {
      return released;
    },
    acquire: async () => ({
      secrets: '{"key":"fixture-only"}',
      release() {
        released = true;
      },
    }),
    encrypt: async () => Buffer.from('new ciphertext'),
  };
}

test('upgrade keeps the library/history and re-encrypts credentials before atomic promotion', async (t) => {
  const f = await fixture(t);
  assert.equal(await migrateProfile(f), true);
  assert.equal(f.released, true);
  assert.equal(
    await readFile(path.join(f.home, 'Profile/Library/data/graph.json'), 'utf8'),
    '{"nodes":["kept"]}',
  );
  assert.equal(
    await readFile(path.join(f.home, 'Profile/Sync/commit'), 'utf8'),
    'encrypted history',
  );
  assert.equal(
    await readFile(path.join(f.home, 'Profile/desktop-secrets.bin'), 'utf8'),
    'new ciphertext',
  );
  assert.equal(
    await readFile(path.join(f.legacyHome, 'desktop-secrets.bin'), 'utf8'),
    'old ciphertext',
  );
  assert.deepEqual(await readdir(f.home), ['Profile']);
});

test('credential failure leaves the original intact and permits retry without a partial library', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    migrateProfile({
      ...f,
      encrypt() {
        throw new Error('keychain locked');
      },
    }),
    /keychain locked/,
  );
  assert.equal(f.released, true);
  assert.deepEqual(await readdir(f.home), []);
  assert.equal(
    await readFile(path.join(f.legacyHome, 'desktop-secrets.bin'), 'utf8'),
    'old ciphertext',
  );
  assert.equal(await migrateProfile(f), true);
});

test('an existing Orbis profile is never overwritten by a previous installation', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, 'Profile'), { recursive: true });
  assert.equal(
    await migrateProfile({
      ...f,
      acquire() {
        assert.fail('must not reopen the old profile');
      },
    }),
    false,
  );
  assert.deepEqual(await readdir(path.join(f.home, 'Profile')), []);
});

test('a running previous application blocks migration before any library is copied', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    migrateProfile({
      ...f,
      acquire() {
        throw new Error('close old app');
      },
    }),
    /close old app/,
  );
  assert.deepEqual(await readdir(f.home), []);
});

test('a local-only profile needs no Google credential store', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await migrateProfile({
      ...f,
      acquire: async () => ({ secrets: null, release() {} }),
      encrypt() {
        assert.fail('no Google connection');
      },
    }),
    true,
  );
  await assert.rejects(readFile(path.join(f.home, 'Profile/desktop-secrets.bin')), {
    code: 'ENOENT',
  });
});
