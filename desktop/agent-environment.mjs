import { constants } from 'node:fs';
import { access, open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function executable(file) {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function agentCommand(file) {
  const node = path.join(path.dirname(file), 'node');
  try {
    if (await executable(node)) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(128);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (/^#![^\n]*\bnode(?:\s|$)/.test(buffer.toString('utf8', 0, bytesRead)))
          return `${JSON.stringify(node)} ${JSON.stringify(file)}`;
      } finally {
        await handle.close();
      }
    }
  } catch {
    // Executable-only files can still be launched without inspecting their shebang.
  }
  return JSON.stringify(file);
}

export async function agentEnvironment(
  inherited,
  {
    home = os.homedir(),
    platform = process.platform,
    applications = '/Applications',
    additionalPaths = [
      path.join(home, '.local/bin'),
      path.join(home, '.toolbox/bin'),
      path.join(home, '.npm-global/bin'),
      path.join(home, '.npm/bin'),
      path.join(home, '.bun/bin'),
      path.join(home, '.volta/bin'),
      path.join(home, '.asdf/shims'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ],
  } = {},
) {
  const env = { ...inherited };
  const versionedPaths = [];
  for (const [root, suffix] of [
    [path.join(home, '.nvm/versions/node'), 'bin'],
    [path.join(home, '.local/share/fnm/node-versions'), 'installation/bin'],
    [path.join(home, '.local/share/mise/installs/node'), 'bin'],
  ]) {
    try {
      const versions = await readdir(root);
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      versionedPaths.push(...versions.map((version) => path.join(root, version, suffix)));
    } catch {
      // A version manager is optional.
    }
  }
  const inheritedPaths = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const directories = [
    ...new Set([...inheritedPaths, ...additionalPaths, ...versionedPaths]),
  ];
  env.PATH = directories.join(path.delimiter);
  for (const agent of ['CODEX', 'CLAUDE']) {
    if (!env[`ORBIS_${agent}`] && env[`LITBENCH_${agent}`])
      env[`ORBIS_${agent}`] = env[`LITBENCH_${agent}`];
    if (env[`ORBIS_${agent}`]) continue;
    const name = agent.toLowerCase();
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      if (!(await executable(candidate))) continue;
      if (!inheritedPaths.includes(directory)) {
        env[`ORBIS_${agent}`] = await agentCommand(candidate);
        // npm-installed CLIs need the Node runtime from the same installation.
        env.PATH = [directory, ...env.PATH.split(path.delimiter)].join(path.delimiter);
      }
      break;
    }
  }
  if (env.ORBIS_CODEX || platform !== 'darwin') return env;
  // Respect an independently installed CLI before using an app's bundled CLI.
  for (const directory of directories)
    if (await executable(path.join(directory, 'codex'))) return env;

  for (const directory of [applications, path.join(home, 'Applications')]) {
    for (const bundle of ['Codex.app', 'ChatGPT.app']) {
      const resources = path.join(directory, bundle, 'Contents/Resources');
      for (const relative of ['codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex']) {
        const candidate = path.join(resources, relative);
        if (await executable(candidate)) {
          // The Python bridge parses this as argv with shlex, without a shell.
          env.ORBIS_CODEX = JSON.stringify(candidate);
          return env;
        }
      }
    }
  }
  return env;
}
