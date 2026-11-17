from contextlib import closing
from http.client import HTTPConnection
import json
from pathlib import Path
import tempfile
import unittest

from ld02_completion import EditCompletion
import test_responses_gateway as fixtures
from responses_gateway import LOOPBACK
from ld03_model_stdio import call


EXPECTED = {"name": "Ceramics review", "receipt": "AC-270",
            "text": "Ready for registrar review", "gap_px": 14, "radius_px": 10}


class CompletionTests(unittest.TestCase):
    start_server = fixtures.GatewayTest.start_server
    setup_gateway = fixtures.GatewayTest.setup_gateway
    post = fixtures.GatewayTest.post
    def registration(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "config.json"
        path.write_text(json.dumps({"expected_arguments": EXPECTED,
                                   "receipt_path": str(Path(temp.name) / "receipt.json")}))
        return path, EditCompletion(path)

    def status(self):
        with closing(HTTPConnection(LOOPBACK, self.gateway.server_port, timeout=1)) as connection:
            connection.request("GET", "/benchmark/completion")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            return json.loads(response.read())

    def test_receipt_only_after_exact_successful_guarded_result(self):
        _, completion = self.registration()
        request = {"name": "edit_section", "arguments": EXPECTED}
        for params, reply in (
            (request, {"error": "native edit failed"}),
            (request, {"result": {**EXPECTED, "gap_px": 15}}),
            ({"name": "find_section", "arguments": EXPECTED}, {"result": EXPECTED}),
            ({**request, "arguments": {**EXPECTED, "radius_px": 11}}, {"result": EXPECTED}),
        ):
            completion.observe(params, reply)
            self.assertFalse(completion.completed())
        completion.observe({**request, "arguments": {**EXPECTED, "name": "ceramics review"}}, {"result": EXPECTED})
        self.assertTrue(completion.completed())
        self.assertEqual(completion.path.stat().st_mode & 0o777, 0o600)
        # An invalid socket would fail if a post-completion product operation were dispatched.
        blocked = call("does-not-exist", {"name": "find_section"}, "bench_ld02_atlas", completion)
        self.assertTrue(blocked["isError"])
        self.assertIn("independent verification", blocked["content"][0]["text"])

    def test_edit_stops_generation_and_waits_for_actual_terminal_usage(self):
        path, completion = self.registration()
        self.setup_gateway(100, {"main": 20, "title": 10}, {
            "main": fixtures.terminal("main", 20, 3, 0), "title": fixtures.terminal("title", 10, 2, 4),
        }, llama_ld02_atlas=True, completion_config=path)
        self.assertIsNone(self.status()["completion"])
        self.assertEqual(self.post("main", tools=[])[0], 200)
        # An automatic title is already admitted when the native edit returns.
        admission = self.gateway.gate.admit("active-title", "responses",
                                           b'{"model":"llama","stream":true}', minimum_input_tokens=10)
        completion.observe({"name": "edit_section", "arguments": EXPECTED}, {"result": EXPECTED})
        self.assertIsNone(self.status()["completion"])
        self.assertEqual(self.post("title", tools=[])[0], 409)
        self.assertEqual(len(self.mock.events), 2)
        event = {"type": "response.completed", "response": {
            "id": "resp-title", "status": "completed",
            "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12,
                      "input_tokens_details": {"cached_tokens": 4}},
        }}
        self.gateway.gate.record_event(admission.request_id, json.dumps(event).encode())
        self.assertEqual(self.status()["completion"], "guarded_edit_metered")
        self.assertEqual(self.gateway.gate.snapshot()["observed_total_tokens"], 35)

    def test_cancelled_unmetered_request_cannot_complete(self):
        path, completion = self.registration()
        self.setup_gateway(100, {}, {}, llama_ld02_atlas=True, completion_config=path)
        self.gateway.gate.admit("q", "responses", b'{"model":"llama","stream":true}', minimum_input_tokens=10)
        completion.observe({"name": "edit_section", "arguments": EXPECTED}, {"result": EXPECTED})
        self.gateway.gate.end_unmetered("q", "cancelled")
        self.assertIsNone(self.status()["completion"])
        self.assertFalse(self.status()["usage_complete"])


if __name__ == "__main__":
    unittest.main()
