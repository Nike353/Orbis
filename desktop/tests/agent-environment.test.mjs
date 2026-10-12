import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentEnvironment } from '../agent-environment.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbis-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    home: path.join(root, 'User Home'),
    applications: path.join(root, 'Apps'),
    platform: 'darwin',
    additionalPaths: [path.join(root, 'User Home/.local/bin')],
  };
}
async function makeExecutable(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o700);
}

test('Finder launches discover the current nested ChatGPT Codex CLI', async (t) => {
  const options = await fixture(t);
  const cli = path.join(
    options.applications,
    'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  );
  await makeExecutable(cli);
  const env = await agentEnvironment({ PATH: '/usr/bin:/bin' }, options);
  assert.equal(JSON.parse(env.ORBIS_CODEX), cli);
  assert.ok(env.PATH.split(path.delimiter).includes(path.join(options.home, '.local/bin')));
});

test('per-user app bundles with spaces and previous bundle layouts are supported', async (t) => {
  const options = await fixture(t);
  const cli = path.join(options.home, 'Applications/Codex.app/Contents/Resources/codex');
  await makeExecutable(cli);
  const env = await agentEnvironment({ PATH: '/usr/bin:/bin' }, options);
  assert.equal(JSON.parse(env.ORBIS_CODEX), cli);
});

test('a CLI on the inherited PATH takes precedence over bundled versions', async (t) => {
  const options = await fixture(t);
  const bin = path.join(options.home, 'custom-bin');
  await makeExecutable(path.join(bin, 'codex'));
  await makeExecutable(
    path.join(options.applications, 'Codex.app/Contents/Resources/codex'),
  );
  const env = await agentEnvironment({ PATH: `${bin}:/usr/bin` }, options);
  assert.equal(env.ORBIS_CODEX, undefined);
  assert.equal(env.PATH.split(path.delimiter)[0], bin);
});

test('explicit commands and legacy overrides are preserved without mutating the caller', async (t) => {
  const options = await fixture(t);
  const inherited = {
    ORBIS_CODEX: 'custom-codex --flag',
    LITBENCH_CODEX: 'old-codex',
    LITBENCH_CLAUDE: 'custom-claude',
  };
  const env = await agentEnvironment(inherited, options);
  assert.equal(env.ORBIS_CODEX, 'custom-codex --flag');
  assert.equal(env.ORBIS_CLAUDE, 'custom-claude');
  assert.equal(inherited.PATH, undefined);
  assert.equal(
    (await agentEnvironment({ LITBENCH_CODEX: 'old-codex' }, options)).ORBIS_CODEX,
    'old-codex',
  );
});

test('directories and non-executable files are not reported as installed CLIs', async (t) => {
  const options = await fixture(t);
  const resources = path.join(options.applications, 'Codex.app/Contents/Resources');
  await mkdir(path.join(resources, 'codex'), { recursive: true });
  const nested = path.join(resources, 'codex-cli/CodexCLI.app/Contents/MacOS/codex');
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(nested, 'not executable', { mode: 0o600 });
  assert.equal(
    (await agentEnvironment({ PATH: '/usr/bin:/bin' }, options)).ORBIS_CODEX,
    undefined,
  );
});

test('Linux keeps normal CLI discovery and never selects a macOS bundle', async (t) => {
  const options = await fixture(t);
  await makeExecutable(
    path.join(options.applications, 'Codex.app/Contents/Resources/codex'),
  );
  const env = await agentEnvironment(
    { PATH: '/usr/bin:/bin' },
    { ...options, platform: 'linux' },
  );
  assert.equal(env.ORBIS_CODEX, undefined);
});
