import { create } from 'zustand';
import {
  NODE_TYPES,
  STATUSES,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type ReviewStatus,
} from '../domain/schema';
import { replaceEdge, replaceNode } from '../domain/graph';
import {
  clearDraft,
  loadGraph,
  persistDraft,
  restoreDraft,
  saveGraph,
  type LoadMode,
  type SaveMode,
} from '../services/graphRepository';

export type Selection = { kind: 'node' | 'edge'; id: string } | null;
export type WorkspaceTab =
  'library' | 'review' | 'filters' | 'imports' | 'research' | 'compare';
export type GraphView = 'lineages' | 'universe';

interface Filters {
  query: string;
  nodeTypes: Set<NodeType>;
  statuses: Set<ReviewStatus>;
  relations: Set<string>;
  clusterId: string | null;
  showRejected: boolean;
}

interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'warning' | 'error';
}

interface WorkspaceState {
  graph: GraphData | null;
  baseRevision: number;
  mode: LoadMode | null;
  loading: boolean;
  dirty: boolean;
  error: string | null;
  migratedFrom: number | null;
  draftAvailable: boolean;
  addPaperOpen: boolean;
  selection: Selection;
  activeTab: WorkspaceTab | null;
  graphView: GraphView;
  researchScope: string[];
  researchNonce: number;
  openResearch: (ids: string[], compare?: boolean) => void;
  filters: Filters;
  toasts: Toast[];
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  restoreDraft: () => void;
  dismissDraft: () => void;
  setAddPaperOpen: (open: boolean) => void;
  select: (selection: Selection) => void;
  setTab: (tab: WorkspaceTab | null) => void;
  setGraphView: (view: GraphView) => void;
  setQuery: (query: string) => void;
  toggleNodeType: (type: NodeType) => void;
  toggleStatus: (status: ReviewStatus) => void;
  toggleRelation: (relation: string) => void;
  setCluster: (clusterId: string | null) => void;
  toggleRejected: () => void;
  resetFilters: () => void;
  updateNode: (id: string, updates: Partial<GraphNode>) => void;
  updateNodePosition: (id: string, position: { x: number; y: number; z: number }) => void;
  updateEdge: (id: string, updates: Partial<GraphEdge>) => void;
  setStatus: (kind: 'node' | 'edge', id: string, status: ReviewStatus) => void;
  replaceGraph: (graph: GraphData) => void;
  save: () => Promise<SaveMode>;
  addToast: (message: string, tone?: Toast['tone']) => void;
  removeToast: (id: number) => void;
}

function relations(graph: GraphData) {
  return new Set(graph.edges.map((edge) => edge.relation));
}

function markDirty(
  state: WorkspaceState,
  graph: GraphData,
): Pick<WorkspaceState, 'graph' | 'dirty'> {
  persistDraft(graph, state.baseRevision);
  return { graph, dirty: true };
}

let toastId = 0;
let pendingSave: Promise<SaveMode> | null = null;
const initialTab: WorkspaceTab | null = null;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  graph: null,
  baseRevision: 0,
  mode: null,
  loading: true,
  dirty: false,
  error: null,
  migratedFrom: null,
  draftAvailable: false,
  addPaperOpen: false,
  selection: null,
  activeTab: initialTab,
  graphView: 'universe',
  researchScope: [],
  researchNonce: 0,
  openResearch: (ids, compare = false) =>
    set((state) => ({
      activeTab: compare ? 'compare' : 'research',
      researchScope: ids,
      researchNonce: state.researchNonce + 1,
    })),
  filters: {
    query: '',
    nodeTypes: new Set(NODE_TYPES),
    statuses: new Set(STATUSES),
    relations: new Set(),
    clusterId: null,
    showRejected: false,
  },
  toasts: [],

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = await loadGraph();
      set((state) => ({
        graph: result.graph,
        baseRevision: result.baseRevision,
        mode: result.mode,
        migratedFrom: result.migratedFrom,
        draftAvailable: result.draftAvailable,
        loading: false,
        dirty: false,
        filters: { ...state.filters, relations: relations(result.graph) },
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refresh: async () => {
    const result = await loadGraph();
    if (get().dirty) return;
    clearDraft();
    set((state) => ({
      graph: result.graph,
      baseRevision: result.baseRevision,
      mode: result.mode,
      dirty: false,
      draftAvailable: false,
      filters: { ...state.filters, relations: relations(result.graph) },
    }));
  },

  restoreDraft: () => {
    const { baseRevision } = get();
    const graph = restoreDraft(baseRevision);
    if (graph) set({ graph, dirty: true, draftAvailable: false });
  },
  dismissDraft: () => {
    clearDraft();
    set({ draftAvailable: false });
  },
  setAddPaperOpen: (addPaperOpen) => set({ addPaperOpen }),
  select: (selection) => set({ selection }),
  setTab: (activeTab) => set({ activeTab }),
  setGraphView: (graphView) => set({ graphView }),
  setQuery: (query) => set((state) => ({ filters: { ...state.filters, query } })),
  toggleNodeType: (type) =>
    set((state) => {
      const nodeTypes = new Set(state.filters.nodeTypes);
      if (nodeTypes.has(type)) nodeTypes.delete(type);
      else nodeTypes.add(type);
      return { filters: { ...state.filters, nodeTypes } };
    }),
  toggleStatus: (status) =>
    set((state) => {
      const statuses = new Set(state.filters.statuses);
      if (statuses.has(status)) statuses.delete(status);
      else statuses.add(status);
      return { filters: { ...state.filters, statuses } };
    }),
  toggleRelation: (relation) =>
    set((state) => {
      const next = new Set(state.filters.relations);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return { filters: { ...state.filters, relations: next } };
    }),
  setCluster: (clusterId) => set((state) => ({ filters: { ...state.filters, clusterId } })),
  toggleRejected: () =>
    set((state) => ({
      filters: { ...state.filters, showRejected: !state.filters.showRejected },
    })),
  resetFilters: () =>
    set((state) => ({
      filters: {
        query: '',
        nodeTypes: new Set(NODE_TYPES),
        statuses: new Set(STATUSES),
        relations: state.graph ? relations(state.graph) : new Set(),
        clusterId: null,
        showRejected: false,
      },
    })),

  updateNode: (id, updates) =>
    set((state) => {
      if (!state.graph) return {};
      return markDirty(state, replaceNode(state.graph, id, updates));
    }),
  updateNodePosition: (id, position) =>
    set((state) => {
      if (!state.graph) return {};
      return markDirty(state, replaceNode(state.graph, id, { position }, false));
    }),
  updateEdge: (id, updates) =>
    set((state) => {
      if (!state.graph) return {};
      return markDirty(state, replaceEdge(state.graph, id, updates));
    }),
  setStatus: (kind, id, status) =>
    set((state) => {
      if (!state.graph) return {};
      const graph =
        kind === 'node'
          ? replaceNode(state.graph, id, { status })
          : replaceEdge(state.graph, id, { status });
      return markDirty(state, graph);
    }),
  replaceGraph: (graph) =>
    set((state) => ({
      ...markDirty(state, graph),
      selection: null,
      filters: { ...state.filters, relations: relations(graph) },
    })),

  save: () => {
    if (pendingSave) return pendingSave;
    pendingSave = (async () => {
      const { graph, baseRevision, mode } = get();
      if (!graph || !mode) throw new Error('No graph is loaded.');
      const result = await saveGraph(graph, baseRevision, mode);
      // Auto-save may finish after the user has made another edit. Keep that draft.
      if (get().graph !== graph) {
        const current = get().graph!;
        persistDraft(current, result.graph.meta.revision);
        set({ baseRevision: result.graph.meta.revision });
        return result.mode;
      }
      clearDraft();
      set({
        graph: result.graph,
        baseRevision: result.graph.meta.revision,
        dirty: false,
        draftAvailable: false,
      });
      return result.mode;
    })().finally(() => {
      pendingSave = null;
    });
    return pendingSave;
  },

  addToast: (message, tone = 'default') => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    window.setTimeout(() => get().removeToast(id), 4_500);
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
