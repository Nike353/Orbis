#!/usr/bin/env python3
"""Retrieve a metadata-only arXiv candidate queue for a local agent.

This tool deliberately does no PDF fetching, summarization, semantic relevance
assessment, clustering, or graph editing. It queries arXiv, normalizes Atom
metadata, applies date/category/query constraints, deduplicates arXiv versions,
and writes an auditable queue manifest plus raw source snapshots.
"""
import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

try:
    from agent_bridge import QueueStateStore, atomic_write_bytes, atomic_write_json
except ModuleNotFoundError:  # Imported as tools.retrieve_arxiv by tests.
    from tools.agent_bridge import (
        QueueStateStore,
        atomic_write_bytes,
        atomic_write_json,
    )

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = (
    ROOT / "data" / "imports" / "humanoid-loco-manipulation-2026.json")
DEFAULT_STATE_OUTPUT = (
    ROOT / "data" / "imports" /
    "humanoid-loco-manipulation-2026-state.json")
DEFAULT_SNAPSHOT_DIR = ROOT / "data" / "imports" / "sources"
ENDPOINT = "https://export.arxiv.org/api/query"
USER_AGENT = (
    "Orbis/2.0 metadata-retriever "
    "(local research workspace; contact: local-user)")
ATOM = {"atom": "http://www.w3.org/2005/Atom",
        "arxiv": "http://arxiv.org/schemas/atom",
        "open": "http://a9.com/-/spec/opensearch/1.1/"}
VERSION_RE = re.compile(r"v\d+$")
SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class QuerySpec:
    query_id: str
    expression: str
    terms: tuple


QUERY_SPECS = (
    QuerySpec(
        "direct-loco-manipulation",
        '(all:"loco-manipulation" OR all:"loco manipulation" '
        'OR all:"tele-loco-manipulation" OR all:"loco-manipulation")',
        ("loco-manipulation", "loco manipulation",
         "tele-loco-manipulation"),
    ),
    QuerySpec(
        "humanoid-manipulation",
        '(all:humanoid AND (all:manipulation OR all:teleoperation '
        'OR all:"object interaction" OR all:"physical interaction"))',
        ("humanoid", "manipulation", "teleoperation", "object interaction",
         "physical interaction"),
    ),
    QuerySpec(
        "humanoid-whole-body",
        '(all:humanoid AND (all:"whole-body control" '
        'OR all:"whole body control" OR all:"whole-body motion" '
        'OR all:"whole body motion" OR all:"whole-body tracking"))',
        ("humanoid", "whole-body control", "whole body control",
         "whole-body motion", "whole body motion", "whole-body tracking"),
    ),
    QuerySpec(
        "humanoid-locomotion-control",
        '((all:humanoid OR all:bipedal) AND '
        '(all:locomotion OR all:walking OR all:"mobile manipulation") '
        'AND (all:control OR all:learning))',
        ("humanoid", "bipedal", "locomotion", "walking",
         "mobile manipulation", "control", "learning"),
    ),
)


def normalize(value):
    return SPACE_RE.sub(" ", value or "").strip()


def iso_bound(value, end=False):
    parsed = date.fromisoformat(value)
    suffix = "2359" if end else "0000"
    return parsed.strftime("%Y%m%d") + suffix


def build_search_query(spec, date_from, date_through):
    return (
        f"cat:cs.RO AND {spec.expression} AND "
        f"submittedDate:[{iso_bound(date_from)} TO "
        f"{iso_bound(date_through, end=True)}]"
    )


def fetch_feed(search_query, max_results, attempts=5):
    params = urllib.parse.urlencode({
        "search_query": search_query,
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    })
    request = urllib.request.Request(
        ENDPOINT + "?" + params,
        headers={"User-Agent": USER_AGENT, "Accept": "application/atom+xml"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if attempt == attempts - 1:
                raise RuntimeError(
                    f"arXiv request failed after {attempts} attempts: {exc}"
                ) from exc
            retry_after = exc.headers.get("Retry-After")
            if exc.code == 429:
                delay = (
                    float(retry_after)
                    if retry_after and retry_after.isdigit()
                    else 15 * (2 ** attempt)
                )
            else:
                delay = 4 * (attempt + 1)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == attempts - 1:
                raise RuntimeError(
                    f"arXiv request failed after {attempts} attempts: {exc}"
                ) from exc
            time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def parse_feed(payload, query_spec):
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise ValueError(f"invalid Atom response: {exc}") from exc

    records = []
    for entry in root.findall("atom:entry", ATOM):
        versioned_url = normalize(entry.findtext("atom:id", "", ATOM))
        versioned_id = versioned_url.rsplit("/", 1)[-1]
        arxiv_id = VERSION_RE.sub("", versioned_id)
        categories = [
            item.attrib.get("term", "")
            for item in entry.findall("atom:category", ATOM)
            if item.attrib.get("term")
        ]
        primary = entry.find("arxiv:primary_category", ATOM)
        primary_category = (
            primary.attrib.get("term", "") if primary is not None
            else (categories[0] if categories else ""))
        title = normalize(entry.findtext("atom:title", "", ATOM))
        abstract = normalize(entry.findtext("atom:summary", "", ATOM))
        haystack = (title + " " + abstract).casefold()
        matched_terms = sorted({
            term for term in query_spec.terms if term.casefold() in haystack
        })
        records.append({
            "arxiv_id": arxiv_id,
            "versioned_id": versioned_id,
            "canonical_url": f"https://arxiv.org/abs/{arxiv_id}",
            "title": title,
            "authors": [
                normalize(author.findtext("atom:name", "", ATOM))
                for author in entry.findall("atom:author", ATOM)
            ],
            "abstract": abstract,
            "submitted_at": normalize(
                entry.findtext("atom:published", "", ATOM)),
            "updated_at": normalize(
                entry.findtext("atom:updated", "", ATOM)),
            "categories": categories,
            "primary_category": primary_category,
            "query_id": query_spec.query_id,
            "query_terms": list(query_spec.terms),
            "retrieval_match": {
                "query_ids": [query_spec.query_id],
                "matched_terms": matched_terms,
            },
        })
    return records


def merge_records(records):
    by_id = {}
    for record in records:
        arxiv_id = record["arxiv_id"]
        existing = by_id.get(arxiv_id)
        if existing is None:
            by_id[arxiv_id] = record
            continue
        query_ids = set(existing["retrieval_match"]["query_ids"])
        query_ids.update(record["retrieval_match"]["query_ids"])
        terms = set(existing["retrieval_match"]["matched_terms"])
        terms.update(record["retrieval_match"]["matched_terms"])
        if record["updated_at"] > existing["updated_at"]:
            existing.update(record)
        existing["retrieval_match"] = {
            "query_ids": sorted(query_ids),
            "matched_terms": sorted(terms),
        }
        existing["query_id"] = sorted(query_ids)[0]
    return sorted(
        by_id.values(),
        key=lambda item: (item["submitted_at"], item["arxiv_id"]),
        reverse=True,
    )


def retrieve(args):
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    all_records = []
    sources = []
    search_queries = []
    args.snapshot_dir.mkdir(parents=True, exist_ok=True)

    fixture_paths = list(args.fixture or [])
    for index, spec in enumerate(QUERY_SPECS):
        search_query = build_search_query(
            spec, args.date_from, args.date_through)
        search_queries.append(search_query)
        if fixture_paths:
            matching = [
                path for path in fixture_paths
                if path.stem.startswith(spec.query_id)]
            if not matching:
                continue
            payload = matching[0].read_bytes()
        else:
            if index:
                time.sleep(args.request_delay)
            payload = fetch_feed(search_query, args.max_results_per_query)

        snapshot_name = (
            f"{spec.query_id}-{args.date_from}_{args.date_through}.atom.xml")
        snapshot_path = args.snapshot_dir / snapshot_name
        atomic_write_bytes(snapshot_path, payload)
        parsed = parse_feed(payload, spec)
        all_records.extend(parsed)
        try:
            snapshot_reference = str(snapshot_path.relative_to(ROOT))
        except ValueError:
            snapshot_reference = str(snapshot_path)
        sources.append({
            "query_id": spec.query_id,
            "snapshot_file": snapshot_reference,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "result_count": len(parsed),
        })

    merged = merge_records(all_records)
    exclusions = []
    eligible = []
    for record in merged:
        submitted = record["submitted_at"][:10]
        if not (args.date_from <= submitted <= args.date_through):
            exclusions.append({
                "arxiv_id": record["arxiv_id"],
                "title": record["title"],
                "reason": "outside requested submission date range",
            })
        elif "cs.RO" not in record["categories"]:
            exclusions.append({
                "arxiv_id": record["arxiv_id"],
                "title": record["title"],
                "reason": "not categorized under cs.RO",
            })
        else:
            eligible.append(record)

    selected = eligible[:args.count]
    for record in selected:
        record.pop("versioned_id", None)
        record["retrieved_at"] = generated_at
        record["queue_status"] = "queued"
        record["attempts"] = 0
        record["last_error"] = None

    batch_id = (
        f"humanoid-loco-manipulation-{args.date_from}_{args.date_through}")
    return {
        "schema_version": 1,
        "batch_id": batch_id,
        "generated_at": generated_at,
        "date_range": {
            "from": args.date_from,
            "through": args.date_through,
        },
        "query": {
            "endpoint": ENDPOINT,
            "search_queries": search_queries,
            "sort_by": "submittedDate",
            "sort_order": "descending",
        },
        "sources": sources,
        "relevance_policy": {
            "description": (
                "The selected local agent, not the retrieval tool, determines "
                "whether a "
                "candidate is genuinely relevant to humanoid "
                "loco-manipulation before proposing graph changes."),
            "evaluated_by": "selected-local-agent",
            "hard_requirements": [
                "Humanoid or bipedal robotic embodiment is central.",
                "The contribution concerns loco-manipulation, whole-body "
                "control or interaction, locomotion while manipulating, "
                "humanoid mobile manipulation, or embodied humanoid control.",
                "Incidental benchmark mentions or non-humanoid mobile-agent "
                "work must be rejected.",
            ],
        },
        "requested_count": args.count,
        "retrieved_count": len(selected),
        "agent_qualified_count": None,
        "records": selected,
        "retrieval_exclusions": exclusions[:50],
    }


def validate_manifest(manifest):
    errors = []
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    if manifest.get("schema_version") != 1:
        errors.append("unsupported manifest schema_version")
    records = manifest.get("records", [])
    if not isinstance(records, list):
        return [*errors, "records must be an array"]

    source_records = []
    source_query_ids = set()
    specs = {spec.query_id: spec for spec in QUERY_SPECS}
    sources = manifest.get("sources", [])
    if not isinstance(sources, list):
        return [*errors, "sources must be an array"]
    for source in sources:
        if not isinstance(source, dict):
            errors.append("every source must be an object")
            continue
        query_id = source.get("query_id")
        if query_id in source_query_ids:
            errors.append(f"duplicate source query_id: {query_id}")
        source_query_ids.add(query_id)
        spec = specs.get(query_id)
        if spec is None:
            errors.append(f"unknown source query_id: {query_id}")
            continue
        source_path = Path(str(source.get("snapshot_file", "")))
        if not source_path.is_absolute():
            source_path = ROOT / source_path
        try:
            payload = source_path.read_bytes()
        except OSError as exc:
            errors.append(f"could not read source snapshot {source_path}: {exc}")
            continue
        digest = hashlib.sha256(payload).hexdigest()
        if digest != source.get("sha256"):
            errors.append(f"source hash mismatch for {query_id}")
        try:
            parsed = parse_feed(payload, spec)
        except ValueError as exc:
            errors.append(f"invalid source snapshot for {query_id}: {exc}")
            continue
        if len(parsed) != source.get("result_count"):
            errors.append(f"source result_count mismatch for {query_id}")
        source_records.extend(parsed)

    if source_query_ids != set(specs):
        errors.append("source snapshots do not cover every configured query")

    verified_by_id = {
        record["arxiv_id"]: record
        for record in merge_records(source_records)
    }
    ids = [record.get("arxiv_id") for record in records]
    if len(ids) != len(set(ids)):
        errors.append("duplicate arXiv IDs")
    dates = [record.get("submitted_at", "") for record in records]
    if dates != sorted(dates, reverse=True):
        errors.append("records are not sorted by submitted_at descending")
    if manifest.get("retrieved_count") != len(records):
        errors.append("retrieved_count does not match records")
    if manifest.get("retrieved_count", 0) > manifest.get(
            "requested_count", 0):
        errors.append("retrieved_count exceeds requested_count")

    date_range = manifest.get("date_range", {})
    date_from = str(date_range.get("from", ""))
    date_through = str(date_range.get("through", ""))
    expected_queries = [
        build_search_query(spec, date_from, date_through)
        for spec in QUERY_SPECS
    ]
    query = manifest.get("query", {})
    if not isinstance(query, dict):
        errors.append("query must be an object")
        query = {}
    if query.get("endpoint") != ENDPOINT:
        errors.append("query endpoint does not match the arXiv API")
    if query.get("search_queries") != expected_queries:
        errors.append("search_queries do not match the configured queries")
    if (query.get("sort_by") != "submittedDate"
            or query.get("sort_order") != "descending"):
        errors.append("query sort configuration is invalid")

    metadata_fields = (
        "canonical_url", "title", "authors", "abstract", "submitted_at",
        "updated_at", "categories", "primary_category", "query_id",
        "retrieval_match",
    )
    for record in records:
        arxiv_id = str(record.get("arxiv_id", ""))
        if not re.fullmatch(r"\d{4}\.\d{4,5}", arxiv_id):
            errors.append(f"invalid arXiv ID: {arxiv_id}")
        if record.get("canonical_url") != (
                "https://arxiv.org/abs/" + arxiv_id):
            errors.append(
                f"non-canonical URL for {arxiv_id}")
        if not record.get("authors") or not record.get("abstract"):
            errors.append(
                f"incomplete metadata for {arxiv_id}")
        submitted = str(record.get("submitted_at", ""))[:10]
        if not (date_from <= submitted <= date_through):
            errors.append(f"record outside date range: {arxiv_id}")
        if "cs.RO" not in record.get("categories", []):
            errors.append(f"record is not categorized under cs.RO: {arxiv_id}")
        query_ids = set(
            record.get("retrieval_match", {}).get("query_ids", []))
        if not query_ids or not query_ids <= source_query_ids:
            errors.append(f"invalid query provenance for {arxiv_id}")
        verified = verified_by_id.get(arxiv_id)
        if verified is None:
            errors.append(f"record absent from source snapshots: {arxiv_id}")
            continue
        for field in metadata_fields:
            if record.get(field) != verified.get(field):
                errors.append(
                    f"metadata mismatch for {arxiv_id}: {field}")
    return errors


def display_path(path):
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Retrieve metadata-only arXiv candidates for a local agent")
    parser.add_argument("--from", dest="date_from", default="2026-01-01")
    parser.add_argument(
        "--through", dest="date_through", default=date.today().isoformat())
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--max-results-per-query", type=int, default=100)
    parser.add_argument("--request-delay", type=float, default=3.1)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--state-output", type=Path, default=DEFAULT_STATE_OUTPUT)
    parser.add_argument(
        "--snapshot-dir", type=Path, default=DEFAULT_SNAPSHOT_DIR)
    parser.add_argument(
        "--fixture", type=Path, action="append",
        help="offline Atom fixture; filename must start with a query id")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        date.fromisoformat(args.date_from)
        date.fromisoformat(args.date_through)
    except ValueError as exc:
        print(f"ERROR: invalid date: {exc}", file=sys.stderr)
        return 2
    if args.date_from > args.date_through:
        print("ERROR: --from must be on or before --through", file=sys.stderr)
        return 2
    if args.count < 1 or args.count > 500:
        print("ERROR: --count must be between 1 and 500", file=sys.stderr)
        return 2

    try:
        manifest = retrieve(args)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    errors = validate_manifest(manifest)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(args.output, manifest)
    QueueStateStore(args.output, args.state_output).load(persist=True)
    print(
        f"OK: retrieved {manifest['retrieved_count']} unique arXiv records "
        f"from {manifest['date_range']['from']} through "
        f"{manifest['date_range']['through']}; wrote "
        f"{display_path(args.output)}")
    print(
        "OK: reconciled durable local-agent queue state at "
        f"{display_path(args.state_output)}")
    if manifest["retrieved_count"] < manifest["requested_count"]:
        print(
            f"NOTE: requested {manifest['requested_count']}; the query "
            "returned fewer eligible metadata records. No padding was added.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
