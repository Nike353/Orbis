import { X } from 'lucide-react';
import type { GraphData, GraphEdge } from '../domain/schema';
import type { SceneLink } from './graph/sceneModel';
import { MarkdownView } from './MarkdownNotes';

export function ConnectionPreview({
  link,
  graph,
  onClose,
  onOpen,
}: {
  link: SceneLink;
  graph: GraphData;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const label = (id: string) => nodes.get(id)?.label ?? id;
  const membership = link.kind === 'membership';
  const evidence = membership
    ? graph.edges.filter((edge) => {
        if (edge.status === 'rejected') return false;
        const otherId =
          edge.source === link.paperId
            ? edge.target
            : edge.target === link.paperId
              ? edge.source
              : null;
        const other = otherId ? nodes.get(otherId) : null;
        return (
          other &&
          other.status !== 'rejected' &&
          (other.type === 'cluster' ? other.id : other.cluster) === link.clusterId
        );
      })
    : link.original
      ? [link.original]
      : [];
  function note(edge: GraphEdge) {
    return (
      <section className="connection-preview-note" key={edge.id}>
        <h3>
          {edge.relation.replaceAll('_', ' ')}{' '}
          <small>· {Math.round(edge.confidence * 100)}% confidence</small>
        </h3>
        {membership && (
          <p className="connection-preview-route">
            {label(edge.source)} → {label(edge.target)}
          </p>
        )}
        <MarkdownView text={edge.transition_note || 'No connection note yet.'} />
        {edge.evidence && (
          <>
            <h4>Evidence</h4>
            <MarkdownView text={edge.evidence} />
          </>
        )}
        <button className="button secondary" onClick={() => onOpen(edge.id)}>
          Open connection
        </button>
      </section>
    );
  }
  return (
    <section
      className="connection-preview"
      aria-label="Connection notes"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header>
        <strong>
          {membership
            ? link.membershipRole === 'secondary'
              ? 'Bridge to research field'
              : 'Research field membership'
            : 'Connection notes'}
        </strong>
        <button
          className="icon-button"
          aria-label="Close connection preview"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div
        className="connection-preview-body"
        tabIndex={0}
        aria-label="Full connection notes"
      >
        <p className="connection-preview-route">
          {membership
            ? `${label(link.paperId!)} → ${label(link.clusterId!)}`
            : link.original
              ? `${label(link.original.source)} → ${label(link.original.target)}`
              : ''}
        </p>
        {evidence.map(note)}
        {membership && evidence.length === 0 && (
          <p>
            This paper belongs to this research field. No separate connection notes have
            been recorded.
          </p>
        )}
      </div>
    </section>
  );
}
