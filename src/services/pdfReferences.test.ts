import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { loadPdfCitationLinks, resolvePdfReference } from './pdfReferences';

const ref = { num: 11, gen: 0 };
const xyz = (top: number, page: unknown = ref) => [page, { name: 'XYZ' }, 42, top, null];
const fitH = (top: number, page: unknown = ref) => [page, { name: 'FitH' }, top];
const run = (str: string, y: number, x = 42, height = 12): TextItem => ({
  str,
  dir: 'ltr',
  transform: [height, 0, 0, height, x, y],
  width: str.length * 6,
  height,
  fontName: 'fixture',
  hasEOL: false,
});
const citation = (dest: unknown, rect: unknown = [60, 680, 180, 700]) => ({
  subtype: 'Link',
  dest,
  rect,
});

function pdfFixture({
  destinations = new Map([['cite.example', xyz(700)]]),
  items = [run('A. Example. A reference title. Journal, 2026.', 688)],
  annotations = [citation('cite.example')],
  rotate = 0,
}: {
  destinations?: Map<string, unknown>;
  items?: TextItem[];
  annotations?: unknown[];
  rotate?: number;
} = {}) {
  const viewport = {
    width: rotate === 90 ? 800 : 600,
    height: rotate === 90 ? 600 : 800,
    convertToViewportPoint: (x: number, y: number) =>
      rotate === 90 ? [y, x] : [x, 800 - y],
  };
  const page = {
    view: [0, 0, 600, 800],
    rotate,
    getViewport: vi.fn(() => viewport),
    getAnnotations: vi.fn().mockResolvedValue(annotations),
    getTextContent: vi.fn().mockResolvedValue({ items }),
  };
  const stub = {
    numPages: 2,
    getDestinations: vi.fn().mockResolvedValue(destinations),
    getPageIndex: vi.fn().mockResolvedValue(1),
    getPage: vi.fn().mockResolvedValue(page),
  };
  return { pdf: stub as unknown as PDFDocumentProxy, stub, page, viewport };
}

describe('PDF citation regions', () => {
  it('loads only actual named citation links and clips their visual coordinates', async () => {
    const { pdf, page } = pdfFixture({
      annotations: [
        citation('cite.example'),
        citation('cite.clipped', [-12, 795, 12, 805]),
        citation('section.results'),
        citation(['cite.example']),
        { ...citation('cite.external'), url: 'https://example.org/' },
        { ...citation('cite.note'), subtype: 'Text' },
        citation('cite.bad', [0, NaN, 100, 200]),
        citation('cite.empty', [0, 0, 0, 0]),
        citation('cite.outside', [700, 0, 750, 30]),
        null,
      ],
    });
    expect(await loadPdfCitationLinks(pdf, 1)).toEqual([
      {
        destination: 'cite.example',
        rect: {
          x: 0.1,
          y: 0.125,
          width: expect.closeTo(0.2),
          height: expect.closeTo(0.025),
        },
      },
      {
        destination: 'cite.clipped',
        rect: { x: 0, y: 0, width: 0.02, height: 0.00625 },
      },
    ]);
    await loadPdfCitationLinks(pdf, 1);
    expect(page.getAnnotations).toHaveBeenCalledTimes(1);
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1 });
  });

  it('uses viewport transforms for rotated and cropped pages', async () => {
    const { pdf, viewport } = pdfFixture({
      rotate: 90,
      annotations: [citation('cite.example', [60, 680, 180, 700])],
    });
    const [link] = await loadPdfCitationLinks(pdf, 1);
    expect(link.rect.x).toBeCloseTo(0.85);
    expect(link.rect.y).toBeCloseTo(0.1);
    expect(link.rect.width).toBeCloseTo(0.025);
    expect(link.rect.height).toBeCloseTo(0.2);
    viewport.convertToViewportPoint = (x, y) => [(x - 10) * 2, (820 - y) * 2];
    viewport.width = 1200;
    viewport.height = 1600;
    const [cropped] = await loadPdfCitationLinks(pdf, 2);
    expect(cropped.rect.x).toBeCloseTo(50 / 600);
    expect(cropped.rect.y).toBeCloseTo(120 / 800);
  });

  it('returns no regions for invalid pages or an unavailable PDF worker', async () => {
    const { pdf, stub } = pdfFixture();
    expect(await loadPdfCitationLinks(pdf, 0)).toEqual([]);
    expect(await loadPdfCitationLinks(pdf, 3)).toEqual([]);
    expect(stub.getPage).not.toHaveBeenCalled();
    stub.getPage.mockRejectedValue(new Error('Worker was destroyed.'));
    expect(await loadPdfCitationLinks(pdf, 1)).toEqual([]);
  });
});

describe('PDF bibliography previews', () => {
  it('preserves multiline text runs and stops at the next reference, including FitH targets', async () => {
    const { pdf, stub, page } = pdfFixture({
      destinations: new Map([
        ['cite.example', xyz(700)],
        ['cite.alias', xyz(700)],
        ['cite.reader', fitH(650)],
        ['section.appendix', fitH(600)],
      ]),
      items: [
        run('A. Example', 688),
        run(', B. Author. Evidence-linked reading.', 688, 102),
        run('Journal of Synthetic Research, 2026.', 674, 54),
        run('B. Reader. Reliable citation previews.', 638),
        run('Fixture Conference, 2025.', 624, 54),
        run('Appendix: this is not a reference.', 588),
        run('2', 5, 295, 9),
      ],
    });
    const [example, reader, alias] = await Promise.all([
      resolvePdfReference(pdf, 'cite.example'),
      resolvePdfReference(pdf, 'cite.reader'),
      resolvePdfReference(pdf, 'cite.alias'),
    ]);
    expect(example).toEqual({
      text: 'A. Example, B. Author. Evidence-linked reading. Journal of Synthetic Research, 2026.',
      page: 2,
      y: 0.125,
    });
    expect(reader).toEqual({
      text: 'B. Reader. Reliable citation previews. Fixture Conference, 2025.',
      page: 2,
      y: 0.1875,
    });
    expect(alias).toEqual(example);
    await resolvePdfReference(pdf, 'cite.example');
    expect(stub.getDestinations).toHaveBeenCalledTimes(1);
    expect(stub.getPageIndex).toHaveBeenCalledTimes(1);
    expect(page.getTextContent).toHaveBeenCalledTimes(1);
  });

  it('uses section destinations as boundaries even when no later citation is named', async () => {
    const { pdf } = pdfFixture({
      destinations: new Map([
        ['cite.example', xyz(700)],
        ['appendix', [ref, { name: 'FitR' }, 0, 0, 600, 670]],
      ]),
      items: [
        run('A. Example. The complete reference.', 688),
        run('Appendix content on the very next line.', 664),
      ],
    });
    expect((await resolvePdfReference(pdf, 'cite.example')).text).toBe(
      'A. Example. The complete reference.',
    );
  });

  it('stops the last paragraph at a large gap and excludes a page footer', async () => {
    const { pdf } = pdfFixture({
      items: [
        run('A. Example. The final reference title.', 688),
        run('Journal, pages 1-20, 2026.', 674, 54),
        run('A later unlinked heading.', 610),
        run('2', 5, 295, 9),
      ],
    });
    expect((await resolvePdfReference(pdf, 'cite.example')).text).toBe(
      'A. Example. The final reference title. Journal, pages 1-20, 2026.',
    );
    const footer = pdfFixture({
      items: [run('A. Example. Complete reference, 2026.', 688), run('2', 5, 295, 9)],
    });
    expect(
      (await resolvePdfReference(footer.pdf, 'cite.example')).unavailable,
    ).toBeUndefined();
  });

  it('supports a zero-based numeric page destination without resolving a page ref', async () => {
    const { pdf, stub } = pdfFixture({
      destinations: new Map([['cite.example', fitH(700, 0)]]),
    });
    expect(await resolvePdfReference(pdf, 'cite.example')).toMatchObject({
      page: 1,
      y: 0.125,
      text: 'A. Example. A reference title. Journal, 2026.',
    });
    expect(stub.getPageIndex).not.toHaveBeenCalled();
  });

  it.each([
    [run('A. Example. Left column.', 688), run('Unrelated right column.', 688, 380)],
    [run('A. Example. First line.', 688), run('Unrelated other column.', 674, 380)],
    [run('An incomplete reference which continues', 688)],
    [{ ...run('Vertical reference.', 688), dir: 'ttb' }],
    [{ ...run('Skewed reference.', 688), transform: [12, 4, 0, 12, 42, 688] }],
    [],
  ])('returns an honest fallback for ambiguous or absent text (%#)', async (...items) => {
    const { pdf } = pdfFixture({ items });
    expect(await resolvePdfReference(pdf, 'cite.example')).toMatchObject({
      text: '',
      page: 2,
      y: 0.125,
      unavailable: expect.stringContaining('cannot be previewed reliably'),
    });
  });

  it('does not claim a complete preview when the reference may continue on another page', async () => {
    const { pdf } = pdfFixture({
      destinations: new Map([['cite.example', xyz(30)]]),
      items: [run('A. Example. A sentence at the page break.', 18)],
    });
    expect((await resolvePdfReference(pdf, 'cite.example')).unavailable).toBeTruthy();
  });

  it('preserves a jump target when bibliography rotation is unsupported', async () => {
    const { pdf } = pdfFixture({ rotate: 90 });
    expect(await resolvePdfReference(pdf, 'cite.example')).toMatchObject({
      page: 2,
      y: 42 / 600,
      text: '',
      unavailable: expect.any(String),
    });
  });

  it.each([
    ['cite.missing', new Map(), null, null],
    ['cite.example', new Map([['cite.example', null]]), null, null],
    ['cite.example', new Map([['cite.example', xyz(700, -1)]]), null, null],
    ['cite.example', new Map([['cite.example', xyz(NaN)]]), 2, null],
    ['cite.example', new Map([['cite.example', xyz(900)]]), 2, null],
    ['cite.example', new Map([['cite.example', [ref, { name: 'Fit' }]]]), 2, null],
    ['https://example.org/', new Map(), null, null],
  ])(
    'rejects malformed or unsupported destinations (%#)',
    async (name, destinations, page, y) => {
      const { pdf } = pdfFixture({ destinations });
      expect(await resolvePdfReference(pdf, name)).toMatchObject({
        text: '',
        page,
        y,
        unavailable: expect.any(String),
      });
    },
  );

  it('isolates a bad page ref instead of discarding other named references', async () => {
    const { pdf, stub } = pdfFixture({
      destinations: new Map([
        ['cite.example', xyz(700, 0)],
        ['cite.bad', xyz(650)],
      ]),
    });
    stub.getPageIndex.mockRejectedValue(new Error('Invalid page ref.'));
    expect((await resolvePdfReference(pdf, 'cite.example')).text).toContain('A. Example.');
    expect((await resolvePdfReference(pdf, 'cite.bad')).page).toBeNull();
  });

  it('handles worker failures without rejecting a preview promise', async () => {
    const unreadable = pdfFixture();
    unreadable.page.getTextContent.mockRejectedValue(new Error('Worker destroyed.'));
    expect(await resolvePdfReference(unreadable.pdf, 'cite.example')).toMatchObject({
      text: '',
      page: 2,
      y: 0.125,
      unavailable: expect.stringContaining('text could not be read'),
    });
    const destroyed = pdfFixture();
    destroyed.stub.getDestinations.mockRejectedValue(new Error('Worker destroyed.'));
    expect(await resolvePdfReference(destroyed.pdf, 'cite.example')).toMatchObject({
      text: '',
      page: null,
      unavailable: expect.any(String),
    });
  });

  it('keeps slow results from an old PDF separate from a newly opened PDF', async () => {
    const old = pdfFixture();
    const current = pdfFixture({
      items: [run('Current PDF. A different reference, 2026.', 688)],
    });
    let finish!: (content: { items: TextItem[] }) => void;
    old.page.getTextContent.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const oldReference = resolvePdfReference(old.pdf, 'cite.example');
    const currentReference = await resolvePdfReference(current.pdf, 'cite.example');
    finish({ items: [run('Old PDF. Its original reference, 2020.', 688)] });
    expect((await oldReference).text).toBe('Old PDF. Its original reference, 2020.');
    expect(currentReference.text).toBe('Current PDF. A different reference, 2026.');
    expect(await resolvePdfReference(current.pdf, 'cite.example')).toEqual(
      currentReference,
    );
  });
});
