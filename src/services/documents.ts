export interface OriginalDocument {
  id: string;
  node_id: string;
  sha256: string;
  media_type: 'application/pdf' | 'text/plain';
  size: number;
  filename: string;
  source_url: string;
  source_version: string;
  retrieved_at: string;
  page_count: number;
  text_status: 'ready' | 'no_text' | 'error' | 'unavailable';
  extraction_error: string;
  available: boolean;
  keep_offline: boolean;
  last_page: number;
  remote_available: boolean;
  transfer_error: string;
  transfer_status: string;
  remote_id: string;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PaperAnnotation {
  id: string;
  document_id: string;
  page: number;
  quote: string;
  comment: string;
  color: 'yellow' | 'blue' | 'green' | 'pink';
  rects: HighlightRect[];
  created_at: string;
}
export interface SelectedPassage {
  document_id: string;
  page: number;
  text: string;
  rects?: HighlightRect[];
}
export interface SourcePage {
  page: number;
  section: string;
  text: string;
}
export interface DocumentListing {
  documents: OriginalDocument[];
  annotations: PaperAnnotation[];
}
export interface ActivityJob {
  id: string;
  kind: 'document' | 'discussion' | 'comparison' | 'import';
  title: string;
  status: string;
  phase?: string;
  node_id?: string;
  document_id?: string;
  scope_ids?: string[];
  session_id?: string;
  created_at: string;
  error?: string;
  url?: string;
  agent?: string;
  hint?: string;
  source_kind?: 'paper' | 'blog' | 'website';
  settings?: { model: string; effort: string };
}

export async function documentRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result as T;
}

export async function attachOriginal(
  nodeId: string,
  file: File,
): Promise<OriginalDocument> {
  if (file.size > 25 * 1024 * 1024)
    throw new Error('Choose a PDF or text file up to 25 MB.');
  const query = new URLSearchParams({ node_id: nodeId, filename: file.name });
  const response = await fetch(`/api/documents/attach?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.name.toLowerCase().endsWith('.txt')
        ? 'text/plain'
        : 'application/pdf',
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Original could not be attached.');
  return result as OriginalDocument;
}

export const originalFileUrl = (id: string) =>
  `/api/documents/${encodeURIComponent(id)}/original`;
