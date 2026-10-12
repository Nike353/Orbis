import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
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

export async function agentEnvironment(
  inherited,
  {
    home = os.homedir(),
    platform = process.platform,
    applications = '/Applications',
    additionalPaths = [
      path.join(home, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ],
  } = {},
) {
  const env = { ...inherited };
  const directories = [
    ...new Set([
      ...(env.PATH || '').split(path.delimiter).filter(Boolean),
      ...additionalPaths,
    ]),
  ];
  env.PATH = directories.join(path.delimiter);
  for (const agent of ['CODEX', 'CLAUDE']) {
    if (!env[`ORBIS_${agent}`] && env[`LITBENCH_${agent}`])
      env[`ORBIS_${agent}`] = env[`LITBENCH_${agent}`];
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
