import json
from pathlib import Path
import tempfile
import unittest

from usage import summarize_usage


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

    def test_unsealed_or_unsupported_rollout(self):
        state = trace(3)
        state["recording_status"] = "closed_with_partial_payloads"
        self.assertEqual(self.rollout(state)["status"], "INCOMPLETE")
        state["schema_version"] = 42
        self.assertIsNone(self.rollout(state)["total_tokens"])


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
