import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownView } from './MarkdownNotes';
import { documentRequest, type PaperAnnotation } from '../services/documents';

interface AnnotationDraft {
  comment: string;
  color: PaperAnnotation['color'];
  expected: PaperAnnotation;
}

function AnnotationCard({
  annotation,
  onOpen,
  onSaved,
  onDraftFlush,
  activation,
}: {
  annotation: PaperAnnotation;
  onOpen: (annotation: PaperAnnotation) => void;
  onSaved: () => Promise<void>;
  onDraftFlush: (id: string, flush: (() => Promise<void>) | null) => void;
  activation?: { nonce: number; edit: boolean };
}) {
  const [comment, setComment] = useState(annotation.comment);
  const [color, setColor] = useState(annotation.color);
  const [busy, setBusy] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expected, setExpected] = useState(annotation);
  const [draftReady, setDraftReady] = useState(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const draftActive = useRef(false);
  const closeFlushes = useRef(0);
  const card = useRef<HTMLElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const handledActivation = useRef<number>();
  useEffect(() => {
    let stopped = false;
    void documentRequest<AnnotationDraft | null>(`annotations/${annotation.id}/draft`)
      .then((draft) => {
        if (stopped) return;
        if (draft) {
          draftActive.current = true;
          setComment(draft.comment);
          setColor(draft.color);
          setExpected(draft.expected);
          setEditing(true);
        }
        setDraftReady(true);
      })
      .catch((failure: Error) => {
        if (!stopped) setError(failure.message);
      });
    return () => {
      stopped = true;
    };
  }, [annotation.id]);
  useEffect(() => {
    if (!activation || activation.nonce === handledActivation.current) return;
    if (activation.edit && (!draftReady || busy || flushing)) return;
    handledActivation.current = activation.nonce;
    if (activation.edit && !editing) {
      draftActive.current = true;
      setComment(annotation.comment);
      setColor(annotation.color);
      setExpected(annotation);
      setEditing(true);
    }
    card.current?.scrollIntoView?.({ block: 'nearest' });
    if (!activation.edit) card.current?.focus({ preventScroll: true });
  }, [activation, annotation, busy, draftReady, editing, flushing]);
  useEffect(() => {
    if (editing && activation?.edit && !busy && !flushing)
      commentInput.current?.focus({ preventScroll: true });
  }, [activation, busy, editing, flushing]);
  const flush = useCallback(async () => {
    if (editing && draftReady) {
      writes.current = writes.current
        .catch(() => {})
        .then(() => {
          // A queued autosave must not recreate a saved or discarded draft.
          if (!draftActive.current) return;
          return documentRequest(`annotations/${annotation.id}/draft`, {
            comment,
            color,
            expected,
          });
        });
    }
    await writes.current;
  }, [annotation.id, color, comment, draftReady, editing, expected]);
  const flushForClose = useCallback(async () => {
    closeFlushes.current += 1;
    setFlushing(true);
    try {
      await flush();
    } finally {
      closeFlushes.current -= 1;
      setFlushing(closeFlushes.current > 0);
    }
  }, [flush]);
  useEffect(() => {
    onDraftFlush(annotation.id, flushForClose);
    const timer = setTimeout(() => {
      void flush().catch((failure: Error) =>
        setError(`Draft could not be saved: ${failure.message}`),
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      onDraftFlush(annotation.id, null);
    };
  }, [annotation.id, flush, flushForClose, onDraftFlush]);
  async function save(remove = false) {
    setBusy(true);
    setError('');
    const mutation = writes.current
      .catch(() => {})
      .then(async () => {
        await documentRequest(`annotations/${annotation.id}`, {
          ...(remove ? { action: 'delete' } : { comment, color }),
          expected: remove ? annotation : expected,
        });
        draftActive.current = false;
        setEditing(false);
      });
    writes.current = mutation;
    try {
      await mutation;
      await onSaved();
    } catch (failure) {
      if (writes.current === mutation) writes.current = Promise.resolve();
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      ref={card}
      tabIndex={-1}
      className={`annotation-card highlight-${annotation.color}${activation ? ' active' : ''}`}
      aria-label={`Highlight on page ${annotation.page}`}
    >
      <button className="annotation-anchor" onClick={() => onOpen(annotation)}>
        Open page {annotation.page}
      </button>
      <blockquote>{annotation.quote}</blockquote>
      {editing ? (
        <>
          <label>
            Comment
            <textarea
              ref={commentInput}
              aria-label="Highlight comment"
              rows={3}
              value={comment}
              disabled={busy || flushing}
              maxLength={10000}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <label>
            Color
            <select
              aria-label="Highlight color"
              value={color}
              disabled={busy || flushing}
              onChange={(event) => setColor(event.target.value as PaperAnnotation['color'])}
            >
              {(['yellow', 'blue', 'green', 'pink'] as const).map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={busy || flushing}
            onClick={() => void save()}
          >
            Save comment
          </button>
          <button
            className="button secondary"
            disabled={busy || flushing}
            onClick={async () => {
              setBusy(true);
              const mutation = writes.current
                .catch(() => {})
                .then(async () => {
                  await documentRequest(`annotations/${annotation.id}/draft`, {
                    action: 'discard',
                  });
                  draftActive.current = false;
                  setComment(annotation.comment);
                  setColor(annotation.color);
                  setExpected(annotation);
                  setEditing(false);
                });
              writes.current = mutation;
              try {
                await mutation;
              } catch (failure) {
                if (writes.current === mutation) writes.current = Promise.resolve();
                setError((failure as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Keep saved version
          </button>
        </>
      ) : (
        <>
          {annotation.comment ? (
            <div className="annotation-comment">
              <strong>Comment</strong>
              <MarkdownView text={annotation.comment} />
            </div>
          ) : (
            <p className="annotation-empty-comment">Add your thoughts to this passage.</p>
          )}
          <button
            className="button secondary"
            disabled={!draftReady || busy || flushing}
            onClick={() => {
              draftActive.current = true;
              setComment(annotation.comment);
              setColor(annotation.color);
              setExpected(annotation);
              setEditing(true);
            }}
          >
            {annotation.comment ? 'Edit comment' : 'Add comment'}
          </button>
          <button
            className="button secondary"
            disabled={busy || flushing}
            onClick={() => setConfirmDelete(true)}
          >
            Remove highlight
          </button>
        </>
      )}
      {confirmDelete && (
        <p className="research-warning">
          Remove this highlight and its comment?
          <button
            className="button secondary"
            disabled={busy || flushing}
            onClick={() => void save(true)}
          >
            Remove
          </button>
          <button className="button secondary" onClick={() => setConfirmDelete(false)}>
            Keep highlight
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="research-warning">
          {error}
        </p>
      )}
    </article>
  );
}

export function PaperAnnotations({
  annotations,
  onOpen,
  onSaved,
  onDraftFlush,
  annotationRequest,
}: {
  annotations: PaperAnnotation[];
  onOpen: (annotation: PaperAnnotation) => void;
  onSaved: () => Promise<void>;
  onDraftFlush: (flush: () => Promise<void>) => void;
  annotationRequest?: { id: string; nonce: number; edit: boolean } | null;
}) {
  const drafts = useRef(new Map<string, () => Promise<void>>());
  const register = useCallback((id: string, flush: (() => Promise<void>) | null) => {
    if (flush) drafts.current.set(id, flush);
    else drafts.current.delete(id);
  }, []);
  useEffect(() => {
    onDraftFlush(async () => {
      await Promise.all([...drafts.current.values()].map((flush) => flush()));
    });
  }, [onDraftFlush]);
  return (
    <section className="paper-annotations" aria-label="Paper highlights">
      <h3>
        Highlights & comments <span>{annotations.length}</span>
      </h3>
      {!annotations.length && (
        <p className="research-caption">
          Select text in the original, then choose Highlight and comment.
        </p>
      )}
      {annotations.map((annotation) => (
        <AnnotationCard
          key={annotation.id}
          annotation={annotation}
          onOpen={onOpen}
          onSaved={onSaved}
          onDraftFlush={register}
          activation={
            annotationRequest?.id === annotation.id ? annotationRequest : undefined
          }
        />
      ))}
    </section>
  );
}
