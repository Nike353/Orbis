import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Read-only compatibility identifiers for installations made before the rename.
export const LEGACY_APP_NAME = 'litbench';
export const TRANSFER_FLAG = '--orbis-upgrade-credentials';

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

// Promote one complete profile atomically. The old profile remains a backup.
// acquire() holds the previous app's instance lock until the copy is complete.
export async function migrateProfile({ home, legacyHome, acquire, encrypt }) {
  const profile = path.join(home, 'Profile');
  if (await exists(profile)) return false;
  if (!(await exists(path.join(legacyHome, 'Library')))) return false;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const source = await acquire();
  let stage;
  try {
    stage = await mkdtemp(path.join(home, '.profile-upgrade-'));
    for (const name of ['Library', 'Sync']) {
      const from = path.join(legacyHome, name);
      if (await exists(from)) await cp(from, path.join(stage, name), { recursive: true });
    }
    if (source.secrets !== null) {
      const sealed = await encrypt(source.secrets);
      await writeFile(path.join(stage, 'desktop-secrets.bin'), sealed, { mode: 0o600 });
    }
    await rename(stage, profile);
    stage = null;
    return true;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    source.release();
  }
}

// A short-lived Electron process reads the old OS keychain identity. Secrets
// travel only over a private parent/child IPC pipe, never stdout or a temp file.
export function acquireLegacyProfile({
  executable,
  appPath,
  packaged,
  legacyHome,
  parentOwnsLock = false,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        ...(packaged ? [] : [appPath]),
        TRANSFER_FLAG,
        legacyHome,
        ...(parentOwnsLock ? ['--orbis-profile-locked'] : []),
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    let delivered = false;
    const fail = () => {
      clearTimeout(timer);
      child.kill();
      if (!delivered)
        reject(
          new Error(
            'Could not upgrade the saved Google connection. Close other Orbis windows and retry; your previous library is unchanged.',
          ),
        );
    };
    const timer = setTimeout(fail, 60000);
    child.once('error', fail);
    child.once('exit', () => {
      if (!delivered) fail();
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      if (message?.error) {
        child.kill();
        reject(new Error(message.error));
      } else if (
        message?.ready &&
        (message.secrets === null || typeof message.secrets === 'string')
      ) {
        delivered = true;
        resolve({ secrets: message.secrets, release: () => child.kill() });
      } else fail();
    });
  });
}

export async function serveLegacyProfile({ app, safeStorage, legacyHome }) {
  await app.whenReady();
  if (
    !process.argv.includes('--orbis-profile-locked') &&
    !app.requestSingleInstanceLock()
  ) {
    process.send(
      {
        error:
          'Close the previous Orbis app before upgrading. Your library has not been changed.',
      },
      () => app.exit(),
    );
    return;
  }
  process.on('disconnect', () => app.exit());
  try {
    let secrets = null;
    const file = path.join(legacyHome, 'desktop-secrets.bin');
    if (await exists(file)) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' &&
          safeStorage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('Credential store unavailable');
      secrets = safeStorage.decryptString(await readFile(file));
      JSON.parse(secrets);
    }
    process.send({ ready: true, secrets });
  } catch {
    process.send(
      {
        error:
          'Unlock your OS credential store and reopen Orbis to finish the upgrade. Your previous library and Google connection are unchanged.',
      },
      () => app.exit(),
    );
  }
}
