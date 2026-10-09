import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadGraph,
  RevisionConflictError,
  saveGraph,
  clearDraft,
  restoreDraft,
} from './graphRepository';
import { migrateAndValidateGraph } from '../domain/schema';
import canonicalGraph from '../../tests/fixtures/library/data/graph.json';

const rawGraph = canonicalGraph;
const graph = migrateAndValidateGraph(rawGraph).graph;

describe('graph repository', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('prefers the canonical local API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(rawGraph), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await loadGraph();
    expect(result.mode).toBe('api');
    expect(result.migratedFrom).toBeNull();
  });

  it('falls back to the static graph when the API is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(rawGraph), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadGraph();
    expect(result.mode).toBe('http');
  });

  it('surfaces revision conflicts from API saves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ current_revision: 4 }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(saveGraph(graph, 3, 'api')).rejects.toEqual(
      expect.objectContaining<Partial<RevisionConflictError>>({
        name: 'RevisionConflictError',
        currentRevision: 4,
      }),
    );
  });

  it('recovers a previous workspace draft and does not resurrect it after saving', async () => {
    const key = 'litbench:v2:draft:workspace-a';
    localStorage.setItem(key, JSON.stringify({ baseRevision: graph.meta.revision, graph }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(rawGraph), {
          headers: { 'X-Orbis-Workspace': 'workspace-a' },
        }),
      ),
    );
    const loaded = await loadGraph();
    expect(loaded.draftAvailable).toBe(true);
    expect(restoreDraft(graph.meta.revision)).toEqual(graph);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem('orbis:v2:draft:workspace-a')).not.toBeNull();
    clearDraft();
    expect(restoreDraft(graph.meta.revision)).toBeNull();
  });

  it('reads previous offline exports while preferring Orbis snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    vi.stubGlobal('LITBENCH_DATA', rawGraph);
    expect((await loadGraph()).mode).toBe('snapshot');
    vi.stubGlobal('ORBIS_DATA', {
      ...rawGraph,
      meta: { ...rawGraph.meta, title: 'New export' },
    });
    expect((await loadGraph()).graph.meta.title).toBe('New export');
  });
});
