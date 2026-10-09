#!/usr/bin/env python3
"""Build an arXiv-only queue from the verified Appendix B source ledger.

This tool reads only report text and arXiv Atom metadata. It never downloads
paper HTML/PDF content or performs semantic paper analysis.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

try:
    from agent_bridge import QueueStateStore, atomic_write_json
except ModuleNotFoundError:  # Imported as tools.* by tests.
    from tools.agent_bridge import QueueStateStore, atomic_write_json


ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://export.arxiv.org/api/query"
ATOM = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}
VERSION_RE = re.compile(r"v\d+$")
SPACE_RE = re.compile(r"\s+")
ENTRY_RE = re.compile(r"(?m)^\s*\[(\d+)\]\s*")
ARXIV_URL_RE = re.compile(
    r"https://arxiv\.org/abs/(\d{4}\.\d{4,5})(?:v\d+)?",
    re.IGNORECASE,
)

# MELA's report entry links to Science Robotics, but it also has an exact
# arXiv version. The remaining publisher-only entries in this span have no
# matching arXiv record and are intentionally skipped.
ARXIV_OVERRIDES = {88: "2012.05810"}


def normalize(value):
    return SPACE_RE.sub(" ", value or "").strip()


def parse_ledger(text):
    normalized = text.replace("\f", "\n")
    headings = [
        match.start()
        for match in re.finditer(
            r"(?m)^Appendix B\. Verified source ledger\s*$", normalized)
    ]
    if not headings:
        raise ValueError("Appendix B source ledger was not found")
    start = headings[-1]
    end = normalized.find("Methodological note", start)
    ledger = normalized[start:end if end >= 0 else None]
    parts = ENTRY_RE.split(ledger)
    entries = {}
    for index in range(1, len(parts), 2):
        number = int(parts[index])
        body = normalize(parts[index + 1])
        source_match = re.search(r"https?://\S+", body)
        year_match = re.search(r"\((\d{4})\)\.", body)
        title_match = re.match(
            r".+?\(\d{4}\)\.\s*(.+?)(?:\.\s+(?:arXiv|Nature|NeurIPS|"
            r"ICLR|ICRA|IROS|RSS|Science|IEEE|AAAI|Robotics|Annals|CoRL|"
            r"PMLR)|\.\s+https?://)",
            body,
        )
        arxiv_match = ARXIV_URL_RE.search(body)
        entries[number] = {
            "number": number,
            "body": body,
            "title": normalize(title_match.group(1)) if title_match else body,
            "publication_year": (
                int(year_match.group(1)) if year_match else None
            ),
            "source_url": (
                source_match.group(0).rstrip(".,)")
                if source_match else None
            ),
            "arxiv_id": (
                arxiv_match.group(1)
                if arxiv_match else ARXIV_OVERRIDES.get(number)
            ),
        }
    return entries


def select_entries(entries, start_entry, count, excluded_arxiv_ids=None):
    excluded_ids = set(excluded_arxiv_ids or ())
    selected = []
    skipped = []
    number = start_entry
    while len(selected) < count:
        entry = entries.get(number)
        if entry is None:
            raise ValueError(
                f"ledger ended before {count} eligible arXiv entries were found")
        entry = dict(entry)
        if not entry["arxiv_id"]:
            entry["exclusion_reason"] = (
                "The verified ledger entry has no matching arXiv record; "
                "the arXiv-only local-agent bridge cannot process it."
            )
            skipped.append(entry)
        elif entry["arxiv_id"] in excluded_ids:
            entry["exclusion_reason"] = (
                "This arXiv paper is already represented in the Orbis "
                "graph, so it was replaced by the next eligible ledger entry."
            )
            skipped.append(entry)
        else:
            selected.append(entry)
        number += 1
    return selected, skipped, number


def graph_arxiv_ids(path):
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read existing graph {path}: {exc}") from exc

    result = set()
    for node in graph.get("nodes", []):
        if not isinstance(node, dict) or node.get("type") != "paper":
            continue
        paper = node.get("paper")
        if not isinstance(paper, dict):
            continue
        arxiv = paper.get("arxiv")
        if isinstance(arxiv, dict) and isinstance(arxiv.get("id"), str):
            result.add(VERSION_RE.sub("", arxiv["id"]))
        match = ARXIV_URL_RE.search(str(paper.get("url", "")))
        if match:
            result.add(match.group(1))
    return result


def extract_report_text(path):
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("pdftotext is required to read the report") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"could not extract report text: {exc.stderr.strip()}") from exc
    return result.stdout


def parse_atom(path):
    try:
        root = ET.fromstring(path.read_bytes())
    except (OSError, ET.ParseError) as exc:
        raise ValueError(f"could not parse Atom snapshot {path}: {exc}") from exc

    records = {}
    for entry in root.findall("atom:entry", ATOM):
        versioned_url = normalize(entry.findtext("atom:id", "", ATOM))
        versioned_id = versioned_url.rsplit("/", 1)[-1]
        arxiv_id = VERSION_RE.sub("", versioned_id)
        categories = [
            item.attrib["term"]
            for item in entry.findall("atom:category", ATOM)
            if item.attrib.get("term")
        ]
        primary = entry.find("arxiv:primary_category", ATOM)
        primary_category = (
            primary.attrib.get("term", "")
            if primary is not None
            else (categories[0] if categories else "")
        )
        records[arxiv_id] = {
            "arxiv_id": arxiv_id,
            "canonical_url": f"https://arxiv.org/abs/{arxiv_id}",
            "title": normalize(entry.findtext("atom:title", "", ATOM)),
            "authors": [
                normalize(author.findtext("atom:name", "", ATOM))
                for author in entry.findall("atom:author", ATOM)
            ],
            "abstract": normalize(entry.findtext("atom:summary", "", ATOM)),
            "submitted_at": normalize(
                entry.findtext("atom:published", "", ATOM)),
            "updated_at": normalize(
                entry.findtext("atom:updated", "", ATOM)),
            "categories": categories,
            "primary_category": primary_category,
        }
    return records


def relative_path(path):
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path.resolve())


def source_record(query_id, path, result_count):
    payload = path.read_bytes()
    return {
        "query_id": query_id,
        "snapshot_file": relative_path(path),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "result_count": result_count,
    }


def build_manifest(
        report_path, atom_paths, start_entry, count, generated_at=None,
        excluded_arxiv_ids=None):
    entries = parse_ledger(extract_report_text(report_path))
    selected, skipped, number = select_entries(
        entries, start_entry, count, excluded_arxiv_ids)

    metadata = {}
    atom_counts = []
    for path in atom_paths:
        parsed = parse_atom(path)
        overlap = metadata.keys() & parsed.keys()
        if overlap:
            raise ValueError(
                "duplicate arXiv metadata across snapshots: "
                + ", ".join(sorted(overlap)))
        metadata.update(parsed)
        atom_counts.append(len(parsed))

    missing = [
        entry["arxiv_id"]
        for entry in selected
        if entry["arxiv_id"] not in metadata
    ]
    if missing:
        raise ValueError(
            "missing arXiv metadata for: " + ", ".join(missing))

    timestamp = generated_at or (
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    query_id = (
        f"adaptation-appendix-b-{start_entry:03d}-{number - 1:03d}")
    records = []
    for entry in selected:
        record = dict(metadata[entry["arxiv_id"]])
        record.update({
            "query_id": query_id,
            "query_terms": [
                "verified adaptation source ledger",
                f"appendix-b-entry-{entry['number']}",
            ],
            "retrieved_at": timestamp,
            "retrieval_match": {
                "query_ids": [query_id],
                "matched_terms": [
                    "verified-ledger",
                    f"entry-{entry['number']}",
                ],
            },
            "queue_status": "queued",
            "attempts": 0,
            "last_error": None,
            "appendix_entry": entry["number"],
            "ledger_year": entry["publication_year"],
            "ledger_title": entry["title"],
            "ledger_source_url": entry["source_url"],
        })
        records.append(record)

    sources = [
        source_record(
            f"{query_id}-atom-{index + 1}",
            path,
            atom_counts[index],
        )
        for index, path in enumerate(atom_paths)
    ]
    sources.append(source_record(
        f"{query_id}-report",
        report_path,
        len(entries),
    ))
    return {
        "schema_version": 1,
        "batch_id": f"{query_id}-arxiv-{count}",
        "generated_at": timestamp,
        "date_range": {
            "from": f"Appendix B [{start_entry}]",
            "through": f"Appendix B [{number - 1}]",
        },
        "query": {
            "endpoint": ENDPOINT,
            "search_queries": [
                "Verified arXiv identifiers from Appendix B of "
                "Where Does Adaptation Live? v2"
            ],
            "sort_by": "submittedDate",
            "sort_order": "descending",
        },
        "sources": sources,
        "relevance_policy": {
            "description": (
                "These papers are already verified members of the report's "
                "adaptation taxonomy. The selected agent must map each readable paper "
                "into the adaptation literature graph rather than reapplying "
                "the older humanoid-only retrieval filter."
            ),
            "evaluated_by": "selected-local-agent",
            "hard_requirements": [
                "Read the full arXiv paper before adding semantic content.",
                "Treat membership in the verified Appendix B ledger as "
                "sufficient topical qualification.",
                "Insert every readable, non-duplicate paper and place it by "
                "its adaptation carrier, conditioned component, and update "
                "timescale.",
                "Return failed, not excluded, when full text is unavailable "
                "or the arXiv metadata does not identify the ledger paper.",
            ],
        },
        "requested_count": count,
        "retrieved_count": len(records),
        "agent_qualified_count": None,
        "records": records,
        "retrieval_exclusions": [
            {
                "arxiv_id": f"appendix:{entry['number']}",
                "title": entry["title"],
                "reason": entry["exclusion_reason"],
            }
            for entry in skipped
        ],
    }


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Build an arXiv-only queue from Appendix B")
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "Where_Does_Adaptation_Live_v2.pdf",
    )
    parser.add_argument(
        "--atom", type=Path, action="append", required=True)
    parser.add_argument("--start-entry", type=int, default=51)
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--generated-at")
    parser.add_argument(
        "--existing-graph",
        type=Path,
        default=ROOT / "data" / "graph.json",
        help=(
            "Skip arXiv papers already represented in this graph and extend "
            "the ledger span until the requested count is reached"
        ),
    )
    parser.add_argument(
        "--skip-existing-graph-check",
        action="store_true",
        help=(
            "Do not derive exclusions from the current graph; use this when "
            "rebuilding an already-started durable manifest"
        ),
    )
    parser.add_argument(
        "--exclude-arxiv-id",
        action="append",
        default=[],
        help="Explicit arXiv ID to replace with the next eligible entry",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=(
            ROOT / "data" / "imports" /
            "adaptation-appendix-b-051-106.json"),
    )
    parser.add_argument(
        "--state-output",
        type=Path,
        default=(
            ROOT / "data" / "imports" /
            "adaptation-appendix-b-051-106-state.json"),
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.start_entry < 1 or args.count < 1:
        print(
            "ERROR: --start-entry and --count must be positive",
            file=sys.stderr,
        )
        return 2
    try:
        existing_arxiv_ids = set(args.exclude_arxiv_id)
        if not args.skip_existing_graph_check:
            existing_arxiv_ids.update(graph_arxiv_ids(args.existing_graph))
        manifest = build_manifest(
            args.report,
            args.atom,
            args.start_entry,
            args.count,
            args.generated_at,
            existing_arxiv_ids,
        )
        atomic_write_json(args.output, manifest)
        store = QueueStateStore(args.output, args.state_output)
        state = store.load(persist=True)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    entries = [
        record["appendix_entry"] for record in manifest["records"]
    ]
    print(
        "OK: wrote "
        f"{len(entries)} arXiv records from Appendix B "
        f"[{min(entries)}]-[{max(entries)}]; "
        f"{len(manifest['retrieval_exclusions'])} ineligible or duplicate "
        "entries "
        f"skipped; {sum(1 for item in state['records'].values() if item['status'] == 'queued')} queued"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
