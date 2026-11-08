import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import canonicalGraph from '../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph, NODE_TYPES, STATUSES } from '../domain/schema';
import { useWorkspaceStore } from './workspaceStore';

const graph = migrateAndValidateGraph(canonicalGraph).graph;

function resetStore() {
  useWorkspaceStore.setState({
    graph: structuredClone(graph),
    baseRevision: graph.meta.revision,
    mode: 'api',
    loading: false,
    dirty: false,
    error: null,
    migratedFrom: null,
    draftAvailable: false,
    selection: null,
    paperWorkspace: null,
    researchScope: [],
    researchSessionId: null,
    activeTab: 'library',
    graphView: 'universe',
    filters: {
      query: '',
      nodeTypes: new Set(NODE_TYPES),
      statuses: new Set(STATUSES),
      relations: new Set(graph.edges.map((edge) => edge.relation)),
      clusterId: null,
      showRejected: false,
    },
    toasts: [],
  });
}

describe('workspace store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('marks content edits as user-owned and persists a draft', () => {
    const proposed = graph.nodes.find((node) => node.origin === 'claude')!;

    useWorkspaceStore.getState().updateNode(proposed.id, {
      label: 'Researcher-edited label',
    });

    const state = useWorkspaceStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.graph?.nodes.find((node) => node.id === proposed.id)).toMatchObject({
      label: 'Researcher-edited label',
      origin: 'user',
    });
    expect(localStorage.getItem('orbis:v2:draft')).not.toBeNull();
  });

  it('persists layout positions without transferring content ownership', () => {
    const proposed = graph.nodes.find((node) => node.origin === 'claude')!;

    useWorkspaceStore.getState().updateNodePosition(proposed.id, { x: 12, y: -4, z: 30 });

    expect(
      useWorkspaceStore.getState().graph?.nodes.find((node) => node.id === proposed.id),
    ).toMatchObject({
      origin: 'claude',
      position: { x: 12, y: -4, z: 30 },
    });
  });

  it('makes review decisions user-owned for nodes and edges', () => {
    const proposedNode = graph.nodes.find((node) => node.status === 'proposed')!;
    const proposedEdge = graph.edges.find((edge) => edge.status === 'proposed')!;
    const store = useWorkspaceStore.getState();

    store.setStatus('node', proposedNode.id, 'accepted');
    useWorkspaceStore.getState().setStatus('edge', proposedEdge.id, 'uncertain');

    const updated = useWorkspaceStore.getState().graph!;
    expect(updated.nodes.find((node) => node.id === proposedNode.id)).toMatchObject({
      status: 'accepted',
      origin: 'user',
    });
    expect(updated.edges.find((edge) => edge.id === proposedEdge.id)).toMatchObject({
      status: 'uncertain',
      origin: 'user',
    });
  });

  it('resets every graph visibility filter together', () => {
    useWorkspaceStore.setState(() => ({
      filters: {
        query: 'narrow query',
        nodeTypes: new Set(),
        statuses: new Set(),
        relations: new Set(),
        clusterId: graph.nodes.find((node) => node.type === 'cluster')!.id,
        showRejected: true,
      },
    }));

    useWorkspaceStore.getState().resetFilters();

    const filters = useWorkspaceStore.getState().filters;
    expect(filters.query).toBe('');
    expect(filters.nodeTypes).toEqual(new Set(NODE_TYPES));
    expect(filters.statuses).toEqual(new Set(STATUSES));
    expect(filters.relations).toEqual(new Set(graph.edges.map((edge) => edge.relation)));
    expect(filters.clusterId).toBeNull();
    expect(filters.showRejected).toBe(false);
  });

  it('switches graph views without changing graph data or filters', () => {
    const before = useWorkspaceStore.getState();

    before.setGraphView('lineages');

    const after = useWorkspaceStore.getState();
    expect(after.graphView).toBe('lineages');
    expect(after.graph).toBe(before.graph);
    expect(after.filters).toBe(before.filters);
  });

  it('opens and closes a paper without changing galaxy data, filters, or view', () => {
    const before = useWorkspaceStore.getState();
    const paperId = graph.nodes.find((node) => node.type === 'paper')!.id;
    before.openPaper(paperId, 'original-id', 3, 'Discuss');
    const opened = useWorkspaceStore.getState();
    expect(opened.paperWorkspace).toMatchObject({
      nodeId: paperId,
      documentId: 'original-id',
      page: 3,
      tab: 'Discuss',
    });
    expect(opened.graph).toBe(before.graph);
    expect(opened.filters).toBe(before.filters);
    expect(opened.graphView).toBe(before.graphView);
    opened.closePaper();
    expect(useWorkspaceStore.getState().paperWorkspace).toBeNull();
    expect(useWorkspaceStore.getState().dirty).toBe(false);
    useWorkspaceStore.getState().openPaper('paper:missing');
    expect(useWorkspaceStore.getState().paperWorkspace).toBeNull();
  });

  it('saves the next revision and clears dirty draft state', async () => {
    const proposed = graph.nodes.find((node) => node.status === 'proposed')!;
    useWorkspaceStore.getState().setStatus('node', proposed.id, 'accepted');
    const nextRevision = graph.meta.revision + 1;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        base_revision: number;
        graph: typeof graph;
      };
      expect(body.base_revision).toBe(graph.meta.revision);
      expect(body.graph.meta.revision).toBe(nextRevision);
      return new Response(JSON.stringify(body.graph), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mode = await useWorkspaceStore.getState().save();

    const state = useWorkspaceStore.getState();
    expect(mode).toBe('api');
    expect(state.baseRevision).toBe(nextRevision);
    expect(state.graph?.meta.revision).toBe(nextRevision);
    expect(state.dirty).toBe(false);
    expect(localStorage.getItem('orbis:v2:draft')).toBeNull();
  });
  it('keeps edits made during an autosave and saves them against the acknowledged revision', async () => {
    const id = graph.nodes[0].id;
    let finish!: (response: Response) => void;
    let firstBody!: { graph: typeof graph };
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!firstBody) {
        firstBody = body;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      expect(body.base_revision).toBe(firstBody.graph.meta.revision);
      return Promise.resolve(new Response(JSON.stringify(body.graph), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    useWorkspaceStore.getState().updateNode(id, { label: 'First edit' });
    const saving = useWorkspaceStore.getState().save();
    useWorkspaceStore.getState().updateNode(id, { label: 'Newer edit' });
    const concurrent = useWorkspaceStore.getState().save();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify(firstBody.graph), { status: 200 }));
    await Promise.all([saving, concurrent]);
    expect(useWorkspaceStore.getState().dirty).toBe(true);
    expect(useWorkspaceStore.getState().graph?.nodes.find((n) => n.id === id)?.label).toBe(
      'Newer edit',
    );
    expect(localStorage.getItem('orbis:v2:draft')).not.toBeNull();
    await useWorkspaceStore.getState().save();
    expect(useWorkspaceStore.getState().dirty).toBe(false);
    expect(useWorkspaceStore.getState().graph?.nodes.find((n) => n.id === id)?.label).toBe(
      'Newer edit',
    );
  });
});
