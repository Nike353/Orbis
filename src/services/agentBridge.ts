export interface LocalAgent {
  id: 'claude' | 'codex';
  label: string;
  available: boolean;
}

export interface BridgeHealth {
  ok: boolean;
  agents: LocalAgent[];
  default_agent: LocalAgent['id'] | null;
  busy: boolean;
  active_record?: string | null;
  active_agent?: LocalAgent['id'] | null;
  graph_revision?: number;
}

export type AgentEvent =
  | { type: 'start'; url: string; arxiv_id?: string }
  | {
      type: 'event';
      kind: 'tool' | 'text' | 'status';
      name?: string;
      detail?: string;
      text?: string;
    }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      ok: boolean;
      outcome: 'inserted' | 'excluded' | 'duplicate';
      reason: string;
      summary: string;
      graph_node_id: string | null;
      duration_s: number | null;
      cost_usd: number | null;
    };

export async function getBridgeHealth(): Promise<BridgeHealth | null> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    return response.ok ? ((await response.json()) as BridgeHealth) : null;
  } catch {
    return null;
  }
}

export async function runAgentInsertion(
  agent: LocalAgent['id'],
  url: string,
  hint: string,
  batchId: string | null,
  arxivId: string | null,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
  sourceKind: 'paper' | 'blog' | 'website' = 'paper',
) {
  const response = await fetch('/api/insert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent,
      url,
      hint,
      source_kind: sourceKind,
      ...(batchId && arxivId ? { batch_id: batchId, arxiv_id: arxivId } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `Agent bridge returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Streaming is unavailable in this browser.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as AgentEvent;
      if (event.type === 'done' || event.type === 'error') terminal = true;
      onEvent(event);
    }
  }

  if (!terminal && !signal.aborted) {
    throw new Error('The agent bridge closed before reporting a result.');
  }
}

export async function cancelAgentInsertion() {
  const response = await fetch('/api/insert', { method: 'DELETE' });
  if (!response.ok && response.status !== 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Cancellation returned HTTP ${response.status}`);
  }
}
