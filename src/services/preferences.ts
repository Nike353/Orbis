// Read earlier installations' keys once; all new writes use the Orbis namespace.
function previousKey(key: string) {
  return key.replace(/^orbis(?=[:.])/, 'litbench');
}

export function readPreference(key: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const previous = localStorage.getItem(previousKey(key));
    if (previous !== null) {
      try {
        localStorage.setItem(key, previous);
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
}
