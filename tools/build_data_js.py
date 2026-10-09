#!/usr/bin/env python3
"""Validate data/graph.json and regenerate the data/graph.js mirror.

The mirror lets index.html work when opened directly from disk (file://),
where fetch() is blocked. Run this after every edit to graph.json.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
GRAPH_JSON = ROOT / "data" / "graph.json"
GRAPH_JS = ROOT / "data" / "graph.js"

NODE_TYPES = {
    "paper", "cluster", "method", "representation",
    "assumption", "experiment", "claim", "open_question",
}
STATUSES = {"proposed", "accepted", "rejected", "uncertain"}
ORIGINS = {"user", "agent", "claude"}
ARXIV_ID_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")
EDGE_ID_RE = re.compile(r"^e\d+$")


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_non_empty_string(value):
    return isinstance(value, str) and bool(value.strip())


def is_url(value):
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def validate(data):
    errors = []
    node_ids = set()

    if not isinstance(data, dict):
        return ["graph must be an object"]
    for key in ("meta", "nodes", "edges"):
        if key not in data:
            errors.append(f"missing top-level key: {key}")
    if errors:
        return errors

    meta = data["meta"]
    if not isinstance(meta, dict):
        errors.append("meta must be an object")
        return errors
    if (not isinstance(meta.get("schema_version"), int)
            or isinstance(meta.get("schema_version"), bool)
            or meta.get("schema_version") not in (1, 2)):
        errors.append("meta.schema_version must be 1 or 2")
    if (not isinstance(meta.get("revision"), int)
            or isinstance(meta.get("revision"), bool)
            or meta.get("revision", -1) < 0):
        errors.append("meta.revision must be a non-negative integer")
    if not is_non_empty_string(meta.get("title")):
        errors.append("meta.title must be a non-empty string")
    if not is_non_empty_string(meta.get("updated_at")):
        errors.append("meta.updated_at must be a non-empty string")
    if not isinstance(data["nodes"], list):
        errors.append("nodes must be an array")
    if not isinstance(data["edges"], list):
        errors.append("edges must be an array")
    if errors:
        return errors

    for n in data["nodes"]:
        if not isinstance(n, dict):
            errors.append("every node must be an object")
            continue
        raw_id = n.get("id")
        nid = raw_id if isinstance(raw_id, str) else "<missing or invalid id>"
        if isinstance(raw_id, str) and raw_id in node_ids:
            errors.append(f"duplicate node id: {nid}")
        if isinstance(raw_id, str):
            node_ids.add(raw_id)
        for field in ("id", "type", "label", "status", "origin"):
            if field not in n:
                errors.append(f"node {nid}: missing required field '{field}'")
        if not is_non_empty_string(raw_id):
            errors.append(f"node {nid}: id must be a non-empty string")
        if n.get("type") not in NODE_TYPES:
            errors.append(f"node {nid}: invalid type '{n.get('type')}'")
        if not is_non_empty_string(n.get("label")):
            errors.append(f"node {nid}: label must be a non-empty string")
        if n.get("status") not in STATUSES:
            errors.append(f"node {nid}: invalid status '{n.get('status')}'")
        if n.get("origin") not in ORIGINS:
            errors.append(f"node {nid}: invalid origin '{n.get('origin')}'")
        if "description" in n and not isinstance(n["description"], str):
            errors.append(f"node {nid}: description must be a string")
        if "notes" in n and (not isinstance(n["notes"], str) or len(n["notes"]) > 100000):
            errors.append(f"node {nid}: notes must be a string of at most 100000 characters")
        if "cluster" in n and not isinstance(n["cluster"], str):
            errors.append(f"node {nid}: cluster must be a string")
        if "created_at" in n and not isinstance(n["created_at"], str):
            errors.append(f"node {nid}: created_at must be a string")
        if "notes_file" in n and not isinstance(n["notes_file"], str):
            errors.append(f"node {nid}: notes_file must be a string")
        if "position" in n:
            position = n["position"]
            if not isinstance(position, dict):
                errors.append(f"node {nid}: position must be an object")
            else:
                for axis in ("x", "y"):
                    if not is_number(position.get(axis)):
                        errors.append(
                            f"node {nid}: position.{axis} must be a number")
                if "z" in position and not is_number(position["z"]):
                    errors.append(
                        f"node {nid}: position.z must be a number")
        if n.get("type") == "paper":
            paper = n.get("paper")
            if not isinstance(paper, dict):
                errors.append(f"node {nid}: paper node missing 'paper' card")
            else:
                for field in ("title", "authors", "year", "venue", "url",
                              "summary", "key_findings"):
                    if field not in paper:
                        errors.append(
                            f"node {nid}: paper card missing '{field}'")
                if not is_non_empty_string(paper.get("title")):
                    errors.append(
                        f"node {nid}: paper title must be a non-empty string")
                source_kind = paper.get("source_kind", "paper")
                if source_kind not in ("paper", "blog", "website"):
                    errors.append(f"node {nid}: invalid source_kind")
                web_source = source_kind in ("blog", "website")
                authors = paper.get("authors")
                if (not isinstance(authors, list) or (not authors and not web_source)
                        or not all(is_non_empty_string(author)
                                   for author in authors)):
                    errors.append(
                        f"node {nid}: paper authors must be a non-empty "
                        "string array")
                year = paper.get("year")
                if not (web_source and year is None) and (
                        not isinstance(year, int) or isinstance(year, bool)
                        or not 1900 <= year <= 2200):
                    errors.append(
                        f"node {nid}: paper year must be an integer in "
                        "[1900, 2200]")
                if not isinstance(paper.get("venue"), str):
                    errors.append(
                        f"node {nid}: paper venue must be a string")
                if not is_url(paper.get("url")):
                    errors.append(
                        f"node {nid}: paper url must be an http(s) URL")
                if not isinstance(paper.get("summary"), str):
                    errors.append(
                        f"node {nid}: paper summary must be a string")
                findings = paper.get("key_findings")
                if (not isinstance(findings, list)
                        or not all(isinstance(finding, str)
                                   for finding in findings)):
                    errors.append(
                        f"node {nid}: paper key_findings must be a string "
                        "array")
                arxiv = paper.get("arxiv")
                if arxiv is not None:
                    if not isinstance(arxiv, dict):
                        errors.append(
                            f"node {nid}: paper arxiv must be an object")
                    else:
                        arxiv_id = arxiv.get("id")
                        if (not isinstance(arxiv_id, str)
                                or not ARXIV_ID_RE.fullmatch(arxiv_id)):
                            errors.append(
                                f"node {nid}: paper arxiv.id is invalid")
                        if not is_url(arxiv.get("canonical_url")):
                            errors.append(
                                f"node {nid}: paper arxiv canonical_url "
                                "must be an http(s) URL")
                        for field in (
                                "submitted_at", "updated_at",
                                "primary_category", "query_id"):
                            if not is_non_empty_string(arxiv.get(field)):
                                errors.append(
                                    f"node {nid}: paper arxiv.{field} "
                                    "must be a non-empty string")
                        categories = arxiv.get("categories")
                        if (not isinstance(categories, list)
                                or not categories
                                or not all(is_non_empty_string(category)
                                           for category in categories)):
                            errors.append(
                                f"node {nid}: paper arxiv.categories must "
                                "be a non-empty string array")
        if n.get("type") == "cluster" and "cluster" in n:
            errors.append(f"node {nid}: cluster nodes cannot belong to a cluster")

    cluster_ids = {
        n.get("id") for n in data["nodes"]
        if isinstance(n, dict)
        and n.get("type") == "cluster"
        and isinstance(n.get("id"), str)
    }
    for n in data["nodes"]:
        if not isinstance(n, dict):
            continue
        c = n.get("cluster")
        if c and c not in cluster_ids:
            errors.append(
                f"node {n.get('id', '<missing id>')}: unknown cluster '{c}'")

    edge_ids = set()
    for e in data["edges"]:
        if not isinstance(e, dict):
            errors.append("every edge must be an object")
            continue
        raw_id = e.get("id")
        eid = raw_id if isinstance(raw_id, str) else "<missing or invalid id>"
        if isinstance(raw_id, str) and raw_id in edge_ids:
            errors.append(f"duplicate edge id: {eid}")
        if isinstance(raw_id, str):
            edge_ids.add(raw_id)
        for field in ("id", "source", "target", "relation",
                      "transition_note", "confidence", "evidence",
                      "status", "origin"):
            if field not in e:
                errors.append(f"edge {eid}: missing required field '{field}'")
        if (not isinstance(raw_id, str)
                or not EDGE_ID_RE.fullmatch(raw_id)):
            errors.append(f"edge {eid}: id must match eNNN")
        for endpoint in ("source", "target"):
            ref = e.get(endpoint)
            if not is_non_empty_string(ref):
                errors.append(
                    f"edge {eid}: {endpoint} must be a non-empty string")
            elif ref not in node_ids:
                errors.append(f"edge {eid}: unknown {endpoint} '{ref}'")
        for field in ("relation", "transition_note", "evidence"):
            if not is_non_empty_string(e.get(field)):
                errors.append(
                    f"edge {eid}: {field} must be a non-empty string")
        if e.get("status") not in STATUSES:
            errors.append(f"edge {eid}: invalid status '{e.get('status')}'")
        if e.get("origin") not in ORIGINS:
            errors.append(f"edge {eid}: invalid origin '{e.get('origin')}'")
        conf = e.get("confidence")
        if not is_number(conf) or not 0.0 <= conf <= 1.0:
            errors.append(f"edge {eid}: confidence must be a number in [0, 1]")
        if "created_at" in e and not isinstance(e["created_at"], str):
            errors.append(f"edge {eid}: created_at must be a string")

    return errors


def render_mirror(data):
    return (
        "// GENERATED FILE - DO NOT EDIT.\n"
        "// Mirror of data/graph.json for file:// mode. Regenerate with:\n"
        "//   python3 tools/build_data_js.py\n"
        "window.ORBIS_DATA = "
        + json.dumps(data, indent=2, ensure_ascii=False)
        + ";\n"
    )


def write_mirror(data):
    GRAPH_JS.write_text(render_mirror(data), encoding="utf-8")


def load_and_validate():
    try:
        data = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR reading {GRAPH_JSON}: {exc}", file=sys.stderr)
        return None, [str(exc)]

    errors = validate(data)
    if errors:
        return data, errors
    return data, []


def main():
    parser = argparse.ArgumentParser(
        description="Validate graph.json and maintain its file:// mirror")
    parser.add_argument(
        "--check", action="store_true",
        help="validate and verify mirror freshness without writing files")
    args = parser.parse_args()

    data, errors = load_and_validate()
    if errors:
        print(f"VALIDATION FAILED ({len(errors)} error(s)):", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    mirror = render_mirror(data)
    if args.check:
        try:
            current = GRAPH_JS.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"ERROR reading {GRAPH_JS}: {exc}", file=sys.stderr)
            return 1
        if current != mirror:
            print("VALIDATION FAILED: data/graph.js is stale; run "
                  "python3 tools/build_data_js.py", file=sys.stderr)
            return 1
        action = "mirror current"
    else:
        write_mirror(data)
        action = f"wrote {GRAPH_JS.relative_to(ROOT)}"

    print(f"OK: graph.json valid ({len(data['nodes'])} nodes, "
          f"{len(data['edges'])} edges, revision {data['meta']['revision']}); "
          f"{action}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
