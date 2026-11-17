from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from threading import Barrier
import unittest

from budget_gate import BudgetGate


def request(**fields):
    return json.dumps({"model": "mock-model", "stream": True, **fields}).encode()


def meter(input_tokens, output_tokens, cached_tokens):
    return {
        "input_tokens": input_tokens,
        "input_tokens_details": {"cached_tokens": cached_tokens},
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }


def event(response_id, usage=None, status="completed"):
    return json.dumps({
        "type": f"response.{status}",
        "response": {"id": response_id, "status": status, "usage": usage},
    }).encode()


class BudgetGateTest(unittest.TestCase):
    def test_total_includes_title_cached_input_and_distinct_retries(self):
        gate = BudgetGate(100)
        body = request(max_output_tokens=8)
        title = gate.admit("title", "title", body, minimum_input_tokens=15)
        self.assertEqual(title.body_sha256, sha256(body).hexdigest())
        self.assertEqual(title.max_output_tokens, 8)
        self.assertFalse(gate.record_event("title", event("resp-title", status="created")))
        self.assertFalse(gate.record_event("title", b'{"type":"response.output_text.delta","delta":"UI"}'))
        self.assertTrue(gate.record_event("title", event("resp-title", meter(18, 2, 12))))

        main = gate.admit("first", "main", request(), minimum_input_tokens=21)
        self.assertEqual(main.max_output_tokens, 59)
        self.assertTrue(gate.record_event("first", event("resp-first", meter(25, 5, 10), "failed")))

        retry = gate.admit("retry", "main", request(), minimum_input_tokens=25, retry_of="first")
        self.assertEqual(retry.max_output_tokens, 25)
        self.assertTrue(gate.record_event("retry", event("resp-retry", meter(29, 8, 20))))
        summary = gate.snapshot()
        self.assertTrue(summary["usage_complete"])
        self.assertEqual(summary["observed_input_tokens"], 72)
        self.assertEqual(summary["observed_cached_input_tokens"], 42)
        self.assertEqual(summary["observed_output_tokens"], 15)
        self.assertEqual(summary["observed_total_tokens"], 87)
        self.assertEqual(summary["requests"][2]["admission"]["retry_of"], "first")
        self.assertEqual(summary["requests"][1]["raw_usage"], meter(25, 5, 10))
        self.assertEqual(summary["budget_status"], "WITHIN_BUDGET")
        json.dumps(summary)

    def test_known_input_and_provider_output_floor_gate_dispatch(self):
        gate = BudgetGate(100, minimum_output_tokens=16)
        for minimum_input, body in ((85, request()), (40, request(max_output_tokens=15))):
            with self.subTest(minimum_input=minimum_input):
                with self.assertRaisesRegex(ValueError, "insufficient budget"):
                    gate.admit("denied", "main", body, minimum_input_tokens=minimum_input)
        with self.assertRaises(ValueError):
            gate.admit("denied", "main", request(), minimum_input_tokens=None)
        admitted = gate.admit("ok", "main", request(), minimum_input_tokens=84)
        self.assertEqual(admitted.max_output_tokens, 16)
        self.assertTrue(gate.record_event("ok", event("resp-1", meter(84, 16, 70))))
        self.assertEqual(gate.snapshot()["budget_status"], "AT_LIMIT")
        with self.assertRaisesRegex(ValueError, "insufficient budget"):
            gate.admit("later", "title", request(), minimum_input_tokens=0)

    def test_final_input_overshoot_is_counted_in_full_and_blocks_future_turns(self):
        gate = BudgetGate(100)
        admitted = gate.admit("main", "main", request(), minimum_input_tokens=80)
        self.assertEqual(admitted.max_output_tokens, 20)
        gate.record_event("main", event("resp-main", meter(103, 10, 90), "incomplete"))
        summary = gate.snapshot()
        self.assertTrue(summary["usage_complete"])
        self.assertEqual(summary["observed_total_tokens"], 113)
        self.assertEqual(summary["overshoot_tokens"], 13)
        self.assertEqual(summary["budget_status"], "TIMEOUT_BUDGET")
        with self.assertRaisesRegex(ValueError, "insufficient budget"):
            gate.admit("second", "main", request(), minimum_input_tokens=0)

    def test_metered_cancellation_is_charged_and_ambiguous_cancellation_blocks_retry(self):
        gate = BudgetGate(200)
        gate.admit("cancelled", "main", request(), minimum_input_tokens=0)
        self.assertTrue(gate.record_event("cancelled", event("resp-cancelled", meter(11, 2, 7), "cancelled")))
        gate.admit("retry", "main", request(), minimum_input_tokens=0, retry_of="cancelled")
        gate.end_unmetered("retry", "cancelled")
        summary = gate.snapshot()
        self.assertFalse(summary["usage_complete"])
        self.assertEqual(summary["observed_total_tokens"], 13)
        self.assertEqual(summary["observed_cached_input_tokens"], 7)
        self.assertIsNone(summary["requests"][1]["input_tokens"])
        with self.assertRaisesRegex(ValueError, "usage is incomplete"):
            gate.admit("retry-again", "main", request(), minimum_input_tokens=0, retry_of="retry")

    def test_malformed_event_or_usage_cannot_silently_admit_another_request(self):
        for body in (
            b'{"type":"response.completed","type":"response.created"}',
            b'{"type":"response.completed","literal":1e999}',
            b'\xff',
            b'{' + b' ' * 400,
            event("resp-1", None),
            event("resp-1", {**meter(10, 2, 6), "total_tokens": 11}),
            event("resp-1", meter(10, 2, 12)),
        ):
            with self.subTest(body=body[:60]):
                gate = BudgetGate(100, max_json_bytes=400)
                gate.admit("first", "main", request(), minimum_input_tokens=0)
                self.assertTrue(gate.record_event("first", body))
                summary = gate.snapshot()
                self.assertFalse(summary["usage_complete"])
                self.assertIsNone(summary["observed_cached_input_tokens"])
                self.assertIn(summary["observed_total_tokens"], (0, 12))
                with self.assertRaisesRegex(ValueError, "usage is incomplete"):
                    gate.admit("second", "title", request(), minimum_input_tokens=0)

    def test_valid_totals_survive_output_cap_or_input_floor_violation(self):
        for usage in (meter(15, 55, 10), meter(8, 1, 5)):
            with self.subTest(usage=usage):
                gate = BudgetGate(100)
                gate.admit("first", "main", request(max_output_tokens=12), minimum_input_tokens=10)
                gate.record_event("first", event("resp-1", usage))
                summary = gate.snapshot()
                self.assertEqual(summary["observed_total_tokens"], usage["total_tokens"])
                self.assertFalse(summary["usage_complete"])
                self.assertIn("contradicts", summary["requests"][0]["issue"])

    def test_invalid_request_bodies_do_not_consume_a_slot(self):
        gate = BudgetGate(100, max_json_bytes=200)
        for body in (
            b'{"model":"test","stream":true,"model":"other"}',
            b'{"model":"test","stream":true,"n":NaN}',
            b'[]',
            b'{' + b' ' * 200,
            request(max_output_tokens=True),
            request(stream=False),
            request(background=True),
        ):
            with self.subTest(body=body[:60]), self.assertRaises(ValueError):
                gate.admit("request", "main", body, minimum_input_tokens=0)
        self.assertEqual(gate.admit("request", "main", request(), minimum_input_tokens=0).request_id, "request")

    def test_duplicate_and_cross_request_evidence_cannot_double_count(self):
        gate = BudgetGate(100)
        gate.admit("first", "main", request(), minimum_input_tokens=0)
        with self.assertRaisesRegex(ValueError, "does not belong"):
            gate.record_event("other", event("resp-1", meter(10, 2, 1)))
        gate.record_event("first", event("resp-1", meter(10, 2, 1)))
        with self.assertRaisesRegex(ValueError, "already been used"):
            gate.admit("first", "main", request(), minimum_input_tokens=0)
        gate.admit("second", "main", request(), minimum_input_tokens=0)
        self.assertTrue(gate.record_event("second", event("resp-1", meter(10, 2, 1))))
        self.assertEqual(gate.snapshot()["observed_total_tokens"], 12)
        self.assertFalse(gate.snapshot()["usage_complete"])

    def test_concurrent_title_and_main_cannot_both_get_a_slot(self):
        gate = BudgetGate(100)
        barrier = Barrier(2, timeout=3)

        def acquire(kind):
            barrier.wait()
            try:
                return gate.admit(kind, kind, request(), minimum_input_tokens=10).request_id
            except ValueError as error:
                self.assertIn("in flight", str(error))
                return None

        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(acquire, ("main", "title")))
        self.assertEqual(results.count(None), 1)
        self.assertIn(gate.snapshot()["in_flight_request_id"], results)


if __name__ == "__main__":
    unittest.main()
