import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { rm } from 'node:fs/promises';
import { readLibraryImport, copyImportOriginals } from '../library-import.mjs';
import { hashBytes } from '../sync-core.mjs';

async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'orbis-import-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = path.join(folder, 'source'),
    destination = path.join(folder, 'destination');
  await mkdir(source);
  await mkdir(destination);
  const bytes = Buffer.from('Synthetic original article'),
    sha = hashBytes(bytes);
  const record = {
    id: 'd'.repeat(32),
    node_id: 'paper:fixture',
    sha256: sha,
    size: bytes.length,
    media_type: 'text/plain',
    filename: 'article.txt',
    source_url: '',
    source_version: '',
    retrieved_at: '2026-11-07T00:00:00Z',
  };
  async function graph(prefix = '', originals = false) {
    const root = path.join(source, prefix);
    await mkdir(path.join(root, 'data'), { recursive: true });
    await mkdir(path.join(root, 'papers'), { recursive: true });
    await writeFile(
      path.join(root, 'data/graph.json'),
      JSON.stringify({
        meta: {
          title: 'Synthetic library',
          schema_version: 2,
          revision: 3,
          updated_at: 'today',
        },
        nodes: [
          {
            id: 'paper:fixture',
            type: 'paper',
            label: 'Fixture',
            notes: 'My personal notes',
          },
        ],
        edges: [
          {
            id: 'e001',
            source: 'paper:fixture',
            target: 'claim:fixture',
            relation: 'supports',
            evidence: 'Full connection evidence',
          },
        ],
      }),
    );
    await writeFile(path.join(root, 'papers/fixture.md'), '# Imported summary\n$E=mc^2$');
    await writeFile(
      path.join(root, 'data/research.json'),
      JSON.stringify({
        sessions: [
          {
            id: 's'.repeat(32),
            title: 'Saved discussion',
            turns: [],
            scope_ids: ['paper:fixture'],
            criteria: [],
          },
        ],
      }),
    );
    if (originals) {
      await mkdir(path.join(root, 'attachments'));
      await writeFile(path.join(root, `attachments/${sha}.blob`), bytes);
      await writeFile(
        path.join(root, 'data/documents.json'),
        JSON.stringify({ [record.id]: record }),
      );
      await writeFile(
        path.join(root, 'data/annotations.json'),
        JSON.stringify({
          ['a'.repeat(32)]: {
            id: 'a'.repeat(32),
            document_id: record.id,
            page: 1,
            quote: 'Synthetic original',
            comment: 'A saved highlight comment',
          },
        }),
      );
    }
  }
  return { source, destination, graph, record, bytes, sha };
}

test('legacy import preserves notes, complete connections and discussions without migrating device state', async (t) => {
  const f = await fixture(t);
  await f.graph();
  await mkdir(path.join(f.source, '.orbis'));
  await writeFile(path.join(f.source, '.orbis/research-drafts.json'), 'device-local draft');
  await writeFile(
    path.join(f.source, 'desktop-secrets.bin'),
    'synthetic credentials excluded',
  );
  const snapshot = await readLibraryImport(f.source);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.graphs.main.nodes['paper:fixture'].notes, 'My personal notes');
  assert.equal(snapshot.graphs.main.edges.e001.evidence, 'Full connection evidence');
  assert.equal(snapshot.graphs.main.notes['fixture.md'], '# Imported summary\n$E=mc^2$');
  assert.equal(Object.values(snapshot.graphs.main.sessions)[0].title, 'Saved discussion');
  await copyImportOriginals(f.source, f.destination, snapshot);
  assert.deepEqual(await readdir(f.destination), []);
});

test('attachment import preserves both graphs, highlights and verified originals before metadata apply', async (t) => {
  const f = await fixture(t),
    child = 'c'.repeat(32);
  await f.graph('', true);
  await f.graph(`graphs/${child}`, true);
  await writeFile(
    path.join(f.source, 'data/graphs.json'),
    JSON.stringify([{ id: child, name: 'Independent' }]),
  );
  const snapshot = await readLibraryImport(f.source);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.graphs[child].name, 'Independent');
  assert.equal(
    Object.values(snapshot.graphs.main.annotations)[0].comment,
    'A saved highlight comment',
  );
  await copyImportOriginals(f.source, f.destination, snapshot);
  assert.deepEqual(
    await readFile(path.join(f.destination, `attachments/${f.sha}.blob`)),
    f.bytes,
  );
  assert.deepEqual(
    await readFile(path.join(f.destination, `graphs/${child}/attachments/${f.sha}.blob`)),
    f.bytes,
  );
  await copyImportOriginals(f.source, f.destination, snapshot);
  assert.equal((await readdir(path.join(f.destination, 'attachments'))).length, 1);
  assert.equal(JSON.stringify(snapshot).includes('keep_offline'), false);
});

test('a failed integrity check preserves source bytes and never applies metadata', async (t) => {
  const f = await fixture(t);
  await f.graph('', true);
  const snapshot = await readLibraryImport(f.source);
  await writeFile(path.join(f.source, `attachments/${f.sha}.blob`), 'Damaged original');
  await assert.rejects(
    copyImportOriginals(f.source, f.destination, snapshot),
    /integrity check/,
  );
  assert.equal(
    await readFile(path.join(f.source, `attachments/${f.sha}.blob`), 'utf8'),
    'Damaged original',
  );
  assert.deepEqual(await readdir(f.destination), []);
});

test('remote-only original metadata is preserved for later recovery-key pairing', async (t) => {
  const f = await fixture(t);
  await f.graph('', true);
  await rm(path.join(f.source, 'attachments'), { recursive: true });
  const snapshot = await readLibraryImport(f.source);
  await copyImportOriginals(f.source, f.destination, snapshot);
  assert.equal(snapshot.graphs.main.documents[f.record.id].sha256, f.sha);
  assert.deepEqual(await readdir(f.destination), []);
});

test('import rejects symlinked originals and duplicate graph records', async (t) => {
  const f = await fixture(t);
  await f.graph('', true);
  const snapshot = await readLibraryImport(f.source);
  const blob = path.join(f.source, `attachments/${f.sha}.blob`);
  await rm(blob);
  await symlink(path.join(f.source, 'papers/fixture.md'), blob);
  await assert.rejects(
    copyImportOriginals(f.source, f.destination, snapshot),
    /symbolic links/,
  );
  const file = path.join(f.source, 'data/graph.json'),
    graph = JSON.parse(await readFile(file, 'utf8'));
  graph.nodes.push(graph.nodes[0]);
  await writeFile(file, JSON.stringify(graph));
  await assert.rejects(readLibraryImport(f.source), /duplicate nodes/);
});
