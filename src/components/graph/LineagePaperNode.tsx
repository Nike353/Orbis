import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ArrowDownLeft, ArrowUpRight, FileText } from 'lucide-react';
import type { LineageSceneNode } from './lineageMapModel';

export function LineagePaperNode({ data, selected }: NodeProps<LineageSceneNode>) {
  if (data.kind !== 'paper') return null;
  const { node, color, memberships, incoming, outgoing, dimmed } = data;
  const paper = node.paper;
  const firstAuthor = paper.authors[0]?.trim().split(/\s+/).at(-1) ?? 'Unknown';
  const membershipLabel = memberships
    .map(
      (membership) =>
        `${membership.label} (${membership.role === 'primary' ? 'primary' : 'bridge'})`,
    )
    .join(', ');

  return (
    <article
      className={[
        'lineage-paper',
        selected ? 'selected' : '',
        dimmed ? 'dimmed' : '',
        node.status === 'proposed' ? 'proposed' : '',
        node.status === 'uncertain' ? 'uncertain' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--lineage-color': color } as CSSProperties}
      data-testid="lineage-paper"
      data-paper-id={node.id}
    >
      <Handle type="target" position={Position.Left} id="target-left" />
      <Handle type="source" position={Position.Left} id="source-left" />
      <Handle type="target" position={Position.Right} id="target-right" />
      <Handle type="source" position={Position.Right} id="source-right" />
      <Handle type="target" position={Position.Top} id="target-top" />
      <Handle type="source" position={Position.Top} id="source-top" />
      <Handle type="target" position={Position.Bottom} id="target-bottom" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />

      <header>
        <span className="lineage-paper-kicker">
          <FileText size={12} aria-hidden="true" />
          Paper
        </span>
        <span className="lineage-paper-year">{paper.year ?? 'Undated'}</span>
      </header>
      <h3 title={paper.title}>{node.label}</h3>
      <p className="lineage-paper-byline">
        {firstAuthor} | {paper.venue || 'Preprint'}
      </p>
      <footer>
        <span
          className="lineage-memberships"
          aria-label={membershipLabel || data.lane.label}
          title={membershipLabel || data.lane.label}
        >
          {(memberships.length
            ? memberships
            : [
                {
                  clusterId: data.lane.id,
                  label: data.lane.label,
                  color,
                  role: 'primary' as const,
                  weight: 1,
                },
              ]
          ).map((membership) => (
            <i
              key={membership.clusterId}
              className={membership.role}
              style={{ background: membership.color }}
              aria-hidden="true"
            />
          ))}
        </span>
        <span
          className="lineage-edge-counts"
          aria-label={`${incoming} incoming and ${outgoing} outgoing connections`}
        >
          <ArrowDownLeft size={11} aria-hidden="true" />
          {incoming}
          <ArrowUpRight size={11} aria-hidden="true" />
          {outgoing}
        </span>
      </footer>
    </article>
  );
}
