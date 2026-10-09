import { migrateAndValidateGraph, type GraphData } from '../domain/schema';
import { serializeForSave } from '../domain/graph';
import { readPreference, removePreference } from './preferences';

const DRAFT_KEY = 'orbis:v2:draft';
let draftKey = DRAFT_KEY;
const API_TIMEOUT_MS = 1_800;

export type LoadMode = 'api' | 'http' | 'snapshot';
export type SaveMode = 'api' | 'picker' | 'download';

export interface LoadResult {
  graph: GraphData;
  baseRevision: number;
  mode: LoadMode;
  migratedFrom: number | null;
  draftAvailable: boolean;
}

interface StoredDraft {
  baseRevision: number;
  graph: GraphData;
}

export class RevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`The graph changed on disk (revision ${currentRevision}). Reload before saving.`);
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: init?.signal ?? controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function readDraft(): StoredDraft | null {
  try {
    const raw = readPreference(draftKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    const { graph } = migrateAndValidateGraph(parsed.graph);
    return { baseRevision: parsed.baseRevision, graph };
  } catch {
    removePreference(draftKey);
    return null;
  }
}

async function loadRawGraph(): Promise<{ raw: unknown; mode: LoadMode }> {
  try {
    const response = await fetchWithTimeout('/api/graph', { cache: 'no-store' });
    if (response.ok) {
      const workspace =
        response.headers.get('X-Orbis-Workspace') ??
        response.headers.get('X-LitBench-Workspace');
      draftKey = workspace ? `${DRAFT_KEY}:${workspace}` : DRAFT_KEY;
      return { raw: await response.json(), mode: 'api' };
    }
  } catch {
    // The optional local API is not running; continue to static storage.
  }

  draftKey = DRAFT_KEY;

  try {
    const response = await fetch('/data/graph.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { raw: await response.json(), mode: 'http' };
  } catch {
    const snapshot = window.ORBIS_DATA ?? window.LITBENCH_DATA;
    if (snapshot) {
      return { raw: snapshot, mode: 'snapshot' };
    }
    throw new Error(
      'Could not load the research graph. Start the local server or regenerate data/graph.js.',
    );
  }
}

export async function loadGraph(): Promise<LoadResult> {
  const { raw, mode } = await loadRawGraph();
  const { graph, migratedFrom } = migrateAndValidateGraph(raw);
  const draft = readDraft();
  return {
    graph,
    baseRevision: graph.meta.revision,
    mode,
    migratedFrom,
    draftAvailable: Boolean(draft && draft.baseRevision === graph.meta.revision),
  };
}

export function restoreDraft(baseRevision: number): GraphData | null {
  const draft = readDraft();
  return draft?.baseRevision === baseRevision ? draft.graph : null;
}

export function persistDraft(graph: GraphData, baseRevision: number) {
  try {
    localStorage.setItem(draftKey, JSON.stringify({ graph, baseRevision }));
  } catch {
    // Draft persistence is best-effort in private browsing or low-storage environments.
  }
}

export function clearDraft() {
  try {
    removePreference(draftKey);
  } catch {
    // No-op when storage is unavailable.
  }
}

async function saveThroughApi(graph: GraphData, baseRevision: number): Promise<GraphData> {
  const nextGraph = serializeForSave(graph, baseRevision);
  const response = await fetch('/api/graph', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: baseRevision, graph: nextGraph }),
  });

  if (response.status === 409) {
    const conflict = (await response.json()) as { current_revision?: number };
    throw new RevisionConflictError(conflict.current_revision ?? baseRevision + 1);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Save failed with HTTP ${response.status}`);
  }
  return migrateAndValidateGraph(await response.json()).graph;
}

async function saveThroughPicker(graph: GraphData, baseRevision: number) {
  const nextGraph = serializeForSave(graph, baseRevision);
  const payload = JSON.stringify(nextGraph, null, 2) + '\n';
  const picker = window as Window & {
    showSaveFilePicker?: (options: object) => Promise<{
      createWritable: () => Promise<{
        write: (value: string) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };

  if (picker.showSaveFilePicker && window.isSecureContext) {
    const handle = await picker.showSaveFilePicker({
      suggestedName: 'graph.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(payload);
    await writable.close();
    return { graph: nextGraph, mode: 'picker' as const };
  }

  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'graph.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { graph: nextGraph, mode: 'download' as const };
}

export async function saveGraph(
  graph: GraphData,
  baseRevision: number,
  mode: LoadMode,
): Promise<{ graph: GraphData; mode: SaveMode }> {
  if (mode === 'api') {
    return { graph: await saveThroughApi(graph, baseRevision), mode: 'api' };
  }
  return saveThroughPicker(graph, baseRevision);
}

export async function loadGraphFile(file: File): Promise<GraphData> {
  if (file.size > 20 * 1024 * 1024) throw new Error('Graph file exceeds the 20 MB limit.');
  return migrateAndValidateGraph(JSON.parse(await file.text())).graph;
}
