"""Serial budget ledger for a prospective compatible Responses gateway.

The caller must route every billable attempt through one ledger, including title
generation, helpers, compaction, and retries. The input lower bound must come from
trusted metering for the actual request, including any provider-managed history.
The caller applies the returned max_output_tokens before dispatch and supplies
the provider's JSON events before admitting anything else. A lower bound leaves
room for a final input overshoot, which the ledger retains in full.

This component performs no transport, credential handling, or approval actions.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
from hashlib import sha256
import json
import math
from threading import Lock


TERMINAL_EVENTS = {
    "response.completed": "completed",
    "response.incomplete": "incomplete",
    "response.failed": "failed",
    "response.cancelled": "cancelled",
    "response.canceled": "cancelled",
}


def _count(value):
    if type(value) is not int or value < 0:
        raise ValueError("expected a nonnegative integer")
    return value


def _identity(value):
    if (
        not isinstance(value, str) or not 0 < len(value) <= 256
        or not value.isprintable() or not value.strip()
    ):
        raise ValueError("expected a bounded nonempty identifier")
    return value


def _reject_constant(_):
    raise ValueError("nonfinite JSON value")


def _finite_float(raw):
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("nonfinite JSON value")
    return value


def _unique_fields(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON field")
        obj[key] = value
    return obj


def _object(raw, max_bytes):
    if type(raw) is not bytes or not 0 < len(raw) <= max_bytes:
        raise ValueError("JSON body is outside the byte limit")
    try:
        obj = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_fields,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except (ValueError, RecursionError) as error:
        raise ValueError("invalid JSON body") from error
    if not isinstance(obj, dict):
        raise ValueError("expected a JSON object")
    return obj


@dataclass(frozen=True)
class Admission:
    request_id: str
    kind: str
    retry_of: str | None
    body_sha256: str
    minimum_input_tokens: int
    max_output_tokens: int


class BudgetGate:
    def __init__(self, token_cap, *, minimum_output_tokens=1, max_json_bytes=8 * 1024 * 1024,
                 require_exact_input=False):
        self.token_cap = _count(token_cap)
        self.minimum_output_tokens = _count(minimum_output_tokens)
        self.max_json_bytes = _count(max_json_bytes)
        self.require_exact_input = require_exact_input
        if min(self.token_cap, self.minimum_output_tokens, self.max_json_bytes) == 0:
            raise ValueError("limits must be positive")
        self._lock = Lock()
        self._active = None
        self._provider_id = None
        self._records = {}
        self._provider_ids = set()
        self._total_tokens = 0
        self._incomplete = False

    def admit(self, request_id, kind, body, *, minimum_input_tokens, retry_of=None):
        """Return an output cap to apply to the exact admitted body before dispatch."""
        _identity(request_id)
        _identity(kind)
        if retry_of is not None:
            _identity(retry_of)
        minimum_input = _count(minimum_input_tokens)
        request = _object(body, self.max_json_bytes)
        _identity(request.get("model"))
        background = request.get("background")
        if request.get("stream") is not True or (background is not False and background is not None):
            raise ValueError("the gateway requires an attached streaming response")
        requested_output = request.get("max_output_tokens")
        if requested_output is not None:
            _count(requested_output)

        with self._lock:
            if self._active is not None:
                raise ValueError("a request is already in flight")
            if self._incomplete:
                raise ValueError("provider token usage is incomplete")
            if request_id in self._records:
                raise ValueError("request identifier has already been used")
            if retry_of is not None and retry_of not in self._records:
                raise ValueError("retry must reference a finished request")
            output_cap = self.token_cap - self._total_tokens - minimum_input
            if requested_output is not None:
                output_cap = min(output_cap, requested_output)
            if output_cap < self.minimum_output_tokens:
                raise ValueError("insufficient budget for input and provider output minimum")
            self._active = Admission(
                request_id, kind, retry_of, sha256(body).hexdigest(), minimum_input, output_cap
            )
            return self._active

    def record_event(self, request_id, body):
        """Consume one provider event. Return true when the request became terminal."""
        with self._lock:
            admission = self._current(request_id)
            try:
                event = _object(body, self.max_json_bytes)
                event_type = _identity(event.get("type"))
                if event_type in TERMINAL_EVENTS or event_type in {
                    "response.created", "response.in_progress", "response.queued",
                }:
                    response = event.get("response")
                    if not isinstance(response, dict):
                        raise ValueError("provider response object is missing")
                    response_id = _identity(response.get("id"))
                    if response_id in self._provider_ids or self._provider_id not in (None, response_id):
                        raise ValueError("provider response identity is inconsistent")
                    self._provider_id = response_id
                if event_type in TERMINAL_EVENTS:
                    outcome = TERMINAL_EVENTS[event_type]
                    status = response.get("status")
                    issue = None
                    if status is not None and status != outcome and (status, outcome) != ("canceled", "cancelled"):
                        issue = "provider event type and response status conflict"
                    self._finish(admission, outcome, response.get("usage"), issue)
                    return True
                if event_type == "error":
                    self._finish(admission, "failed", None)
                    return True
            except ValueError as error:
                self._finish(admission, "invalid_event", None, str(error))
                return True
            return False

    def end_unmetered(self, request_id, outcome, *, issue=None):
        """Seal an EOF, transport failure or cancellation with no terminal provider meter."""
        if outcome not in ("cancelled", "stream_ended", "transport_failed"):
            raise ValueError("unexpected unmetered outcome")
        with self._lock:
            self._finish(self._current(request_id), outcome, None, issue)

    def _current(self, request_id):
        if self._active is None or self._active.request_id != request_id:
            raise ValueError("event does not belong to the in-flight request")
        return self._active

    def _finish(self, admission, outcome, usage, issue=None):
        input_tokens = output_tokens = cached_tokens = None
        if isinstance(usage, dict):
            try:
                input_tokens = _count(usage.get("input_tokens"))
                output_tokens = _count(usage.get("output_tokens"))
                if _count(usage.get("total_tokens")) != input_tokens + output_tokens:
                    raise ValueError("usage total does not match input plus output")
            except ValueError:
                input_tokens = output_tokens = None
                issue = "provider token totals are invalid"
            else:
                self._total_tokens += input_tokens + output_tokens
                try:
                    details = usage.get("input_tokens_details")
                    if not isinstance(details, dict):
                        raise ValueError("cache details are missing")
                    cached_tokens = _count(details.get("cached_tokens"))
                    if cached_tokens > input_tokens:
                        raise ValueError("cache total exceeds input")
                except ValueError:
                    cached_tokens = None
                    issue = "provider cached input meter is incomplete or invalid"
                if (
                    input_tokens < admission.minimum_input_tokens
                    or (self.require_exact_input and input_tokens != admission.minimum_input_tokens)
                    or output_tokens > admission.max_output_tokens
                ):
                    issue = "provider usage contradicts the admitted input or output bounds"
        else:
            issue = issue or "provider token usage is unavailable"
        if issue is not None:
            self._incomplete = True
        self._records[admission.request_id] = {
            "admission": asdict(admission),
            "provider_response_id": self._provider_id,
            "outcome": outcome,
            "raw_usage": usage if isinstance(usage, dict) else None,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_tokens,
            "issue": issue,
        }
        if self._provider_id is not None:
            self._provider_ids.add(self._provider_id)
        self._active = self._provider_id = None

    def snapshot(self):
        """Return observed spend, including any final overshoot, with the full request ledger."""
        with self._lock:
            records = deepcopy(list(self._records.values()))
            metered = [record for record in records if record["input_tokens"] is not None]
            cached = [row["cached_input_tokens"] for row in metered if row["cached_input_tokens"] is not None]
            overshoot = max(0, self._total_tokens - self.token_cap)
            complete = not self._incomplete and self._active is None
            budget_status = "WITHIN_BUDGET"
            if overshoot:
                budget_status = "TIMEOUT_BUDGET"
            elif not complete:
                budget_status = "UNKNOWN"
            elif self._total_tokens == self.token_cap:
                budget_status = "AT_LIMIT"
            return {
                "token_cap": self.token_cap,
                "observed_input_tokens": sum(row["input_tokens"] for row in metered),
                "observed_output_tokens": sum(row["output_tokens"] for row in metered),
                "observed_cached_input_tokens": sum(cached) if cached or complete else None,
                "observed_total_tokens": self._total_tokens,
                "usage_complete": complete,
                "budget_status": budget_status,
                "overshoot_tokens": overshoot,
                "in_flight_request_id": self._active.request_id if self._active is not None else None,
                "requests": records,
            }
