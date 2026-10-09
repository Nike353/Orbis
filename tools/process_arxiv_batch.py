#!/usr/bin/env python3
"""Resume the Orbis paper queue through a selected local agent."""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BATCH = (
    ROOT / "data" / "imports" / "adaptation-appendix-b-051-106.json")
RETRYABLE_STATUSES = {"queued", "failed", "cancelled", "processing"}


def request_json(url, method="GET", body=None, timeout=30):
    payload = None
    headers = {}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def eligible_records(batch, state, only_ids=None):
    requested = set(only_ids or [])
    result = []
    for record in batch["records"]:
        arxiv_id = record["arxiv_id"]
        if requested and arxiv_id not in requested:
            continue
        status = state["records"].get(
            arxiv_id, {"status": "queued"})["status"]
        if status in RETRYABLE_STATUSES:
            result.append(record)
    return result


def process_record(server, batch, record, agent, verbose=False):
    body = {
        "agent": agent,
        "url": record["canonical_url"],
        "batch_id": batch["batch_id"],
        "arxiv_id": record["arxiv_id"],
        "hint": (
            f"Unattended processing for verified batch {batch['batch_id']}. "
            "Apply this manifest's relevance policy before insertion. "
            "An insertion "
            "must add exactly one paper note and no more than six new edges. "
            "Copy manifest authors exactly: use all authors when there are "
            "six or fewer; otherwise use the first six followed by the "
            "literal string \"...\"."
        ),
    }
    request = urllib.request.Request(
        server + "/api/insert",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    terminal = None
    with urllib.request.urlopen(request, timeout=31 * 60) as response:
        for raw in response:
            try:
                event = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if verbose and event.get("type") == "event":
                if event.get("kind") == "tool":
                    print(
                        f"    {event.get('name', 'Tool')}: "
                        f"{event.get('detail', '')}",
                        flush=True,
                    )
                elif event.get("text"):
                    print(f"    {event['text']}", flush=True)
            if event.get("type") in ("done", "error"):
                terminal = event
    if terminal is None:
        raise RuntimeError("bridge stream ended without a terminal event")
    return terminal


def cancel(server):
    try:
        request_json(
            server + "/api/insert", method="DELETE", timeout=10)
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        pass


def local_server_url(value):
    parsed = urllib.parse.urlparse(value)
    if (parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")):
        raise argparse.ArgumentTypeError(
            "server must be an http:// localhost URL")
    return value.rstrip("/")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Process the durable arXiv queue with a local agent")
    parser.add_argument(
        "--server", type=local_server_url,
        default="http://127.0.0.1:8000")
    parser.add_argument("--batch", type=Path, default=DEFAULT_BATCH)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--agent", choices=("claude", "codex"))
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--stop-on-error", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.limit is not None and args.limit < 1:
        print("ERROR: --limit must be positive", file=sys.stderr)
        return 2
    try:
        batch = json.loads(args.batch.read_text(encoding="utf-8"))
        health = request_json(args.server + "/api/health")
        state = request_json(args.server + "/api/imports/state")
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        print(f"ERROR: could not load queue: {exc}", file=sys.stderr)
        return 1
    agents = {
        item["id"]: item
        for item in health.get("agents", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    agent_id = args.agent or health.get("default_agent")
    if not agent_id or not agents.get(agent_id, {}).get("available"):
        print(
            f"ERROR: local agent {agent_id or '(none)'} is unavailable",
            file=sys.stderr,
        )
        return 1
    if state.get("batch_id") != batch.get("batch_id"):
        print("ERROR: server queue state does not match the batch",
              file=sys.stderr)
        return 1

    records = eligible_records(batch, state, args.only)
    if args.limit is not None:
        records = records[:args.limit]
    print(
        f"Processing {len(records)} retryable record(s) from "
        f"{batch['batch_id']} with {agents[agent_id]['label']} "
        f"through {args.server}",
        flush=True,
    )
    inserted = 0
    excluded = 0
    failed = 0
    try:
        for index, record in enumerate(records, start=1):
            arxiv_id = record["arxiv_id"]
            print(
                f"[{index}/{len(records)}] {arxiv_id} "
                f"{record['title']}",
                flush=True,
            )
            try:
                event = process_record(
                    args.server, batch, record, agent_id, args.verbose)
            except (OSError, urllib.error.URLError, RuntimeError) as exc:
                failed += 1
                print(f"    failed: {exc}", flush=True)
                if args.stop_on_error:
                    return 1
                continue
            outcome = event.get("outcome", "failed")
            if event.get("type") == "error":
                failed += 1
                print(f"    failed: {event.get('message', 'unknown error')}",
                      flush=True)
                if args.stop_on_error:
                    return 1
            elif outcome in ("inserted", "duplicate"):
                inserted += 1
                print(f"    {outcome}", flush=True)
            elif outcome == "excluded":
                excluded += 1
                print("    excluded", flush=True)
            else:
                failed += 1
                print(f"    unexpected outcome: {outcome}", flush=True)
                if args.stop_on_error:
                    return 1
    except KeyboardInterrupt:
        print("\nCancellation requested; stopping active agent run.",
              flush=True)
        cancel(args.server)
        return 130

    print(
        f"Finished: {inserted} inserted/duplicate, {excluded} excluded, "
        f"{failed} failed.",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
