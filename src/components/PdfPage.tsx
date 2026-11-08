import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import { MessageSquare } from 'lucide-react';
import type { HighlightRect, PaperAnnotation } from '../services/documents';
import { loadPdfCitationLinks, type PdfCitationLink } from '../services/pdfReferences';

export type PdfPreviewItem =
  | { kind: 'reference'; link: PdfCitationLink }
  | { kind: 'annotation'; annotation: PaperAnnotation };

function rectStyle(rect: HighlightRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export function PdfPage({
  pdf,
  page,
  width,
  zoom,
  aspectRatio,
  viewport,
  pinned,
  annotations,
  activeAnnotation,
  preview,
  onReady,
  onSelect,
  onPreview,
  onHidePreview,
  onDismissPreview,
  onJumpReference,
  onOpenAnnotation,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  aspectRatio: number;
  viewport: RefObject<HTMLDivElement>;
  pinned: boolean;
  annotations: PaperAnnotation[];
  activeAnnotation?: string;
  preview: (PdfPreviewItem & { page: number }) | null;
  onReady: () => void;
  onSelect: (page: number) => void;
  onPreview: (page: number, item: PdfPreviewItem, rect: HighlightRect) => void;
  onHidePreview: () => void;
  onDismissPreview: () => void;
  onJumpReference: (page: number, link: PdfCitationLink) => void;
  onOpenAnnotation: (annotation: PaperAnnotation) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  const [ratio, setRatio] = useState(aspectRatio);
  const [links, setLinks] = useState<PdfCitationLink[]>([]);
  const [error, setError] = useState('');
  const [rendered, setRendered] = useState<{
    pdf: PDFDocumentProxy;
    width: number;
    zoom: number;
  } | null>(null);
  const active = nearby || pinned;
  const ready =
    active && rendered?.pdf === pdf && rendered.width === width && rendered.zoom === zoom;

  useEffect(() => {
    if (!element.current || !viewport.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearby(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearby(entry.isIntersecting),
      { root: viewport.current, rootMargin: '800px 0px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [viewport]);

  useEffect(() => {
    const target = canvas.current;
    const container = textLayer.current;
    if (!target || !container) return;
    setRendered(null);
    setLinks([]);
    setError('');
    if (!active) {
      target.width = target.height = 0;
      container.replaceChildren();
      return;
    }
    let disposed = false;
    let current: PDFPageProxy | undefined;
    let renderTask: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const render = async () => {
      current = await pdf.getPage(page);
      if (disposed) return;
      const base = current.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const scale = (width / base.width) * zoom;
      const pageViewport = current.getViewport({ scale });
      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16_000_000 / (pageViewport.width * pageViewport.height)),
      );
      const context = target.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      target.width = Math.floor(pageViewport.width * pixelRatio);
      target.height = Math.floor(pageViewport.height * pixelRatio);
      target.style.width = `${pageViewport.width}px`;
      target.style.height = `${pageViewport.height}px`;
      container.replaceChildren();
      element.current?.style.setProperty('--scale-factor', String(scale));
      element.current?.style.setProperty(
        '--total-scale-factor',
        String(scale * current.userUnit),
      );
      renderTask = current.render({
        canvas: target,
        canvasContext: context,
        viewport: pageViewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await renderTask.promise;
      if (disposed) return;
      const text = await current.getTextContent();
      if (disposed) return;
      layer = new TextLayer({
        textContentSource: text,
        container,
        viewport: pageViewport,
      });
      await layer.render();
      if (disposed) return;
      const citations = await loadPdfCitationLinks(pdf, page).catch(() => []);
      if (disposed) return;
      setLinks(citations);
      setRendered({ pdf, width, zoom });
    };
    void render().catch((failure: Error) => {
      if (!disposed && failure.name !== 'RenderingCancelledException')
        setError(`Page ${page} could not be rendered: ${failure.message}`);
    });
    return () => {
      disposed = true;
      renderTask?.cancel();
      layer?.cancel();
      current?.cleanup();
    };
  }, [active, page, pdf, width, zoom]);

  useEffect(() => {
    if (ready) onReady();
  }, [onReady, ready]);

  function hitAt(clientX: number, clientY: number) {
    if (!ready) return {};
    const bounds = element.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return {};
    const x = (clientX - bounds.left) / bounds.width;
    const y = (clientY - bounds.top) / bounds.height;
    const contains = (rect: HighlightRect) =>
      x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
    return {
      link: links.find((item) => contains(item.rect)),
      annotation: annotations.find((item) => item.rects.some(contains)),
    };
  }

  return (
    <div
      className="pdf-page"
      ref={element}
      data-page={page}
      aria-label={`Paper page ${page}`}
      aria-busy={!ready}
      style={{ width: width * zoom, height: width * zoom * ratio }}
      onPointerUp={() => onSelect(page)}
      onKeyUp={() => onSelect(page)}
      onPointerMove={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) return;
        if (event.buttons || window.getSelection()?.isCollapsed === false) {
          onDismissPreview();
          return;
        }
        const { link, annotation } = hitAt(event.clientX, event.clientY);
        if (link) onPreview(page, { kind: 'reference', link }, link.rect);
        else if (annotation)
          onPreview(page, { kind: 'annotation', annotation }, annotation.rects[0]);
        else onHidePreview();
      }}
      onPointerLeave={onHidePreview}
      onClick={(event) => {
        if (
          !event.detail ||
          (event.target instanceof Element && event.target.closest('button')) ||
          window.getSelection()?.isCollapsed === false
        )
          return;
        const { link, annotation } = hitAt(event.clientX, event.clientY);
        if (link) onJumpReference(page, link);
        else if (annotation) onOpenAnnotation(annotation);
      }}
    >
      {!ready && (
        <div className="pdf-page-placeholder">
          {error ? (
            <p className="reader-error" role="alert">
              {error}
            </p>
          ) : (
            <span>Page {page}</span>
          )}
        </div>
      )}
      <canvas ref={canvas} aria-label={`PDF page ${page}`} />
      <div ref={textLayer} className="textLayer" />
      <div className="page-highlights" aria-hidden="true">
        {ready &&
          annotations.flatMap((annotation) =>
            annotation.rects.map((rect, i) => (
              <span
                key={`${annotation.id}:${i}`}
                className={`page-highlight highlight-${annotation.color}${activeAnnotation === annotation.id ? ' active' : ''}`}
                style={rectStyle(rect)}
              />
            )),
          )}
      </div>
      {ready && (
        <div className="pdf-page-controls">
          {links.map((link, index) => (
            <button
              key={`${link.destination}:${index}`}
              className="pdf-citation-link"
              role="link"
              aria-label={`Reference ${link.destination.replace(/^cite[.:]/, '')}`}
              aria-describedby={
                preview?.kind === 'reference' &&
                preview.page === page &&
                preview.link === link
                  ? 'pdf-reference-preview'
                  : undefined
              }
              style={rectStyle(link.rect)}
              onFocus={() => onPreview(page, { kind: 'reference', link }, link.rect)}
              onBlur={onHidePreview}
              onClick={() => onJumpReference(page, link)}
            />
          ))}
          {annotations.map((annotation) => {
            const rect = annotation.rects[0];
            if (!rect) return null;
            return (
              <button
                key={annotation.id}
                className={`annotation-marker highlight-${annotation.color}`}
                data-annotation-id={annotation.id}
                aria-label={`View highlight: ${annotation.quote.slice(0, 80)}`}
                aria-expanded={
                  preview?.kind === 'annotation' && preview.annotation.id === annotation.id
                }
                aria-controls="pdf-highlight-preview"
                style={{ top: `${rect.y * 100}%` }}
                onPointerEnter={() =>
                  onPreview(page, { kind: 'annotation', annotation }, rect)
                }
                onFocus={(event) => {
                  if (
                    event.relatedTarget instanceof Element &&
                    event.relatedTarget.closest('.reader-popover')
                  )
                    return;
                  onPreview(page, { kind: 'annotation', annotation }, rect);
                }}
                onBlur={onHidePreview}
                onClick={() => onOpenAnnotation(annotation)}
              >
                <MessageSquare size={14} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
