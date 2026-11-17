from contextlib import closing
from http.client import HTTPConnection
from email.message import Message
import json
from pathlib import Path
import io
import tempfile
import unittest
from unittest.mock import Mock, patch

from ld02_completion import EditCompletion
import test_responses_gateway as fixtures
from responses_gateway import LOOPBACK, ResponsesGateway, ResponsesHandler
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


class LD03CompletionTests(unittest.TestCase):
    def registration(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "config.json"
        self.arguments = {"accent": "#136b62", "spacing_px": 20}
        self.observed = {"target": self.arguments, "archive": {"accent": "#2864dc", "spacing_px": 12}}
        path.write_text(json.dumps({"workload": "LD03", "expected_arguments": self.arguments,
            "expected_result": self.observed, "receipt_path": str(Path(temp.name) / "receipt.json")}))
        return path, EditCompletion(path)

    def gateway(self, path, **kwargs):
        # Exercise the real gate/handler without binding any socket or starting a server.
        with patch("responses_gateway.ThreadingHTTPServer.__init__",
                   lambda server, *_: setattr(server, "server_port", 10001)):
            return ResponsesGateway(10002, 100, completion_config=path, **kwargs)

    def status(self, gateway):
        handler = Mock(server=gateway, path="/benchmark/completion", headers={}, wfile=io.BytesIO())
        ResponsesHandler.do_GET(handler)
        return json.loads(handler.wfile.getvalue())

    def test_exact_edit_and_protected_archive_required(self):
        _, completion = self.registration()
        request = {"name": "set_shared_values", "arguments": self.arguments}
        for params, result in (
            ({**request, "name": "inspect_shared_values"}, self.observed),
            ({**request, "arguments": {**self.arguments, "spacing_px": 21}}, self.observed),
            ({**request, "arguments": {**self.arguments, "spacing_px": float("nan")}}, self.observed),
            (request, {**self.observed, "archive": self.arguments}),
            (request, {**self.observed, "extra": True}),
        ):
            completion.observe(params, {"result": result})
            self.assertFalse(completion.completed())
        completion.observe(request, {"error": "native failure", "result": self.observed})
        self.assertFalse(completion.completed())
        completion.observe({**request, "arguments": {**self.arguments, "accent": "#136B62"}},
                           {"result": self.observed})
        self.assertTrue(completion.completed())
        self.assertTrue(call("absent", request, "bench_ld03", completion)["isError"])

    def test_invalid_finite_registration_or_wrong_bridge_rejected(self):
        path, _ = self.registration()
        with self.assertRaises(ValueError):
            self.gateway(path, llama_ld02_atlas=True)
        config = json.loads(path.read_text())
        config["expected_arguments"]["spacing_px"] = float("nan")
        path.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            EditCompletion(path)

    def test_main_and_admitted_title_must_both_settle(self):
        path, completion = self.registration()
        gateway = self.gateway(path, llama_ld03=True)
        def finish(request_id, inputs, outputs, cached):
            gateway.gate.record_event(request_id, json.dumps({"type": "response.completed", "response": {
                "id": "resp-" + request_id, "status": "completed", "usage": {
                    "input_tokens": inputs, "output_tokens": outputs, "total_tokens": inputs + outputs,
                    "input_tokens_details": {"cached_tokens": cached}}}}).encode())
        main = gateway.gate.admit("main", "responses", b'{"model":"llama","stream":true}',
                                  minimum_input_tokens=20)
        finish(main.request_id, 20, 3, 0)
        title = gateway.gate.admit("title", "responses", b'{"model":"llama","stream":true}',
                                   minimum_input_tokens=10)
        completion.observe({"name": "set_shared_values", "arguments": self.arguments}, {"result": self.observed})
        self.assertTrue(gateway.edit_completed())
        self.assertIsNone(self.status(gateway)["completion"])
        body = b'{"model":"llama","stream":true,"tools":[]}'
        headers = Message()
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
        handler = Mock(server=gateway, path="/v1/responses", headers=headers, rfile=io.BytesIO(body))
        gateway.count_input = Mock()
        ResponsesHandler.handle_response_request(handler)
        handler.reply_error.assert_called_once_with(409, "guarded_edit_completed")
        gateway.count_input.assert_not_called()
        finish(title.request_id, 10, 2, 4)
        with gateway.admissions:
            self.assertIsNone(self.status(gateway)["completion"])
        self.assertEqual(self.status(gateway)["completion"], "guarded_edit_metered")
        self.assertEqual(gateway.gate.snapshot()["observed_total_tokens"], 35)

    def test_cancelled_title_cannot_complete_even_after_valid_edit(self):
        path, completion = self.registration()
        gateway = self.gateway(path, llama_ld03=True)
        gateway.gate.admit("title", "responses", b'{"model":"llama","stream":true}', minimum_input_tokens=10)
        completion.observe({"name": "set_shared_values", "arguments": self.arguments}, {"result": self.observed})
        gateway.gate.end_unmetered("title", "cancelled")
        self.assertIsNone(self.status(gateway)["completion"])
        self.assertFalse(self.status(gateway)["usage_complete"])


if __name__ == "__main__":
    unittest.main()
