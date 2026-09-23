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
} from '../services/research';
import { downloadText } from '../services/exportMarkdown';

const PRESETS = [
  'Input',
  'Architecture',
  'Training objective / loss',
  'Training data',
  'Evaluation',
  'Limitations',
  'Adaptation mechanism',
];

export function ResearchDesk({ comparison }: { comparison: boolean }) {
  const graph = useWorkspaceStore((s) => s.graph)!;
  const dirty = useWorkspaceStore((s) => s.dirty);
  const reload = useWorkspaceStore((s) => s.refresh);
  const researchScope = useWorkspaceStore((s) => s.researchScope);
  const nonce = useWorkspaceStore((s) => s.researchNonce);
  const addToast = useWorkspaceStore((s) => s.addToast);
  const select = useWorkspaceStore((s) => s.select);
  const setTab = useWorkspaceStore((s) => s.setTab);
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [current, setCurrent] = useState<ResearchSession | null>(null);
  const [scope, setScope] = useState<string[]>(researchScope);
  const [criteria, setCriteria] = useState(PRESETS.slice(0, 4));
  const [custom, setCustom] = useState('');
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [agent, setAgent] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [archived, setArchived] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [noteDraft, setNoteDraft] = useState<{ turn: ResearchTurn; text: string } | null>(
    null,
  );
  const [noteTarget, setNoteTarget] = useState(researchScope[0] ?? '');
  const currentId = useRef<string | null>(null);
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
    void refreshList().catch((e) => setError(String(e.message)));
    void getBridgeHealth().then((value) => {
      setHealth(value);
      setAgent(value?.default_agent ?? '');
    });
  }, [refreshList]);
  useEffect(() => {
    currentId.current = null;
    setCurrent(null);
    setScope(
      researchScope.filter(
        (id) => !comparison || graph.nodes.find((n) => n.id === id)?.type === 'paper',
      ),
    );
    setQuestion('');
    setError('');
    // Opening an inspector's Discuss action starts a fresh, explicitly scoped conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
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
    setScope([]);
    setQuestion('');
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
        base_revision: graph.meta.revision,
      });
      setQuestion('');
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
      `litbench-${current.id}.${format}`,
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

  return (
    <div className="research-desk">
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
              (s) => s.archived === archived && Boolean(s.criteria.length) === comparison,
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
              {current?.title ?? (comparison ? 'Compare papers' : 'Discuss your library')}
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
            <label className="field-label">
              {comparison ? 'Find papers to compare' : 'Choose context'}
              <input
                type="search"
                placeholder="Search your library"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="scope-chips">
              {scope.map((id) => (
                <button key={id} onClick={() => setScope(scope.filter((s) => s !== id))}>
                  {labels.get(id) ?? id} ×
                </button>
              ))}
            </div>
            <div className="scope-picker" aria-label="Context records">
              {matches.slice(0, 150).map((n) => (
                <label key={n.id}>
                  <input
                    type="checkbox"
                    checked={scope.includes(n.id)}
                    disabled={!scope.includes(n.id) && scope.length >= 20}
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
                      <span>
                        {turn.status}
                        {turn.duration_s !== undefined ? ` · ${turn.duration_s}s` : ''}
                        {turn.cost_usd != null ? ` · $${turn.cost_usd.toFixed(3)}` : ''}
                      </span>
                    </div>
                    {turn.status === 'running' && (
                      <div className="running-answer">
                        <span className="loading-dot" /> Reading your library context… You
                        can leave this view and come back.
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
                    {turn.error && <p className="research-warning">{turn.error}</p>}
                    {turn.result && (
                      <>
                        <MarkdownView text={turn.result.answer} />
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
                              <button onClick={() => inspect(c.node_id)}>
                                {labels.get(c.node_id) ?? c.node_id}
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
                            Answers use your stored library context, without a new full-text
                            retrieval.
                          </p>
                        </details>
                        {(turn.preview?.length ?? 0) > 0 && (
                          <section className="proposal-bundle">
                            <h3>
                              Proposed library changes{' '}
                              <span className="status-pill">{turn.proposal_status}</span>
                            </h3>
                            {turn.preview!.map((p, i) => (
                              <div className="change-preview" key={i}>
                                <strong>
                                  {p.action} ·{' '}
                                  {'label' in p.after ? p.after.label : p.after.relation}
                                </strong>
                                <p>{p.reason}</p>
                                <details>
                                  <summary>Before and after</summary>
                                  <div className="change-diff">
                                    <pre>
                                      {p.before
                                        ? JSON.stringify(p.before, null, 2)
                                        : 'New record'}
                                    </pre>
                                    <pre>{JSON.stringify(p.after, null, 2)}</pre>
                                  </div>
                                </details>
                              </div>
                            ))}
                            {turn.proposal_status === 'pending' && (
                              <div className="research-actions">
                                <button
                                  className="button primary"
                                  disabled={
                                    pending ||
                                    running ||
                                    dirty ||
                                    turn.base_revision !== graph.meta.revision
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
                                {turn.base_revision !== graph.meta.revision && (
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
          <div className="composer-footer">
            <label>
              Agent{' '}
              <select
                aria-label="Research agent"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
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
            One run at a time · 10-minute limit · conversations stay local.{' '}
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
