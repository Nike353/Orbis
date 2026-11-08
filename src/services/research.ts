import type { AgentSettings } from './agentBridge';
import type { GraphNode, GraphEdge } from '../domain/schema';
import type { SelectedPassage } from './documents';

export interface ResearchResult {
  answer: string;
  citations: ResearchCitation[];
  source_mode?: 'originals' | 'mixed' | 'notes_only';
  quality_warnings?: string[];
  changes: Record<string, unknown>[];
  cells: (Omit<ResearchCitation, 'node_id'> & {
    paper_id: string;
    criterion: string;
    value: string;
    source_mode?: 'originals' | 'notes_only';
  })[];
}
export interface ResearchCitation {
  node_id: string;
  evidence: string;
  passage_id?: string;
  document_id?: string;
  sha256?: string;
  page?: number;
  section?: string;
  source_url?: string;
}
export interface ResearchTurn {
  id: string;
  question: string;
  agent: string;
  settings?: AgentSettings;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  phase?: string;
  selection?: SelectedPassage;
  created_at: string;
  base_revision: number;
  base_fingerprint?: string;
  proposal_stale?: boolean;
  duration_s?: number;
  cost_usd?: number | null;
  error?: string;
  result?: ResearchResult;
  proposal_status?: 'pending' | 'applied' | 'rejected' | 'none';
  saved_note_ids?: string[];
  coverage: {
    records_included: number;
    records_omitted: number;
    history_turns: number;
    note_character_limit: number;
    original_passages?: number;
    original_sources?: {
      node_id: string;
      document_id?: string;
      status?: string;
      text_status?: string;
      extraction_error?: string;
    }[];
  };
  preview?: {
    action: string;
    reason: string;
    before: GraphNode | GraphEdge | null;
    after: GraphNode | GraphEdge;
  }[];
}
export interface ResearchSession {
  id: string;
  title: string;
  scope_ids: string[];
  criteria: string[];
  created_at: string;
  archived: boolean;
  turns: ResearchTurn[];
  turn_count?: number;
  running?: boolean;
}
export async function researchRequest<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/research${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result as T;
}

const escapeCell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
export function sessionMarkdown(
  session: ResearchSession,
  labels: Map<string, string>,
): string {
  const name = (id: string) => labels.get(id) ?? id;
  const lines = [
    `# ${session.title}`,
    '',
    `Scope: ${session.scope_ids.map(name).join(', ') || 'Library'}`,
    '',
  ];
  for (const turn of session.turns) {
    lines.push(
      `## ${turn.question}`,
      '',
      `${turn.agent}${turn.settings ? ` · ${turn.settings.model || 'CLI model'} / ${turn.settings.effort || 'CLI effort'}` : ''} · ${turn.created_at} · ${turn.status}`,
      '',
    );
    if (!turn.result) {
      lines.push(turn.error ?? 'Answer in progress', '');
      continue;
    }
    lines.push(turn.result.answer, '');
    if (session.criteria.length) {
      lines.push(
        `| Paper | ${session.criteria.map(escapeCell).join(' | ')} |`,
        `| --- | ${session.criteria.map(() => '---').join(' | ')} |`,
      );
      for (const id of session.scope_ids) {
        lines.push(
          `| ${escapeCell(name(id))} | ${session.criteria
            .map((criterion) => {
              const cell = turn.result!.cells.find(
                (c) => c.paper_id === id && c.criterion === criterion,
              );
              return cell
                ? escapeCell(
                    `${cell.value} [${cell.page ? `Page ${cell.page} (${cell.section})` : 'Library notes'}: ${cell.evidence}]`,
                  )
                : 'Not established';
            })
            .join(' | ')} |`,
        );
      }
      lines.push('');
    }
    for (const c of turn.result.citations)
      lines.push(
        `- ${name(c.node_id)}${c.page ? ` · page ${c.page} (${c.section})` : ' · library notes'}: ${c.evidence}`,
      );
    if (turn.preview?.length)
      lines.push(
        '',
        `Graph proposals: ${turn.proposal_status}`,
        ...turn.preview.map((p) => `- ${p.action}: ${p.after.id} — ${p.reason}`),
      );
    lines.push('');
  }
  return lines.join('\n');
}

export function comparisonCsv(
  session: ResearchSession,
  turn: ResearchTurn,
  labels: Map<string, string>,
) {
  // Prevent formula execution when opened in spreadsheet applications.
  const cell = (value: string) =>
    `"${(/^[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  const rows = [['Paper', ...session.criteria.flatMap((c) => [c, `${c} — evidence`])]];
  for (const id of session.scope_ids)
    rows.push([
      labels.get(id) ?? id,
      ...session.criteria.flatMap((criterion) => {
        const c = turn.result?.cells.find(
          (v) => v.paper_id === id && v.criterion === criterion,
        );
        return [
          c?.value ?? 'Not established',
          c
            ? `${c.page ? `Page ${c.page} (${c.section})` : 'Library notes'}: ${c.evidence}`
            : '',
        ];
      }),
    ]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
