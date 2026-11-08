import type { ResearchTurn } from '../services/research';
import { MarkdownView } from './MarkdownNotes';

type Preview = NonNullable<ResearchTurn['preview']>[number];

export function ResearchProposal({
  preview,
  labels,
}: {
  preview: Preview;
  labels: Map<string, string>;
}) {
  const { action, before, after, reason } = preview;
  const name = (id?: string) => (id ? (labels.get(id) ?? id) : 'Unassigned');
  if ('source' in after)
    return (
      <article className="change-preview">
        <h4>
          Connect {name(after.source)} → {name(after.target)}
        </h4>
        <span className="relation-pill">{after.relation.replaceAll('_', ' ')}</span>
        <MarkdownView text={after.transition_note ?? reason} />
        {after.evidence && (
          <div className="connection-evidence">
            <strong>Supporting evidence</strong>
            <MarkdownView text={after.evidence} />
          </div>
        )}
      </article>
    );
  const previous = before && 'label' in before ? before : null;
  return (
    <article className="change-preview">
      <h4>
        {action === 'summary'
          ? 'Replace paper summary'
          : action === 'note'
            ? 'Add to personal notes'
            : action === 'rename'
              ? 'Rename'
              : action === 'move'
                ? 'Move paper'
                : 'Create record'}{' '}
        · {after.label}
      </h4>
      <p>{reason}</p>
      {action === 'rename' && (
        <p>
          {previous?.label} → <strong>{after.label}</strong>
        </p>
      )}
      {action === 'move' && (
        <p>
          {name(previous?.cluster)} → <strong>{name(after.cluster)}</strong>
        </p>
      )}
      {action === 'create' && <MarkdownView text={after.description ?? ''} />}
      {action === 'note' && (
        <MarkdownView
          text={(after.notes ?? '').slice(previous?.notes?.length ?? 0).trim()}
        />
      )}
      {action === 'summary' && after.paper && (
        <>
          <MarkdownView text={after.paper.summary} />
          {!!after.paper.key_findings.length && (
            <ul>
              {after.paper.key_findings.map((finding, index) => (
                <li key={index}>{finding}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>Previous summary</summary>
            <MarkdownView text={previous?.paper?.summary ?? 'No previous summary.'} />
          </details>
          <p className="research-caption">
            Your personal notes and discussion history are kept.
          </p>
        </>
      )}
    </article>
  );
}
