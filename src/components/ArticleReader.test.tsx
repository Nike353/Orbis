import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OriginalDocument, SelectedPassage } from '../services/documents';
import { ArticleReader } from './ArticleReader';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

it('keeps a newer same-page selection when an earlier article highlight finishes', async () => {
  const document: OriginalDocument = {
    id: 'a'.repeat(32),
    node_id: 'fixture-article',
    sha256: 'b'.repeat(64),
    media_type: 'text/plain',
    size: 100,
    filename: 'article.txt',
    source_url: '',
    source_version: '',
    retrieved_at: '2026-01-01T00:00:00Z',
    page_count: 1,
    text_status: 'ready',
    extraction_error: '',
    available: true,
    keep_offline: false,
    last_page: 1,
    remote_available: false,
    transfer_error: '',
    transfer_status: '',
    remote_id: '',
  };
  const text = 'First passage. A newer passage.';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ pages: [{ page: 1, section: 'Article', text }] })),
    ),
  );
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onHighlight = vi
    .fn<
      (
        selection: SelectedPassage,
        comment?: boolean,
        isCurrent?: () => boolean,
      ) => Promise<void>
    >()
    .mockReturnValue(pending);
  const onDiscuss = vi.fn();
  await act(async () => {
    render(
      <ArticleReader
        document={document}
        page={1}
        onPage={vi.fn()}
        onHighlight={onHighlight}
        onDiscuss={onDiscuss}
      />,
    );
  });
  const source = screen.getByText(text);
  function select(passage: string) {
    const range = window.document.createRange();
    range.setStart(source.firstChild!, text.indexOf(passage));
    range.setEnd(source.firstChild!, text.indexOf(passage) + passage.length);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    fireEvent.pointerUp(source);
  }
  act(() => select('First passage.'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Highlight and comment' }));
  });
  const isCurrent = onHighlight.mock.calls[0][2]!;
  expect(isCurrent()).toBe(true);
  act(() => select('A newer passage.'));
  expect(isCurrent()).toBe(false);
  await act(async () => {
    finish();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask about selection' }));
  expect(onDiscuss).toHaveBeenCalledWith({
    document_id: document.id,
    page: 1,
    text: 'A newer passage.',
  });
});
