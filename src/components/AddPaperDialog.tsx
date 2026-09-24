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
  const stored = window.localStorage.getItem('litbench.agent');
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
  const reloadGraph = useWorkspaceStore((state) => state.load);
  const select = useWorkspaceStore((state) => state.select);
  const [url, setUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<'paper' | 'blog' | 'website'>('paper');
  const [hint, setHint] = useState('');
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [agentId, setAgentId] = useState<LocalAgent['id'] | ''>('');
  const { choice: settings } = useAgentSettings(agentId);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getBridgeHealth().then((next) => {
      if (!active) return;
      setHealth(next);
      if (next) setAgentId((current) => chooseAgent(next, current));
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      active = false;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, running, setOpen]);

  useEffect(() => {
    if (agentId) window.localStorage.setItem('litbench.agent', agentId);
  }, [agentId]);

  function close() {
    if (running) return;
    setOpen(false);
    setEvents([]);
    setError(null);
  }

  async function cancel() {
    try {
      await cancelAgentInsertion();
    } finally {
      controllerRef.current?.abort();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setEvents([]);
    if (dirty) {
      setError('Save or reload graph edits before adding a paper.');
      return;
    }

    const currentHealth = await getBridgeHealth();
    setHealth(currentHealth);
    const agent = currentHealth?.agents.find((item) => item.id === agentId);
    if (!agent?.available) {
      setError(`${agent?.label ?? 'The selected agent'} is unavailable on PATH.`);
      return;
    }
    if (currentHealth?.busy) {
      setError('Another local agent run is already active.');
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    let outcome: 'inserted' | 'excluded' | 'duplicate' | null = null;
    let graphNodeId: string | null = null;
    try {
      await runAgentInsertion(
        agent.id,
        url.trim(),
        hint.trim(),
        null,
        null,
        controller.signal,
        (next) => {
          setEvents((current) => [...current, next].slice(-30));
          if (next.type === 'done') {
            outcome = next.outcome;
            graphNodeId = next.graph_node_id;
          }
          if (next.type === 'error') throw new Error(next.message);
        },
        sourceKind,
        settings,
      );
      if (outcome === 'inserted') {
        await reloadGraph();
        if (graphNodeId) select({ kind: 'node', id: graphNodeId });
        setUrl('');
        setHint('');
      } else if (outcome === 'duplicate' && graphNodeId) {
        select({ kind: 'node', id: graphNodeId });
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Insertion failed.');
      }
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
            disabled={running}
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
            <span>{dirty ? 'Unsaved graph edits' : 'localhost only'}</span>
            <div>
              {running && (
                <button
                  type="button"
                  className="button danger"
                  onClick={() => void cancel()}
                >
                  <CircleStop size={15} /> Cancel
                </button>
              )}
              <button
                type="submit"
                className="button primary"
                disabled={running || busy || dirty || !ready || !validUrl}
              >
                {running ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
                {running ? 'Reading paper' : 'Read & add'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
