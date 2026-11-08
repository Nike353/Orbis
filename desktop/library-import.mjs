import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBytes } from './sync-core.mjs';
import { atomic } from './sync-engine.mjs';

const MAX_ORIGINAL = 25 * 1024 * 1024;

async function safePath(root, relative) {
  const target = path.join(root, relative);
  for (let part = target; ; part = path.dirname(part)) {
    try {
      if ((await lstat(part)).isSymbolicLink())
        throw new Error('Library import cannot follow symbolic links.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (part === root) break;
  }
  return target;
}

async function boundedFile(root, name, limit) {
  const file = await safePath(root, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > limit)
    throw new Error(`Invalid or oversized import file: ${name}`);
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error(`Import file changed while reading: ${name}`);
  return bytes;
}

function keyed(records, label) {
  if (
    !Array.isArray(records) ||
    records.some((record) => !record || typeof record.id !== 'string') ||
    new Set(records.map((record) => record.id)).size !== records.length
  )
    throw new Error(`Invalid or duplicate ${label} in library import.`);
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

export async function readLibraryImport(directory) {
  const root = path.resolve(directory);
  const json = async (name, fallback) => {
    try {
      return JSON.parse((await boundedFile(root, name, 64 * 1024 * 1024)).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
      throw error;
    }
  };
  const catalog = await json('data/graphs.json', []);
  if (
    !Array.isArray(catalog) ||
    catalog.length > 100 ||
    new Set(['main', ...catalog.map((entry) => entry?.id)]).size !== catalog.length + 1
  )
    throw new Error('Invalid library graph catalog.');
  const graphs = {};
  for (const entry of [{ id: 'main' }, ...catalog]) {
    if (!entry || !/^(main|[a-f0-9]{32})$/.test(entry.id))
      throw new Error('Invalid library graph.');
    const prefix = entry.id === 'main' ? '' : `graphs/${entry.id}/`;
    const graph = await json(`${prefix}data/graph.json`);
    const { revision: _revision, updated_at: _updated, ...meta } = graph.meta;
    const notes = {};
    for (const name of await readdir(await safePath(root, `${prefix}papers`)))
      if (name.endsWith('.md')) {
        if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(name))
          throw new Error('Invalid paper note filename in library import.');
        const text = (await boundedFile(root, `${prefix}papers/${name}`, 1000000)).toString(
          'utf8',
        );
        if (text.length > 250000) throw new Error('Paper note exceeds the import limit.');
        notes[name] = text;
      }
    const sessions = (await json(`${prefix}data/research.json`, { sessions: [] })).sessions;
    if (
      !Array.isArray(sessions) ||
      sessions.some(
        (session) =>
          !Array.isArray(session.turns) ||
          session.turns.some((turn) => turn.status === 'running'),
      )
    )
      throw new Error('Stop running agents before importing this library.');
    const documents = await json(`${prefix}data/documents.json`, {});
    const annotations = await json(`${prefix}data/annotations.json`, {});
    if (
      !documents ||
      typeof documents !== 'object' ||
      Array.isArray(documents) ||
      !annotations ||
      typeof annotations !== 'object' ||
      Array.isArray(annotations)
    )
      throw new Error('Invalid original or highlight catalog in library import.');
    for (const [id, record] of Object.entries(documents))
      if (
        !record ||
        record.id !== id ||
        !/^[a-f0-9]{32}$/.test(id) ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !Number.isInteger(record.size) ||
        record.size < 1 ||
        record.size > MAX_ORIGINAL
      )
        throw new Error('Invalid original metadata in library import.');
    graphs[entry.id] = {
      name: entry.name || meta.title,
      meta,
      notes,
      nodes: keyed(graph.nodes, 'nodes'),
      edges: keyed(graph.edges, 'connections'),
      sessions: keyed(sessions, 'conversations'),
      documents,
      annotations,
    };
  }
  const version = Object.values(graphs).some(
    (graph) => Object.keys(graph.documents).length || Object.keys(graph.annotations).length,
  )
    ? 2
    : 1;
  if (version === 1)
    for (const graph of Object.values(graphs)) {
      delete graph.documents;
      delete graph.annotations;
    }
  return { version, graphs };
}

export async function copyImportOriginals(sourceDirectory, destinationDirectory, snapshot) {
  const source = path.resolve(sourceDirectory),
    destination = path.resolve(destinationDirectory);
  for (const [graph, value] of Object.entries(snapshot.graphs)) {
    const prefix = graph === 'main' ? '' : `graphs/${graph}/`;
    const seen = new Set();
    for (const record of Object.values(value.documents ?? {})) {
      if (seen.has(record.sha256)) continue;
      seen.add(record.sha256);
      let bytes;
      try {
        bytes = await boundedFile(
          source,
          `${prefix}attachments/${record.sha256}.blob`,
          MAX_ORIGINAL,
        );
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (bytes.length !== record.size || hashBytes(bytes) !== record.sha256)
        throw new Error(
          'An original failed its import integrity check. Source files and library records are preserved.',
        );
      const target = await safePath(
        destination,
        `${prefix}attachments/${record.sha256}.blob`,
      );
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        if (
          hashBytes(
            await boundedFile(
              destination,
              `${prefix}attachments/${record.sha256}.blob`,
              MAX_ORIGINAL,
            ),
          ) !== record.sha256
        )
          throw new Error(
            'A damaged destination original was preserved. Restore it before importing.',
          );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomic(target, bytes);
      }
    }
  }
}
