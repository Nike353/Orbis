"""Managed originals, page-linked annotations, and device-local text retrieval."""

import hashlib
import http.client
import io
import ipaddress
import json
import re
import socket
import sqlite3
import ssl
import threading
import unicodedata
import uuid
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

from pypdf import PdfReader, apply_configuration, __version__ as pdf_version

try:
    from agent_bridge import atomic_write_json, utc_now
    from workspace import ensure_library_writable
except ModuleNotFoundError:
    from tools.agent_bridge import atomic_write_json, utc_now
    from tools.workspace import ensure_library_writable


MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_PAGES = 1000
MAX_TEXT = 2_000_000
EXTRACTOR = f"pypdf-{pdf_version}:orbis-2"
HASH_RE = re.compile(r"[a-f0-9]{64}")
ID_RE = re.compile(r"[a-f0-9]{32}")
DOCUMENT_FIELDS = {
    "id", "node_id", "sha256", "media_type", "size", "filename", "source_url",
    "source_version", "retrieved_at",
}
ANNOTATION_FIELDS = {
    "id", "document_id", "page", "quote", "comment", "color", "rects",
    "created_at",
}
COLORS = {"yellow", "blue", "green", "pink"}


class DocumentError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def normalized_text(text):
    return " ".join(unicodedata.normalize("NFKC", text).split())

def evidence_excerpt(text, query, limit):
    if len(text) <= limit:
        return text
    terms = [term for term in dict.fromkeys(re.findall(r"[\w-]{3,}", query.casefold()))
             if term not in {"the", "and", "what", "how", "does", "this", "that", "are",
                             "paper", "explain", "compare", "reported", "with", "for"}][:24]
    positions = ([m.start() for m in re.finditer(
        r"\b(?:" + "|".join(re.escape(term) for term in terms) + r")\b", text, re.I)][:500]
                 if terms else [])
    starts = [max(0, min(len(text) - limit, position - limit // 3)) for position in positions]
    start = max(starts, key=lambda point: sum(point <= position < point + limit
                                             for position in positions), default=0)
    return text[start:start + limit]


def source_identity(url):
    """Identity ignores arXiv versions; the stored URL always retains the version."""
    if not isinstance(url, str):
        raise DocumentError("Choose a valid source URL.")
    parsed = urlparse(url)
    if parsed.hostname in ("arxiv.org", "www.arxiv.org", "export.arxiv.org"):
        match = re.fullmatch(
            r"/(?:abs|pdf|html)/(\d{4}\.\d{4,5}|[a-z-]+/\d{7})(v\d+)?(?:\.pdf)?/?",
            parsed.path,
        )
        if match:
            return "arxiv:" + match[1], match[2] or ""
    return url, ""


def original_url(url):
    identity, _ = source_identity(url)
    if identity.startswith("arxiv:"):
        path = re.sub(r"^/(?:abs|html)/", "/pdf/", urlparse(url).path)
        return "https://arxiv.org" + path
    return url


def validate_url(url, empty=False):
    if empty and url == "":
        return url
    if (not isinstance(url, str) or len(url) > 4000
            or any(ord(c) < 32 for c in url)):
        raise DocumentError("Choose a valid HTTPS source URL.")
    try:
        parsed = urlparse(url)
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        valid = False
    if not valid:
        raise DocumentError("Sources must use HTTPS without credentials or custom ports.")
    return url


def validate_document(record, nodes=None):
    if not isinstance(record, dict) or set(record) != DOCUMENT_FIELDS:
        raise DocumentError("Invalid attachment metadata.")
    if not isinstance(record["id"], str) or not ID_RE.fullmatch(record["id"]):
        raise DocumentError("Invalid attachment identifier.")
    if not isinstance(record["node_id"], str) or (nodes is not None and record["node_id"] not in nodes):
        raise DocumentError("Attachment refers to a missing paper.")
    if not isinstance(record["sha256"], str) or not HASH_RE.fullmatch(record["sha256"]):
        raise DocumentError("Invalid attachment hash.")
    if record["media_type"] not in ("application/pdf", "text/plain"):
        raise DocumentError("Unsupported attachment type.")
    if type(record["size"]) is not int or not 1 <= record["size"] <= MAX_FILE_BYTES:
        raise DocumentError("Attachments must be between 1 byte and 25 MB.")
    for key, limit in (("filename", 250), ("source_version", 100), ("retrieved_at", 100)):
        if not isinstance(record[key], str) or len(record[key]) > limit:
            raise DocumentError("Invalid attachment metadata.")
    if not record["filename"] or Path(record["filename"]).name != record["filename"]:
        raise DocumentError("Invalid attachment filename.")
    validate_url(record["source_url"], empty=True)
    return record


def validate_annotation(record, documents):
    if not isinstance(record, dict) or set(record) != ANNOTATION_FIELDS:
        raise DocumentError("Invalid highlight.")
    if not isinstance(record["id"], str) or not ID_RE.fullmatch(record["id"]):
        raise DocumentError("Invalid highlight identifier.")
    if not isinstance(record["document_id"], str) or record["document_id"] not in documents:
        raise DocumentError("Highlight refers to a missing original.")
    if type(record["page"]) is not int or not 1 <= record["page"] <= MAX_PAGES:
        raise DocumentError("Invalid highlight page.")
    for key, limit in (("quote", 4000), ("comment", 10000), ("created_at", 100)):
        if not isinstance(record[key], str) or len(record[key]) > limit:
            raise DocumentError("Highlight text is too long.")
    if not record["quote"].strip() or not isinstance(record["color"], str) or record["color"] not in COLORS:
        raise DocumentError("Choose text and a supported highlight color.")
    if not isinstance(record["rects"], list) or len(record["rects"]) > 200:
        raise DocumentError("Invalid highlight geometry.")
    for rect in record["rects"]:
        if not isinstance(rect, dict) or set(rect) != {"x", "y", "width", "height"}:
            raise DocumentError("Invalid highlight geometry.")
        if any(type(v) not in (int, float) or not 0 <= v <= 1 for v in rect.values()):
            raise DocumentError("Invalid highlight geometry.")
        if rect["x"] + rect["width"] > 1.01 or rect["y"] + rect["height"] > 1.01:
            raise DocumentError("Highlight extends beyond its page.")
    return record


def public_download(url, cancelled=None):
    """Pin each HTTPS connection to a checked public IP, including every redirect."""
    cancelled = cancelled or threading.Event()
    for _ in range(6):
        validate_url(url)
        parsed = urlparse(url)
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise DocumentError("Source downloads cannot access private or local networks.")
        if cancelled.is_set():
            raise DocumentError("Cancelled by user.")
        connection = http.client.HTTPSConnection(parsed.hostname, timeout=20)
        try:
            connection.sock = ssl.create_default_context().wrap_socket(
                socket.create_connection((addresses[0][4][0], 443), timeout=20),
                server_hostname=parsed.hostname,
            )
            route = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")
            connection.request("GET", route, headers={
                "User-Agent": "Orbis/2.1 (personal research library)",
                "Accept": "application/pdf,text/html,text/plain",
                "Accept-Encoding": "identity",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise DocumentError("Source redirect has no destination.")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise DocumentError(
                    f"Source returned HTTP {response.status}. Attach a file you can access.")
            if response.getheader("Content-Encoding", "identity") != "identity":
                raise DocumentError("Source returned unsupported compressed content.")
            parts, size = [], 0
            while True:
                if cancelled.is_set():
                    raise DocumentError("Cancelled by user.")
                part = response.read(64 * 1024)
                if not part:
                    break
                size += len(part)
                if size > MAX_FILE_BYTES:
                    raise DocumentError("Original exceeds the 25 MB attachment limit.")
                parts.append(part)
            return b"".join(parts), response.getheader("Content-Type", ""), url
        finally:
            connection.close()
    raise DocumentError("Source redirected too many times.")


class ReadableHTML(HTMLParser):
    """Store readable text, never executable HTML or remote page resources."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipped = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "nav", "footer", "noscript", "svg"):
            self.skipped.append(tag)
        if not self.skipped and tag in ("p", "div", "br", "article", "li", "h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.skipped and tag == self.skipped[-1]:
            self.skipped.pop()
        elif not self.skipped and tag in ("p", "div", "article", "li", "h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_data(self, text):
        if not self.skipped:
            self.parts.append(text)

    def text(self):
        return "\n\n".join(normalized_text(line) for line in "".join(self.parts).splitlines()
                           if normalized_text(line))


def extract_pages(content, media_type, cancelled=None):
    cancelled = cancelled or threading.Event()
    if media_type == "text/plain":
        text = content.decode("utf-8")
        if len(text) > MAX_TEXT:
            raise DocumentError("Article exceeds the extraction limit.")
        return [{"page": i + 1, "section": f"Article part {i + 1}", "text": text[start:start + 5000]}
                for i, start in enumerate(range(0, len(text), 5000))]
    page_limit = 8 * 1024 * 1024
    with apply_configuration(
            maximum_declared_stream_length=MAX_FILE_BYTES,
            array_based_stream_maximum_output_length=page_limit,
            zlib_maximum_output_length=page_limit, lzw_maximum_output_length=page_limit,
            run_length_maximum_output_length=page_limit, brotli_maximum_output_length=page_limit,
            stream_decoding_work_maximum_length=2 * page_limit,
            stream_parsing_work_maximum_count=250000, xform_maximum_invocations_per_extraction=1000,
            page_tree_maximum_entries=4 * MAX_PAGES, page_tree_maximum_page_entries=4 * MAX_PAGES,
            jbig2dec_binary=None):
        reader = PdfReader(io.BytesIO(content), strict=True, root_object_recovery_limit=1000,
                           xref_stream_maximum_entries=250000)
        if reader.is_encrypted:
            raise DocumentError("This PDF is encrypted. Attach an unlocked copy you may read.")
        if len(reader.pages) > MAX_PAGES:
            raise DocumentError("PDF exceeds the 1,000-page reader limit.")
        pages, total, decoded = [], 0, 0
        for number, page in enumerate(reader.pages, 1):
            if cancelled.is_set():
                raise DocumentError("Cancelled by user.")
            stream = page.get_contents()
            size = len(stream.get_data()) if stream is not None else 0
            decoded += size
            if size > page_limit or decoded > 5 * page_limit:
                raise DocumentError("PDF exceeds the safe extraction size.")
            text = page.extract_text() or ""
            total += len(text)
            if total > MAX_TEXT:
                raise DocumentError("PDF exceeds the extracted-text limit.")
            heading = next((line.strip() for line in text.splitlines()
                            if re.match(r"^(?:\d+[.)]?\s+)?(?:abstract|introduction|background|related work|"
                                        r"method|approach|framework|experiment|evaluation|result|limitation|conclusion)",
                                        line.strip(), re.I)), "")
            pages.append({"page": number, "section": heading[:160] or f"Page {number}", "text": text})
    return pages


class DocumentStore:
    def __init__(self, root, graph_lock=None):
        self.root = Path(root)
        self.path = self.root / "data/documents.json"
        self.annotation_path = self.root / "data/annotations.json"
        self.local_path = self.root / ".orbis/document-state.json"
        self.jobs_path = self.root / ".orbis/document-jobs.json"
        self.draft_path = self.root / ".orbis/annotation-drafts.json"
        self.lock = threading.RLock()
        self.graph_lock = graph_lock or threading.RLock()
        self.active = {}
        self.verified_blobs = {}

    def state_path(self, path):
        path.relative_to(self.root)
        for part in (path, *path.parents):
            if part == self.root:
                break
            if part.is_symlink():
                raise DocumentError("Document state cannot be a symbolic link.")
        return path

    def write(self, path, value, sync=False):
        if path in (self.path, self.annotation_path) and not sync:
            try:
                ensure_library_writable(self.root)
            except ValueError as exc:
                raise DocumentError(str(exc), 409) from exc
        atomic_write_json(self.state_path(path), value)

    def read(self, path, default):
        self.state_path(path)
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            raise DocumentError("Could not read document state; original files are preserved.", 500) from exc

    def records(self):
        value = self.read(self.path, {})
        if not isinstance(value, dict) or len(value) > 10000:
            raise DocumentError("Invalid attachment catalog.")
        for identifier, record in value.items():
            validate_document(record)
            if record["id"] != identifier:
                raise DocumentError("Attachment identifiers do not match.")
        return value

    def annotations(self):
        documents = self.records()
        value = self.read(self.annotation_path, {})
        if not isinstance(value, dict) or len(value) > 50000:
            raise DocumentError("Invalid highlights catalog.")
        for identifier, annotation in value.items():
            validate_annotation(annotation, documents)
            if identifier != annotation["id"]:
                raise DocumentError("Highlight identifiers do not match.")
        return value

    def node(self, node_id):
        graph = json.loads((self.root / "data/graph.json").read_text())
        node = next((n for n in graph["nodes"] if n["id"] == node_id and n["type"] == "paper"), None)
        if node is None:
            raise DocumentError("Paper not found in this graph.", 404)
        return node

    def blob_path(self, sha):
        if not isinstance(sha, str) or not HASH_RE.fullmatch(sha):
            raise DocumentError("Invalid original hash.")
        folder = self.root / "attachments"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        if folder.is_symlink():
            raise DocumentError("Attachment storage cannot be a symbolic link.")
        path = folder / (sha + ".blob")
        if path.is_symlink():
            raise DocumentError("Original files cannot be symbolic links.")
        return path

    def blob(self, sha):
        path = self.blob_path(sha)
        if not path.exists():
            raise DocumentError("Original is not downloaded on this device.", 404)
        if path.stat().st_size > MAX_FILE_BYTES:
            raise DocumentError("Original exceeds the size limit.")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != sha:
            raise DocumentError("Original failed its integrity check. Re-download it; the file is preserved.", 409)
        return content

    def file_available(self, sha):
        path = self.blob_path(sha)
        try:
            stat = path.stat()
        except FileNotFoundError:
            return False
        fingerprint = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        cached = self.verified_blobs.get(sha)
        if cached and cached[0] == fingerprint:
            return cached[1]
        try:
            self.blob(sha)
            verified = True
        except (DocumentError, OSError):
            verified = False
        try:
            after = path.stat()
        except FileNotFoundError:
            return False
        if after and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) == fingerprint:
            self.verified_blobs[sha] = (fingerprint, verified)
        return verified

    def store_blob(self, sha, content):
        if not content or len(content) > MAX_FILE_BYTES or hashlib.sha256(content).hexdigest() != sha:
            raise DocumentError("Original failed its integrity or size check.")
        path = self.blob_path(sha)
        if path.exists() and path.read_bytes() == content:
            return
        temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.touch(mode=0o600, exist_ok=False)
            temporary.write_bytes(content)
            temporary.replace(path)
            self.verified_blobs.pop(sha, None)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def database(self):
        folder = self.root / ".orbis"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = folder / "document-text.sqlite3"
        if path.is_symlink() or folder.is_symlink():
            raise DocumentError("Document cache cannot be a symbolic link.")
        connection = sqlite3.connect(path, timeout=15)
        try:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS originals
                    (sha TEXT PRIMARY KEY, extractor TEXT, status TEXT, error TEXT, page_count INTEGER);
                CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5
                    (sha UNINDEXED, page UNINDEXED, section UNINDEXED, text);
            """)
            with connection:
                yield connection
        finally:
            connection.close()

    def index(self, record, cancelled=None):
        # A cached index attests to these bytes, never to a replaced or corrupt file.
        content = self.blob(record["sha256"])
        with self.database() as db:
            cached = db.execute("SELECT extractor, status, error, page_count FROM originals WHERE sha=?",
                                (record["sha256"],)).fetchone()
            if cached and cached[0] == EXTRACTOR:
                return {"text_status": cached[1], "extraction_error": cached[2], "page_count": cached[3]}
            try:
                pages = extract_pages(content, record["media_type"], cancelled)
                status = "ready" if any(p["text"].strip() for p in pages) else "no_text"
                error = "" if status == "ready" else "No selectable text. This may be an image-only scan; OCR is not available."
            except Exception as exc:
                pages, status, error = [], "error", str(exc)[:1000]
            if cancelled and cancelled.is_set():
                raise DocumentError("Cancelled by user.")
            db.execute("DELETE FROM pages WHERE sha=?", (record["sha256"],))
            db.executemany("INSERT INTO pages VALUES (?, ?, ?, ?)",
                           [(record["sha256"], p["page"], p["section"], p["text"]) for p in pages])
            db.execute("INSERT OR REPLACE INTO originals VALUES (?, ?, ?, ?, ?)",
                       (record["sha256"], EXTRACTOR, status, error, len(pages)))
        return {"text_status": status, "extraction_error": error, "page_count": len(pages)}

    def view(self, record):
        local = self.read(self.local_path, {}).get(record["sha256"], {})
        available = self.blob_path(record["sha256"]).exists()
        try:
            info = self.index(record) if available else {
                "text_status": "unavailable", "extraction_error": "", "page_count": 0}
        except DocumentError as exc:
            available = False
            info = {"text_status": "error", "extraction_error": str(exc), "page_count": 0}
        return {**record, **info, "available": available,
                "keep_offline": bool(local.get("keep_offline")),
                "last_page": local.get("last_page", 1),
                "remote_available": bool(local.get("remote_available")),
                "transfer_error": local.get("transfer_error", "") or (info["extraction_error"] if not available else ""),
                "transfer_status": local.get("transfer_status", "pending_upload"),
                "remote_id": local.get("remote_id", "")}

    def listing(self, node_id):
        self.node(node_id)
        with self.lock:
            records = [r for r in self.records().values() if r["node_id"] == node_id]
            annotations = [a for a in self.annotations().values()
                           if a["document_id"] in {r["id"] for r in records}]
        return {"documents": [self.view(r) for r in records], "annotations": annotations}

    def attach(self, node_id, content, filename="paper.pdf", source_url="", media_type="application/pdf",
               cancelled=None):
        validate_url(source_url, empty=True)
        if not content or len(content) > MAX_FILE_BYTES:
            raise DocumentError("Choose an original file up to 25 MB.")
        if media_type == "application/pdf":
            if not content.startswith(b"%PDF-"):
                raise DocumentError("File is not a PDF.")
        elif media_type == "text/plain":
            if content.startswith(b"%PDF-"):
                raise DocumentError("This file is a PDF; attach it as a PDF rather than an article.")
            content.decode("utf-8")
        else:
            raise DocumentError("Choose a PDF or readable UTF-8 text file.")
        with self.graph_lock, self.lock:
            self.node(node_id)
            sha = hashlib.sha256(content).hexdigest()
            records = self.records()
            duplicate = next((r for r in records.values()
                              if r["node_id"] == node_id and r["sha256"] == sha
                              and r["source_url"] == source_url and r["media_type"] == media_type), None)
            self.store_blob(sha, content)
            if duplicate:
                record = duplicate
            else:
                record = {
                    "id": uuid.uuid4().hex, "node_id": node_id, "sha256": sha,
                    "size": len(content), "media_type": media_type,
                    "filename": Path(filename).name[:250] or ("paper.pdf" if media_type == "application/pdf" else "article.txt"),
                    "source_url": source_url, "source_version": source_identity(source_url)[1],
                    "retrieved_at": utc_now(),
                }
                validate_document(record)
                records[record["id"]] = record
                self.write(self.path, records)
        # Parsing can be slow; metadata and galaxy saves stay available while it runs.
        self.index(record, cancelled)
        return self.view(record)

    def document(self, identifier):
        if not isinstance(identifier, str) or not ID_RE.fullmatch(identifier):
            raise DocumentError("Invalid original identifier.")
        with self.lock:
            record = self.records().get(identifier)
            if record is None:
                raise DocumentError("Original not found in this graph.", 404)
            return record

    def pages(self, identifier, query=""):
        record = self.document(identifier)
        info = self.index(record)
        with self.database() as db:
            rows = db.execute("SELECT page, section, text FROM pages WHERE sha=? ORDER BY CAST(page AS INTEGER)",
                              (record["sha256"],)).fetchall()
        if query:
            rows = [r for r in rows if normalized_text(query).casefold() in normalized_text(r[2]).casefold()]
        return {**info, "pages": [{"page": int(p), "section": s, "text": t} for p, s, t in rows]}

    def annotate(self, body):
        record = self.document(body.get("document_id"))
        quote = body.get("quote", "")
        page = body.get("page")
        pages = self.pages(record["id"])["pages"]
        text = next((p["text"] for p in pages if p["page"] == page), "")
        if not isinstance(quote, str) or not quote.strip() or normalized_text(quote) not in normalized_text(text):
            raise DocumentError("Selected text does not match the original page.")
        with self.lock:
            if self.document(record["id"]) != record:
                raise DocumentError("Original changed while adding the highlight. Reopen it and retry.", 409)
            annotation = {"id": uuid.uuid4().hex, "document_id": record["id"], "page": page,
                          "quote": quote, "comment": body.get("comment", ""),
                          "color": body.get("color", "yellow"), "rects": body.get("rects", []),
                          "created_at": utc_now()}
            annotations = self.annotations()
            validate_annotation(annotation, self.records())
            annotations[annotation["id"]] = annotation
            self.write(self.annotation_path, annotations)
            return annotation

    def edit_annotation(self, identifier, body):
        with self.lock:
            annotations = self.annotations()
            if identifier not in annotations:
                raise DocumentError("Highlight not found.", 404)
            if body.get("expected") != annotations[identifier]:
                raise DocumentError("Highlight changed on another device. Reopen it before saving.", 409)
            if body.get("action") == "delete":
                del annotations[identifier]
            else:
                annotation = annotations[identifier]
                annotation["comment"] = body.get("comment", annotation["comment"])
                annotation["color"] = body.get("color", annotation["color"])
                validate_annotation(annotation, self.records())
            self.write(self.annotation_path, annotations)
            drafts = self.read(self.draft_path, {})
            drafts.pop(identifier, None)
            self.write(self.draft_path, drafts)
            return {"ok": True}

    def annotation_draft(self, identifier, body=None):
        with self.lock:
            if body is not None and body.get("action") != "discard":
                try:
                    ensure_library_writable(self.root)
                except ValueError as exc:
                    raise DocumentError(str(exc), 409) from exc
            annotation = self.annotations().get(identifier)
            if annotation is None:
                raise DocumentError("Highlight not found.", 404)
            drafts = self.read(self.draft_path, {})
            if not isinstance(drafts, dict):
                raise DocumentError("Invalid highlight draft state. Draft file is preserved.", 409)
            if body is not None:
                if body.get("action") == "discard":
                    drafts.pop(identifier, None)
                else:
                    if set(body) != {"comment", "color", "expected"}:
                        raise DocumentError("Invalid highlight draft.")
                    expected = body["expected"]
                    validate_annotation(expected, self.records())
                    if expected["id"] != identifier:
                        raise DocumentError("Draft refers to a different highlight.")
                    validate_annotation({**expected, "comment": body["comment"], "color": body["color"]},
                                        self.records())
                    drafts[identifier] = body
                self.write(self.draft_path, drafts)
            return drafts.get(identifier)

    def local_state(self, sha, **updates):
        with self.lock:
            self.blob_path(sha)
            value = self.read(self.local_path, {})
            value[sha] = {**value.get(sha, {}), **updates}
            self.write(self.local_path, value)
            return value[sha]

    def availability(self):
        with self.lock:
            records = self.records()
            local = self.read(self.local_path, {})
        return {sha: {"size": next(r["size"] for r in records.values() if r["sha256"] == sha),
                      **local.get(sha, {}), "available": self.file_available(sha),
                      "keep_offline": bool(local.get(sha, {}).get("keep_offline"))}
                for sha in {r["sha256"] for r in records.values()}}

    def remove_local(self, identifier):
        with self.lock:
            record = self.document(identifier)
            local = self.read(self.local_path, {}).get(record["sha256"], {})
            if not local.get("remote_available"):
                raise DocumentError("Upload this original to Drive before removing its local copy.", 409)
            if local.get("keep_offline"):
                raise DocumentError("Turn off Keep offline before removing this download.", 409)
            self.blob_path(record["sha256"]).unlink(missing_ok=True)
            self.verified_blobs.pop(record["sha256"], None)
            self.local_state(record["sha256"], transfer_status="available_on_drive")
            return {"ok": True}

    def jobs(self):
        return self.read(self.jobs_path, [])

    def recover(self):
        with self.lock:
            jobs = self.jobs()
            changed = False
            for job in jobs:
                if job["status"] in ("queued", "fetching", "reading"):
                    job.update(status="interrupted", error="App stopped. Retry to download the original.",
                               finished_at=utc_now())
                    changed = True
            if changed:
                self.write(self.jobs_path, jobs)
            local = self.read(self.local_path, {})
            changed = False
            for value in local.values():
                if value.get("transfer_status") in ("uploading", "downloading"):
                    value.update(transfer_status="interrupted",
                                 transfer_error="File transfer was interrupted. Sync or download again to retry.")
                    changed = True
            if changed:
                self.write(self.local_path, local)

    def update_job(self, identifier, **updates):
        with self.lock:
            jobs = self.jobs()
            job = next(j for j in jobs if j["id"] == identifier)
            job.update(updates)
            self.write(self.jobs_path, jobs)

    def fetch(self, body):
        node = self.node(body.get("node_id"))
        url = original_url(body.get("url") or node.get("paper", {}).get("url", ""))
        validate_url(url)
        with self.lock:
            jobs = self.jobs()
            existing = next((j for j in jobs if j["node_id"] == node["id"]
                             and j["status"] in ("queued", "fetching", "reading")), None)
            if existing:
                return existing
            job = {"id": uuid.uuid4().hex, "kind": "document", "node_id": node["id"],
                   "title": node["label"], "url": url, "status": "queued", "created_at": utc_now()}
            jobs.insert(0, job)
            self.write(self.jobs_path, jobs[:500])
            cancelled = threading.Event()
            self.active[job["id"]] = cancelled
            threading.Thread(target=self.run_fetch, args=(dict(job), cancelled), daemon=True).start()
            return job

    def run_fetch(self, job, cancelled):
        try:
            self.update_job(job["id"], status="fetching")
            content, media, final_url = public_download(job["url"], cancelled)
            self.update_job(job["id"], status="reading")
            if content.startswith(b"%PDF-"):
                media_type, filename = "application/pdf", Path(urlparse(final_url).path).name
                if not filename.endswith(".pdf"):
                    filename += ".pdf"
            elif "html" in media:
                parser = ReadableHTML()
                parser.feed(content.decode("utf-8", errors="replace"))
                text = parser.text()
                if len(text) < 200:
                    raise DocumentError("No readable article text was found. Attach an accessible original.")
                content, media_type, filename = text.encode(), "text/plain", "article.txt"
            elif "text/plain" in media:
                media_type, filename = "text/plain", "article.txt"
            else:
                raise DocumentError("Source is not a PDF or readable article. Attach an original manually.")
            if cancelled.is_set():
                raise DocumentError("Cancelled by user.")
            record = self.attach(job["node_id"], content, filename, final_url, media_type, cancelled)
            self.update_job(job["id"], status="completed", document_id=record["id"],
                            finished_at=utc_now(), error="")
        except Exception as exc:
            self.update_job(job["id"], status="cancelled" if cancelled.is_set() else "failed",
                            error=str(exc)[:1500], finished_at=utc_now())
        finally:
            self.active.pop(job["id"], None)

    def cancel(self, identifier):
        event = self.active.get(identifier)
        if event is None:
            raise DocumentError("This download is no longer running.", 409)
        event.set()
        return {"ok": True}

    def retrieve(self, scope_ids, query, budget=48000):
        """FTS relevance plus method/results context, fairly bounded across sources."""
        records = [r for r in self.records().values() if r["node_id"] in scope_ids]
        evidence, coverage = [], []
        per_source = max(1000, budget // max(1, len(scope_ids)))
        for node_id in scope_ids:
            originals = [r for r in records if r["node_id"] == node_id]
            available = [r for r in originals if self.blob_path(r["sha256"]).exists()]
            if not available:
                coverage.append({"node_id": node_id, "status": "not_downloaded" if originals else "no_original"})
                continue
            record = sorted(available, key=lambda r: r["retrieved_at"], reverse=True)[0]
            try:
                info = self.index(record)
            except DocumentError as exc:
                info = {"text_status": "error", "extraction_error": str(exc), "page_count": 0}
            coverage.append({"node_id": node_id, "document_id": record["id"], **info})
            if info["text_status"] != "ready":
                continue
            with self.database() as db:
                terms = list(dict.fromkeys(re.findall(r"[\w-]{3,}", query, re.UNICODE)))[:24]
                match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
                relevant = db.execute(
                    "SELECT page FROM pages WHERE pages MATCH ? AND sha=? ORDER BY bm25(pages) LIMIT 6",
                    (match, record["sha256"]),
                ).fetchall() if match else []
                rows = db.execute("SELECT page, section, text FROM pages WHERE sha=? ORDER BY CAST(page AS INTEGER)",
                                  (record["sha256"],)).fetchall()
            pages = {int(p): (s, t) for p, s, t in rows}
            ranked = [int(r[0]) for r in relevant]
            ranked += [p for p, (s, _) in pages.items()
                       if re.search(r"abstract|method|approach|framework|result|evaluation|limitation", s, re.I)]
            ranked += [1]
            ranked = list(dict.fromkeys(ranked))
            # Neighboring pages supply context around a match rather than isolated keywords.
            ranked += [p + offset for p in ranked[:3] for offset in (-1, 1)
                       if p + offset in pages and p + offset not in ranked]
            used = 0
            for page in ranked:
                if page not in pages or used >= per_source:
                    continue
                section, text = pages[page]
                excerpt = evidence_excerpt(text, query, min(5000, per_source - used))
                if not excerpt.strip():
                    continue
                evidence.append({"id": f"{record['id']}:{page}", "node_id": node_id,
                                 "document_id": record["id"], "sha256": record["sha256"],
                                 "page": page, "section": section, "source_url": record["source_url"],
                                 "text": excerpt, "truncated": len(excerpt) < len(text)})
                used += len(excerpt)
        return {"passages": evidence, "sources": coverage}
