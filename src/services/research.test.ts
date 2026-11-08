import { describe, expect, it } from 'vitest';
import {
  comparisonCsv,
  sessionMarkdown,
  type ResearchSession,
  type ResearchTurn,
} from './research';

const turn: ResearchTurn = {
  id: 'turn',
  question: 'Compare',
  agent: 'codex',
  status: 'completed',
  created_at: '2026-01-01',
  base_revision: 0,
  coverage: {
    records_included: 2,
    records_omitted: 0,
    history_turns: 0,
    note_character_limit: 10000,
  },
  result: {
    answer: 'An evidence-backed answer',
    citations: [{ node_id: 'paper:a', evidence: 'Source note' }],
    changes: [],
    cells: [
      {
        paper_id: 'paper:a',
        criterion: 'Input',
        value: '=1+1',
        evidence: 'Quoted "evidence" | detail\nnext line',
      },
    ],
  },
};
const session: ResearchSession = {
  id: 'session',
  title: 'Comparison',
  scope_ids: ['paper:a', 'paper:b'],
  criteria: ['Input'],
  created_at: '2026-01-01',
  archived: false,
  turns: [turn],
};
const labels = new Map([
  ['paper:a', 'A'],
  ['paper:b', 'B'],
]);

describe('research exports', () => {
  it('exports evidence, escapes CSV quotes, blocks spreadsheet formulas, and records missing cells', () => {
    const csv = comparisonCsv(session, turn, labels);
    expect(csv).toContain('"Input — evidence"');
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('""evidence""');
    expect(csv).toContain('"B","Not established",""');
  });
  it('keeps scope, citations, table evidence, and escaped pipes in Markdown', () => {
    const md = sessionMarkdown(session, labels);
    expect(md).toContain('Scope: A, B');
    expect(md).toContain('Library notes: Quoted "evidence" \\| detail<br>next line');
    expect(md).toContain('- A · library notes: Source note');
    expect(md).toContain('| B | Not established |');
  });
  it('retains page and section anchors when exporting original-source answers', () => {
    const original = structuredClone(session);
    original.turns[0].result!.citations[0].page = 3;
    original.turns[0].result!.citations[0].section = 'Results';
    original.turns[0].result!.cells[0].page = 3;
    original.turns[0].result!.cells[0].section = 'Results';
    expect(sessionMarkdown(original, labels)).toContain('page 3 (Results)');
    expect(comparisonCsv(original, original.turns[0], labels)).toContain(
      'Page 3 (Results)',
    );
  });
});
