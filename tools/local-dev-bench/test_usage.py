import json
from pathlib import Path
import tempfile
import unittest

from budget_gate import BudgetGate
from usage import RESPONSES_LEDGER_FORMAT, summarize_usage


USAGE = {
    "input_tokens": 10, "output_tokens": 7, "cached_input_tokens": 2,
    "cache_write_input_tokens": 3, "reasoning_output_tokens": 4,
}


class UsageTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def turns(self, *events):
        path = self.root / "stdout.jsonl"
        path.write_text("\n".join(event if isinstance(event, str) else json.dumps(event) for event in events))
        return summarize_usage(path)

    def rollout(self, state):
        path = self.root / "state.json"
        path.write_text(json.dumps(state))
        return summarize_usage(path)

    def test_turn_aggregates_are_observed_but_incomplete(self):
        result = self.turns(
            {"type": "thread.started"}, {"type": "turn.started"},
            {"type": "turn.completed", "usage": USAGE},
            {"type": "turn.started"}, {"type": "turn.completed", "usage": USAGE},
        )
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["source"], "codex-turn")
        self.assertEqual(result["total_tokens"], 34)
        self.assertEqual(result["uncached_input_tokens"], 10)
        self.assertEqual(result["cache_read_input_tokens"], 4)
        self.assertEqual(result["cache_write_input_tokens"], 6)
        self.assertEqual(result["reasoning_output_tokens"], 8)
        self.assertEqual(result["record_count"], 2)

    def test_duplicate_terminal_without_start_is_not_added(self):
        end = {"type": "turn.completed", "usage": USAGE}
        result = self.turns({"type": "turn.started"}, end, end)
        self.assertEqual(result["total_tokens"], 17)
        self.assertTrue(any("no matching turn start" in issue for issue in result["issues"]))

    def test_unknown_counters_stay_null(self):
        result = self.turns({"type": "turn.completed", "usage": {"input_tokens": 0, "output_tokens": 0}})
        self.assertEqual(result["total_tokens"], 0)
        self.assertIsNone(result["uncached_input_tokens"])
        self.assertIsNone(result["cache_write_input_tokens"])
        self.assertIsNone(result["reasoning_output_tokens"])
        self.assertIsNone(self.turns({"type": "turn.failed"})["total_tokens"])
        self.assertEqual(summarize_usage(None)["status"], "NOT_OBSERVABLE")
        self.assertEqual(summarize_usage(self.root / "missing")["status"], "INCOMPLETE")

    def test_invalid_and_truncated_usage(self):
        for update in (
            {"input_tokens": True}, {"output_tokens": -1},
            {"cache_write_input_tokens": 20}, {"reasoning_output_tokens": 8},
            {"cached_input_tokens": None},
        ):
            with self.subTest(update=update):
                result = self.turns({"type": "turn.completed", "usage": USAGE | update})
                self.assertIsNone(result["total_tokens"])
        result = self.turns(
            {"type": "turn.started"}, {"type": "turn.completed", "usage": USAGE},
            {"type": "turn.started"}, '{"type":"turn.',
        )
        self.assertEqual(result["total_tokens"], 17)
        self.assertIn("turn ended without terminal usage", result["issues"])

    def test_closed_rollout_tracks_separate_requests(self):
        for version in (2, 3):
            with self.subTest(version=version):
                result = self.rollout(trace(version))
                self.assertEqual(result["status"], "COMPLETE")
                self.assertEqual(result["source"], "codex-rollout")
                self.assertEqual(result["record_count"], 2)
                self.assertEqual(result["total_tokens"], 34)

    def test_rollout_retains_metered_calls_when_retry_usage_is_missing(self):
        state = trace(3)
        retry = state["inference_calls"]["q2"]
        retry.update(usage=None, execution={"status": "cancelled"}, raw_response_payload_id=None)
        state["compaction_requests"]["c1"] = {}
        result = self.rollout(state)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["total_tokens"], 17)
        self.assertTrue(any("compaction usage" in issue for issue in result["issues"]))
        self.assertTrue(any("metered usage" in issue for issue in result["issues"]))

    def provider_ledger(self, state, cap=100):
        path = self.root / "ledger.json"
        path.write_text(json.dumps(state))
        return summarize_usage(path, usage_format=RESPONSES_LEDGER_FORMAT, expected_token_cap=cap)

    def test_responses_ledger_uses_terminal_usage_and_exact_admissions(self):
        state = gateway_ledger()
        result = self.provider_ledger(state)
        self.assertEqual(result["status"], "COMPLETE")
        self.assertEqual(result["record_count"], 2)
        self.assertEqual(result["source"], RESPONSES_LEDGER_FORMAT)
        self.assertEqual(result["input_tokens"], 20)
        self.assertEqual(result["output_tokens"], 6)
        self.assertEqual(result["total_tokens"], 26)
        self.assertEqual(result["cache_read_input_tokens"], 8)
        self.assertEqual(result["uncached_input_tokens"], 12)
        self.assertIsNone(result["cache_write_input_tokens"])
        self.assertIsNone(result["reasoning_output_tokens"])
        self.assertEqual(summarize_usage(self.root / "ledger.json")["status"], "INCOMPLETE")

    def test_responses_ledger_rejects_admission_and_cumulative_mismatches(self):
        state = gateway_ledger()
        state["requests"][0]["admission"]["minimum_input_tokens"] = 9
        state["requests"][1]["input_tokens"] = 1
        state["observed_cached_input_tokens"] = 1
        result = self.provider_ledger(state, cap=99)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["total_tokens"], 26)
        for issue in ("registered token budget", "exact pre-count", "copied request", "observed_cached_input_tokens"):
            self.assertTrue(any(issue in observed for observed in result["issues"]), result["issues"])

    def test_responses_ledger_deduplicates_ids_and_retains_spend_on_missing_terminal(self):
        state = gateway_ledger()
        first, second = state["requests"]
        state["requests"].append({**first, "provider_response_id": "third"})
        state["requests"].append({**first, "admission": {**first["admission"], "request_id": "another"}})
        second.update(outcome="stream_ended", raw_usage=None, issue="unmetered")
        state.update(usage_complete=False, in_flight_request_id="not-closed")
        result = self.provider_ledger(state)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["total_tokens"], 13)
        self.assertEqual(sum("duplicate admission" in issue for issue in result["issues"]), 2)
        self.assertIn("provider ledger did not close with complete metering", result["issues"])

    def test_responses_ledger_preserves_actual_final_overshoot(self):
        result = self.provider_ledger(gateway_ledger(cap=12, single=True), cap=12)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["total_tokens"], 13)
        self.assertTrue(any("admitted output cap" in issue for issue in result["issues"]))

    def test_unsealed_or_unsupported_rollout(self):
        state = trace(3)
        state["recording_status"] = "closed_with_partial_payloads"
        self.assertEqual(self.rollout(state)["status"], "INCOMPLETE")
        state["schema_version"] = 42
        self.assertIsNone(self.rollout(state)["total_tokens"])


def gateway_ledger(cap=100, single=False):
    gate = BudgetGate(cap, require_exact_input=True)
    for index in range(1 if single else 2):
        uid = f"request-{index}"
        gate.admit(uid, "responses", b'{"model":"llama","stream":true}', minimum_input_tokens=10)
        raw = {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13,
               "input_tokens_details": {"cached_tokens": 8 * index}}
        event = {"type": "response.completed", "response": {
            "id": f"provider-{index}", "usage": raw, "status": "completed",
        }}
        gate.record_event(uid, json.dumps(event).encode())
    return gate.snapshot()


def trace(version):
    return {
        "schema_version": version,
        **({"recording_complete": True} if version == 2 else {"recording_status": "complete"}),
        "inference_calls": {
            key: {
                "inference_call_id": key, "execution": {"status": "completed"},
                "raw_request_payload_id": f"{key}-request",
                "raw_response_payload_id": f"{key}-response",
                "usage": USAGE,
            }
            for key in ("q1", "q2")
        },
        "compaction_requests": {},
        "raw_payloads": {
            f"{key}-{role}": {"kind": {"type": f"inference_{role}"}}
            for key in ("q1", "q2") for role in ("request", "response")
        },
    }


if __name__ == "__main__":
    unittest.main()
