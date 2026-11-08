import { useEffect, useRef, useState } from 'react';
import {
  documentRequest,
  type OriginalDocument,
  type SelectedPassage,
  type SourcePage,
} from '../services/documents';

export function ArticleReader({
  document,
  page,
  onPage,
  onDiscuss,
  onHighlight,
}: {
  document: OriginalDocument;
  page: number;
  onPage: (page: number) => void;
  onDiscuss: (selection: SelectedPassage) => void;
  onHighlight: (
    selection: SelectedPassage,
    comment?: boolean,
    isCurrent?: () => boolean,
  ) => Promise<void>;
}) {
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<SelectedPassage | null>(null);
  const mounted = useRef(true);
  const identity = useRef({ documentId: document.id, page, selection });
  identity.current = { documentId: document.id, page, selection };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setSelection(null), [document.id, page]);
  useEffect(() => {
    let stopped = false;
    void documentRequest<{ pages: SourcePage[] }>(`documents/${document.id}/pages`)
      .then((value) => {
        if (!stopped) setPages(value.pages);
      })
      .catch((failure: Error) => {
        if (!stopped) setError(failure.message);
      });
    return () => {
      stopped = true;
    };
  }, [document.id]);
  const current = pages.find((item) => item.page === page) ?? pages[0];
  async function highlight(comment = false) {
    if (!selection) return;
    const isCurrent = () =>
      mounted.current &&
      identity.current.documentId === document.id &&
      identity.current.page === page &&
      identity.current.selection === selection;
    try {
      await onHighlight(selection, comment, isCurrent);
      if (isCurrent()) setSelection(null);
    } catch (failure) {
      if (mounted.current && identity.current.documentId === document.id)
        setError((failure as Error).message);
    }
  }
  return (
    <section className="article-reader" aria-label="Article reader">
      <div className="reader-toolbar">
        <label>
          Article part{' '}
          <select
            aria-label="Article part"
            value={page}
            onChange={(event) => onPage(Number(event.target.value))}
          >
            {pages.map((item) => (
              <option key={item.page} value={item.page}>
                {item.page} of {pages.length}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          aria-label="Search article text"
          placeholder="Find in article"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {query && (
        <div className="reader-search-results">
          {pages
            .filter((item) => item.text.toLowerCase().includes(query.toLowerCase()))
            .map((item) => (
              <button key={item.page} onClick={() => onPage(item.page)}>
                Part {item.page}
              </button>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="reader-error">
          {error}
        </p>
      )}
      <div
        className="article-content"
        onPointerUp={() => {
          const selected = window.getSelection();
          const target = selected?.anchorNode?.parentElement;
          const text = selected?.toString().trim();
          if (
            current &&
            text &&
            text.length <= 4000 &&
            target?.closest('.article-source-text')
          )
            setSelection({ document_id: document.id, page: current.page, text });
          else setSelection(null);
        }}
      >
        <p className="article-source-text">{current?.text ?? 'Opening article…'}</p>
      </div>
      {selection && (
        <div className="selection-actions">
          <button className="button secondary" onClick={() => void highlight(true)}>
            Highlight and comment
          </button>
          <button className="button secondary" onClick={() => void highlight()}>
            Highlight selection
          </button>
          <button className="button primary" onClick={() => onDiscuss(selection)}>
            Ask about selection
          </button>
        </div>
      )}
    </section>
  );
}
