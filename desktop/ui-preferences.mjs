import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './sync-engine.mjs';

const KEYS = new Set(['orbis.agent', 'orbis.agent-models']);
const valid = (key, value) =>
  KEYS.has(key) && typeof value === 'string' && value.length <= 16000;

export async function readUiPreferences(profile) {
  const file = path.join(profile, 'ui-preferences.json');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40000)
      throw new Error('Invalid desktop preference file; it has been preserved.');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(([key, text]) => !valid(key, text))
    )
      throw new Error('Invalid desktop preferences; the file has been preserved.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeUiPreference(profile, key, value) {
  if (!KEYS.has(key) || (value !== null && !valid(key, value)))
    throw new Error('Invalid desktop preference.');
  const preferences = await readUiPreferences(profile);
  if (value === null) delete preferences[key];
  else preferences[key] = value;
  await atomic(path.join(profile, 'ui-preferences.json'), JSON.stringify(preferences));
}
