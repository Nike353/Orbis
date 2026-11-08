import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  ArrowLeft,
  BookOpen,
  ExternalLink,
  FilePlus2,
  Orbit,
  PanelLeft,
  Upload,
} from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  attachOriginal,
  documentRequest,
  originalFileUrl,
  type ActivityJob,
  type DocumentListing,
  type OriginalDocument,
  type PaperAnnotation,
  type SelectedPassage,
} from '../services/documents';
import type { ResearchCitation } from '../services/research';
import { MarkdownNotes, MarkdownView } from './MarkdownNotes';
import { ResearchDesk } from './ResearchDesk';
import { PaperAnnotations } from './PaperAnnotations';
import { ArticleReader } from './ArticleReader';

const PdfReader = lazy(() => import('./PdfReader'));
const TABS = ['Summary', 'My notes', 'Discuss', 'Connections'] as const;
type PaperTab = (typeof TABS)[number];

export default function PaperWorkspace() {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const workspace = useWorkspaceStore((state) => state.paperWorkspace)!;
  const closePaper = useWorkspaceStore((state) => state.closePaper);
  const openPaper = useWorkspaceStore((state) => state.openPaper);
  const updateNode = useWorkspaceStore((state) => state.updateNode);
  const select = useWorkspaceStore((state) => state.select);
  const openResearch = useWorkspaceStore((state) => state.openResearch);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const save = useWorkspaceStore((state) => state.save);
  const node = graph.nodes.find((item) => item.id === workspace.nodeId);
  const [tab, setTab] = useState<PaperTab>(workspace.tab ?? 'Summary');
  const [summaryRequest, setSummaryRequest] = useState<{ text: string; nonce: number }>();
  const [listing, setListing] = useState<DocumentListing>({
    documents: [],
    annotations: [],
  });
  const [documentId, setDocumentId] = useState(workspace.documentId ?? '');
  const [page, setPage] = useState(workspace.page ?? 1);
  const [sourceNote, setSourceNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceUrl, setSourceUrl] = useState(node?.paper?.url ?? '');
  const [fetchJob, setFetchJob] = useState<ActivityJob | null>(null);
  const [selectedPassage, setSelectedPassage] = useState<SelectedPassage | null>(null);
  const [annotationRequest, setAnnotationRequest] = useState<{
    id: string;
    nonce: number;
    edit: boolean;
  } | null>(null);
  const [sideWidth, setSideWidth] = useState(440);
  const [libraryVisible, setLibraryVisible] = useState(false);
  const [query, setQuery] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const flushDraft = useRef<(() => Promise<void>) | null>(null);
  const flushAnnotations = useRef<(() => Promise<void>) | null>(null);
  const readerIntent = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const document = listing.documents.find((item) => item.id === documentId);
  useEffect(() => {
    readerIntent.current += 1;
  }, [documentId, page]);
  const connections = graph.edges.filter(
    (edge) => edge.source === workspace.nodeId || edge.target === workspace.nodeId,
  );
  const papers = graph.nodes.filter(
    (item) =>
      item.type === 'paper' &&
      `${item.label} ${item.paper?.title ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  const reload = useCallback(async () => {
    const value = await documentRequest<DocumentListing>(
      `documents?node_id=${encodeURIComponent(workspace.nodeId)}`,
    );
    setListing(value);
    return value;
  }, [workspace.nodeId]);
  const registerDraft = useCallback((flush: () => Promise<void>) => {
    flushDraft.current = flush;
  }, []);
  const registerAnnotations = useCallback((flush: () => Promise<void>) => {
    flushAnnotations.current = flush;
  }, []);
  useEffect(() => {
    if (!window.orbis) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void reload().catch((failure: Error) => setError(failure.message));
      }, 200);
    };
    const remove = window.orbis.onDocumentsChanged(changed);
    const removeLibrary = window.orbis.onLibraryChanged(changed);
    return () => {
      clearTimeout(timer);
      remove();
      removeLibrary();
    };
  }, [reload]);

  useEffect(() => {
    if (workspace.tab) setTab(workspace.tab);
  }, [workspace.nonce, workspace.tab]);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    void (async () => {
      try {
        const [value, notes, activity] = await Promise.all([
          reload(),
          fetch(`/api/notes?id=${encodeURIComponent(workspace.nodeId)}`).then((response) =>
            response.ok ? response.json() : { text: '' },
          ),
          documentRequest<{ jobs: ActivityJob[] }>('activity').catch(() => ({ jobs: [] })),
        ]);
        if (stopped) return;
        setSourceNote(notes.text);
        const latest = [...value.documents].sort((a, b) =>
          b.retrieved_at.localeCompare(a.retrieved_at),
        )[0];
        const initial =
          value.documents.find((item) => item.id === workspace.documentId) ?? latest;
        if (initial) {
          setDocumentId(initial.id);
          setPage(workspace.page ?? initial.last_page ?? 1);
        }
        setFetchJob(
          activity.jobs.find(
            (job) =>
              job.kind === 'document' &&
              job.node_id === workspace.nodeId &&
              ['queued', 'fetching', 'reading'].includes(job.status),
          ) ?? null,
        );
      } catch (failure) {
        if (!stopped) setError((failure as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
    // The workspace is keyed by paper; subsequent nonce changes are citation jumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, workspace.nodeId]);

  useEffect(() => {
    if (!workspace.documentId) return;
    setDocumentId(workspace.documentId);
    setPage(workspace.page ?? 1);
  }, [workspace.documentId, workspace.page, workspace.nonce]);

  useEffect(() => {
    if (!fetchJob || !['queued', 'fetching', 'reading'].includes(fetchJob.status)) return;
    let stopped = false;
    const timer = setInterval(() => {
      void documentRequest<{ jobs: ActivityJob[] }>('activity')
        .then(async (value) => {
          const job = value.jobs.find((item) => item.id === fetchJob.id);
          if (!job || stopped) return;
          if (job.status === 'completed') {
            const updated = await reload();
            if (!stopped && job.document_id) {
              setDocumentId(job.document_id);
              setPage(1);
              setListing(updated);
            }
          } else if (job.error) setError(job.error);
          // Changing the job stops this effect, so select its original first.
          if (!stopped) setFetchJob(job);
        })
        .catch((failure: Error) => {
          if (!stopped) setError(failure.message);
        });
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fetchJob, reload]);

  useEffect(() => {
    if (!documentId || loading) return;
    const timer = setTimeout(() => {
      void documentRequest(`documents/${documentId}/local`, { last_page: page }).catch(
        (failure: Error) => setError(failure.message),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [documentId, loading, page]);

  const navigate = useCallback(
    async (action: () => void) => {
      try {
        await flushDraft.current?.();
        await flushAnnotations.current?.();
        if (documentId && !loading)
          await documentRequest(`documents/${documentId}/local`, { last_page: page });
        action();
      } catch (failure) {
        setError(`Your discussion draft is preserved here: ${(failure as Error).message}`);
      }
    },
    [documentId, loading, page],
  );
  useEffect(() => {
    const flush = (event: Event) => {
      const writes = (event as CustomEvent<Promise<unknown>[]>).detail;
      writes.push(
        Promise.all([
          flushDraft.current?.(),
          flushAnnotations.current?.(),
          documentId && !loading
            ? documentRequest(`documents/${documentId}/local`, { last_page: page })
            : undefined,
        ]),
      );
    };
    window.addEventListener('orbis:flushDrafts', flush);
    return () => window.removeEventListener('orbis:flushDrafts', flush);
  }, [documentId, loading, page]);
  useEffect(() => {
    const previous = window.document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', trap);
    return () => {
      window.removeEventListener('keydown', trap);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        void navigate(closePaper);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [closePaper, navigate]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retrieve() {
    const job = await documentRequest<ActivityJob>('documents/fetch', {
      node_id: workspace.nodeId,
      url: sourceUrl,
    });
    setFetchJob(job);
  }
  async function attach(file: File) {
    const attached = await attachOriginal(workspace.nodeId, file);
    await reload();
    setDocumentId(attached.id);
    setPage(1);
  }
  async function highlight(
    selection: SelectedPassage,
    comment = false,
    isCurrent?: () => boolean,
  ) {
    const intent = readerIntent.current;
    const annotation = await documentRequest<PaperAnnotation>('annotations', {
      document_id: selection.document_id,
      page: selection.page,
      quote: selection.text,
      rects: selection.rects ?? [],
      color: 'yellow',
      comment: '',
    });
    await reload();
    if (comment && intent === readerIntent.current && (isCurrent?.() ?? true))
      openAnnotation(annotation, true);
  }
  function discuss(selection: SelectedPassage) {
    setSelectedPassage(selection);
    setTab('Discuss');
  }
  function openAnnotation(annotation: PaperAnnotation, edit = false) {
    setDocumentId(annotation.document_id);
    setPage(annotation.page);
    setTab('My notes');
    setAnnotationRequest((previous) => ({
      id: annotation.id,
      nonce: (previous?.nonce ?? 0) + 1,
      edit,
    }));
  }
  function citation(cite: ResearchCitation) {
    if (cite.document_id && cite.page)
      void navigate(() => openPaper(cite.node_id, cite.document_id, cite.page));
    else if (cite.node_id === workspace.nodeId) setTab('Summary');
    else
      void navigate(() => {
        closePaper();
        select({ kind: 'node', id: cite.node_id });
      });
  }
  async function offline(value: boolean) {
    if (!document) return;
    await documentRequest(`documents/${document.id}/local`, { keep_offline: value });
    try {
      if (value && !document.available) {
        if (!window.orbis)
          throw new Error(
            'Download this original in the desktop app, or attach a local copy.',
          );
        await window.orbis.downloadDocument(document.id);
      }
    } finally {
      await reload();
    }
  }
  async function openExternal(original: OriginalDocument) {
    if (window.orbis) await window.orbis.openDocument(original.id);
    else window.open(originalFileUrl(original.id), '_blank', 'noopener');
  }

  if (!node?.paper)
    return (
      <section className="paper-workspace" role="dialog" aria-label="Paper workspace">
        <p>
          This paper is no longer in the current graph. Your original files remain on disk.
        </p>
        <button className="button secondary" onClick={closePaper}>
          Back to galaxy
        </button>
      </section>
    );

  return (
    <section
      ref={dialog}
      className="paper-workspace"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-workspace-title"
      style={{ '--paper-side-width': `${sideWidth}px` } as CSSProperties}
    >
      <header className="paper-workspace-header">
        <button className="button secondary" onClick={() => void navigate(closePaper)}>
          <ArrowLeft size={16} /> Back to galaxy
        </button>
        <button
          className="icon-button"
          aria-label="Browse papers"
          aria-pressed={libraryVisible}
          onClick={() => setLibraryVisible((value) => !value)}
        >
          <PanelLeft size={18} />
        </button>
        <div className="paper-workspace-heading">
          <span className="eyebrow">
            <Orbit size={12} /> Your research universe
          </span>
          <h1 id="paper-workspace-title">{node.paper.title}</h1>
        </div>
        <a
          className="button secondary"
          href={node.paper.url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={15} /> Source
        </a>
        {dirty && (
          <button className="button primary" disabled={busy} onClick={() => void run(save)}>
            Save notes
          </button>
        )}
      </header>
      {error && (
        <div role="alert" className="paper-workspace-error">
          <p>{error}</p>
          <button className="button secondary" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      <div className={`paper-workspace-body${libraryVisible ? ' with-paper-library' : ''}`}>
        {libraryVisible && (
          <aside className="paper-library" aria-label="Reader library">
            <label>
              Find a paper
              <input
                type="search"
                aria-label="Find a paper"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div>
              {papers.slice(0, 200).map((paper) => (
                <button
                  key={paper.id}
                  className={paper.id === node.id ? 'active' : ''}
                  onClick={() => void navigate(() => openPaper(paper.id))}
                >
                  <strong>{paper.label}</strong>
                  <small>{paper.paper?.year ?? 'Undated'}</small>
                </button>
              ))}
            </div>
            {papers.length > 200 && <p>Search to narrow {papers.length} papers.</p>}
          </aside>
        )}
        <main className="paper-original">
          <div className="paper-file-bar">
            <div>
              <BookOpen size={16} />
              {listing.documents.length ? (
                <select
                  aria-label="Paper original"
                  value={documentId}
                  onChange={(event) => {
                    setDocumentId(event.target.value);
                    setPage(1);
                  }}
                >
                  {listing.documents.map((original) => (
                    <option key={original.id} value={original.id}>
                      {original.filename}
                      {original.source_version ? ` · ${original.source_version}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <strong>Original paper</strong>
              )}
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => upload.current?.click()}
            >
              <FilePlus2 size={15} /> Attach file
            </button>
            <input
              ref={upload}
              type="file"
              accept=".pdf,.txt,application/pdf,text/plain"
              aria-label="Attach original file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void run(() => attach(file));
                event.target.value = '';
              }}
            />
          </div>
          {loading ? (
            <div className="reader-empty" role="status">
              Opening this paper’s workspace…
            </div>
          ) : document?.available ? (
            <>
              <div className="paper-file-details">
                <span>
                  {(document.size / 1024 / 1024).toFixed(1)} MB · saved{' '}
                  {document.retrieved_at.slice(0, 10)}
                </span>
                <span className="reader-transfer-state" role="status">
                  {document.transfer_status === 'uploading'
                    ? 'Uploading to Drive…'
                    : document.transfer_status === 'error'
                      ? 'Sync needs attention'
                      : document.remote_available
                        ? 'Available on Drive'
                        : 'Saved locally · awaiting Drive sync'}
                </span>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={document.keep_offline}
                    disabled={busy}
                    onChange={(event) => void run(() => offline(event.target.checked))}
                  />{' '}
                  Keep offline
                </label>
                <button
                  className="text-button"
                  title="Open a separate read-only copy in your default app"
                  onClick={() => void run(() => openExternal(document))}
                >
                  Open externally
                </button>
                {window.orbis && document.remote_available && !document.keep_offline && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.orbis!.removeDocument(document.id);
                        await reload();
                      })
                    }
                  >
                    Remove download
                  </button>
                )}
              </div>
              {document.transfer_error && (
                <p className="reader-text-warning" role="alert">
                  {document.transfer_error}
                </p>
              )}
              {document.text_status !== 'ready' && (
                <p className="reader-text-warning">
                  {document.extraction_error ||
                    'Full text is unavailable; discussion will use library notes.'}
                </p>
              )}
              {document.media_type === 'application/pdf' ? (
                <Suspense
                  fallback={
                    <div className="reader-empty" role="status">
                      Preparing PDF reader…
                    </div>
                  }
                >
                  <PdfReader
                    document={document}
                    page={page}
                    onPage={setPage}
                    annotations={listing.annotations.filter(
                      (a) => a.document_id === document.id,
                    )}
                    onHighlight={highlight}
                    onDiscuss={discuss}
                    annotationRequest={annotationRequest}
                    onOpenAnnotation={openAnnotation}
                  />
                </Suspense>
              ) : (
                <ArticleReader
                  document={document}
                  page={page}
                  onPage={setPage}
                  onHighlight={highlight}
                  onDiscuss={discuss}
                />
              )}
            </>
          ) : (
            <div className="reader-empty">
              <BookOpen size={38} />
              <h2>
                {document
                  ? 'Original is not downloaded here'
                  : 'Bring the original alongside your ideas'}
              </h2>
              <p>
                {document
                  ? 'Your notes and highlights are here. Download the original to read it on this device.'
                  : 'Retrieve an accessible PDF or article, or attach a file you already have.'}
              </p>
              {document?.transfer_error && (
                <p className="reader-error">{document.transfer_error}</p>
              )}
              {document && window.orbis ? (
                <>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.orbis!.downloadDocument(document.id);
                        await reload();
                      })
                    }
                  >
                    <Upload size={16} /> {busy ? 'Downloading…' : 'Download original'}
                  </button>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={document.keep_offline}
                      disabled={busy}
                      onChange={(event) => void run(() => offline(event.target.checked))}
                    />{' '}
                    Keep offline
                  </label>
                </>
              ) : (
                <div className="original-retrieval">
                  <label>
                    Source URL
                    <input
                      aria-label="Original source URL"
                      type="url"
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !sourceUrl ||
                      Boolean(
                        fetchJob &&
                        ['queued', 'fetching', 'reading'].includes(fetchJob.status),
                      )
                    }
                    onClick={() => void run(retrieve)}
                  >
                    Retrieve original
                  </button>
                </div>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => upload.current?.click()}
              >
                Attach PDF or article
              </button>
              {fetchJob && (
                <p className="reader-transfer-state" role="status">
                  {fetchJob.status === 'reading'
                    ? 'Extracting pages…'
                    : fetchJob.status === 'fetching'
                      ? 'Downloading source…'
                      : fetchJob.status}
                  {['queued', 'fetching', 'reading'].includes(fetchJob.status) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(() =>
                          documentRequest(`activity/${fetchJob.id}/cancel`, {}),
                        )
                      }
                    >
                      Cancel download
                    </button>
                  )}
                </p>
              )}
              <small>
                Originals stay in your library. No access restrictions are bypassed.
              </small>
            </div>
          )}
        </main>
        <div
          className="paper-resize-handle"
          role="separator"
          aria-label="Resize paper side panel"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={680}
          aria-valuenow={sideWidth}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setSideWidth((value) =>
                Math.max(
                  280,
                  Math.min(680, value + (event.key === 'ArrowLeft' ? 20 : -20)),
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            resizeStart.current = { x: event.clientX, width: sideWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!resizeStart.current) return;
            setSideWidth(
              Math.max(
                280,
                Math.min(
                  680,
                  resizeStart.current.width + resizeStart.current.x - event.clientX,
                ),
              ),
            );
          }}
          onPointerUp={() => {
            resizeStart.current = null;
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
        />
        <aside className="paper-side-panel" aria-label="Paper notes and discussion">
          <div className="paper-tabs" role="tablist" aria-label="Paper workspace views">
            {TABS.map((name) => (
              <button
                key={name}
                role="tab"
                id={`paper-tab-${name.replaceAll(' ', '-')}`}
                aria-controls={`paper-panel-${name.replaceAll(' ', '-')}`}
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                    return;
                  event.preventDefault();
                  const index = TABS.indexOf(name);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? TABS.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) %
                          TABS.length;
                  setTab(TABS[next]);
                  const controls =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      '[role=tab]',
                    );
                  controls?.[next]?.focus();
                }}
              >
                {name}
                {name === 'Connections' && <span>{connections.length}</span>}
              </button>
            ))}
          </div>
          <section
            className="paper-tab-panel"
            role="tabpanel"
            id="paper-panel-Summary"
            aria-labelledby="paper-tab-Summary"
            hidden={tab !== 'Summary'}
          >
            <div className="paper-card-meta">
              {node.paper.authors.join(', ')}
              <span>
                {node.paper.year ?? 'Undated'} · {node.paper.venue}
              </span>
            </div>
            <MarkdownView text={node.paper.summary} />
            <button
              className="button secondary"
              disabled={!document?.available || document.text_status !== 'ready'}
              onClick={() => {
                setSummaryRequest({
                  text: 'Regenerate the summary of this paper from its supplied original passages. Propose one summary change for review, covering motivation, background, each framework stage, results with conditions, and author-stated limitations versus inference. Preserve my personal notes and history, and identify missing evidence.',
                  nonce: (summaryRequest?.nonce ?? 0) + 1,
                });
                setTab('Discuss');
              }}
            >
              Regenerate with review
            </button>
            {!!node.paper.key_findings.length && (
              <section>
                <h3>Key findings</h3>
                <ul>
                  {node.paper.key_findings.map((finding) => (
                    <li key={finding}>{finding}</li>
                  ))}
                </ul>
              </section>
            )}
            {sourceNote && (
              <details className="source-paper-note">
                <summary>Imported reading note</summary>
                <p className="research-caption">
                  Saved at import; reviewed summary updates appear above.
                </p>
                <MarkdownView text={sourceNote} />
              </details>
            )}
          </section>
          <section
            className="paper-tab-panel"
            role="tabpanel"
            id="paper-panel-My-notes"
            aria-labelledby="paper-tab-My-notes"
            hidden={tab !== 'My notes'}
          >
            <MarkdownNotes
              label="My notes"
              value={node.notes ?? ''}
              onChange={(notes) => updateNode(node.id, { notes })}
            />
            <PaperAnnotations
              annotations={listing.annotations}
              onOpen={openAnnotation}
              onSaved={async () => {
                await reload();
              }}
              onDraftFlush={registerAnnotations}
              annotationRequest={annotationRequest}
            />
          </section>
          <section
            className="paper-tab-panel paper-discuss-panel"
            role="tabpanel"
            id="paper-panel-Discuss"
            aria-labelledby="paper-tab-Discuss"
            hidden={tab !== 'Discuss'}
          >
            <ResearchDesk
              comparison={false}
              paperId={node.id}
              selectedPassage={selectedPassage}
              onCitation={citation}
              onDraftFlush={registerDraft}
              draftRequest={summaryRequest}
            />
          </section>
          <section
            className="paper-tab-panel"
            role="tabpanel"
            id="paper-panel-Connections"
            aria-labelledby="paper-tab-Connections"
            hidden={tab !== 'Connections'}
          >
            <h2>How this paper connects</h2>
            {!connections.length && (
              <p>
                No connections yet. Discuss related papers to propose evidence-backed
                connections.
              </p>
            )}
            {connections.map((edge) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = graph.nodes.find((item) => item.id === otherId);
              return (
                <article className="paper-connection-card" key={edge.id}>
                  <span className={`status-pill ${edge.status}`}>{edge.status}</span>
                  <h3>{other?.label ?? otherId}</h3>
                  <p className="connection-relation">
                    {edge.source === node.id ? 'Connects to' : 'Connects from'} ·{' '}
                    {edge.relation.replaceAll('_', ' ')}
                  </p>
                  <MarkdownView text={edge.transition_note} />
                  {edge.evidence && (
                    <details open>
                      <summary>Connection evidence</summary>
                      <MarkdownView text={edge.evidence} />
                    </details>
                  )}
                  <div className="research-actions">
                    {other?.type === 'paper' && (
                      <button
                        className="button secondary"
                        onClick={() => void navigate(() => openPaper(otherId))}
                      >
                        Read connected paper
                      </button>
                    )}
                    <button
                      className="button secondary"
                      onClick={() =>
                        void navigate(() => {
                          closePaper();
                          select({ kind: 'edge', id: edge.id });
                        })
                      }
                    >
                      Show connection in galaxy
                    </button>
                  </div>
                </article>
              );
            })}
            <button
              className="button secondary"
              onClick={() =>
                void navigate(() => {
                  closePaper();
                  openResearch([node.id], true);
                })
              }
            >
              Compare with other papers
            </button>
          </section>
        </aside>
      </div>
    </section>
  );
}
