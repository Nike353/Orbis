import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUiPreferences, writeUiPreference } from '../ui-preferences.mjs';

test('agent choices persist in the profile across app ports without storing library drafts', async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'orbis-preferences-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  assert.deepEqual(await readUiPreferences(profile), {});
  await writeUiPreference(profile, 'orbis.agent', 'codex');
  await writeUiPreference(
    profile,
    'orbis.agent-models',
    '{"state":{"choices":{"codex":{"model":"fixture-model","effort":"high"}}}}',
  );
  assert.equal((await readUiPreferences(profile))['orbis.agent'], 'codex');
  assert.match((await readUiPreferences(profile))['orbis.agent-models'], /fixture-model/);
  await writeUiPreference(profile, 'orbis.onboarding', 'skipped');
  assert.equal((await readUiPreferences(profile))['orbis.onboarding'], 'skipped');
  await writeUiPreference(profile, 'orbis.onboarding', 'completed');
  assert.equal((await readUiPreferences(profile))['orbis.onboarding'], 'completed');
  await assert.rejects(
    writeUiPreference(profile, 'orbis.onboarding', 'unexpected'),
    /Invalid desktop preference/,
  );
  await assert.rejects(
    writeUiPreference(profile, 'orbis:v2:draft', 'Private library'),
    /Invalid desktop preference/,
  );
  await assert.rejects(
    writeUiPreference(profile, 'orbis.agent', 'x'.repeat(16001)),
    /Invalid desktop preference/,
  );
  await writeUiPreference(profile, 'orbis.agent', null);
  assert.equal('orbis.agent' in (await readUiPreferences(profile)), false);
});

test('invalid or symlinked preference files are preserved instead of overwritten', async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'orbis-preferences-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const file = path.join(profile, 'ui-preferences.json');
  await writeFile(file, '{"unexpected":"preserve"}');
  await assert.rejects(writeUiPreference(profile, 'orbis.agent', 'claude'), /preserved/);
  assert.equal(await readFile(file, 'utf8'), '{"unexpected":"preserve"}');
  await rm(file);
  await symlink('/etc/hostname', file);
  await assert.rejects(readUiPreferences(profile), /preserved/);
});
