import { readPreference, writePreference } from '../services/preferences';
import { AgentModelSettings } from './AgentModelSettings';
import { useAgentSettings } from '../store/agentSettings';
import { MarkdownNotes, MarkdownView } from './MarkdownNotes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Download,
  MessagesSquare,
  Plus,
  Send,
  Square,
  Table2,
  Trash2,
} from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { getBridgeHealth, type BridgeHealth } from '../services/agentBridge';
import {
  comparisonCsv,
  researchRequest,
  sessionMarkdown,
  type ResearchSession,
  type ResearchTurn,
  type ResearchCitation,
} from '../services/research';
import type { SelectedPassage } from '../services/documents';
import { downloadText } from '../services/exportMarkdown';
import { ResearchProposal } from './ResearchProposal';

const PRESETS = [
  'Input',
  'Architecture',
  'Training objective / loss',
  'Training data',
  'Evaluation',
  'Limitations',
  'Adaptation mechanism',
];

export function ResearchDesk({
  comparison,
  paperId,
  selectedPassage,
  onCitation,
  onDraftFlush,
  draftRequest,
}: {
  comparison: boolean;
  paperId?: string;
  selectedPassage?: SelectedPassage | null;
  onCitation?: (citation: ResearchCitation) => void;
  onDraftFlush?: (flush: () => Promise<void>) => void;
  draftRequest?: { text: string; nonce: number };
}) {
  const graph = useWorkspaceStore((s) => s.graph)!;
  const dirty = useWorkspaceStore((s) => s.dirty);
  const reload = useWorkspaceStore((s) => s.refresh);
  const researchScope = useWorkspaceStore((s) => s.researchScope);
  const nonce = useWorkspaceStore((s) => s.researchNonce);
  const researchSessionId = useWorkspaceStore((s) => s.researchSessionId);
  const addToast = useWorkspaceStore((s) => s.addToast);
  const select = useWorkspaceStore((s) => s.select);
  const setTab = useWorkspaceStore((s) => s.setTab);
  const openPaper = useWorkspaceStore((s) => s.openPaper);
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [current, setCurrent] = useState<ResearchSession | null>(null);
  const [scope, setScope] = useState<string[]>(paperId ? [paperId] : researchScope);
  const [criteria, setCriteria] = useState(PRESETS.slice(0, 4));
  const [custom, setCustom] = useState('');
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [agent, setAgent] = useState('');
  const { choice: settings } = useAgentSettings(
    agent,
    health?.agents.find((item) => item.id === agent),
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [archived, setArchived] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [noteDraft, setNoteDraft] = useState<{ turn: ResearchTurn; text: string } | null>(
    null,
  );
  const [noteTarget, setNoteTarget] = useState(researchScope[0] ?? '');
  const currentId = useRef<string | null>(null);
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const appliedDraftRequest = useRef<number>();
  const [draftReady, setDraftReady] = useState(!paperId);
  const [activeSelection, setActiveSelection] = useState<SelectedPassage | null>(null);
  const labels = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph]);
  const running = current?.turns.some((t) => t.status === 'running') ?? false;
  const candidates = graph.nodes.filter(
    (n) => n.status !== 'rejected' && (!comparison || n.type === 'paper'),
  );
  const matches = candidates.filter((n) =>
    `${n.label} ${n.paper?.authors.join(' ') ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  const refreshList = useCallback(async () => {
    const state = await researchRequest<{ sessions: ResearchSession[] }>();
    setSessions(state.sessions);
  }, []);
  const refreshCurrent = useCallback(async (id: string) => {
    const session = await researchRequest<ResearchSession>(`/${id}`);
    if (currentId.current === id) setCurrent(session);
    return session;
  }, []);
  useEffect(() => {
    if (currentId.current)
      void refreshCurrent(currentId.current).catch((e: Error) => setError(e.message));
  }, [graph.meta.revision, refreshCurrent]);

  useEffect(() => {
    void refreshList().catch((e) => setError(String(e.message)));
    void getBridgeHealth().then((value) => {
      setHealth(value);
      const stored = readPreference('orbis.agent');
      setAgent(
        value?.agents.find((a) => a.id === stored && a.available)?.id ??
          value?.default_agent ??
          '',
      );
    });
  }, [refreshList]);
  useEffect(() => {
    if (paperId) return;
    currentId.current = null;
    setCurrent(null);
    setScope(
      researchScope.filter(
        (id) => !comparison || graph.nodes.find((n) => n.id === id)?.type === 'paper',
      ),
    );
    setQuestion('');
    setError('');
    if (researchSessionId) {
      currentId.current = researchSessionId;
      void refreshCurrent(researchSessionId)
        .then((session) => {
          setScope(session.scope_ids);
          setNoteTarget(session.scope_ids[0] ?? '');
        })
        .catch((failure: Error) => setError(failure.message));
    }
    // Opening an inspector's Discuss action starts a fresh, explicitly scoped conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, paperId, researchSessionId]);
  useEffect(() => {
    if (!paperId) return;
    let stopped = false;
    setScope([paperId]);
    setNoteTarget(paperId);
    void (async () => {
      try {
        const [draft, list] = await Promise.all([
          researchRequest<{ question: string; selection: SelectedPassage | null }>(
            `/drafts?node_id=${encodeURIComponent(paperId)}`,
          ),
          researchRequest<{ sessions: ResearchSession[] }>(),
        ]);
        if (stopped) return;
        setQuestion(draft.question);
        setActiveSelection(draft.selection);
        setSessions(list.sessions);
        const previous = list.sessions.find(
          (session) =>
            !session.archived &&
            !session.criteria.length &&
            session.scope_ids[0] === paperId,
        );
        if (previous) {
          currentId.current = previous.id;
          const session = await refreshCurrent(previous.id);
          if (!stopped) setScope(session.scope_ids);
        }
        if (!stopped) setDraftReady(true);
      } catch (failure) {
        if (!stopped) setError((failure as Error).message);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [paperId, refreshCurrent]);
  useEffect(() => {
    if (!selectedPassage) return;
    setActiveSelection(selectedPassage);
    setQuestion((value) => value || 'Explain this selected passage.');
  }, [selectedPassage]);
  useEffect(() => {
    if (!draftRequest || !draftReady || appliedDraftRequest.current === draftRequest.nonce)
      return;
    appliedDraftRequest.current = draftRequest.nonce;
    setQuestion((previous) => {
      const next = previous.trim()
        ? `${previous}\n\n${draftRequest.text}`
        : draftRequest.text;
      if (next.length > 8000) {
        setError('Send or shorten your current draft before requesting a new summary.');
        return previous;
      }
      return next;
    });
  }, [draftRequest, draftReady]);
  const flushDraft = useCallback(async () => {
    if (!paperId || !draftReady) return;
    const selection = activeSelection
      ? {
          document_id: activeSelection.document_id,
          page: activeSelection.page,
          text: activeSelection.text,
        }
      : null;
    draftWrites.current = draftWrites.current
      .catch(() => {})
      .then(() =>
        researchRequest(`/drafts?node_id=${encodeURIComponent(paperId)}`, {
          question,
          selection,
        }),
      );
    await draftWrites.current;
  }, [activeSelection, draftReady, paperId, question]);
  useEffect(() => {
    onDraftFlush?.(flushDraft);
    if (!paperId || !draftReady) return;
    const timer = setTimeout(() => {
      void flushDraft().catch((failure: Error) =>
        setError(`Draft could not be saved: ${failure.message}`),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [draftReady, flushDraft, onDraftFlush, paperId]);
  useEffect(() => {
    if (!running || !current?.id) return;
    const id = current.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await refreshCurrent(id);
        if (!updated.turns.some((t) => t.status === 'running')) await refreshList();
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, current?.id, refreshCurrent, refreshList]);

  function newConversation() {
    currentId.current = null;
    setCurrent(null);
    setScope(paperId ? [paperId] : []);
    setQuestion('');
    setActiveSelection(null);
    setError('');
    setDeleteConfirm(false);
  }
  async function openSession(id: string) {
    currentId.current = id;
    setError('');
    setQuestion('');
    setDeleteConfirm(false);
    try {
      const session = await refreshCurrent(id);
      setScope(session.scope_ids);
      setNoteTarget(session.scope_ids[0] ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send() {
    setPending(true);
    setError('');
    try {
      let session = current;
      const message =
        question.trim() ||
        (comparison
          ? 'Compare these papers using the selected criteria. Explain important differences and evidence gaps.'
          : '');
      if (!message) throw new Error('Enter a question.');
      if (dirty) throw new Error('Save your graph edits before asking the agent.');
      if (!session) {
        session = await researchRequest<ResearchSession>('', {
          title: comparison
            ? `Comparison: ${scope
                .map((id) => labels.get(id))
                .join(' · ')
                .slice(0, 140)}`
            : message.slice(0, 80),
          scope_ids: scope,
          criteria: comparison ? criteria : [],
        });
        currentId.current = session.id;
        setCurrent(session);
        setNoteTarget(scope[0] ?? '');
        await refreshList();
      }
      await researchRequest(`/${session.id}/turns`, {
        question: message,
        agent,
        settings,
        base_revision: graph.meta.revision,
        ...(activeSelection
          ? {
              selection: {
                document_id: activeSelection.document_id,
                page: activeSelection.page,
                text: activeSelection.text,
              },
            }
          : {}),
      });
      setQuestion('');
      setActiveSelection(null);
      await refreshCurrent(session.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function decide(turn: ResearchTurn, action: string, text?: string) {
    if (!current) return false;
    setPending(true);
    setError('');
    try {
      if (dirty && action !== 'reject')
        throw new Error('Save your graph edits before applying an answer.');
      await researchRequest(`/${current.id}/decide/${turn.id}`, {
        action,
        ...(text === undefined ? {} : { text }),
        node_id: noteTarget,
        base_revision: graph.meta.revision,
      });
      await refreshCurrent(current.id);
      if (action !== 'reject') await reload();
      addToast(
        action === 'reject' ? 'Proposal rejected.' : 'Saved to your library.',
        'success',
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  async function manage(action: string) {
    if (!current) return;
    setPending(true);
    setError('');
    try {
      await researchRequest(`/${current.id}`, { action, archived: !current.archived });
      if (action === 'delete') newConversation();
      else await refreshCurrent(current.id);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  function exportSession(format: 'json' | 'md') {
    if (!current) return;
    downloadText(
      `orbis-${current.id}.${format}`,
      format === 'json'
        ? JSON.stringify(current, null, 2)
        : sessionMarkdown(current, labels),
      format === 'json' ? 'application/json' : 'text/markdown',
    );
  }
  function inspect(id: string) {
    select({ kind: 'node', id });
    setTab(null);
  }
  function cite(citation: ResearchCitation) {
    if (onCitation) onCitation(citation);
    else if (citation.document_id && citation.page)
      openPaper(citation.node_id, citation.document_id, citation.page);
    else inspect(citation.node_id);
  }

  return (
    <div className={`research-desk${paperId ? ' paper-discussion' : ''}`}>
      <aside className="conversation-list" aria-label="Saved conversations">
        <button className="button primary full" onClick={newConversation}>
          <Plus size={16} /> New {comparison ? 'comparison' : 'conversation'}
        </button>
        <label className="check-line">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{' '}
          Show archived
        </label>
        <div className="session-items">
          {sessions
            .filter(
              (s) =>
                s.archived === archived &&
                Boolean(s.criteria.length) === comparison &&
                (!paperId || s.scope_ids[0] === paperId),
            )
            .map((s) => (
              <button
                key={s.id}
                className={current?.id === s.id ? 'active' : ''}
                onClick={() => void openSession(s.id)}
              >
                <strong>{s.title}</strong>
                <small>
                  {s.turn_count ?? s.turns.length} turns · {s.created_at.slice(0, 10)}
                  {s.running ? ' · running' : ''}
                </small>
              </button>
            ))}
        </div>
        <p className="research-caption">
          Stored in this workspace. Export before deleting. Archived conversations remain
          available.
        </p>
      </aside>
      <section className="research-content">
        <header className="research-heading">
          <div>
            <span className="eyebrow">Your research workspace</span>
            <h1>
              {comparison ? <Table2 size={25} /> : <MessagesSquare size={25} />}
              {current?.title ??
                (comparison
                  ? 'Compare papers'
                  : paperId
                    ? 'Discuss this paper'
                    : 'Discuss your library')}
            </h1>
          </div>
          {current && (
            <div className="research-actions">
              <button className="button secondary" onClick={() => exportSession('md')}>
                <Download size={14} /> Markdown
              </button>
              <button className="button secondary" onClick={() => exportSession('json')}>
                JSON
              </button>
              <button
                className="button secondary"
                disabled={running || pending}
                onClick={() => void manage('archive')}
              >
                <Archive size={14} />
                {current.archived ? 'Restore' : 'Archive'}
              </button>
              <button
                className="button secondary"
                disabled={running || pending}
                onClick={() => setDeleteConfirm(!deleteConfirm)}
                aria-label="Delete conversation"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </header>
        {deleteConfirm && (
          <div className="research-warning">
            Delete this conversation and its saved comparisons? Notes and accepted graph
            changes stay in your library. Export first to keep a copy.{' '}
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => void manage('delete')}
            >
              Delete permanently
            </button>
            <button className="button secondary" onClick={() => setDeleteConfirm(false)}>
              Keep conversation
            </button>
          </div>
        )}
        {!current ? (
          <div className="research-setup">
            <p>
              {comparison
                ? 'Choose 2–20 papers and the questions that matter to your research. Each cell keeps its evidence.'
                : 'Ask about a paper, a method, a cluster, or the relationships across your library. Graph edits always come back for review.'}
            </p>
            <div className="scope-chips">
              {scope.map((id) => (
                <button
                  key={id}
                  disabled={id === paperId}
                  onClick={() => setScope(scope.filter((s) => s !== id))}
                >
                  {labels.get(id) ?? id}
                  {id === paperId ? ' · selected paper' : ' ×'}
                </button>
              ))}
            </div>
            <details className="research-context-picker" open={!paperId}>
              <summary>
                {paperId ? 'Add other library context' : 'Choose library context'}
              </summary>
              <label className="field-label">
                {comparison ? 'Find papers to compare' : 'Choose context'}
                <input
                  type="search"
                  placeholder="Search your library"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="scope-picker" aria-label="Context records">
                {matches.slice(0, 150).map((n) => (
                  <label key={n.id}>
                    <input
                      type="checkbox"
                      checked={scope.includes(n.id)}
                      disabled={
                        n.id === paperId || (!scope.includes(n.id) && scope.length >= 20)
                      }
                      onChange={(e) =>
                        setScope(
                          e.target.checked
                            ? [...scope, n.id]
                            : scope.filter((id) => id !== n.id),
                        )
                      }
                    />
                    <span>
                      <strong>{n.label}</strong>
                      <small>
                        {n.type}
                        {n.paper ? ` · ${n.paper.year ?? 'Undated'}` : ''}
                      </small>
                    </span>
                  </label>
                ))}
                {!matches.length && (
                  <p>No matching records. Add a paper to start your library.</p>
                )}
                {matches.length > 150 && (
                  <p>Search to narrow down {matches.length} records.</p>
                )}
              </div>
            </details>
            {comparison && (
              <section className="criteria-picker">
                <h2>Comparison criteria</h2>
                <div className="criteria-options">
                  {Array.from(new Set([...PRESETS, ...criteria])).map((c) => (
                    <label key={c}>
                      <input
                        type="checkbox"
                        checked={criteria.includes(c)}
                        onChange={(e) =>
                          setCriteria(
                            e.target.checked
                              ? [...criteria, c]
                              : criteria.filter((v) => v !== c),
                          )
                        }
                      />
                      {c}
                    </label>
                  ))}
                </div>
                <div className="custom-criterion">
                  <input
                    aria-label="Custom comparison criterion"
                    placeholder="Custom criterion, e.g. deployment compute"
                    value={custom}
                    maxLength={80}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={!custom.trim() || criteria.length >= 12}
                    onClick={() => {
                      const c = custom.trim();
                      if (!criteria.some((v) => v.toLowerCase() === c.toLowerCase()))
                        setCriteria([...criteria, c]);
                      setCustom('');
                    }}
                  >
                    Add criterion
                  </button>
                </div>
              </section>
            )}
          </div>
        ) : (
          <>
            <div className="scope-chips">
              {current.scope_ids.map((id) => (
                <button key={id} onClick={() => inspect(id)}>
                  {labels.get(id) ?? id}
                </button>
              ))}
              {!current.scope_ids.length && <span>Library overview</span>}
            </div>
            {current.criteria.length > 0 && (
              <p className="research-caption">Criteria: {current.criteria.join(' · ')}</p>
            )}
            <div className="research-turns" aria-live="polite">
              {current.turns.map((turn) => (
                <article className="research-turn" key={turn.id}>
                  <div className="research-question">
                    <span>You</span>
                    <p>{turn.question}</p>
                  </div>
                  <div className="research-answer">
                    <div className="answer-meta">
                      <strong>{turn.agent === 'codex' ? 'Codex' : 'Claude Code'}</strong>
                      {turn.settings && (
                        <span>
                          {turn.settings.model || 'CLI model'} ·{' '}
                          {turn.settings.effort || 'CLI effort'}
                        </span>
                      )}
                      <span>
                        {turn.status}
                        {turn.duration_s !== undefined ? ` · ${turn.duration_s}s` : ''}
                        {turn.cost_usd != null ? ` · $${turn.cost_usd.toFixed(3)}` : ''}
                      </span>
                    </div>
                    {turn.status === 'running' && (
                      <div className="running-answer">
                        <span className="loading-dot" />{' '}
                        {turn.phase === 'retrieving'
                          ? 'Retrieving source passages…'
                          : 'Preparing your answer…'}{' '}
                        You can leave this view and come back.
                        <button
                          className="button secondary"
                          onClick={() =>
                            void researchRequest(`/${current.id}/cancel/${turn.id}`, {})
                              .then(() => refreshCurrent(current.id))
                              .catch((e) => setError(e.message))
                          }
                        >
                          <Square size={12} /> Stop
                        </button>
                      </div>
                    )}
                    {turn.error && (
                      <div className="research-warning">
                        <p>{turn.error}</p>
                        <button
                          className="button secondary"
                          disabled={pending || running}
                          onClick={() => {
                            setQuestion(turn.question);
                            setActiveSelection(turn.selection ?? null);
                          }}
                        >
                          Retry this question
                        </button>
                      </div>
                    )}
                    {turn.result && (
                      <>
                        <p
                          className={`source-mode source-mode-${turn.result.source_mode ?? 'notes_only'}`}
                        >
                          {turn.result.source_mode === 'originals'
                            ? 'Original-source excerpts'
                            : turn.result.source_mode === 'mixed'
                              ? 'Original excerpts and library notes'
                              : 'Notes-only answer · verify against the original'}
                        </p>
                        <MarkdownView text={turn.result.answer} />
                        {turn.result.quality_warnings?.map((warning) => (
                          <p className="research-warning" key={warning}>
                            {warning}
                          </p>
                        ))}
                        {turn.result.cells.length > 0 && (
                          <>
                            <div className="comparison-scroll">
                              <table className="comparison-table">
                                <caption>
                                  Library-grounded comparison · {current.scope_ids.length}{' '}
                                  papers
                                </caption>
                                <thead>
                                  <tr>
                                    <th scope="col">Paper</th>
                                    {current.criteria.map((c) => (
                                      <th scope="col" key={c}>
                                        {c}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {current.scope_ids.map((id) => (
                                    <tr key={id}>
                                      <th scope="row">
                                        <button onClick={() => inspect(id)}>
                                          {labels.get(id) ?? id}
                                        </button>
                                      </th>
                                      {current.criteria.map((criterion) => {
                                        const cell = turn.result!.cells.find(
                                          (c) =>
                                            c.paper_id === id && c.criterion === criterion,
                                        );
                                        return (
                                          <td key={criterion}>
                                            <p>{cell?.value ?? 'Not established'}</p>
                                            <details>
                                              <summary>Evidence</summary>
                                              <p>{cell?.evidence}</p>
                                              {cell && (
                                                <button
                                                  onClick={() =>
                                                    cite({
                                                      ...cell,
                                                      node_id: cell.paper_id,
                                                    })
                                                  }
                                                >
                                                  {cell.page
                                                    ? `Open page ${cell.page} · ${cell.section}`
                                                    : 'Library notes · verify against original'}
                                                </button>
                                              )}
                                            </details>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <button
                              className="button secondary"
                              onClick={() =>
                                downloadText(
                                  `comparison-${turn.id}.csv`,
                                  comparisonCsv(current, turn, labels),
                                  'text/csv',
                                )
                              }
                            >
                              Export table CSV
                            </button>
                          </>
                        )}
                        <details className="research-sources">
                          <summary>
                            Sources and context ({turn.result.citations.length})
                          </summary>
                          {turn.result.citations.map((c, i) => (
                            <p key={i}>
                              <button onClick={() => cite(c)}>
                                {labels.get(c.node_id) ?? c.node_id}
                                {c.page
                                  ? ` · page ${c.page} · ${c.section}`
                                  : ' · library notes'}
                              </button>{' '}
                              — {c.evidence}
                            </p>
                          ))}
                          <p className="research-caption">
                            {turn.coverage.records_included} library records; up to{' '}
                            {turn.coverage.note_character_limit.toLocaleString()} characters
                            per source note; {turn.coverage.history_turns} previous answers.{' '}
                            {turn.coverage.records_omitted > 0
                              ? `${turn.coverage.records_omitted} records omitted; narrow the scope for details.`
                              : ''}{' '}
                            {turn.coverage.original_passages ?? 0} original-source passages.
                            Citation anchors and quotes are checked; answer meaning still
                            needs your judgment.
                          </p>
                        </details>
                        {(turn.preview?.length ?? 0) > 0 && (
                          <section className="proposal-bundle">
                            <h3>
                              Proposed library changes{' '}
                              <span className="status-pill">{turn.proposal_status}</span>
                            </h3>
                            {turn.preview!.map((p, i) => (
                              <ResearchProposal key={i} preview={p} labels={labels} />
                            ))}
                            {turn.proposal_status === 'pending' && (
                              <div className="research-actions">
                                <button
                                  className="button primary"
                                  disabled={
                                    pending ||
                                    running ||
                                    dirty ||
                                    (turn.proposal_stale ?? !turn.base_fingerprint)
                                  }
                                  onClick={() => void decide(turn, 'apply')}
                                >
                                  Accept all {turn.preview!.length} changes
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={pending}
                                  onClick={() => void decide(turn, 'reject')}
                                >
                                  Reject changes
                                </button>
                                {(turn.proposal_stale ?? !turn.base_fingerprint) && (
                                  <p>
                                    Graph changed. Ask for a fresh proposal before
                                    accepting.
                                  </p>
                                )}
                              </div>
                            )}
                          </section>
                        )}
                        {noteDraft?.turn.id === turn.id && (
                          <div className="note-save-preview">
                            <MarkdownNotes
                              value={noteDraft.text}
                              onChange={(text) => setNoteDraft({ ...noteDraft, text })}
                              label="Edit note before saving"
                            />
                            <p>
                              Only this text is added. The conversation and citations remain
                              in research history.
                            </p>
                            <button
                              className="button primary"
                              disabled={
                                pending || dirty || !noteTarget || !noteDraft.text.trim()
                              }
                              onClick={async () => {
                                if (await decide(turn, 'save_note', noteDraft.text))
                                  setNoteDraft(null);
                              }}
                            >
                              Save edited note
                            </button>
                            <button
                              className="button secondary"
                              onClick={() => setNoteDraft(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        <div className="save-answer">
                          <label>
                            Save answer to notes
                            <select
                              aria-label="Note destination"
                              value={noteTarget}
                              onChange={(e) => setNoteTarget(e.target.value)}
                            >
                              <option value="">Choose a record</option>
                              {graph.nodes
                                .filter((n) => n.status !== 'rejected')
                                .map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {n.label}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button
                            className="button secondary"
                            disabled={
                              !noteTarget ||
                              pending ||
                              running ||
                              dirty ||
                              turn.saved_note_ids?.includes(noteTarget)
                            }
                            onClick={() =>
                              setNoteDraft({ turn, text: turn.result!.answer })
                            }
                          >
                            {turn.saved_note_ids?.includes(noteTarget)
                              ? 'Saved'
                              : 'Review answer as note'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="research-warning">
            {error}
          </div>
        )}
        {dirty && (
          <p className="research-warning">
            You have unsaved graph edits. Save them with the header button before running
            research or applying changes.
          </p>
        )}
        <section className="research-composer">
          {activeSelection && (
            <div className="selected-passage">
              <strong>Selected text · page {activeSelection.page}</strong>
              <p>{activeSelection.text}</p>
              <button className="button secondary" onClick={() => setActiveSelection(null)}>
                Clear selection
              </button>
            </div>
          )}
          <label className="field-label">
            {comparison ? 'Comparison instructions or follow-up' : 'Your question'}
            <textarea
              rows={3}
              maxLength={8000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={
                comparison
                  ? 'Focus on how the training objectives differ…'
                  : 'What is the key idea? How does this connect to my library? Rename this cluster…'
              }
            />
          </label>
          <AgentModelSettings
            key={agent}
            agent={health?.agents.find((a) => a.id === agent)}
            disabled={pending || running}
          />
          <div className="composer-footer">
            <label>
              Agent{' '}
              <select
                aria-label="Research agent"
                value={agent}
                disabled={pending || running}
                onChange={(e) => {
                  setAgent(e.target.value);
                  writePreference('orbis.agent', e.target.value);
                }}
              >
                {!agent && <option value="">Choose an agent</option>}
                {health?.agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.available}>
                    {a.label}
                    {a.available ? '' : ' (not installed)'}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              disabled={
                pending ||
                running ||
                dirty ||
                !agent ||
                current?.archived ||
                (!current &&
                  comparison &&
                  (scope.length < 2 || !criteria.length || criteria.length > 12)) ||
                (!comparison && !question.trim())
              }
              onClick={() => void send()}
            >
              <Send size={15} />
              {pending
                ? 'Starting…'
                : running
                  ? 'Working…'
                  : comparison && !current
                    ? 'Build comparison'
                    : 'Ask agent'}
            </button>
          </div>
          <p className="research-caption">
            Your selected library context is sent through this CLI's configured provider.
            One run at a time · 10-minute limit · conversations are saved in your library.{' '}
            {current?.archived ? 'Restore this conversation to continue.' : ''}
            {!health?.agents.some((a) => a.available)
              ? ' Install and sign in to Codex or Claude Code, then restart the server.'
              : ''}
          </p>
        </section>
      </section>
    </div>
  );
}
