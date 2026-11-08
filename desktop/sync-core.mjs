import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const equal = (a, b) => canonical(a) === canonical(b);
export const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAX_ORIGINAL = 25 * 1024 * 1024;
export function sealOriginal(bytes, key, context) {
  if (!bytes.length || bytes.length > MAX_ORIGINAL)
    throw new Error('Invalid original size');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function unsealOriginal(bytes, key, context, sha, size) {
  if (bytes.length < 29 || bytes.length > MAX_ORIGINAL + 28)
    throw new Error('Invalid encrypted original');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const content = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  if (hashBytes(content) !== sha || content.length !== size)
    throw new Error('Original failed its hash or size check; no file was replaced');
  return content;
}

export function normalizedSnapshot(snapshot) {
  if (![1, 2].includes(snapshot?.version) || !snapshot.graphs) return snapshot;
  return {
    version: 2,
    graphs: Object.fromEntries(
      Object.entries(snapshot.graphs).map(([id, graph]) => [
        id,
        {
          ...graph,
          documents: graph.documents ?? {},
          annotations: graph.annotations ?? {},
        },
      ]),
    ),
  };
}
export const snapshotsEqual = (a, b) => equal(normalizedSnapshot(a), normalizedSnapshot(b));
export function seal(value, key, context) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function unseal(bytes, key, context) {
  if (bytes.length < 29 || bytes.length > 32 * 1024 * 1024)
    throw new Error('Invalid encrypted sync file');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    gunzipSync(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]), {
      maxOutputLength: 64 * 1024 * 1024,
    }).toString(),
  );
}

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function mergeSnapshots(base, variants, resolutions = {}) {
  const conflicts = [];
  function merge(before, choices, path) {
    const changed = choices.filter((c) => !equal(c.value, before));
    if (!changed.length) return before;
    if (changed.every((c) => equal(c.value, changed[0].value))) return changed[0].value;
    // A delete versus an edit is one conflict, never a silently reconstructed record.
    const collidingRecord =
      before === undefined &&
      path.length === 4 &&
      ['nodes', 'edges', 'sessions', 'documents', 'annotations'].includes(path[2]);
    if (
      !collidingRecord &&
      changed.every((c) => object(c.value)) &&
      (before === undefined || object(before))
    ) {
      const keys = new Set([
        ...Object.keys(before || {}),
        ...changed.flatMap((c) => Object.keys(c.value)),
      ]);
      const output = Object.create(null);
      for (const key of [...keys].sort()) {
        const value = merge(
          before?.[key],
          changed.map((c) => ({ id: c.id, value: c.value[key] })),
          [...path, key],
        );
        if (value !== undefined) output[key] = value;
      }
      return output;
    }
    const id = JSON.stringify(path);
    const chosen = changed.find((c) => c.id === resolutions[id]);
    if (chosen) return chosen.value;
    conflicts.push({
      id,
      path: path.join(' / '),
      choices: changed.map((c) => ({
        id: c.id,
        value:
          c.value === undefined
            ? '(deleted)'
            : typeof c.value === 'string'
              ? c.value
              : JSON.stringify(c.value, null, 2),
      })),
    });
    return before;
  }
  return { snapshot: merge(base, variants, []), conflicts };
}

export function mergeCommits(commits, resolutions = {}) {
  const map = new Map(commits.map((c) => [c.id, c]));
  const referenced = new Set(commits.flatMap((c) => c.parents));
  const heads = commits
    .filter((c) => !referenced.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const memo = new Map();
  function ancestors(id, visiting = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id) || !map.has(id))
      throw new Error('Incomplete or cyclic sync history; no changes applied');
    const next = new Set([...visiting, id]),
      result = new Set([id]);
    for (const parent of map.get(id).parents)
      for (const a of ancestors(parent, next)) result.add(a);
    memo.set(id, result);
    return result;
  }
  for (const c of commits) ancestors(c.id);
  if (!heads.length) throw new Error('Empty sync history');
  const common = [...ancestors(heads[0].id)].filter((id) =>
    heads.every((h) => ancestors(h.id).has(id)),
  );
  const bases = common.filter(
    (id) => !common.some((other) => other !== id && ancestors(other).has(id)),
  );
  // Multiple incomparable bases need explicit reconciliation, not an arbitrary old snapshot.
  if (bases.length > 1)
    throw new Error(
      'Concurrent merge histories need recovery. All versions are preserved.',
    );
  const normalize = commits.some((c) => c.snapshot?.version === 2)
    ? normalizedSnapshot
    : (value) => value;
  const base = bases.length ? normalize(map.get(bases[0]).snapshot) : undefined;
  const merged = mergeSnapshots(
    base,
    heads.map((c) => ({ id: c.id, value: normalize(c.snapshot) })),
    resolutions,
  );
  return { ...merged, heads: heads.map((c) => c.id) };
}
