import { readPreference, writePreference } from '../services/preferences';
import { AgentModelSettings } from './AgentModelSettings';
import { useAgentSettings } from '../store/agentSettings';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, CheckCircle2, Circle, CircleStop, LoaderCircle, Plus, X } from 'lucide-react';
import {
  cancelAgentInsertion,
  getBridgeHealth,
  runAgentInsertion,
  type AgentEvent,
  type BridgeHealth,
  type LocalAgent,
} from '../services/agentBridge';
import { useWorkspaceStore } from '../store/workspaceStore';

function eventText(event: AgentEvent) {
  if (event.type === 'start') return 'Agent session started';
  if (event.type === 'error') return event.message;
  if (event.type === 'done') {
    if (event.outcome === 'inserted') return 'Proposal validated and added';
    if (event.outcome === 'duplicate') return 'Paper already exists';
    return `Paper excluded: ${event.reason}`;
  }
  if (event.kind === 'tool') {
    const name = (event.name ?? '').toLowerCase();
    if (/fetch|search|open.page/.test(name)) return 'Retrieving and reading the full text…';
    if (/rebuild|validat/.test(name)) return 'Checking the summary and graph changes…';
    if (/write|edit/.test(name)) return 'Preparing the summary and proposed connections…';
    if (/read|list/.test(name)) return 'Reviewing the source and your library…';
    return `${event.name ?? 'Tool'}${event.detail ? ` | ${event.detail}` : ''}`;
  }
  return event.text ?? 'Working';
}

function chooseAgent(
  health: BridgeHealth,
  current: LocalAgent['id'] | '',
): LocalAgent['id'] | '' {
  if (health.agents.some((agent) => agent.id === current && agent.available)) {
    return current;
  }
  const stored = readPreference('orbis.agent');
  return (
    health.agents.find((agent) => agent.available && agent.id === stored)?.id ??
    health.agents.find((agent) => agent.available && agent.id === health.default_agent)
      ?.id ??
    health.agents.find((agent) => agent.available)?.id ??
    ''
  );
}

export function AddPaperDialog() {
  const open = useWorkspaceStore((state) => state.addPaperOpen);
  const setOpen = useWorkspaceStore((state) => state.setAddPaperOpen);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const reloadGraph = useWorkspaceStore((state) => state.refresh);
  const beginImport = useWorkspaceStore((state) => state.beginPaperImport);
  const updateImport = useWorkspaceStore((state) => state.updatePaperImport);
  const finishImport = useWorkspaceStore((state) => state.finishPaperImport);
  const [url, setUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<'paper' | 'blog' | 'website'>('paper');
  const [hint, setHint] = useState('');
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [agentId, setAgentId] = useState<LocalAgent['id'] | ''>('');
  const { choice: settings } = useAgentSettings(
    agentId,
    health?.agents.find((agent) => agent.id === agentId),
  );
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const jobId = useRef<string>();

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getBridgeHealth().then((next) => {
      if (!active) return;
      setHealth(next);
      if (next) setAgentId((current) => chooseAgent(next, current));
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      active = false;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, running, setOpen]);

  useEffect(() => {
    if (agentId) writePreference('orbis.agent', agentId);
  }, [agentId]);

  function close() {
    setOpen(false);
    if (running) return;
    setEvents([]);
    setError(null);
  }

  async function cancel() {
    try {
      if (jobId.current) await cancelAgentInsertion(jobId.current);
    } finally {
      controllerRef.current?.abort();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running) return;
    setError(null);
    setEvents([]);
    const controller = new AbortController();
    jobId.current = undefined;
    controllerRef.current = controller;
    setRunning(true);
    const importId = beginImport(url.trim(), sourceKind);
    let outcome: 'inserted' | 'excluded' | 'duplicate' | null = null;
    let graphNodeId: string | null = null;
    let outcomeReason = '';
    try {
      const workspace = useWorkspaceStore.getState();
      if (workspace.dirty) {
        if (workspace.mode !== 'api')
          throw new Error(
            'Connect to the local server and save your graph edits before adding a paper.',
          );
        updateImport(importId, { message: 'Saving your graph edits…' });
        await workspace.save();
        if (useWorkspaceStore.getState().dirty)
          throw new Error('You have newer graph edits. Save them before adding the paper.');
        updateImport(importId, { message: 'Checking the local agent…' });
      }
      const currentHealth = await getBridgeHealth();
      setHealth(currentHealth);
      const agent = currentHealth?.agents.find((item) => item.id === agentId);
      if (!agent?.available) {
        throw new Error(`${agent?.label ?? 'The selected agent'} is unavailable on PATH.`);
      }
      if (currentHealth?.busy)
        throw new Error('Another local agent run is already active.');
      await runAgentInsertion(
        agent.id,
        url.trim(),
        hint.trim(),
        null,
        null,
        controller.signal,
        (next) => {
          if (next.type === 'start') {
            jobId.current = next.job_id;
            updateImport(importId, {
              jobId: next.job_id,
              status: 'running',
              message: 'Reading the full text…',
            });
          }
          if (next.type === 'error') throw new Error(next.message);
          setEvents((current) => [...current, next].slice(-30));
          if (next.type === 'event') updateImport(importId, { message: eventText(next) });
          if (next.type === 'done') {
            outcome = next.outcome;
            graphNodeId = next.graph_node_id;
            outcomeReason = next.reason;
          }
        },
        sourceKind,
        settings,
      );
      if (outcome === 'inserted') {
        await reloadGraph();
        if (graphNodeId) finishImport(importId, graphNodeId);
        setUrl('');
        setHint('');
      } else if (outcome === 'duplicate' && graphNodeId) {
        await reloadGraph();
        finishImport(importId, graphNodeId);
      } else {
        updateImport(importId, {
          status: 'excluded',
          message:
            outcomeReason ||
            'This source was not added. Check import activity for the reason.',
        });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Insertion failed.';
      const cancelled = controller.signal.aborted || /cancelled by user/i.test(message);
      updateImport(importId, {
        status: cancelled ? 'cancelled' : 'failed',
        message: cancelled
          ? 'Import cancelled. You can keep reading the original.'
          : message,
      });
      if (!cancelled) setError(message);
    } finally {
      controllerRef.current = null;
      setHealth(await getBridgeHealth());
      setRunning(false);
    }
  }

  if (!open) return null;

  const agent = health?.agents.find((item) => item.id === agentId);
  const busy = Boolean(health?.busy) && !running;
  const ready = Boolean(agent?.available);
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="add-paper-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-paper-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="dialog-icon">
              <Plus size={17} aria-hidden="true" />
            </span>
            <div>
              <span className="eyebrow">Local agent</span>
              <h2 id="add-paper-title">Add a paper or web source</h2>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close add paper dialog"
          >
            <X size={18} />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>Agent</span>
            <span className="dialog-agent-select">
              <Bot size={15} aria-hidden="true" />
              <select
                aria-label="Agent"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value as LocalAgent['id'])}
                disabled={running}
              >
                {health?.agents.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.available}>
                    {item.label}
                    {item.available ? '' : ' (not found)'}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <AgentModelSettings key={agentId} agent={agent} disabled={running} />
          <label className="field">
            <span>Source type</span>
            <select
              aria-label="Source type"
              value={sourceKind}
              disabled={running}
              onChange={(e) => setSourceKind(e.target.value as typeof sourceKind)}
            >
              <option value="paper">Research paper</option>
              <option value="blog">Blog post</option>
              <option value="website">Web page</option>
            </select>
          </label>
          <label className="field">
            <span>{sourceKind === 'paper' ? 'Paper URL' : 'Website URL'}</span>
            <input
              type="url"
              required
              placeholder={
                sourceKind === 'paper'
                  ? 'https://arxiv.org/abs/...'
                  : 'https://example.com/article'
              }
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={running}
              autoFocus
            />
          </label>
          <label className="field">
            <span>
              Additional instructions <small>optional</small>
            </span>
            <textarea
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="e.g. Explain each training stage and compare the approach with Dreamer"
              disabled={running}
              rows={3}
              maxLength={2000}
            />
          </label>

          <p className="research-caption">
            Every paper includes motivation, background, the full framework, key results,
            and limitations. Your instructions add to this summary.
          </p>

          <div className={`agent-status ${ready ? 'ready' : ''}`}>
            {!health ? (
              <Circle size={15} />
            ) : ready ? (
              <CheckCircle2 size={15} />
            ) : (
              <Circle size={15} />
            )}
            <span>
              {!health
                ? 'Local server unavailable'
                : busy
                  ? 'Another agent is processing a paper'
                  : ready
                    ? `${agent?.label ?? 'Local agent'} ready`
                    : 'Selected agent unavailable'}
            </span>
          </div>

          {(events.length > 0 || running) && (
            <div className="insert-progress" aria-live="polite">
              {events.map((item, index) => (
                <div key={`${item.type}-${index}`}>
                  {item.type === 'done' ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <LoaderCircle
                      className={index === events.length - 1 && running ? 'spin' : ''}
                      size={13}
                    />
                  )}
                  <span>{eventText(item)}</span>
                </div>
              ))}
            </div>
          )}

          {error && <p className="form-error">{error}</p>}

          <footer>
            <span>
              {dirty ? 'Your graph edits will be saved first.' : 'localhost only'}
            </span>
            <div>
              {running && (
                <>
                  <button type="button" className="button secondary" onClick={close}>
                    Continue in background
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={!jobId.current}
                    onClick={() => void cancel()}
                  >
                    <CircleStop size={15} /> Cancel
                  </button>
                </>
              )}
              <button
                type="submit"
                className="button primary"
                disabled={running || busy || !ready || !validUrl}
              >
                {running ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
                {running ? 'Reading paper' : dirty ? 'Save & add' : 'Read & add'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
