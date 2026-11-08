import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import canonicalGraph from '../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph } from '../domain/schema';
import type {
  OriginalDocument,
  PaperAnnotation,
  SelectedPassage,
} from '../services/documents';
import { useWorkspaceStore } from '../store/workspaceStore';
import PaperWorkspace from './PaperWorkspace';

const readerSelection = vi.hoisted(() => ({ version: 0 }));

vi.mock('./ResearchDesk', () => ({ ResearchDesk: () => null }));
vi.mock('./PdfReader', () => ({
  default: ({
    document,
    onHighlight,
  }: {
    document: OriginalDocument;
    onHighlight: (
      selection: SelectedPassage,
      comment: boolean,
      isCurrent?: () => boolean,
    ) => Promise<void>;
  }) => (
    <>
      <p>Reading {document.filename}</p>
      <button
        onClick={() => {
          const version = readerSelection.version;
          void onHighlight(
            { document_id: document.id, page: 1, text: 'A fixture passage.' },
            true,
            () => readerSelection.version === version,
          );
        }}
      >
        Comment on fixture passage
      </button>
      <button onClick={() => (readerSelection.version += 1)}>
        Select another fixture passage on this page
      </button>
    </>
  ),
}));

beforeEach(() => {
  readerSelection.version = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('opens a retrieved original without reopening the paper when metadata arrives after completion', async () => {
  vi.useFakeTimers();
  const graph = migrateAndValidateGraph(canonicalGraph).graph;
  const paper = graph.nodes.find((node) => node.type === 'paper')!;
  const original: OriginalDocument = {
    id: 'a'.repeat(32),
    node_id: paper.id,
    sha256: 'b'.repeat(64),
    media_type: 'application/pdf',
    size: 1000,
    filename: 'newly-downloaded.pdf',
    source_url: paper.paper!.url,
    source_version: '',
    retrieved_at: '2026-01-01T00:00:00Z',
    page_count: 3,
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
  const job = {
    id: 'download',
    kind: 'document',
    node_id: paper.id,
    status: 'queued',
    created_at: '2026-01-01T00:00:00Z',
  };
  let started = false;
  let finishMetadata!: (response: Response) => void;
  const metadata = new Promise<Response>((resolve) => {
    finishMetadata = resolve;
  });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/notes?')) return json({ text: '' });
      if (url.startsWith('/api/documents?'))
        return started ? metadata : json({ documents: [], annotations: [] });
      if (url === '/api/documents/fetch') {
        started = true;
        return json(job);
      }
      if (url === '/api/activity')
        return json({
          jobs: started ? [{ ...job, status: 'completed', document_id: original.id }] : [],
        });
      if (url.endsWith('/local')) return json({});
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  useWorkspaceStore.setState({
    graph,
    dirty: false,
    paperWorkspace: { nodeId: paper.id, nonce: 1 },
  });
  await act(async () => {
    render(<PaperWorkspace />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve original' }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await act(async () => {
    finishMetadata(json({ documents: [original], annotations: [] }));
  });
  expect(
    screen.queryByRole('heading', { name: 'Bring the original alongside your ideas' }),
  ).not.toBeInTheDocument();
  vi.useRealTimers();
  expect(await screen.findByText('Reading newly-downloaded.pdf')).toBeInTheDocument();
});

it.each(['originals', 'selection on the same page'] as const)(
  'keeps a committed highlight without moving back when the reader changes %s during creation',
  async (change) => {
    const graph = migrateAndValidateGraph(canonicalGraph).graph;
    const paper = graph.nodes.find((node) => node.type === 'paper')!;
    const first: OriginalDocument = {
      id: 'a'.repeat(32),
      node_id: paper.id,
      sha256: 'b'.repeat(64),
      media_type: 'application/pdf',
      size: 1000,
      filename: 'first.pdf',
      source_url: '',
      source_version: '',
      retrieved_at: '2026-01-01T00:00:00Z',
      page_count: 3,
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
    const second = { ...first, id: 'c'.repeat(32), filename: 'second.pdf' };
    const annotation: PaperAnnotation = {
      id: 'd'.repeat(32),
      document_id: first.id,
      page: 1,
      quote: 'A fixture passage.',
      comment: '',
      color: 'yellow',
      rects: [],
      created_at: '2026-01-01T00:00:00Z',
    };
    let committed = false;
    let finishCreate!: (response: Response) => void;
    const creation = new Promise<Response>((resolve) => {
      finishCreate = resolve;
    });
    const json = (value: unknown) => new Response(JSON.stringify(value));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/documents?'))
          return json({
            documents: [first, second],
            annotations: committed ? [annotation] : [],
          });
        if (url === '/api/annotations') return creation;
        if (url.endsWith('/draft')) return json(null);
        if (url === '/api/activity') return json({ jobs: [] });
        if (url.startsWith('/api/notes?')) return json({ text: '' });
        if (url.endsWith('/local')) return json({});
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    useWorkspaceStore.setState({
      graph,
      dirty: false,
      paperWorkspace: { nodeId: paper.id, documentId: first.id, nonce: 1 },
    });
    render(<PaperWorkspace />);
    await screen.findByText('Reading first.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on fixture passage' }));
    if (change === 'originals')
      fireEvent.change(screen.getByLabelText('Paper original'), {
        target: { value: second.id },
      });
    else
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Select another fixture passage on this page',
        }),
      );
    await act(async () => {
      committed = true;
      finishCreate(json(annotation));
    });
    const selected = change === 'originals' ? second : first;
    expect(screen.getByLabelText('Paper original')).toHaveValue(selected.id);
    expect(screen.getByRole('tab', { name: 'My notes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByText(`Reading ${selected.filename}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'My notes' }));
    expect(screen.getByRole('blockquote')).toHaveTextContent(annotation.quote);
    expect(screen.queryByLabelText('Highlight comment')).not.toBeInTheDocument();
  },
);
