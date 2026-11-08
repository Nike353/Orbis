import { useCallback, useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  ChevronLeft,
  ChevronRight,
  Highlighter,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import {
  documentRequest,
  originalFileUrl,
  type HighlightRect,
  type OriginalDocument,
  type PaperAnnotation,
  type SelectedPassage,
  type SourcePage,
} from '../services/documents';
import {
  resolvePdfReference,
  type PdfCitationLink,
  type PdfReference,
} from '../services/pdfReferences';
import { MarkdownView } from './MarkdownNotes';
import { PdfPage, type PdfPreviewItem } from './PdfPage';

GlobalWorkerOptions.workerSrc = workerUrl;

type ReadingPosition = { page: number; y: number };
type ReaderPreview = PdfPreviewItem & { page: number; left: number; top: number };
type ReaderSelection = {
  passage: SelectedPassage;
  pdf: PDFDocumentProxy;
  width: number;
  zoom: number;
};

export default function PdfReader({
  document,
  page,
  onPage,
  annotations,
  onHighlight,
  onDiscuss,
  annotationRequest,
  onOpenAnnotation,
}: {
  document: OriginalDocument;
  page: number;
  onPage: (page: number) => void;
  annotations: PaperAnnotation[];
  onHighlight: (
    selection: SelectedPassage,
    comment?: boolean,
    isCurrent?: () => boolean,
  ) => Promise<void>;
  onDiscuss: (selection: SelectedPassage) => void;
  annotationRequest?: { id: string; nonce: number } | null;
  onOpenAnnotation: (annotation: PaperAnnotation, edit?: boolean) => void;
}) {
  const viewportElement = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrollFrame = useRef<number>();
  const jumpPosition = useRef<ReadingPosition | null>(null);
  const reportedPage = useRef<number | null>(null);
  const jumpGeneration = useRef(0);
  const mounted = useRef(true);
  const revealedAnnotation = useRef<number>();
  const [loadedPdf, setLoadedPdf] = useState<{
    id: string;
    pdf: PDFDocumentProxy;
    aspectRatio: number;
  } | null>(null);
  const pdf = loadedPdf?.id === document.id ? loadedPdf.pdf : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(640);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SourcePage[]>([]);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [focusedPage, setFocusedPage] = useState<number | null>(null);
  const [renderRevision, setRenderRevision] = useState(0);
  const [preview, setPreview] = useState<ReaderPreview | null>(null);
  const [reference, setReference] = useState<PdfReference | null>(null);
  const [referenceReturn, setReferenceReturn] = useState<ReadingPosition | null>(null);
  const identity = useRef({ pdf, page, documentId: document.id, selection, width });
  identity.current = { pdf, page, documentId: document.id, selection, width };
  const selectionReady =
    selection?.pdf === pdf && selection?.width === width && selection?.zoom === zoom;

  const pageElement = useCallback(
    (number: number) =>
      viewportElement.current?.querySelector<HTMLDivElement>(
        `.pdf-page[data-page="${number}"]`,
      ),
    [],
  );
  const readPosition = useCallback((): ReadingPosition | null => {
    const viewport = viewportElement.current;
    const pages = viewport?.querySelectorAll<HTMLDivElement>('.pdf-page');
    if (!viewport || !pages?.length) return null;
    const top = viewport.getBoundingClientRect().top + 32;
    let low = 0;
    let high = pages.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pages[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const bounds = pages[low].getBoundingClientRect();
    return {
      page: Number(pages[low].dataset.page),
      y: bounds.height ? Math.max(0, Math.min(1, (top - bounds.top) / bounds.height)) : 0,
    };
  }, []);
  const scrollToPassage = useCallback(
    (position: ReadingPosition) => {
      const element = pageElement(position.page);
      const viewport = viewportElement.current;
      if (!element || !viewport) return;
      const bounds = element.getBoundingClientRect();
      viewport.scrollTo({
        top:
          viewport.scrollTop +
          bounds.top -
          viewport.getBoundingClientRect().top +
          position.y * bounds.height -
          32,
      });
      if (element.getAttribute('aria-busy') === 'false') jumpPosition.current = null;
    },
    [pageElement],
  );
  const positionPage = useCallback(
    (position: ReadingPosition) => {
      jumpGeneration.current += 1;
      setPreview(null);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      jumpPosition.current = position;
      scrollToPassage(position);
    },
    [scrollToPassage],
  );
  const requestPage = useCallback(
    (number: number, y = 0) => {
      const current = identity.current;
      if (!current.pdf) return;
      const next = Math.min(current.pdf.numPages, Math.max(1, number));
      reportedPage.current = next !== current.page ? next : null;
      positionPage({ page: next, y });
      if (next !== current.page) onPage(next);
    },
    [onPage, positionPage],
  );
  const onPageReady = useCallback(() => setRenderRevision((revision) => revision + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      jumpGeneration.current += 1;
      clearTimeout(previewTimer.current);
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  useEffect(() => {
    const element = viewportElement.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(240, entry.contentRect.width);
      if (next === identity.current.width) return;
      jumpPosition.current = readPosition();
      setSelection(null);
      setPreview(null);
      setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [readPosition]);

  useEffect(() => {
    let disposed = false;
    jumpGeneration.current += 1;
    setLoadedPdf(null);
    setLoading(true);
    setError('');
    setSelection(null);
    setPreview(null);
    setMatches([]);
    setFocusedPage(null);
    setReferenceReturn(null);
    jumpPosition.current = null;
    reportedPage.current = null;
    revealedAnnotation.current = undefined;
    const task = getDocument({
      url: originalFileUrl(document.id),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      iccUrl: '/pdfjs/iccs/',
      wasmUrl: '/pdfjs/wasm/',
      useWasm: false,
      enableXfa: false,
      maxImageSize: 16_000_000,
      stopAtErrors: true,
    });
    void task.promise
      .then(async (loaded) => {
        if (disposed) return;
        const first = await loaded.getPage(1);
        if (disposed) return;
        const viewport = first.getViewport({ scale: 1 });
        setLoadedPdf({
          id: document.id,
          pdf: loaded,
          aspectRatio: viewport.height / viewport.width,
        });
      })
      .catch((failure: Error) => {
        if (!disposed) setError(`PDF could not be opened: ${failure.message}`);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      void task.destroy().catch(() => {});
    };
  }, [document.id]);

  useEffect(() => {
    if (!pdf) return;
    if (page < 1 || page > pdf.numPages) {
      onPage(Math.min(pdf.numPages, Math.max(1, page)));
      return;
    }
    // A remembered page reported by scrolling is an acknowledgement, not a jump.
    if (reportedPage.current === page) {
      reportedPage.current = null;
      return;
    }
    positionPage({ page, y: 0 });
  }, [onPage, page, pdf, positionPage]);

  useEffect(() => {
    if (jumpPosition.current) scrollToPassage(jumpPosition.current);
  }, [pdf, renderRevision, scrollToPassage, width, zoom]);

  useEffect(() => {
    if (
      !pdf ||
      !annotationRequest ||
      revealedAnnotation.current === annotationRequest.nonce
    )
      return;
    const annotation = annotations.find(
      (item) => item.id === annotationRequest.id && item.document_id === document.id,
    );
    if (!annotation?.rects.length) return;
    revealedAnnotation.current = annotationRequest.nonce;
    requestPage(annotation.page, annotation.rects[0].y);
  }, [annotationRequest, annotations, document.id, pdf, requestPage]);

  const destination = preview?.kind === 'reference' ? preview.link.destination : '';
  useEffect(() => {
    setReference(null);
    if (!pdf || !destination) return;
    let stopped = false;
    void resolvePdfReference(pdf, destination)
      .then((value) => {
        if (!stopped) setReference(value);
      })
      .catch(() => {
        if (!stopped)
          setReference({
            text: '',
            page: null,
            y: null,
            unavailable: 'This reference could not be read from the PDF.',
          });
      });
    return () => {
      stopped = true;
    };
  }, [destination, pdf]);

  const dismissPreview = useCallback(() => {
    clearTimeout(previewTimer.current);
    if (
      preview?.kind === 'annotation' &&
      window.document.activeElement?.closest('.reader-popover')
    ) {
      const trigger = Array.from(
        pageElement(preview.page)?.querySelectorAll<HTMLButtonElement>(
          '.annotation-marker',
        ) ?? [],
      ).find((element) => element.dataset.annotationId === preview.annotation.id);
      trigger?.focus({ preventScroll: true });
    }
    setPreview(null);
  }, [pageElement, preview]);
  useEffect(() => {
    if (!preview) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissPreview();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [dismissPreview, preview]);

  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      void documentRequest<{ pages: SourcePage[] }>(
        `documents/${document.id}/pages?query=${encodeURIComponent(query.trim())}`,
      )
        .then((result) => {
          if (!disposed) setMatches(result.pages);
        })
        .catch((failure: Error) => {
          if (!disposed) setError(failure.message);
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [document.id, query]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !target?.closest('.pdf-viewport')
      )
        return;
      else if (
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) ||
        (event.key === ' ' && !target.closest('button, a, [role="link"]'))
      ) {
        jumpPosition.current = null;
        jumpGeneration.current += 1;
      } else if (target.closest('button, a, [role="link"]')) return;
      else if (event.key === 'ArrowRight' && pdf && page < pdf.numPages) {
        event.preventDefault();
        requestPage(page + 1);
      } else if (event.key === 'ArrowLeft' && page > 1) {
        event.preventDefault();
        requestPage(page - 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [page, pdf, requestPage]);

  function captureSelection(number: number) {
    const selected = window.getSelection();
    const element = pageElement(number);
    if (
      !pdf ||
      !element ||
      element.getAttribute('aria-busy') !== 'false' ||
      !selected?.rangeCount ||
      selected.isCollapsed
    ) {
      setSelection(null);
      return;
    }
    const range = selected.getRangeAt(0);
    if (!element.querySelector('.textLayer')?.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const text = selected.toString().trim();
    if (!text || text.length > 4000) {
      setSelection(null);
      return;
    }
    const bounds = element.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .slice(0, 200)
      .map((r) => {
        const x = Math.max(0, Math.min(1, (r.left - bounds.left) / bounds.width));
        const y = Math.max(0, Math.min(1, (r.top - bounds.top) / bounds.height));
        return {
          x,
          y,
          width: Math.min(1 - x, r.width / bounds.width),
          height: Math.min(1 - y, r.height / bounds.height),
        };
      });
    setSelection({
      passage: { document_id: document.id, page: number, text, rects },
      pdf,
      width,
      zoom,
    });
  }

  async function highlight(comment = false) {
    if (!selection || !selectionReady) return;
    const isCurrent = () =>
      mounted.current &&
      identity.current.documentId === document.id &&
      identity.current.selection === selection;
    setSavingHighlight(true);
    try {
      await onHighlight(selection.passage, comment, isCurrent);
      if (isCurrent()) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    } catch (failure) {
      if (mounted.current && identity.current.documentId === document.id)
        setError((failure as Error).message);
    } finally {
      if (mounted.current) setSavingHighlight(false);
    }
  }

  function showPreview(number: number, item: PdfPreviewItem, rect: HighlightRect) {
    clearTimeout(previewTimer.current);
    const bounds = pageElement(number)?.getBoundingClientRect();
    if (!bounds) return;
    const popupWidth = Math.min(380, window.innerWidth - 32);
    const popupHeight = Math.min(300, window.innerHeight - 32);
    const below = bounds.top + (rect.y + rect.height) * bounds.height + 8;
    setPreview((previous) => {
      if (
        previous?.page === number &&
        previous.kind === 'reference' &&
        item.kind === 'reference' &&
        previous.link === item.link
      )
        return previous;
      if (
        previous?.page === number &&
        previous.kind === 'annotation' &&
        item.kind === 'annotation' &&
        previous.annotation.id === item.annotation.id
      )
        return previous;
      return {
        ...item,
        page: number,
        left: Math.max(
          16,
          Math.min(
            bounds.left + rect.x * bounds.width,
            window.innerWidth - popupWidth - 16,
          ),
        ),
        top: Math.max(
          16,
          Math.min(
            below + popupHeight <= window.innerHeight - 16
              ? below
              : bounds.top + rect.y * bounds.height - popupHeight - 8,
            window.innerHeight - popupHeight - 16,
          ),
        ),
      };
    });
  }

  function hidePreviewSoon() {
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      if (
        window.document.activeElement?.closest(
          '.reader-popover, .annotation-marker, .pdf-citation-link',
        )
      )
        return;
      setPreview(null);
    }, 200);
  }

  async function jumpToReference(sourcePage: number, link: PdfCitationLink) {
    if (!pdf) return;
    const generation = ++jumpGeneration.current;
    const value = await resolvePdfReference(pdf, link.destination).catch(() => null);
    if (
      !mounted.current ||
      generation !== jumpGeneration.current ||
      identity.current.pdf !== pdf ||
      identity.current.documentId !== document.id
    )
      return;
    if (!value?.page || value.y === null) {
      showPreview(sourcePage, { kind: 'reference', link }, link.rect);
      return;
    }
    setReferenceReturn(readPosition() ?? { page: sourcePage, y: 0 });
    requestPage(value.page, value.y);
  }

  function onScroll() {
    setPreview(null);
    if (jumpPosition.current) return;
    jumpGeneration.current += 1;
    if (scrollFrame.current !== undefined) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      const position = readPosition();
      if (!position || position.page === identity.current.page || jumpPosition.current)
        return;
      reportedPage.current = position.page;
      onPage(position.page);
    });
  }

  return (
    <section className="pdf-reader" aria-label="PDF reader">
      <div className="reader-toolbar">
        {referenceReturn && (
          <button
            className="reader-reference-back"
            onClick={() => {
              requestPage(referenceReturn.page, referenceReturn.y);
              setReferenceReturn(null);
            }}
          >
            <ChevronLeft size={15} /> Back to citation
          </button>
        )}
        <div className="reader-page-controls">
          <button
            className="icon-button"
            aria-label="Previous page"
            disabled={page <= 1 || !pdf}
            onClick={() => requestPage(page - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <label>
            Page{' '}
            <input
              aria-label="PDF page"
              type="number"
              min={1}
              max={pdf?.numPages ?? 1}
              value={page}
              onChange={(event) => requestPage(Number(event.target.value))}
            />
            <span> of {pdf?.numPages ?? '…'}</span>
          </label>
          <button
            className="icon-button"
            aria-label="Next page"
            disabled={!pdf || page >= pdf.numPages}
            onClick={() => requestPage(page + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <label className="reader-zoom">
          Zoom{' '}
          <select
            aria-label="PDF zoom"
            value={zoom}
            onChange={(event) => {
              jumpPosition.current = readPosition();
              jumpGeneration.current += 1;
              setSelection(null);
              setPreview(null);
              window.getSelection()?.removeAllRanges();
              setZoom(Number(event.target.value));
            }}
          >
            <option value={0.75}>75%</option>
            <option value={1}>Fit width</option>
            <option value={1.25}>125%</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
          </select>
        </label>
        <label className="reader-search">
          <Search size={15} />
          <input
            ref={searchInput}
            type="search"
            aria-label="Search PDF text"
            placeholder="Find in paper"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {query.trim() && (
        <div className="reader-search-results" aria-live="polite">
          <span>{matches.length} matching pages</span>
          {matches.map((match) => (
            <button key={match.page} onClick={() => requestPage(match.page)}>
              Page {match.page} · {match.section}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="reader-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="pdf-viewport"
        ref={viewportElement}
        tabIndex={0}
        aria-label="PDF page content"
        onScroll={onScroll}
        onPointerDown={() => {
          jumpPosition.current = null;
          jumpGeneration.current += 1;
        }}
        onWheel={() => {
          jumpPosition.current = null;
          jumpGeneration.current += 1;
        }}
        onFocusCapture={(event) => {
          const element = event.target.closest<HTMLElement>('.pdf-page');
          setFocusedPage(element ? Number(element.dataset.page) : null);
        }}
        onBlurCapture={(event) => {
          const element =
            event.relatedTarget instanceof Element
              ? event.relatedTarget.closest<HTMLElement>('.pdf-page')
              : null;
          setFocusedPage(element ? Number(element.dataset.page) : null);
        }}
      >
        {loading && (
          <p className="reader-loading" role="status">
            Opening your original…
          </p>
        )}
        {pdf && (
          <div className="pdf-pages">
            {Array.from({ length: pdf.numPages }, (_, index) => {
              const number = index + 1;
              return (
                <PdfPage
                  key={`${document.id}:${number}`}
                  pdf={pdf}
                  page={number}
                  width={width}
                  zoom={zoom}
                  aspectRatio={loadedPdf!.aspectRatio}
                  viewport={viewportElement}
                  pinned={
                    number === page ||
                    number === selection?.passage.page ||
                    number === focusedPage ||
                    number === preview?.page
                  }
                  annotations={annotations.filter(
                    (annotation) =>
                      annotation.document_id === document.id && annotation.page === number,
                  )}
                  activeAnnotation={annotationRequest?.id}
                  preview={preview}
                  onReady={onPageReady}
                  onSelect={captureSelection}
                  onPreview={showPreview}
                  onHidePreview={hidePreviewSoon}
                  onDismissPreview={() => setPreview(null)}
                  onJumpReference={(source, link) => {
                    void jumpToReference(source, link);
                  }}
                  onOpenAnnotation={(annotation) => {
                    setPreview(null);
                    setSelection(null);
                    window.getSelection()?.removeAllRanges();
                    onOpenAnnotation(annotation);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
      {preview && (
        <div
          className="reader-popover"
          id={
            preview.kind === 'reference' ? 'pdf-reference-preview' : 'pdf-highlight-preview'
          }
          role={preview.kind === 'reference' ? 'tooltip' : 'dialog'}
          aria-label={preview.kind === 'reference' ? 'PDF reference' : 'Highlight comment'}
          style={{ left: preview.left, top: preview.top }}
          onPointerEnter={() => clearTimeout(previewTimer.current)}
          onPointerLeave={hidePreviewSoon}
          onFocusCapture={() => clearTimeout(previewTimer.current)}
          onBlurCapture={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              hidePreviewSoon();
          }}
        >
          <div className="reader-popover-heading">
            <strong>
              {preview.kind === 'reference'
                ? reference?.page
                  ? `Reference · PDF page ${reference.page}`
                  : 'Reference'
                : `Highlight · page ${preview.annotation.page}`}
            </strong>
            {preview.kind === 'annotation' && (
              <button
                className="icon-button"
                aria-label="Close highlight preview"
                onClick={dismissPreview}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="reader-popover-body">
            {preview.kind === 'reference' ? (
              <p>
                {reference
                  ? reference.text || reference.unavailable
                  : 'Reading the reference…'}
              </p>
            ) : (
              <>
                <blockquote>{preview.annotation.quote}</blockquote>
                {preview.annotation.comment ? (
                  <MarkdownView text={preview.annotation.comment} />
                ) : (
                  <p>No comment yet.</p>
                )}
              </>
            )}
          </div>
          {preview.kind === 'reference' ? (
            <small>
              {reference?.page
                ? 'Click the citation to open its reference.'
                : 'Press Escape to close.'}
            </small>
          ) : (
            <button
              className="button secondary"
              onClick={() => {
                onOpenAnnotation(preview.annotation, true);
                setPreview(null);
              }}
            >
              <MessageSquare size={15} />
              {preview.annotation.comment ? 'Edit comment' : 'Add comment'}
            </button>
          )}
        </div>
      )}
      {selection && selectionReady && (
        <div className="selection-actions">
          <span>
            {selection.passage.text.slice(0, 90)}
            {selection.passage.text.length > 90 ? '…' : ''}
          </span>
          <button
            className="button secondary"
            disabled={savingHighlight}
            onClick={() => void highlight(true)}
          >
            <MessageSquare size={15} /> Highlight and comment
          </button>
          <button
            className="button secondary"
            disabled={savingHighlight}
            onClick={() => void highlight()}
          >
            <Highlighter size={15} /> {savingHighlight ? 'Saving…' : 'Highlight'}
          </button>
          <button className="button primary" onClick={() => onDiscuss(selection.passage)}>
            <MessageSquare size={15} /> Ask about selection
          </button>
        </div>
      )}
    </section>
  );
}
