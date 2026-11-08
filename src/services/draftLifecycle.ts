export async function flushPaperDrafts() {
  const writes: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('orbis:flushDrafts', { detail: writes }));
  await Promise.all(writes);
}
