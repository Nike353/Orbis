#!/usr/bin/env python3
"""Revalidate legacy outcomes with a selected local agent."""

import argparse
import subprocess
import sys
import threading
from pathlib import Path

try:
    from agent_bridge import (
        BridgeContractError,
        IsolatedInsertion,
        QueueStateStore,
        build_agent_command,
        build_revalidation_prompt,
        default_agent_id,
        load_batch,
        resolve_agent,
        stream_agent_events,
        utc_now,
        validate_full_text_source,
        agent_environment,
        stop_agent,
    )
except ModuleNotFoundError:  # Imported as tools.* by tests.
    from tools.agent_bridge import (
        BridgeContractError,
        IsolatedInsertion,
        QueueStateStore,
        build_agent_command,
        build_revalidation_prompt,
        default_agent_id,
        load_batch,
        resolve_agent,
        stream_agent_events,
        utc_now,
        validate_full_text_source,
        agent_environment,
        stop_agent,
    )


ROOT = Path(__file__).resolve().parent.parent
MAX_TURNS = 100
TIMEOUT_S = 30 * 60
SEMANTIC_TERMINAL_STATUSES = {"inserted", "excluded"}


def eligible_records(batch, state, only_ids=None):
    requested = set(only_ids or [])
    result = []
    for record in batch["records"]:
        arxiv_id = record["arxiv_id"]
        if requested and arxiv_id not in requested:
            continue
        outcome = state["records"].get(arxiv_id, {})
        if (outcome.get("status") in SEMANTIC_TERMINAL_STATUSES
                and outcome.get("full_text_source") is None):
            result.append(record)
    return result


def run_revalidation(record, prior, agent_id, agent_label, verbose=False):
    expected_status = prior["status"]
    expected_node = (
        prior.get("graph_node_id")
        if expected_status == "inserted"
        else None
    )
    with IsolatedInsertion(ROOT) as insertion:
        prompt = build_revalidation_prompt(
            record, expected_status, expected_node)
        command = build_agent_command(
            agent_id,
            prompt,
            insertion.workspace,
            MAX_TURNS,
            read_only=True,
        )
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(insertion.workspace),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=agent_environment(),
                start_new_session=True,
            )
        except OSError as exc:
            return None, f"could not launch {agent_label}: {exc}"

        timed_out = threading.Event()
        stderr_tail = []

        def drain_stderr():
            for line in proc.stderr:
                stderr_tail.append(line)
                del stderr_tail[:-20]

        def kill_for_timeout():
            timed_out.set()
            stop_agent(proc)

        stderr_thread = threading.Thread(
            target=drain_stderr, daemon=True)
        stderr_thread.start()
        killer = threading.Timer(TIMEOUT_S, kill_for_timeout)
        killer.start()

        def emit(event):
            if not verbose or event.get("type") != "event":
                return
            if event.get("kind") == "tool":
                print(
                    f"    {event.get('name', 'Tool')}: "
                    f"{event.get('detail', '')}",
                    flush=True,
                )
            elif event.get("text"):
                print(f"    {event['text']}", flush=True)

        try:
            result = stream_agent_events(proc, agent_id, emit)
            code = proc.wait()
            stderr_thread.join(timeout=5)
        except KeyboardInterrupt:
            stop_agent(proc)
            proc.wait()
            raise
        finally:
            killer.cancel()
            stop_agent(proc)
            proc.wait()

        if timed_out.is_set():
            return None, f"{agent_label} exceeded the 30-minute limit"
        if code != 0 or not result["ok"]:
            detail = (
                result["summary"]
                or "".join(stderr_tail)[-1500:]
                or f"{agent_label} exited with code {code}"
            )
            return None, detail

        outcome = result["structured_output"]
        if not isinstance(outcome, dict):
            return None, f"{agent_label} did not provide a structured outcome"
        outcome_name = outcome.get("outcome")
        reason = str(outcome.get("reason", "")).strip()
        summary = str(outcome.get("summary", "")).strip()
        if (outcome_name not in ("inserted", "excluded", "failed")
                or not reason or not summary):
            return None, f"{agent_label} returned an invalid structured outcome"
        if outcome_name == "failed":
            return None, reason

        errors = insertion.verify_unchanged()
        errors.extend(validate_full_text_source(
            record,
            outcome.get("full_text_source"),
            result["webfetch_urls"],
        ))
        if outcome.get("graph_node_id") != (
                expected_node if outcome_name == "inserted" else None):
            errors.append(
                "revalidation graph_node_id does not match the durable outcome")
        if errors:
            return None, "; ".join(errors)
        return {
            "classification": outcome_name,
            "reason": reason,
            "summary": summary,
            "full_text_source": outcome["full_text_source"],
            "full_text_attested_at": utc_now(),
        }, None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Read-only local-agent revalidation for legacy outcomes that "
            "lack full-text source attestations"))
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
        batch = load_batch()
        store = QueueStateStore()
        state = store.load(persist=True)
        agent = resolve_agent(args.agent or default_agent_id())
    except BridgeContractError as exc:
        print(f"ERROR: could not start revalidation: {exc}", file=sys.stderr)
        return 1

    records = eligible_records(batch, state, args.only)
    if args.limit is not None:
        records = records[:args.limit]
    print(
        f"Revalidating {len(records)} unattested terminal outcome(s) "
        f"with {agent['label']}",
        flush=True,
    )

    confirmed = 0
    failed = 0
    try:
        for index, record in enumerate(records, start=1):
            arxiv_id = record["arxiv_id"]
            prior = state["records"][arxiv_id]
            prior_status = prior["status"]
            print(
                f"[{index}/{len(records)}] {arxiv_id} "
                f"expected={prior_status} {record['title']}",
                flush=True,
            )
            result, error = run_revalidation(
                record, prior, agent["id"], agent["label"], args.verbose)
            if error:
                failed += 1
                print(f"    failed: {error}", flush=True)
                if args.stop_on_error:
                    return 1
                continue
            if result["classification"] != prior_status:
                failed += 1
                reason = (
                    "Read-only local-agent revalidation classified this "
                    f"paper as {result['classification']}; the prior durable "
                    f"outcome was {prior_status}. Retry through the normal "
                    "attested processing workflow."
                )
                store.update(
                    arxiv_id,
                    "failed",
                    finished_at=utc_now(),
                    reason=reason,
                    summary=result["summary"],
                    graph_node_id=prior.get("graph_node_id"),
                    full_text_source=result["full_text_source"],
                    full_text_attested_at=result["full_text_attested_at"],
                )
                state["records"][arxiv_id].update({
                    "status": "failed",
                    "reason": reason,
                    **result,
                })
                print(
                    f"    drift: {prior_status} -> "
                    f"{result['classification']} (marked retryable)",
                    flush=True,
                )
                if args.stop_on_error:
                    return 1
                continue
            store.update(
                arxiv_id,
                prior_status,
                full_text_source=result["full_text_source"],
                full_text_attested_at=result["full_text_attested_at"],
            )
            state["records"][arxiv_id].update({
                "full_text_source": result["full_text_source"],
                "full_text_attested_at": result["full_text_attested_at"],
            })
            confirmed += 1
            print("    confirmed", flush=True)
    except KeyboardInterrupt:
        print("\nRevalidation cancelled.", flush=True)
        return 130

    print(
        f"Finished: {confirmed} confirmed, {failed} failed.",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
