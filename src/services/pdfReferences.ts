import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { HighlightRect } from './documents';

export interface PdfCitationLink {
  destination: string;
  rect: HighlightRect;
}

export interface PdfReference {
  text: string;
  page: number | null;
  y: number | null;
  unavailable?: string;
}

interface Destination {
  page: number | null;
  top: number | null;
  left: number | null;
  supported: boolean;
}

interface PdfCache {
  pages: Map<number, Promise<PDFPageProxy>>;
  pageIndices: Map<string, Promise<number>>;
  links: Map<number, Promise<PdfCitationLink[]>>;
  text: Map<number, Promise<TextItem[]>>;
  references: Map<string, Promise<PdfReference>>;
  destinations?: Promise<Map<string, Destination>>;
}

const caches = new WeakMap<PDFDocumentProxy, PdfCache>();
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isCitation = (name: unknown): name is string =>
  typeof name === 'string' && name.startsWith('cite.') && name.length > 5;
const layoutUnavailable =
  'This reference layout cannot be previewed reliably. Open the reference in the paper.';

function cacheFor(pdf: PDFDocumentProxy): PdfCache {
  let cache = caches.get(pdf);
  if (!cache) {
    cache = {
      pages: new Map(),
      pageIndices: new Map(),
      links: new Map(),
      text: new Map(),
      references: new Map(),
    };
    caches.set(pdf, cache);
  }
  return cache;
}

function pageFor(pdf: PDFDocumentProxy, number: number) {
  const cache = cacheFor(pdf);
  let pending = cache.pages.get(number);
  if (!pending) {
    pending = pdf.getPage(number);
    cache.pages.set(number, pending);
  }
  return pending;
}

async function resolveDestination(
  pdf: PDFDocumentProxy,
  raw: unknown,
): Promise<Destination> {
  const result: Destination = {
    page: null,
    top: null,
    left: null,
    supported: false,
  };
  if (!Array.isArray(raw) || raw.length < 2) return result;
  const [ref, mode] = raw;
  let index: number;
  if (Number.isInteger(ref)) {
    index = ref;
  } else if (
    ref &&
    typeof ref === 'object' &&
    Number.isInteger(ref.num) &&
    ref.num > 0 &&
    Number.isInteger(ref.gen) &&
    ref.gen >= 0
  ) {
    const indices = cacheFor(pdf).pageIndices;
    const key = `${ref.num}:${ref.gen}`;
    let pending = indices.get(key);
    if (!pending) {
      pending = pdf.getPageIndex({ num: ref.num, gen: ref.gen });
      indices.set(key, pending);
    }
    try {
      index = await pending;
    } catch {
      return result;
    }
  } else {
    return result;
  }
  if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) return result;
  result.page = index + 1;
  const name = mode?.name;
  result.supported = ['XYZ', 'FitH', 'FitBH'].includes(name);
  const top = raw[name === 'XYZ' ? 3 : name === 'FitR' ? 5 : 2];
  if (result.supported || name === 'FitR') {
    result.top = isFiniteNumber(top) ? top : null;
    result.left =
      (name === 'XYZ' || name === 'FitR') && isFiniteNumber(raw[2]) ? raw[2] : null;
  }
  return result;
}

function namedDestinations(pdf: PDFDocumentProxy) {
  const cache = cacheFor(pdf);
  cache.destinations ??= pdf.getDestinations().then(async (raw) => {
    if (!(raw instanceof Map)) throw new Error('Invalid PDF destinations.');
    const entries = await Promise.all(
      [...raw].map(async ([name, value]) => {
        return [name, await resolveDestination(pdf, value)] as const;
      }),
    );
    return new Map(entries);
  });
  return cache.destinations;
}

/** Citation hit regions use the same visual coordinates as the reader's highlights. */
export function loadPdfCitationLinks(
  pdf: PDFDocumentProxy,
  number: number,
): Promise<PdfCitationLink[]> {
  if (!Number.isInteger(number) || number < 1 || number > pdf.numPages)
    return Promise.resolve([]);
  const cache = cacheFor(pdf);
  let pending = cache.links.get(number);
  if (!pending) {
    pending = pageFor(pdf, number)
      .then(async (page) => {
        const viewport = page.getViewport({ scale: 1 });
        const links: PdfCitationLink[] = [];
        for (const annotation of await page.getAnnotations({ intent: 'display' })) {
          if (
            !annotation ||
            annotation.subtype !== 'Link' ||
            !isCitation(annotation.dest) ||
            annotation.url ||
            annotation.unsafeUrl ||
            !Array.isArray(annotation.rect) ||
            annotation.rect.length !== 4 ||
            !annotation.rect.every(isFiniteNumber)
          )
            continue;
          const [a, b] = [
            viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
            viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
          ];
          const x = Math.max(0, Math.min(a[0], b[0]) / viewport.width);
          const y = Math.max(0, Math.min(a[1], b[1]) / viewport.height);
          const right = Math.min(1, Math.max(a[0], b[0]) / viewport.width);
          const bottom = Math.min(1, Math.max(a[1], b[1]) / viewport.height);
          if (![x, y, right, bottom].every(isFiniteNumber) || right <= x || bottom <= y)
            continue;
          links.push({
            destination: annotation.dest,
            rect: { x, y, width: right - x, height: bottom - y },
          });
        }
        return links;
      })
      .catch(() => []);
    cache.links.set(number, pending);
  }
  return pending;
}

interface Line {
  y: number;
  height: number;
  runs: TextItem[];
}

function referenceText(
  items: TextItem[],
  target: Destination,
  lower: number | null,
  view: number[],
): string | null {
  const runs = items.filter(
    (item) =>
      item.str.trim() &&
      isFiniteNumber(item.transform[5]) &&
      item.transform[5] <= target.top! + 1 &&
      item.transform[5] > (lower ?? view[1]) + 1,
  );
  const lines: Line[] = [];
  for (const item of runs.sort((a, b) => b.transform[5] - a.transform[5])) {
    if (
      item.dir !== 'ltr' ||
      item.transform.length !== 6 ||
      !item.transform.every(isFiniteNumber) ||
      item.transform[0] <= 0 ||
      item.transform[3] <= 0 ||
      Math.abs(item.transform[1]) > 0.1 ||
      Math.abs(item.transform[2]) > 0.1 ||
      !isFiniteNumber(item.width) ||
      !isFiniteNumber(item.height) ||
      item.width < 0 ||
      item.height <= 0
    )
      return null;
    const last = lines.at(-1);
    if (last && Math.abs(last.y - item.transform[5]) <= item.height * 0.25) {
      last.runs.push(item);
      last.height = Math.max(last.height, item.height);
    } else {
      lines.push({ y: item.transform[5], height: item.height, runs: [item] });
    }
  }
  if (!lines.length || target.top! - lines[0].y > lines[0].height * 2) return null;
  const paragraphs: string[] = [];
  const firstX = Math.min(...lines[0].runs.map((run) => run.transform[4]));
  for (const [index, line] of lines.entries()) {
    line.runs.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '';
    let previous: TextItem | undefined;
    for (const run of line.runs) {
      const gap = previous
        ? run.transform[4] - (previous.transform[4] + previous.width)
        : 0;
      if (gap > line.height * 2) return null;
      text += `${gap > line.height * 0.12 && !text.endsWith(' ') ? ' ' : ''}${run.str}`;
      previous = run;
    }
    text = text.replace(/\s+/g, ' ').trim();
    const footer =
      line.y < view[1] + (view[3] - view[1]) * 0.15 &&
      /^(?:Page\s+)?(?:\d+|[ivxlcdm]+)$/i.test(text);
    if (footer) break;
    if (index) {
      const preceding = lines[index - 1];
      if (preceding.y - line.y > Math.max(preceding.height, line.height) * 1.8) {
        if (lower !== null) return null;
        break;
      }
    }
    if (Math.abs(line.runs[0].transform[4] - firstX) > line.height * 3) return null;
    paragraphs.push(text);
  }
  const text = paragraphs.join(' ').trim();
  const last = lines[paragraphs.length - 1];
  // shortcut: one horizontal paragraph; extend extraction when supporting multi-column or cross-page references.
  if (
    !text ||
    !/[.!?]["')\]]?$/.test(text) ||
    (lower === null && last.y <= view[1] + last.height * 2)
  )
    return null;
  return text;
}

async function readReference(pdf: PDFDocumentProxy, name: string): Promise<PdfReference> {
  const destinations = await namedDestinations(pdf);
  const target = destinations.get(name);
  const result: PdfReference = { text: '', page: target?.page ?? null, y: null };
  const unavailable = (message: string): PdfReference => ({
    ...result,
    unavailable: message,
  });
  if (!target || target.page === null)
    return unavailable('This citation has no usable PDF destination.');
  try {
    const page = await pageFor(pdf, target.page);
    if (target.top === null || target.top < page.view[1] || target.top > page.view[3])
      return unavailable('This citation has no usable position in the PDF.');
    const viewport = page.getViewport({ scale: 1 });
    const [, y] = viewport.convertToViewportPoint(target.left ?? page.view[0], target.top);
    if (isFiniteNumber(y) && viewport.height > 0 && y >= 0 && y <= viewport.height)
      result.y = y / viewport.height;
    if (!target.supported || page.rotate % 360 !== 0 || result.y === null)
      return unavailable(layoutUnavailable);
    const following = [...destinations.values()]
      .filter(
        (other) =>
          other.page === target.page && other.top !== null && other.top < target.top! - 1,
      )
      .map((other) => other.top!);
    const lower = following.length ? Math.max(...following) : null;
    const cache = cacheFor(pdf);
    let pending = cache.text.get(target.page);
    if (!pending) {
      pending = page
        .getTextContent()
        .then((content) => content.items.filter((item): item is TextItem => 'str' in item));
      cache.text.set(target.page, pending);
    }
    const text = referenceText(await pending, target, lower, page.view);
    return text ? { ...result, text } : unavailable(layoutUnavailable);
  } catch {
    return unavailable('The reference text could not be read. Open it in the paper.');
  }
}

/** Resolve only actual named bibliography destinations; PDF instances never share data. */
export function resolvePdfReference(
  pdf: PDFDocumentProxy,
  destination: string,
): Promise<PdfReference> {
  if (!isCitation(destination))
    return Promise.resolve({
      text: '',
      page: null,
      y: null,
      unavailable: 'This link is not a named PDF citation.',
    });
  const cache = cacheFor(pdf);
  let pending = cache.references.get(destination);
  if (!pending) {
    pending = readReference(pdf, destination).catch(() => ({
      text: '',
      page: null,
      y: null,
      unavailable: 'The PDF references could not be read.',
    }));
    cache.references.set(destination, pending);
  }
  return pending;
}
