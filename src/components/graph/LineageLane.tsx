import type { CSSProperties } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { LineageSceneNode } from './lineageMapModel';

export function LineageLane({ data }: NodeProps<LineageSceneNode>) {
  if (data.kind !== 'lane') return null;
  const { lane, years, yearGap, leftGutter, paperCount } = data;

  return (
    <section
      className="lineage-lane"
      style={{ '--lineage-color': lane.color } as CSSProperties}
      data-testid="lineage-lane"
      data-lineage-id={lane.id}
      aria-hidden="true"
    >
      <div className="lineage-lane-title">
        <i />
        <strong>{lane.label}</strong>
        <span>{paperCount}</span>
      </div>
      {years.map((year, index) => (
        <div
          className="lineage-year-guide"
          key={year}
          style={{ left: leftGutter + index * yearGap }}
        >
          <span>{year || 'Undated'}</span>
        </div>
      ))}
    </section>
  );
}
