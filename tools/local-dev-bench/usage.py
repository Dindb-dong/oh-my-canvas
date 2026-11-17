"""Summarize metered input/output tokens from one attempt's Codex evidence."""

import json
from pathlib import Path
import re

from budget_gate import TERMINAL_EVENTS, _identity, _object

COUNTERS = (
    "input_tokens", "output_tokens", "total_tokens",
    "uncached_input_tokens", "cache_read_input_tokens",
    "cache_write_input_tokens", "reasoning_output_tokens",
)
TERMINAL_REQUEST_STATES = {"completed", "failed", "cancelled", "aborted"}
RESPONSES_LEDGER_FORMAT = "responses-budget-ledger-v1"
MAX_LEDGER_BYTES = 8 * 1024 * 1024


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


def _responses_ledger(state, expected_token_cap):
    source = RESPONSES_LEDGER_FORMAT
    records, issues = [], []
    seen_admissions, seen_responses = set(), set()
    rows = state.get("requests")
    if not isinstance(rows, list) or not rows:
        return _result(source, [], ["no per-request provider ledger records"])
    try:
        cap = _amount(state, "token_cap")
        if cap == 0 or (expected_token_cap is not None and cap != expected_token_cap):
            raise ValueError("ledger cap does not match a positive registered token budget")
    except ValueError as error:
        issues.append(str(error))
        cap = None
    if state.get("usage_complete") is not True or state.get("in_flight_request_id", "") is not None:
        issues.append("provider ledger did not close with complete metering")

    cumulative = 0
    for index, row in enumerate(rows, 1):
        label = f"provider request {index}"
        try:
            admission = row.get("admission") if isinstance(row, dict) else None
            if not isinstance(admission, dict):
                raise ValueError("admission is missing")
            request_id = _identity(admission.get("request_id"))
            response_id = _identity(row.get("provider_response_id"))
            if request_id in seen_admissions or response_id in seen_responses:
                raise ValueError("duplicate admission or provider response ID")
        except ValueError as error:
            issues.append(f"{label}: {error}")
            continue

        retry = admission.get("retry_of")
        if (
            "retry_of" not in admission or
            (retry is not None and (not isinstance(retry, str) or retry not in seen_admissions))
        ):
            issues.append(f"{label}: retry does not reference an earlier admission")
        seen_admissions.add(request_id)
        seen_responses.add(response_id)
        digest = admission.get("body_sha256")
        if admission.get("kind") != "responses" or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            issues.append(f"{label}: invalid Responses admission record")
        outcome = row.get("outcome")
        if not isinstance(outcome, str) or outcome not in TERMINAL_EVENTS.values() or row.get("issue", "") is not None:
            issues.append(f"{label}: missing or incomplete terminal evidence")

        raw = row.get("raw_usage")
        try:
            if not isinstance(raw, dict):
                raise ValueError("metered usage is missing")
            usage = _normalize({key: raw.get(key) for key in ("input_tokens", "output_tokens")})
            if _amount(raw, "total_tokens") != usage["total_tokens"]:
                raise ValueError("raw total does not equal input plus output")
        except ValueError as error:
            issues.append(f"{label}: {error}")
            continue
        records.append(usage)
        details = raw.get("input_tokens_details")
        try:
            if not isinstance(details, dict):
                raise ValueError("provider input cache details are missing")
            cached = _amount(details, "cached_tokens")
            if cached > usage["input_tokens"]:
                raise ValueError("provider cached tokens exceed input")
            usage["cache_read_input_tokens"] = cached
            usage["uncached_input_tokens"] = usage["input_tokens"] - cached
        except ValueError as error:
            issues.append(f"{label}: {error}")
        cached = usage["cache_read_input_tokens"]

        try:
            minimum = _amount(admission, "minimum_input_tokens")
            maximum = _amount(admission, "max_output_tokens")
            if maximum == 0 or (cap is not None and cumulative + minimum + maximum > cap):
                raise ValueError("admission exceeds the remaining token cap")
            if usage["input_tokens"] != minimum or usage["output_tokens"] > maximum:
                raise ValueError("raw usage disagrees with exact pre-count or admitted output cap")
            for key, observed in (("input_tokens", usage["input_tokens"]), ("output_tokens", usage["output_tokens"]),
                                  ("cached_input_tokens", cached)):
                if _amount(row, key) != observed:
                    raise ValueError("copied request counters disagree with raw terminal usage")
        except ValueError as error:
            issues.append(f"{label}: {error}")
        cumulative += usage["total_tokens"]

    for key, count in (
        ("observed_input_tokens", sum(row["input_tokens"] for row in records)),
        ("observed_output_tokens", sum(row["output_tokens"] for row in records)),
        ("observed_total_tokens", cumulative),
        ("observed_cached_input_tokens", sum(row["cache_read_input_tokens"] or 0 for row in records)),
    ):
        reported = state.get(key)
        if type(reported) is not int or reported != count:
            issues.append(f"{key} disagrees with reconciled raw records")
    if cap is not None:
        overshoot = max(0, cumulative - cap)
        status = "WITHIN_BUDGET"
        if overshoot:
            status = "TIMEOUT_BUDGET"
        elif state.get("usage_complete") is not True:
            status = "UNKNOWN"
        elif cumulative == cap:
            status = "AT_LIMIT"
        if (
            type(state.get("overshoot_tokens")) is not int or state["overshoot_tokens"] != overshoot
            or state.get("budget_status") != status
        ):
            issues.append("budget disposition disagrees with reconciled raw records")
    return _result(source, records, issues)


def summarize_usage(path, *, usage_format=None, expected_token_cap=None):
    """Read turn JSONL, a reducer state JSON, or an explicitly registered Responses ledger.

    Numeric counters are observed totals, including on incomplete attempts.
    Keep the private source log or trace bundle for per-request reconciliation.
    """
    if path is None:
        return _result(None, [], [])
    path = Path(path)
    try:
        with path.open("rb") as stream:
            if usage_format == RESPONSES_LEDGER_FORMAT:
                try:
                    ledger = _object(stream.read(MAX_LEDGER_BYTES + 1), MAX_LEDGER_BYTES)
                except ValueError:
                    return _result(RESPONSES_LEDGER_FORMAT, [], ["malformed provider ledger"])
                return _responses_ledger(ledger, expected_token_cap)
            if path.suffix.lower() == ".json":
                try:
                    return _rollout(json.load(stream))
                except (ValueError, UnicodeError):
                    return _result("codex-rollout", [], ["malformed reduced rollout trace"])
            return _turns(stream)
    except OSError:
        return _result(None, [], ["usage evidence is unavailable"])
