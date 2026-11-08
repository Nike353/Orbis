import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
  OriginalDocument,
  PaperAnnotation,
  SelectedPassage,
} from '../services/documents';
import type { PdfCitationLink, PdfReference } from '../services/pdfReferences';
import PdfReader from './PdfReader';

const methods = vi.hoisted(() => ({
  getDocument:
    vi.fn<() => { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> }>(),
  loadLinks: vi.fn<(pdf: PDFDocumentProxy, page: number) => Promise<PdfCitationLink[]>>(),
  resolveReference:
    vi.fn<(pdf: PDFDocumentProxy, destination: string) => Promise<PdfReference>>(),
  documentRequest: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: methods.getDocument,
  TextLayer: class {
    constructor(
      private options: {
        container: HTMLDivElement;
        textContentSource: { items: { str: string }[] };
      },
    ) {}
    async render() {
      this.options.container.textContent = this.options.textContentSource.items
        .map((item) => item.str)
        .join(' ');
    }
    cancel() {}
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'fixture-pdf-worker',
}));
vi.mock('../services/pdfReferences', () => ({
  loadPdfCitationLinks: methods.loadLinks,
  resolvePdfReference: methods.resolveReference,
}));
vi.mock('../services/documents', () => ({
  originalFileUrl: (id: string) => `/api/documents/${id}/original`,
  documentRequest: methods.documentRequest,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pageFixture(number: number) {
  return {
    userUnit: 1,
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({
      items: [{ str: `Synthetic page ${number} passage.` }],
    })),
    cleanup: vi.fn(() => true),
  };
}

function pdfFixture(numPages = 3) {
  const pages = Array.from({ length: numPages }, (_, index) => pageFixture(index + 1));
  const getPage = vi
    .fn<(number: number) => Promise<ReturnType<typeof pageFixture>>>()
    .mockImplementation(async (number) => {
      const page = pages[number - 1];
      if (!page) throw new Error(`Invalid synthetic page ${number}.`);
      return page;
    });
  return {
    pdf: { numPages, getPage } as unknown as PDFDocumentProxy,
    page: pages[0],
    pages,
    getPage,
  };
}

function loadingTask(promise: Promise<PDFDocumentProxy>) {
  return { promise, destroy: async () => {} };
}

function original(id = 'a'.repeat(32)): OriginalDocument {
  return {
    id,
    node_id: 'synthetic-paper',
    sha256: 'b'.repeat(64),
    filename: 'fixture.pdf',
    media_type: 'application/pdf',
    size: 1000,
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
}

function readerProps() {
  return {
    document: original(),
    page: 1,
    annotations: [] as PaperAnnotation[],
    onPage: vi.fn<(page: number) => void>(),
    onHighlight: vi
      .fn<
        (
          selection: SelectedPassage,
          comment?: boolean,
          isCurrent?: () => boolean,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined),
    onDiscuss: vi.fn(),
    onOpenAnnotation: vi.fn(),
  };
}

async function openReader(props = readerProps()) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<PdfReader {...props} />);
  });
  await flushFrames();
  return view;
}

const citation = (name: string): PdfCitationLink => ({
  destination: `cite.${name}`,
  rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.03 },
});
const reference = (page: number): PdfReference => ({
  text: 'Synthetic bibliography entry.',
  page,
  y: 0.5,
});
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo',
);
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let frameTime = 0;
const observers = new Set<PageObserver>();
const resizeObservers = new Set<ReaderResizeObserver>();
const nearby = new Map<number, boolean>();
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  const previous = this.scrollTop;
  this.scrollTop = Math.max(0, options.top ?? previous);
  if (this.scrollTop !== previous)
    queueMicrotask(() => {
      if (!this.isConnected) return;
      refreshObservers();
      this.dispatchEvent(new Event('scroll'));
    });
});

function pageElement(number: number) {
  return screen.getByLabelText(`Paper page ${number}`) as HTMLDivElement;
}

function pageHeight(element: HTMLElement) {
  return Number.parseFloat(element.style.height) || 800;
}

function pageOffset(element: HTMLElement) {
  const pages = Array.from(
    element.closest('.pdf-viewport')?.querySelectorAll<HTMLElement>('.pdf-page') ?? [],
  );
  const index = pages.indexOf(element);
  return pages
    .slice(0, Math.max(0, index))
    .reduce((top, page) => top + pageHeight(page) + 24, 0);
}

function boundsFor(element: HTMLElement) {
  const page = element.closest<HTMLElement>('.pdf-page');
  if (page) {
    const viewport = page.closest<HTMLElement>('.pdf-viewport');
    return new DOMRect(
      0,
      pageOffset(page) - (viewport?.scrollTop ?? 0),
      Number.parseFloat(page.style.width) || 640,
      pageHeight(page),
    );
  }
  return new DOMRect(0, 0, 688, element.classList.contains('pdf-viewport') ? 600 : 800);
}

class PageObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  private targets = new Set<Element>();

  constructor(
    private callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    observers.add(this);
  }
  observe(element: Element) {
    this.targets.add(element);
    queueMicrotask(() => {
      if (this.targets.has(element)) this.emit(element);
    });
  }
  unobserve(element: Element) {
    this.targets.delete(element);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  refresh() {
    for (const element of this.targets) this.emit(element);
  }
  private emit(element: Element) {
    const bounds = element.getBoundingClientRect();
    const rootBounds =
      this.root instanceof Element
        ? this.root.getBoundingClientRect()
        : new DOMRect(0, 0, 688, 600);
    const margin = Number.parseFloat(this.rootMargin) || 0;
    const forced = nearby.get(Number((element as HTMLElement).dataset.page));
    const isIntersecting =
      forced ??
      (bounds.bottom > rootBounds.top - margin && bounds.top < rootBounds.bottom + margin);
    this.callback(
      [
        {
          target: element,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          boundingClientRect: bounds,
          rootBounds,
          intersectionRect: isIntersecting ? bounds : new DOMRect(),
          time: frameTime,
        },
      ],
      this,
    );
  }
}

class ReaderResizeObserver implements ResizeObserver {
  private target: Element | null = null;
  constructor(private callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }
  observe(element: Element) {
    this.target = element;
  }
  unobserve() {
    this.target = null;
  }
  disconnect() {
    this.target = null;
    resizeObservers.delete(this);
  }
  resize(width: number) {
    if (!this.target) return;
    this.callback(
      [
        {
          target: this.target,
          contentRect: new DOMRect(0, 0, width, 600),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}

function refreshObservers() {
  for (const observer of observers) observer.refresh();
}

async function flushFrames() {
  for (let iteration = 0; iteration < 12 && frames.size; iteration += 1) {
    const pending = [...frames.values()];
    frames.clear();
    frameTime += 16;
    await act(async () => {
      for (const callback of pending) callback(frameTime);
    });
  }
  if (frames.size) throw new Error('Reader animation frames did not settle.');
}

async function userScroll(number: number, y = 0) {
  const viewport = screen.getByLabelText('PDF page content');
  const target = pageElement(number);
  await act(async () => {
    fireEvent.wheel(viewport, { deltaY: 400 });
    viewport.scrollTop = pageOffset(target) + pageHeight(target) * y;
    refreshObservers();
    fireEvent.scroll(viewport);
  });
  await flushFrames();
  return viewport.scrollTop;
}

function readingY(number: number) {
  const viewport = screen.getByLabelText('PDF page content');
  const target = pageElement(number);
  return (viewport.scrollTop + 32 - pageOffset(target)) / pageHeight(target);
}

beforeEach(() => {
  vi.resetAllMocks();
  frames.clear();
  frameId = frameTime = 0;
  nearby.clear();
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfFixture().pdf)));
  methods.loadLinks.mockResolvedValue([]);
  methods.resolveReference.mockResolvedValue(reference(2));
  methods.documentRequest.mockResolvedValue({ pages: [] });
  vi.stubGlobal('ResizeObserver', ReaderResizeObserver);
  vi.stubGlobal('IntersectionObserver', PageObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boundsFor(this);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('pdf-page') ? pageOffset(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boundsFor(this).height;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boundsFor(this).height;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  frames.clear();
  observers.clear();
  resizeObservers.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

it('opens a later-page highlight in a different PDF without clamping to the old PDF', async () => {
  const short = pdfFixture(2);
  const long = pdfFixture(12);
  const loaded = deferred<PDFDocumentProxy>();
  methods.getDocument
    .mockReturnValueOnce(loadingTask(Promise.resolve(short.pdf)))
    .mockReturnValueOnce(loadingTask(loaded.promise));
  const props = readerProps();
  const view = await openReader(props);
  props.onPage.mockClear();
  await act(async () => {
    view.rerender(<PdfReader {...props} document={original('c'.repeat(32))} page={10} />);
  });
  expect(props.onPage).not.toHaveBeenCalled();
  expect(screen.getByLabelText('PDF page')).toHaveValue(10);
  await act(async () => {
    loaded.resolve(long.pdf);
  });
  await flushFrames();
  expect(long.getPage).toHaveBeenCalledWith(10);
  expect(props.onPage).not.toHaveBeenCalled();
  expect(pageElement(10)).toHaveAttribute('aria-busy', 'false');
  expect(readingY(10)).toBeCloseTo(0);
});

it('does not change the parent page after a pending citation jump is unmounted', async () => {
  const pending = deferred<PdfReference>();
  methods.loadLinks.mockResolvedValue([citation('first')]);
  methods.resolveReference.mockReturnValue(pending.promise);
  const props = readerProps();
  const view = await openReader(props);
  props.onPage.mockClear();
  await act(async () => {
    fireEvent.click(within(pageElement(1)).getByRole('link', { name: 'Reference first' }));
  });
  view.unmount();
  await act(async () => {
    pending.resolve(reference(2));
  });
  await flushFrames();
  expect(props.onPage).not.toHaveBeenCalled();
});

it('keeps the newer citation intent when an older jump resolves last on the same page', async () => {
  const older = deferred<PdfReference>();
  const newer = deferred<PdfReference>();
  methods.loadLinks.mockResolvedValue([citation('first'), citation('second')]);
  methods.resolveReference.mockImplementation((_pdf, destination) =>
    destination === 'cite.first' ? older.promise : newer.promise,
  );
  const props = readerProps();
  const view = await openReader(props);
  props.onPage.mockClear();
  await act(async () => {
    fireEvent.click(within(pageElement(1)).getByRole('link', { name: 'Reference first' }));
    fireEvent.click(within(pageElement(1)).getByRole('link', { name: 'Reference second' }));
  });
  await act(async () => {
    newer.resolve(reference(2));
  });
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await flushFrames();
  await act(async () => {
    older.resolve(reference(3));
  });
  expect(props.onPage.mock.calls).toEqual([[2]]);
  expect(readingY(2)).toBeCloseTo(0.5);
});

it.each(['close button', 'Escape'] as const)(
  'keeps keyboard focus inside the preview and returns it to its marker after %s',
  async (dismiss) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const props = readerProps();
    props.annotations = [
      {
        id: 'd'.repeat(32),
        document_id: props.document.id,
        page: 1,
        quote: 'Synthetic passage.',
        comment: 'A saved highlight comment.',
        color: 'yellow',
        rects: [
          { x: 0.1, y: 0.2, width: 0.3, height: 0.03 },
          { x: 0.1, y: 0.24, width: 0.4, height: 0.03 },
        ],
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    await openReader(props);
    const markers = screen.getAllByRole('button', {
      name: 'View highlight: Synthetic passage.',
    });
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    act(() => marker.focus());
    const dialog = screen.getByRole('dialog', { name: 'Highlight comment' });
    const close = screen.getByRole('button', { name: 'Close highlight preview' });
    act(() => close.focus());
    fireEvent.pointerLeave(dialog);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240);
    });
    expect(dialog).toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(methods.documentRequest).not.toHaveBeenCalled();
    const workspaceClose = vi.fn();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) workspaceClose();
    };
    window.addEventListener('keydown', escape);
    try {
      if (dismiss === 'Escape') fireEvent.keyDown(close, { key: 'Escape' });
      else fireEvent.click(close);
      expect(screen.queryByRole('dialog', { name: 'Highlight comment' })).toBeNull();
      expect(marker).toHaveFocus();
      expect(workspaceClose).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240);
      });
      expect(screen.queryByRole('dialog', { name: 'Highlight comment' })).toBeNull();
      fireEvent.keyDown(marker, { key: 'Escape' });
      expect(workspaceClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', escape);
    }
  },
);

function selectPassage(number: number, text: string) {
  const element = pageElement(number);
  const layer = element.querySelector<HTMLDivElement>('.textLayer')!;
  layer.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(layer);
  const bounds = element.getBoundingClientRect();
  Object.defineProperty(range, 'getClientRects', {
    value: () => [
      new DOMRect(
        bounds.left + bounds.width * 0.1,
        bounds.top + bounds.height * 0.2,
        bounds.width * 0.3,
        bounds.height * 0.03,
      ),
    ],
  });
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.pointerUp(layer);
}

it('rejects a loading page selection while keeping another ready page selectable', async () => {
  const fixture = pdfFixture();
  const pending = deferred<typeof fixture.page>();
  fixture.getPage.mockImplementation((page) =>
    page === 2 ? pending.promise : Promise.resolve(fixture.pages[page - 1]),
  );
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  const props = readerProps();
  await openReader(props);
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  act(() => selectPassage(2, 'Unready second-page passage.'));
  expect(screen.queryByRole('button', { name: 'Highlight and comment' })).toBeNull();
  expect(props.onHighlight).not.toHaveBeenCalled();
  act(() => selectPassage(1, 'Ready first-page passage.'));
  expect(screen.getByRole('button', { name: 'Highlight and comment' })).toBeEnabled();
  await act(async () => {
    pending.resolve(fixture.pages[1]);
  });
  await flushFrames();
  act(() => selectPassage(2, 'Ready second-page passage.'));
  expect(screen.getByRole('button', { name: 'Highlight and comment' })).toBeEnabled();
});

it.each([1, 2])(
  'preserves a newer selection on page %i when an older highlight finishes',
  async (newerPage) => {
    const pending = deferred<void>();
    const props = readerProps();
    props.onHighlight.mockReturnValue(pending.promise);
    const view = await openReader(props);
    act(() => selectPassage(1, 'First-page selection.'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Highlight and comment' }));
    });
    const isCurrent = props.onHighlight.mock.calls[0][2];
    expect(isCurrent?.()).toBe(true);
    await act(async () => {
      view.rerender(<PdfReader {...props} page={newerPage} />);
    });
    await flushFrames();
    act(() => selectPassage(newerPage, 'Newer selection.'));
    expect(isCurrent?.()).toBe(false);
    const removeRanges = vi.spyOn(window.getSelection()!, 'removeAllRanges');
    await act(async () => {
      pending.resolve();
    });
    expect(document.querySelector('.selection-actions')).toHaveTextContent(
      'Newer selection.',
    );
    expect(removeRanges).not.toHaveBeenCalled();
  },
);

it('reports a scrolled page without snapping when the parent acknowledges it', async () => {
  const props = readerProps();
  const view = await openReader(props);
  const first = pageElement(1);
  const top = await userScroll(2, 0.35);
  expect(props.onPage.mock.calls).toEqual([[2]]);
  scrollTo.mockClear();
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await flushFrames();
  expect(scrollTo).not.toHaveBeenCalled();
  expect(screen.getByLabelText('PDF page content').scrollTop).toBe(top);
  expect(pageElement(1)).toBe(first);
  expect(screen.getByLabelText('PDF page')).toHaveValue(2);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  });
  await act(async () => {
    view.rerender(<PdfReader {...props} page={3} />);
  });
  await flushFrames();
  expect(props.onPage.mock.calls).toEqual([[2], [3]]);
  expect(readingY(3)).toBeCloseTo(0);
  expect(pageElement(1)).toBe(first);
});

it('creates a highlight from the selected page rather than the toolbar page', async () => {
  const props = readerProps();
  await openReader(props);
  expect(screen.getByLabelText('PDF page')).toHaveValue(1);
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'false');
  act(() => selectPassage(2, 'A passage on the neighboring page.'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Highlight and comment' }));
  });
  expect(props.onHighlight).toHaveBeenCalledTimes(1);
  const [passage, comment] = props.onHighlight.mock.calls[0];
  expect(passage).toMatchObject({
    document_id: props.document.id,
    page: 2,
    text: 'A passage on the neighboring page.',
  });
  expect(comment).toBe(true);
  expect(passage.rects).toHaveLength(1);
  expect(passage.rects?.[0].x).toBeCloseTo(0.1);
  expect(passage.rects?.[0].y).toBeCloseTo(0.2);
  expect(passage.rects?.[0].width).toBeCloseTo(0.3);
  expect(passage.rects?.[0].height).toBeCloseTo(0.03);
});

it('rejects selections spanning two pages instead of assigning misleading page coordinates', async () => {
  const props = readerProps();
  await openReader(props);
  const first = pageElement(1).querySelector('.textLayer')!;
  const second = pageElement(2).querySelector('.textLayer')!;
  const range = document.createRange();
  range.setStart(first.firstChild!, 0);
  range.setEnd(second.firstChild!, second.textContent!.length);
  act(() => {
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(second);
  });
  expect(screen.queryByRole('button', { name: 'Highlight and comment' })).toBeNull();
  expect(props.onHighlight).not.toHaveBeenCalled();
});

it('keeps distant pages as placeholders and releases rendered pages when no longer nearby', async () => {
  const fixture = pdfFixture(30);
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  await openReader();
  expect(document.querySelectorAll('.pdf-page')).toHaveLength(30);
  expect(fixture.pages.filter((page) => page.render.mock.calls.length)).toHaveLength(2);
  expect(fixture.pages[19].render).not.toHaveBeenCalled();
  expect(fixture.pages[19].getTextContent).not.toHaveBeenCalled();
  const distant = pageElement(20);
  expect(distant).toHaveAttribute('aria-busy', 'true');
  const height = distant.style.height;

  await act(async () => {
    nearby.set(20, true);
    refreshObservers();
  });
  await flushFrames();
  expect(distant).toHaveAttribute('aria-busy', 'false');
  expect(fixture.pages[19].render).toHaveBeenCalledTimes(1);
  expect(distant.querySelector('.textLayer')).toHaveTextContent('Synthetic page 20');
  await act(async () => {
    nearby.set(20, false);
    refreshObservers();
  });
  expect(distant).toHaveAttribute('aria-busy', 'true');
  expect(distant.style.height).toBe(height);
  expect(distant.querySelector('.textLayer')).toBeEmptyDOMElement();
  expect(distant.querySelector('canvas')).toHaveProperty('width', 0);
  expect(distant.querySelector('canvas')).toHaveProperty('height', 0);
  expect(fixture.pages[19].cleanup).toHaveBeenCalledTimes(1);
});

it('pins the page containing keyboard focus until focus leaves it', async () => {
  const fixture = pdfFixture();
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  const props = readerProps();
  props.annotations = [
    {
      id: 'e'.repeat(32),
      document_id: props.document.id,
      page: 2,
      quote: 'Second-page highlight.',
      comment: 'Keep the focused comment available.',
      color: 'yellow',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.03 }],
      created_at: '2026-01-01T00:00:00Z',
    },
  ];
  await openReader(props);
  const marker = within(pageElement(2)).getByRole('button', {
    name: 'View highlight: Second-page highlight.',
  });
  act(() => marker.focus());
  fireEvent.keyDown(marker, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Highlight comment' })).toBeNull();
  await act(async () => {
    nearby.set(2, false);
    refreshObservers();
  });
  expect(marker).toHaveFocus();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'false');
  expect(fixture.pages[1].cleanup).not.toHaveBeenCalled();
  act(() => screen.getByLabelText('PDF page content').focus());
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  expect(fixture.pages[1].cleanup).toHaveBeenCalledTimes(1);
});

it('pins a selected page until its selection is cleared', async () => {
  const fixture = pdfFixture();
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  await openReader();
  act(() => selectPassage(2, 'A selected passage that must remain in the DOM.'));
  await act(async () => {
    nearby.set(2, false);
    refreshObservers();
  });
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'false');
  expect(window.getSelection()!.toString()).toBe(
    'A selected passage that must remain in the DOM.',
  );
  expect(fixture.pages[1].cleanup).not.toHaveBeenCalled();
  act(() => {
    window.getSelection()!.removeAllRanges();
    fireEvent.pointerUp(pageElement(2).querySelector('.textLayer')!);
  });
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  expect(fixture.pages[1].cleanup).toHaveBeenCalledTimes(1);
});

it('keeps the reading anchor during zoom and does not rewind after later manual scrolling', async () => {
  const fixture = pdfFixture(5);
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  const props = readerProps();
  const view = await openReader(props);
  await userScroll(2, 0.45);
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  const anchor = readingY(2);
  const pending = deferred<Awaited<ReturnType<typeof fixture.page.getTextContent>>>();
  fixture.pages[1].getTextContent.mockReturnValueOnce(pending.promise);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('PDF zoom'), { target: { value: '2' } });
  });
  await flushFrames();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  expect(readingY(2)).toBeCloseTo(anchor);

  const top = await userScroll(3, 0.2);
  await act(async () => {
    view.rerender(<PdfReader {...props} page={3} />);
  });
  props.onPage.mockClear();
  scrollTo.mockClear();
  await act(async () => {
    pending.resolve({ items: [{ str: 'The delayed zoomed second-page passage.' }] });
  });
  await flushFrames();
  expect(screen.getByLabelText('PDF page content').scrollTop).toBe(top);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(props.onPage).not.toHaveBeenCalled();
});

it('ignores text arriving from a cancelled scale instead of replacing the newer page', async () => {
  const fixture = pdfFixture();
  const pending = deferred<Awaited<ReturnType<typeof fixture.page.getTextContent>>>();
  fixture.pages[1].getTextContent.mockReturnValueOnce(pending.promise);
  nearby.set(2, true);
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  await openReader();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('PDF zoom'), { target: { value: '2' } });
  });
  await flushFrames();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'false');
  expect(pageElement(2).querySelector('.textLayer')).toHaveTextContent(
    'Synthetic page 2 passage.',
  );
  await act(async () => {
    pending.resolve({ items: [{ str: 'Cancelled text from the previous scale.' }] });
  });
  await flushFrames();
  expect(pageElement(2).querySelector('.textLayer')).toHaveTextContent(
    'Synthetic page 2 passage.',
  );
  expect(pageElement(2).querySelector('.textLayer')).not.toHaveTextContent(
    'Cancelled text',
  );
});

it('cancels a pending citation jump when the reader is manually scrolled', async () => {
  const pending = deferred<PdfReference>();
  methods.loadLinks.mockImplementation(async (_pdf, number) =>
    number === 1 ? [citation('pending')] : [],
  );
  methods.resolveReference.mockReturnValue(pending.promise);
  const props = readerProps();
  const view = await openReader(props);
  await act(async () => {
    fireEvent.click(
      within(pageElement(1)).getByRole('link', { name: 'Reference pending' }),
    );
  });
  const top = await userScroll(2, 0.4);
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  props.onPage.mockClear();
  await act(async () => {
    pending.resolve(reference(3));
  });
  await flushFrames();
  expect(props.onPage).not.toHaveBeenCalled();
  expect(screen.getByLabelText('PDF page content').scrollTop).toBe(top);
  expect(screen.queryByRole('button', { name: 'Back to citation' })).toBeNull();
});

it('cancels a slow destination jump when PageDown scrolls from the focused source citation', async () => {
  const fixture = pdfFixture();
  const pending = deferred<Awaited<ReturnType<typeof fixture.page.getTextContent>>>();
  fixture.pages[1].getTextContent.mockReturnValueOnce(pending.promise);
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  methods.loadLinks.mockImplementation(async (_pdf, number) =>
    number === 1 ? [citation('slow-target')] : [],
  );
  methods.resolveReference.mockResolvedValue(reference(2));
  const props = readerProps();
  const view = await openReader(props);
  const link = within(pageElement(1)).getByRole('link', {
    name: 'Reference slow-target',
  });
  act(() => link.focus());
  await act(async () => {
    fireEvent.click(link);
  });
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await flushFrames();
  expect(link).toHaveFocus();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'true');
  expect(readingY(2)).toBeCloseTo(0.5);
  const viewport = screen.getByLabelText('PDF page content');
  const top = viewport.scrollTop + 180;
  await act(async () => {
    fireEvent.keyDown(link, { key: 'PageDown' });
    viewport.scrollTop = top;
    refreshObservers();
    fireEvent.scroll(viewport);
  });
  await flushFrames();
  scrollTo.mockClear();
  props.onPage.mockClear();
  await act(async () => {
    pending.resolve({ items: [{ str: 'The slowly rendered destination passage.' }] });
  });
  await flushFrames();
  expect(pageElement(2)).toHaveAttribute('aria-busy', 'false');
  expect(viewport.scrollTop).toBe(top);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(props.onPage).not.toHaveBeenCalled();
});

it('opens a neighboring-page citation and returns to the actual scrolled position', async () => {
  const fixture = pdfFixture();
  methods.getDocument.mockReturnValue(loadingTask(Promise.resolve(fixture.pdf)));
  methods.loadLinks.mockImplementation(async (_pdf, number) =>
    number === 2 ? [citation('neighbor')] : [],
  );
  methods.resolveReference.mockResolvedValue(reference(3));
  const props = readerProps();
  const view = await openReader(props);
  const top = await userScroll(2, 0.3);
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await act(async () => {
    fireEvent.click(
      within(pageElement(2)).getByRole('link', { name: 'Reference neighbor' }),
    );
  });
  await act(async () => {
    view.rerender(<PdfReader {...props} page={3} />);
  });
  await flushFrames();
  expect(readingY(3)).toBeCloseTo(0.5);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Back to citation' }));
  });
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await flushFrames();
  expect(screen.getByLabelText('PDF page content').scrollTop).toBeCloseTo(top);
});

it('drops a neighboring-page reference preview and its late result when the document changes', async () => {
  const pending = deferred<PdfReference>();
  methods.getDocument
    .mockReturnValueOnce(loadingTask(Promise.resolve(pdfFixture().pdf)))
    .mockReturnValueOnce(loadingTask(Promise.resolve(pdfFixture().pdf)));
  methods.loadLinks.mockImplementation(async (_pdf, number) =>
    number === 2 ? [citation('neighbor')] : [],
  );
  methods.resolveReference.mockReturnValue(pending.promise);
  const props = readerProps();
  const view = await openReader(props);
  act(() => {
    within(pageElement(2)).getByRole('link', { name: 'Reference neighbor' }).focus();
  });
  expect(screen.getByRole('tooltip', { name: 'PDF reference' })).toHaveTextContent(
    'Reading the reference',
  );
  await act(async () => {
    view.rerender(<PdfReader {...props} document={original('f'.repeat(32))} />);
  });
  await flushFrames();
  await act(async () => {
    pending.resolve(reference(3));
  });
  expect(screen.queryByRole('tooltip', { name: 'PDF reference' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Back to citation' })).toBeNull();
  expect(props.onPage).not.toHaveBeenCalled();
});

it('preserves the current reading anchor when the viewport width changes', async () => {
  const props = readerProps();
  const view = await openReader(props);
  await userScroll(2, 0.42);
  await act(async () => {
    view.rerender(<PdfReader {...props} page={2} />);
  });
  const anchor = readingY(2);
  const first = pageElement(1);
  await act(async () => {
    for (const observer of resizeObservers) observer.resize(960);
  });
  await flushFrames();
  expect(pageElement(2).style.width).toBe('960px');
  expect(readingY(2)).toBeCloseTo(anchor);
  expect(pageElement(1)).toBe(first);
});

it('limits page keyboard shortcuts to an unmodified key in the reader viewport', async () => {
  const props = readerProps();
  const view = await openReader(props);
  const viewport = screen.getByLabelText('PDF page content');
  act(() => viewport.focus());
  fireEvent.keyDown(viewport, { key: 'ArrowRight', shiftKey: true });
  fireEvent.keyDown(screen.getByLabelText('Search PDF text'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Next page' }), {
    key: 'ArrowRight',
  });
  expect(props.onPage).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.keyDown(viewport, { key: 'ArrowRight' });
    view.rerender(<PdfReader {...props} page={2} />);
  });
  await flushFrames();
  expect(props.onPage.mock.calls).toEqual([[2]]);
  expect(readingY(2)).toBeCloseTo(0);
  fireEvent.keyDown(viewport, { key: 'f', ctrlKey: true });
  expect(screen.getByLabelText('Search PDF text')).toHaveFocus();
});
