// Read earlier installations' keys once; all new writes use the Orbis namespace.
function previousKey(key: string) {
  return key.replace(/^orbis(?=[:.])/, 'litbench');
}
let nativeWrites = Promise.resolve();
const NATIVE_KEYS = new Set(['orbis.agent', 'orbis.agent-models']);

export function writePreference(key: string, value: string) {
  localStorage.setItem(key, value);
  if (window.orbis && NATIVE_KEYS.has(key)) {
    nativeWrites = nativeWrites
      .catch(() => {})
      .then(() => window.orbis!.setPreference(key, value));
    void nativeWrites.catch((error: Error) => {
      window.dispatchEvent(
        new CustomEvent('orbis:preferenceError', { detail: error.message }),
      );
    });
  }
}

export async function restoreDesktopPreferences() {
  if (!window.orbis) return;
  const preferences = await window.orbis.getPreferences();
  for (const [key, value] of Object.entries(preferences))
    if (NATIVE_KEYS.has(key)) localStorage.setItem(key, value);
}

export const flushDesktopPreferences = () => nativeWrites;

export function readPreference(key: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const previous = localStorage.getItem(previousKey(key));
    if (previous !== null) {
      try {
        writePreference(key, previous);
        localStorage.removeItem(previousKey(key));
      } catch {
        // Keep the original if the browser cannot persist the migrated value.
      }
    }
    return previous;
  } catch {
    return null;
  }
}

export function removePreference(key: string) {
  localStorage.removeItem(key);
  localStorage.removeItem(previousKey(key));
  if (window.orbis && NATIVE_KEYS.has(key))
    nativeWrites = nativeWrites
      .catch(() => {})
      .then(() => window.orbis!.setPreference(key, null));
}
