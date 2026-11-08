import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  BookOpen,
  ExternalLink,
  FileText,
  HelpCircle,
  Link2,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Save,
  Table2,
  X,
} from 'lucide-react';
import { indexNodes } from '../domain/graph';
import type { GraphEdge, GraphNode, ReviewStatus } from '../domain/schema';
import { useWorkspaceStore } from '../store/workspaceStore';
import { MarkdownNotes, MarkdownView } from './MarkdownNotes';
import { GraphEditor } from './GraphEditor';

function ReviewControls({
  kind,
  id,
  status,
}: {
  kind: 'node' | 'edge';
  id: string;
  status: ReviewStatus;
}) {
  const setStatus = useWorkspaceStore((state) => state.setStatus);
  return (
    <div className="decision-bar">
      <button
        className={status === 'accepted' ? 'accept active' : 'accept'}
        onClick={() => setStatus(kind, id, 'accepted')}
      >
        <Check size={16} /> Accept
      </button>
      <button
        className={status === 'uncertain' ? 'uncertain active' : 'uncertain'}
        onClick={() => setStatus(kind, id, 'uncertain')}
      >
        <HelpCircle size={16} /> Uncertain
      </button>
      <button
        className={status === 'rejected' ? 'reject active' : 'reject'}
        onClick={() => setStatus(kind, id, 'rejected')}
      >
        <X size={16} /> Reject
      </button>
    </div>
  );
}

function NodeInspector({ node }: { node: GraphNode }) {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const updateNode = useWorkspaceStore((state) => state.updateNode);
  const select = useWorkspaceStore((state) => state.select);
  const addToast = useWorkspaceStore((state) => state.addToast);
  const openResearch = useWorkspaceStore((state) => state.openResearch);
  const openPaper = useWorkspaceStore((state) => state.openPaper);
  const [notes, setNotes] = useState(node.notes ?? '');
  const [sourceNote, setSourceNote] = useState('');
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? '');
  const [cluster, setCluster] = useState(node.cluster ?? '');
  const nodes = useMemo(() => indexNodes(graph), [graph]);
  const clusters = graph.nodes.filter((candidate) => candidate.type === 'cluster');
  const connections = graph.edges.filter(
    (edge) => edge.source === node.id || edge.target === node.id,
  );

  useEffect(() => {
    setLabel(node.label);
    setDescription(node.description ?? '');
    setCluster(node.cluster ?? '');
  }, [node.id, node.label, node.description, node.cluster]);

  useEffect(() => {
    setNotes(node.notes ?? '');
  }, [node.id, node.notes]);

  useEffect(() => {
    let active = true;
    setSourceNote('');
    if (node.notes_file)
      void fetch(`/api/notes?id=${encodeURIComponent(node.id)}`)
        .then((r) => (r.ok ? r.json() : { text: '' }))
        .then((value) => {
          if (active) setSourceNote(value.text);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [node.id, node.notes_file]);

  function apply() {
    updateNode(node.id, {
      label: label.trim() || node.label,
      description: description.trim(),
      notes,
      ...(node.type !== 'cluster' ? { cluster: cluster || undefined } : {}),
    });
    addToast('Node updated. Ownership is now user.', 'success');
  }

  return (
    <>
      <div className="inspector-title">
        <span className={`entity-icon type-bg-${node.type}`}>
          <FileText size={18} aria-hidden="true" />
        </span>
        <div>
          <span>{node.type.replace('_', ' ')}</span>
          <h2>{node.label}</h2>
        </div>
      </div>
      <div className="meta-line">
        <span className={`status-pill ${node.status}`}>{node.status}</span>
        <span>{node.origin === 'user' ? 'Researcher owned' : 'Agent proposal'}</span>
      </div>
      <div
        className="inspector-research-actions"
        role="group"
        aria-label="Research actions"
      >
        {node.paper && (
          <button
            className="button primary"
            aria-label="Read paper"
            onClick={() => openPaper(node.id)}
          >
            <BookOpen size={14} aria-hidden="true" /> Read
          </button>
        )}
        <button
          className="button secondary"
          aria-label={`Discuss this ${node.type}`}
          onClick={() =>
            node.paper
              ? openPaper(node.id, undefined, undefined, 'Discuss')
              : openResearch([node.id])
          }
        >
          <MessagesSquare size={14} aria-hidden="true" /> Discuss
        </button>
        {node.type === 'paper' && (
          <button
            className="button secondary"
            aria-label="Compare with papers"
            onClick={() => openResearch([node.id], true)}
          >
            <Table2 size={14} aria-hidden="true" /> Compare
          </button>
        )}
      </div>

      {node.paper && (
        <section className="paper-details">
          <h3>{node.paper.title}</h3>
          <p className="authors">{node.paper.authors.join(', ')}</p>
          <div className="paper-meta">
            <span>{node.paper.venue}</span>
            <span>{node.paper.year ?? 'Undated'}</span>
            <a href={node.paper.url} target="_blank" rel="noreferrer">
              {node.paper.source_kind === 'blog'
                ? 'Blog'
                : node.paper.source_kind === 'website'
                  ? 'Website'
                  : 'Source'}{' '}
              <ExternalLink size={12} />
            </a>
          </div>
          <MarkdownView text={node.paper.summary} />
          {node.paper.key_findings.length > 0 && (
            <ul>
              {node.paper.key_findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ReviewControls kind="node" id={node.id} status={node.status} />
      {sourceNote && (
        <details className="source-paper-note">
          <summary>Read paper notes</summary>
          <MarkdownView text={sourceNote} />
        </details>
      )}

      <section className="inspector-form">
        <h3>Research record</h3>
        <label>
          <span>Label</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span>Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
          />
        </label>
        <MarkdownNotes
          key={node.id}
          value={notes}
          onChange={(value) => {
            setNotes(value);
            updateNode(node.id, { notes: value });
          }}
        />
        {node.type !== 'cluster' && (
          <label>
            <span>Cluster</span>
            <select value={cluster} onChange={(event) => setCluster(event.target.value)}>
              <option value="">No cluster</option>
              {clusters.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="button primary full" onClick={apply}>
          <Save size={15} /> Apply edits
        </button>
      </section>
      <GraphEditor sourceId={node.id} key={node.id} />

      <section className="connection-list">
        <div className="section-title">
          <h3>Connections</h3>
          <span>{connections.length}</span>
        </div>
        {connections.map((edge) => {
          const outbound = edge.source === node.id;
          const other = nodes.get(outbound ? edge.target : edge.source);
          return (
            <button key={edge.id} onClick={() => select({ kind: 'edge', id: edge.id })}>
              <Link2 size={14} aria-hidden="true" />
              <span>
                <small>
                  {outbound ? 'outbound' : 'inbound'} · {edge.relation}
                </small>
                <strong>{other?.label ?? (outbound ? edge.target : edge.source)}</strong>
              </span>
              <span className={`status-dot ${edge.status}`} />
            </button>
          );
        })}
      </section>
    </>
  );
}

function EdgeInspector({ edge }: { edge: GraphEdge }) {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const updateEdge = useWorkspaceStore((state) => state.updateEdge);
  const select = useWorkspaceStore((state) => state.select);
  const addToast = useWorkspaceStore((state) => state.addToast);
  const nodes = useMemo(() => indexNodes(graph), [graph]);
  const [relation, setRelation] = useState(edge.relation);
  const [note, setNote] = useState(edge.transition_note);
  const [evidence, setEvidence] = useState(edge.evidence);
  const [confidence, setConfidence] = useState(edge.confidence);

  useEffect(() => {
    setRelation(edge.relation);
    setNote(edge.transition_note);
    setEvidence(edge.evidence);
    setConfidence(edge.confidence);
  }, [edge]);

  function apply() {
    updateEdge(edge.id, {
      relation: relation.trim() || edge.relation,
      transition_note: note.trim(),
      evidence: evidence.trim(),
      confidence: Math.min(1, Math.max(0, confidence)),
    });
    addToast('Relationship updated. Ownership is now user.', 'success');
  }

  return (
    <>
      <div className="inspector-title">
        <span className="entity-icon edge-icon">
          <Link2 size={18} aria-hidden="true" />
        </span>
        <div>
          <span>Relationship · {edge.id}</span>
          <h2>{edge.relation.replaceAll('_', ' ')}</h2>
        </div>
      </div>
      <div className="meta-line">
        <span className={`status-pill ${edge.status}`}>{edge.status}</span>
        <span>{edge.origin === 'user' ? 'Researcher owned' : 'Agent proposal'}</span>
      </div>

      <div className="edge-route">
        <button onClick={() => select({ kind: 'node', id: edge.source })}>
          {nodes.get(edge.source)?.label ?? edge.source}
        </button>
        <span>
          <i />
          {edge.relation}
          <i />
        </span>
        <button onClick={() => select({ kind: 'node', id: edge.target })}>
          {nodes.get(edge.target)?.label ?? edge.target}
        </button>
      </div>

      <ReviewControls kind="edge" id={edge.id} status={edge.status} />

      <section className="inspector-form">
        <h3>Connection evidence</h3>
        <label>
          <span>Relation</span>
          <input value={relation} onChange={(event) => setRelation(event.target.value)} />
        </label>
        <label>
          <span>Transition note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={6}
          />
        </label>
        <label>
          <span>Evidence</span>
          <textarea
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            rows={4}
          />
        </label>
        <label>
          <span>Confidence · {confidence.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confidence}
            onChange={(event) => setConfidence(Number(event.target.value))}
          />
        </label>
        <button className="button primary full" onClick={apply}>
          <Save size={15} /> Apply edits
        </button>
      </section>
    </>
  );
}

export function Inspector() {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', restore);
    return () => window.removeEventListener('keydown', restore);
  }, [expanded]);

  if (!selection) return null;
  const item =
    selection.kind === 'node'
      ? graph.nodes.find((node) => node.id === selection.id)
      : graph.edges.find((edge) => edge.id === selection.id);
  if (!item) return null;

  return (
    <aside
      className={`inspector${expanded ? ' inspector-expanded' : ''}`}
      aria-label="Graph inspector"
    >
      <div className="inspector-topbar">
        <span>{expanded ? 'Reading view' : 'Inspector'}</span>
        <div className="inspector-window-controls">
          <button
            className="button secondary inspector-expand"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Restore notes panel' : 'Maximize notes panel'}
            title={expanded ? 'Restore notes panel (Esc)' : 'Maximize notes panel'}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            {expanded ? 'Back to graph' : 'Expand'}
          </button>
          <button
            className="icon-button"
            onClick={() => {
              setExpanded(false);
              select(null);
            }}
            aria-label="Close inspector"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="inspector-scroll">
        <div className="inspector-content">
          {selection.kind === 'node' ? (
            <NodeInspector node={item as GraphNode} />
          ) : (
            <EdgeInspector edge={item as GraphEdge} />
          )}
        </div>
      </div>
    </aside>
  );
}
