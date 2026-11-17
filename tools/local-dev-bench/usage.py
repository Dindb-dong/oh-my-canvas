"""Summarize metered input/output tokens from one attempt's Codex evidence."""

import json
from pathlib import Path

COUNTERS = (
    "input_tokens", "output_tokens", "total_tokens",
    "uncached_input_tokens", "cache_read_input_tokens",
    "cache_write_input_tokens", "reasoning_output_tokens",
)
TERMINAL_REQUEST_STATES = {"completed", "failed", "cancelled", "aborted"}


def _amount(usage, field, optional=False):
    if optional and field not in usage:
        return None
    value = usage.get(field)
    if type(value) is not int or value < 0:
        raise ValueError(f"{field} must be a nonnegative integer")
    return value


def _normalize(usage):
    if not isinstance(usage, dict):
        raise ValueError("metered usage is missing")
    input_tokens = _amount(usage, "input_tokens")
    output_tokens = _amount(usage, "output_tokens")
    cached = _amount(usage, "cached_input_tokens", optional=True)
    written = _amount(usage, "cache_write_input_tokens", optional=True)
    reasoning = _amount(usage, "reasoning_output_tokens", optional=True)
    if (cached or 0) + (written or 0) > input_tokens or (reasoning or 0) > output_tokens:
        raise ValueError("usage categories exceed their reported totals")
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "uncached_input_tokens": (
            input_tokens - cached - written if cached is not None and written is not None else None
        ),
        "cache_read_input_tokens": cached,
        "cache_write_input_tokens": written,
        "reasoning_output_tokens": reasoning,
    }


def _result(source, records, issues):
    status = "INCOMPLETE" if issues else "COMPLETE"
    if source is None and not records and not issues:
        status = "NOT_OBSERVABLE"
    return {
        "normalization_version": 1,
        "status": status,
        "source": source,
        "record_count": len(records),
        "issues": issues,
        **{
            key: (
                sum(record[key] for record in records)
                if records and all(record[key] is not None for record in records)
                else None
            )
            for key in COUNTERS
        },
    }


def _turns(stream):
    records = []
    issues = ["turn aggregates omit per-request provider and model-input evidence"]
    open_turn = False
    started = False
    for line_number, line in enumerate(stream, 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            issues.append(f"line {line_number}: malformed JSON")
            continue
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            issues.append(f"line {line_number}: event type is missing")
            continue
        event_type = event["type"]
        if event_type == "turn.started":
            if open_turn:
                issues.append(f"line {line_number}: previous turn has no terminal event")
            started = open_turn = True
        elif event_type in {"turn.completed", "turn.failed", "turn.interrupted"}:
            # The public event has no turn ID. Require a new start to count a second terminal event.
            if not open_turn and (started or records):
                issues.append(f"line {line_number}: terminal event has no matching turn start")
                continue
            open_turn = False
            try:
                records.append(_normalize(event.get("usage")))
            except ValueError as error:
                issues.append(f"line {line_number}: {error}")
        elif event_type == "error":
            issues.append(f"line {line_number}: fatal stream error")
    if open_turn:
        issues.append("turn ended without terminal usage")
    if not records:
        issues.append("no metered turn records")
    return _result("codex-turn", records, issues)


def _rollout(state):
    source = "codex-rollout"
    if not isinstance(state, dict) or type(state.get("schema_version")) is not int:
        return _result(source, [], ["expected a reduced Codex rollout trace object"])
    version = state["schema_version"]
    if version not in {2, 3}:
        return _result(source, [], ["unsupported reduced Codex rollout trace schema"])
    requests = state.get("inference_calls")
    compactions = state.get("compaction_requests")
    payloads = state.get("raw_payloads")
    if not all(isinstance(group, dict) for group in (requests, compactions, payloads)):
        return _result(source, [], ["required request or payload index is missing"])

    records = []
    issues = []
    closed = (
        state.get("recording_complete") is True
        if version == 2 else state.get("recording_status") == "complete"
    )
    if not closed:
        issues.append("rollout recorder did not seal a complete capture")
    if not requests:
        issues.append("no inference requests")
    if compactions:
        # shortcut: Codex traces omit compaction usage, add attribution once the reducer exposes it.
        issues.append(f"compaction usage is unavailable for {len(compactions)} request(s)")

    for index, (request_id, request) in enumerate(requests.items(), 1):
        label = f"inference request {index}"
        if not isinstance(request, dict) or request.get("inference_call_id") != request_id:
            issues.append(f"{label}: inconsistent request identity")
            continue
        execution = request.get("execution")
        status = execution.get("status") if isinstance(execution, dict) else None
        if not isinstance(status, str) or status not in TERMINAL_REQUEST_STATES:
            issues.append(f"{label}: terminal lifecycle is missing")
        for role in ("request", "response"):
            ref = request.get(f"raw_{role}_payload_id")
            if not isinstance(ref, str) or not isinstance(payloads.get(ref), dict):
                issues.append(f"{label}: raw {role} reference is missing")
        try:
            usage = _normalize(request.get("usage"))
        except ValueError as error:
            issues.append(f"{label}: {error}")
            continue
        if any(value is None for value in usage.values()):
            issues.append(f"{label}: token breakdown is incomplete")
        records.append(usage)
    return _result(source, records, issues)


def summarize_usage(path):
    """Read one JSONL turn ledger or same-binary reducer state JSON.

    Numeric counters are observed totals, including on incomplete attempts.
    Keep the private source log or trace bundle for per-request reconciliation.
    """
    if path is None:
        return _result(None, [], [])
    path = Path(path)
    try:
        with path.open("rb") as stream:
            if path.suffix.lower() == ".json":
                try:
                    return _rollout(json.load(stream))
                except (ValueError, UnicodeError):
                    return _result("codex-rollout", [], ["malformed reduced rollout trace"])
            return _turns(stream)
    except OSError:
        return _result(None, [], ["usage evidence is unavailable"])
