import { AgentModelSettings } from '../AgentModelSettings';
import { useAgentSettings } from '../../store/agentSettings';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  Bot,
  Check,
  CircleStop,
  Clock3,
  ExternalLink,
  FileJson,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type {
  ArxivBatch,
  ArxivRecord,
  ProcessingRecord,
  ProcessingState,
  ProcessingStatus,
} from '../../domain/arxiv';
import {
  cancelAgentInsertion,
  getBridgeHealth,
  runAgentInsertion,
  type BridgeHealth,
  type LocalAgent,
} from '../../services/agentBridge';
import {
  createLocalProcessingState,
  loadArxivBatch,
  loadProcessingState,
  pendingRecords,
} from '../../services/arxivQueue';
import { useWorkspaceStore } from '../../store/workspaceStore';

function statusIcon(status: ProcessingStatus) {
  if (status === 'inserted') return <Check size={14} />;
  if (status === 'excluded') return <Ban size={14} />;
  if (status === 'processing') return <LoaderCircle size={14} className="spin" />;
  if (status === 'failed') return <AlertCircle size={14} />;
  if (status === 'cancelled') return <CircleStop size={14} />;
  if (status === 'duplicate') return <RefreshCw size={14} />;
  return <Clock3 size={14} />;
}

function optimisticRecord(
  record: ProcessingRecord | undefined,
  status: ProcessingStatus,
): ProcessingRecord {
  return {
    status,
    attempts: (record?.attempts ?? 0) + (status === 'processing' ? 1 : 0),
    started_at:
      status === 'processing' ? new Date().toISOString() : (record?.started_at ?? null),
    finished_at: record?.finished_at ?? null,
    reason: null,
    summary: null,
    graph_node_id: null,
    duration_s: null,
    cost_usd: null,
    full_text_source: null,
    full_text_attested_at: null,
  };
}

export function ImportQueue() {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const dirty = useWorkspaceStore((state) => state.dirty);
  const reloadGraph = useWorkspaceStore((state) => state.load);
  const addToast = useWorkspaceStore((state) => state.addToast);
  const [batch, setBatch] = useState<ArxivBatch | null>(null);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [processing, setProcessing] = useState<ProcessingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentLog, setCurrentLog] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<LocalAgent['id'] | ''>('');
  const { choice: settings } = useAgentSettings(selectedAgent);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  const existingUrls = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter((node) => node.type === 'paper' && node.paper)
          .map((node) => node.paper!.url.replace(/^http:/, 'https:').replace(/\/$/, '')),
      ),
    [graph],
  );

  async function refreshState(targetBatch: ArxivBatch) {
    const state = await loadProcessingState(targetBatch);
    setProcessing(state);
    return state;
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      const bridge = await getBridgeHealth();
      if (active) setHealth(bridge);
      try {
        const loadedBatch = await loadArxivBatch();
        const state = await loadProcessingState(loadedBatch);
        if (!active) return;
        setBatch(loadedBatch);
        setProcessing(state);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const poll = window.setInterval(() => {
      void Promise.all([
        batch ? loadProcessingState(batch) : Promise.resolve(null),
        getBridgeHealth(),
      ]).then(async ([state, bridge]) => {
        if (!active) return;
        if (state) setProcessing(state);
        setHealth(bridge);
        if (
          bridge?.graph_revision != null &&
          bridge.graph_revision > graph.meta.revision &&
          !dirty
        ) {
          await reloadGraph();
        }
      });
    }, 4_000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [batch, dirty, graph.meta.revision, reloadGraph]);

  useEffect(() => {
    if (!health) return;
    setSelectedAgent((current) => {
      if (health.agents.some((agent) => agent.id === current && agent.available)) {
        return current;
      }
      const stored = window.localStorage.getItem('litbench.agent');
      const storedAgent = health.agents.find(
        (agent) => agent.available && agent.id === stored,
      );
      const defaultAgent = health.agents.find(
        (agent) => agent.available && agent.id === health.default_agent,
      );
      return (
        storedAgent?.id ??
        defaultAgent?.id ??
        health.agents.find((agent) => agent.available)?.id ??
        ''
      );
    });
  }, [health]);

  useEffect(() => {
    if (selectedAgent) {
      window.localStorage.setItem('litbench.agent', selectedAgent);
    }
  }, [selectedAgent]);

  const selectedAgentInfo = health?.agents.find((agent) => agent.id === selectedAgent);

  async function processRecord(record: ArxivRecord) {
    if (!batch || !processing || !selectedAgent) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    setProcessing((state) =>
      state
        ? {
            ...state,
            records: {
              ...state.records,
              [record.arxiv_id]: optimisticRecord(
                state.records[record.arxiv_id],
                'processing',
              ),
            },
          }
        : state,
    );
    setCurrentLog([]);
    let inserted = false;
    try {
      await runAgentInsertion(
        selectedAgent,
        record.canonical_url,
        `Retrieved in ${batch.batch_id}. Apply the manifest relevance rubric before insertion.`,
        batch.batch_id,
        record.arxiv_id,
        controller.signal,
        (event) => {
          if (event.type === 'event') {
            const text =
              event.kind === 'tool'
                ? `${event.name ?? 'Tool'} ${event.detail ?? ''}`
                : (event.text ?? '');
            if (text.trim()) setCurrentLog((lines) => [...lines.slice(-19), text.trim()]);
          }
          if (event.type === 'done') inserted = event.outcome === 'inserted';
          if (event.type === 'error') throw new Error(event.message);
        },
        'paper',
        settings,
      );
      return inserted;
    } catch (error) {
      if (!controller.signal.aborted) {
        addToast(
          `${selectedAgentInfo?.label ?? 'The local agent'} could not process ${
            record.arxiv_id
          }: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      return false;
    } finally {
      abortRef.current = null;
      await refreshState(batch);
    }
  }

  async function runQueue(records?: ArxivRecord[]) {
    if (!batch || !processing || running || !selectedAgent) return;
    const currentHealth = await getBridgeHealth();
    setHealth(currentHealth);
    const currentAgent = currentHealth?.agents.find((agent) => agent.id === selectedAgent);
    if (!currentAgent?.available) {
      addToast(
        `${selectedAgentInfo?.label ?? 'The selected agent'} is unavailable on PATH.`,
        'error',
      );
      return;
    }
    if (currentHealth?.busy) {
      addToast(
        currentHealth.active_record
          ? `A local agent is already processing ${currentHealth.active_record}.`
          : 'A local agent is already processing another paper.',
        'warning',
      );
      return;
    }
    if (dirty) {
      addToast('Save or reload your graph edits before starting an agent.', 'warning');
      return;
    }
    stopRequestedRef.current = false;
    setRunning(true);
    const candidates =
      records ??
      pendingRecords(batch, processing, existingUrls).filter((record) =>
        ['queued', 'failed', 'cancelled', 'processing'].includes(
          processing.records[record.arxiv_id]?.status ?? 'queued',
        ),
      );
    let insertedAny = false;
    for (const record of candidates) {
      if (stopRequestedRef.current) break;
      insertedAny = (await processRecord(record)) || insertedAny;
      if (stopRequestedRef.current) break;
    }
    if (insertedAny) await reloadGraph();
    setHealth(await getBridgeHealth());
    setRunning(false);
    if (!stopRequestedRef.current) {
      addToast(`${currentAgent.label} queue run finished.`, 'success');
    }
  }

  async function cancelRun() {
    stopRequestedRef.current = true;
    try {
      await cancelAgentInsertion();
    } finally {
      abortRef.current?.abort();
    }
  }

  if (loading) {
    return (
      <div className="panel-loading">
        <LoaderCircle className="spin" />
        <span>Loading retrieval manifest</span>
      </div>
    );
  }

  const displayRecord = (record: ArxivRecord) => {
    if (!batch || !processing) return optimisticRecord(undefined, 'queued');
    const canonical = record.canonical_url.replace(/\/$/, '');
    if (
      existingUrls.has(canonical) &&
      processing.records[record.arxiv_id]?.status === 'queued'
    ) {
      return {
        ...processing.records[record.arxiv_id],
        status: 'duplicate' as const,
        reason: 'A paper with this canonical URL is already in the graph.',
      };
    }
    return (
      processing.records[record.arxiv_id] ??
      createLocalProcessingState(batch).records[record.arxiv_id]
    );
  };
  const counts =
    batch && processing
      ? batch.records.reduce(
          (result, record) => {
            const status = displayRecord(record).status;
            result[status] = (result[status] ?? 0) + 1;
            return result;
          },
          {} as Record<string, number>,
        )
      : {};
  const retryableRecords =
    batch && processing
      ? pendingRecords(batch, processing, existingUrls).filter((record) =>
          ['queued', 'failed', 'cancelled', 'processing'].includes(
            processing.records[record.arxiv_id]?.status ?? 'queued',
          ),
        )
      : [];
  const externallyBusy = Boolean(health?.busy) && !running;
  const activeAgentInfo = health?.agents.find((agent) => agent.id === health.active_agent);
  const agentReady = Boolean(selectedAgentInfo?.available);
  const agentLabel = selectedAgentInfo?.label ?? 'Local agent';
  const bridgeLabel = !health
    ? 'Local server offline'
    : health.busy
      ? `${activeAgentInfo?.label ?? 'Local agent'} working`
      : agentReady
        ? `${agentLabel} ready`
        : 'Agent unavailable';

  return (
    <div className="panel-scroll import-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Local agent</span>
          <h2>Add papers</h2>
        </div>
        <span
          className={`bridge-dot ${
            health?.busy ? 'busy' : agentReady ? 'online' : 'offline'
          }`}
        >
          {bridgeLabel}
        </span>
      </div>
      <div className="queue-agent-bar">
        <label className="agent-picker">
          <Bot size={15} aria-hidden="true" />
          <span>Agent</span>
          <select
            aria-label="Local agent"
            value={selectedAgent}
            onChange={(event) => setSelectedAgent(event.target.value as LocalAgent['id'])}
            disabled={running}
          >
            {health?.agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.label}
                {agent.available ? '' : ' (not found)'}
              </option>
            ))}
          </select>
        </label>
        <AgentModelSettings
          key={selectedAgent}
          agent={selectedAgentInfo}
          disabled={running}
        />
      </div>
      {currentLog.length > 0 && (
        <div className="queue-log" aria-live="polite">
          {currentLog.map((line, index) => (
            <span key={`${index}:${line}`}>{line}</span>
          ))}
        </div>
      )}
      {batch && processing ? (
        <>
          <div className="batch-summary">
            <span>{batch.batch_id}</span>
            <strong>{batch.records.length} verified arXiv candidates</strong>
            <small>
              {batch.date_range.from} - {batch.date_range.through}
            </small>
          </div>
          <div className="queue-metrics">
            <span>
              <strong>{counts.queued ?? 0}</strong> queued
            </span>
            <span>
              <strong>{counts.inserted ?? 0}</strong> inserted
            </span>
            <span>
              <strong>{counts.excluded ?? 0}</strong> excluded
            </span>
            <span>
              <strong>{(counts.failed ?? 0) + (counts.cancelled ?? 0)}</strong> retry
            </span>
          </div>
          <div className="qualification-line">
            <ShieldCheck size={14} aria-hidden="true" />
            <span>
              <strong>{processing.qualified_count}</strong> agent-qualified
            </span>
          </div>
          <div className="queue-toolbar">
            {running ? (
              <button className="button danger" onClick={() => void cancelRun()}>
                <CircleStop size={15} /> Cancel run
              </button>
            ) : (
              <button
                className="button primary"
                onClick={() => void runQueue()}
                disabled={externallyBusy || !agentReady || retryableRecords.length === 0}
              >
                {externallyBusy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
                {externallyBusy
                  ? `Processing ${health?.active_record ?? 'paper'}`
                  : retryableRecords.length
                    ? `Process queue with ${agentLabel}`
                    : 'Queue complete'}
              </button>
            )}
            <button
              className="icon-button"
              title="Refresh durable queue state"
              aria-label="Refresh queue state"
              onClick={() => void refreshState(batch)}
              disabled={running}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="queue-list">
            {batch.records.map((record, index) => {
              const item = displayRecord(record);
              const retryable = ['failed', 'cancelled'].includes(item.status);
              return (
                <article key={record.arxiv_id} className={`queue-record ${item.status}`}>
                  <span className={`queue-status ${item.status}`}>
                    {statusIcon(item.status)}
                  </span>
                  <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <a
                      className="queue-title"
                      href={record.canonical_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <strong>{record.title}</strong>
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    <small>
                      {record.arxiv_id} · {record.submitted_at.slice(0, 10)}
                    </small>
                    {item.reason && <em>{item.reason}</em>}
                    {item.full_text_source && (
                      <a
                        className="queue-source"
                        href={item.full_text_source.url}
                        target="_blank"
                        rel="noreferrer"
                        title={item.full_text_source.evidence}
                      >
                        <ShieldCheck size={11} aria-hidden="true" />
                        Full-text source
                      </a>
                    )}
                  </div>
                  {retryable && !running && (
                    <button
                      className="queue-retry"
                      title={`Retry ${record.arxiv_id}`}
                      aria-label={`Retry ${record.title}`}
                      onClick={() => void runQueue([record])}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty-panel import-empty">
          <FileJson size={26} aria-hidden="true" />
          <strong>No saved batch queue</strong>
          <p>{loadError ?? 'Add individual papers with the URL field above.'}</p>
        </div>
      )}
    </div>
  );
}
