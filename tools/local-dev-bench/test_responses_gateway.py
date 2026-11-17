from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from hashlib import sha256
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Event, Thread
import unittest

from llama_canary import CANARY, FUNCTION, LD03, LD03_APPLY, LD03_INSPECT, LD03_NAMESPACE, LD03_TOOLS, LLAMA_NAME, NAMESPACE
from responses_gateway import COUNT_PATH, CREATE_PATH, LOOPBACK, TIMEOUT_SECONDS, ResponsesGateway, json_bytes


def frame(event_type, response, *, multiline=False):
    data = json_bytes({"type": event_type, "response": response})
    if multiline:
        data = data.replace(b',"response":', b',\r\ndata:"response":', 1)
    return b"event: " + event_type.encode() + b"\r\ndata: " + data + b"\r\n\r\n"


def terminal(name, input_tokens, output_tokens, cached_tokens, *, status="completed"):
    return frame(f"response.{status}", {
        "id": "resp-" + name, "status": status, "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "input_tokens_details": {"cached_tokens": cached_tokens},
        },
    }, multiline=True)


def codex_ld03_namespace():
    return {
        "type": "namespace", "name": LD03_NAMESPACE, "tools": [
            {"type": "function", "name": tool["name"], "description": tool["description"],
             "parameters": tool["inputSchema"], "strict": False}
            for tool in LD03_TOOLS
        ],
    }


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.events.append((self.path, request, set(self.headers.keys())))
        if self.path == COUNT_PATH:
            data = json_bytes({"input_tokens": self.server.counts[request["input"]]})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)
        elif self.path == CREATE_PATH:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.server.generating.set()
            if not self.server.continue_generation.wait(3):
                return
            self.wfile.write(self.server.responses[request["input"]])


class GatewayTest(unittest.TestCase):
    def start_server(self, server):
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def setup_gateway(self, cap, counts, responses, *, pause=False, **gateway_options):
        mock = ThreadingHTTPServer((LOOPBACK, 0), FixtureHandler)
        mock.events, mock.counts, mock.responses = [], counts, responses
        mock.generating, mock.continue_generation = Event(), Event()
        if not pause:
            mock.continue_generation.set()
        self.mock = self.start_server(mock)
        self.gateway = self.start_server(ResponsesGateway(mock.server_port, cap, **gateway_options))

    def post(self, name, *, path=CREATE_PATH, headers=None, **extra):
        body = json_bytes({"model": "mock-model", "stream": True, "input": name, **extra})
        with closing(HTTPConnection(LOOPBACK, self.gateway.server_port, timeout=5)) as conn:
            conn.request("POST", path, body, {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            return response.status, response.read()

    def test_upstream_socket_timeout_is_scoped_and_positive(self):
        with ResponsesGateway(12345, 40) as default, ResponsesGateway(12345, 40, upstream_timeout=60) as opted_in:
            with closing(default.connection()) as default_connection, closing(opted_in.connection()) as longer_connection:
                self.assertEqual(default_connection.timeout, TIMEOUT_SECONDS)
                self.assertEqual(longer_connection.timeout, 60)
        for invalid in (0, -1, True, 1.5):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                ResponsesGateway(12345, 40, upstream_timeout=invalid)

    def test_llama_bridge_reprojects_the_observed_namespace_and_preserves_call_identity(self):
        call = {"type": "function_call", "id": "fc_1", "call_id": "call_1",
                "name": LLAMA_NAME, "arguments": "{ }", "status": "completed"}
        added = {**call, "arguments": "", "status": "in_progress"}
        done = call
        terminal_usage = {"input_tokens": 32, "output_tokens": 4, "total_tokens": 36,
                          "input_tokens_details": {"cached_tokens": 7}}
        three_events = [
            {"type": "response.output_item.added", "item": added},
            {"type": "response.output_item.done", "item": done},
            {"type": "response.completed", "response": {
                "id": "resp-tool", "status": "completed", "usage": terminal_usage, "output": [done],
            }},
        ]
        responses = {"tool": b"".join(b"data: " + json_bytes(event) + b"\n\n" for event in three_events)}
        self.setup_gateway(60, {"tool": 32}, responses, llama_synthetic_canary=True)
        tools = [
            {"type": "function", "name": "create_goal"},
            {"type": "namespace", "name": "mcp__codex_tui", "tools": [{"type": "function", "name": "create_thread"}]},
            {"type": "namespace", "name": "mcp__bench_readonly", "tools": [{
                "type": "function", "name": "get_canary", "strict": False,
                "description": "Return the read-only synthetic canary token. No external operation.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            }]},
        ]
        status, stream = self.post("tool", tools=tools, tool_choice="auto")
        self.assertEqual(status, 200)
        observed = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith(b"data: ")]
        self.assertEqual(observed[0]["item"], {**added, "namespace": NAMESPACE, "name": FUNCTION})
        restored = {**done, "namespace": NAMESPACE, "name": FUNCTION}
        self.assertEqual(observed[1]["item"], restored)
        self.assertEqual(observed[2]["response"]["output"], [restored])
        self.assertEqual(observed[2]["response"]["usage"], terminal_usage)
        count_payload, create_payload = [event[1] for event in self.mock.events]
        self.assertEqual(count_payload["tools"], create_payload["tools"])
        self.assertEqual(count_payload["input"], create_payload["input"])
        self.assertEqual([tool["name"] for tool in create_payload["tools"]], [LLAMA_NAME])
        tool_reply = {"type": "function_call_output", "call_id": "call_1", "output": "CANARY-K7M2"}
        continued = CANARY.normalize_request({"tools": tools, "input": [restored, tool_reply]})
        self.assertEqual(continued["input"], [done, tool_reply])
        self.assertEqual(self.gateway.gate.snapshot()["observed_total_tokens"], 36)

    def test_ld03_schemas_match_the_pinned_proposal(self):
        canonical = json.dumps(LD03_TOOLS, sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(sha256(canonical).hexdigest(),
                         "53d716fc47a4f7f8d438aaa876029cfcc72a3c2f606b1c372d2c31a53bc95ec1")

    def test_ld03_exposes_only_registered_tools_and_round_trips_distinct_calls(self):
        calls = [
            {"type": "function_call", "id": "fc_1", "call_id": "call_1",
             "name": "bench_inspect_shared_values", "arguments": "{}"},
            {"type": "function_call", "id": "fc_2", "call_id": "call_2",
             "name": "bench_set_shared_values", "arguments": '{"accent":"#136b62","spacing_px":20}'},
        ]
        metered = {"input_tokens": 32, "output_tokens": 9, "total_tokens": 41,
                   "input_tokens_details": {"cached_tokens": 7}}
        events = [
            {"type": "response.output_item.added", "item": {**call, "arguments": ""}}
            for call in calls
        ] + [
            {"type": "response.function_call_arguments.delta", "item_id": "fc_2", "delta": calls[1]["arguments"]},
            *({"type": "response.output_item.done", "item": call} for call in calls),
            {"type": "response.completed",
             "response": {"id": "resp-ld03", "status": "completed", "usage": metered, "output": calls}},
        ]
        stream = b"".join(b"data: " + json_bytes(event) + b"\n\n" for event in events)
        self.setup_gateway(60, {"ld03": 32}, {"ld03": stream}, llama_ld03=True)
        tools = [{"type": "function", "name": "create_goal"}, codex_ld03_namespace(),
                 {"type": "namespace", "name": NAMESPACE, "tools": []}]
        status, data = self.post("ld03", tools=tools)
        self.assertEqual(status, 200)
        restored = [{**call, "name": name, "namespace": LD03_NAMESPACE}
                    for call, name in zip(calls, (LD03_INSPECT, LD03_APPLY))]
        received = [json.loads(line[6:]) for line in data.splitlines() if line.startswith(b"data: ")]
        self.assertEqual([item["item"] for item in received[:2]], [{**call, "arguments": ""} for call in restored])
        self.assertEqual(received[2], events[2])
        self.assertEqual([item["item"] for item in received[3:5]], restored)
        self.assertEqual(received[-1]["response"]["output"], restored)
        self.assertEqual(received[-1]["response"]["usage"], metered)
        count_payload, create_payload = [event[1] for event in self.mock.events]
        self.assertEqual(count_payload["input"], create_payload["input"])
        self.assertEqual(count_payload["tools"], create_payload["tools"])
        self.assertEqual([tool["name"] for tool in create_payload["tools"]], [call["name"] for call in calls])
        results = [{"type": "function_call_output", "call_id": call["call_id"], "output": "scoped receipt"}
                   for call in calls]
        continuation = LD03.normalize_request({"tools": tools, "input": [*restored, *results]})
        self.assertEqual(continuation["input"], [*calls, *results])
        self.assertEqual(self.gateway.gate.snapshot()["observed_total_tokens"], 41)

    def test_ld03_rejects_schema_changes_before_counting(self):
        self.setup_gateway(60, {}, {}, llama_ld03=True)
        changed = codex_ld03_namespace()
        changed["tools"][1]["description"] = "Write any value anywhere"
        self.assertEqual(self.post("ld03", tools=[changed])[0], 400)
        self.assertEqual(self.mock.events, [])

    def test_ld03_restores_validation_after_codex_projects_mcp_parameters(self):
        namespace = codex_ld03_namespace()
        params = namespace["tools"][1]["parameters"]
        namespace["tools"][1]["parameters"] = {**params, "properties": {
            "accent": {"type": "string"}, "spacing_px": {"type": "integer"},
        }}
        [_, apply] = LD03.normalize_request({"tools": [namespace]})["tools"]
        self.assertEqual(apply["parameters"], params)

    def test_ld03_rejects_out_of_contract_completed_arguments(self):
        call = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "bench_set_shared_values"}
        bad = (
            '{"accent":"#136b62","spacing_px":true}', '{"accent":"#136b62","spacing_px":20.0}',
            '{"accent":"#136b62","spacing_px":-1}', '{"accent":"#136b62","spacing_px":129}',
            '{"accent":"#136b62","spacing_px":20,"extra":0}', '{"accent":"#136b62","spacing_px":20,"spacing_px":21}',
            '{"accent":"red","spacing_px":20}', '{"spacing_px":20}',
        )
        for arguments in bad:
            with self.subTest(arguments=arguments), self.assertRaisesRegex(ValueError, "JSON|schema"):
                LD03.restore_event({"type": "response.output_item.done", "item": {**call, "arguments": arguments}},
                                   enabled=True)
        self.assertEqual(CANARY.normalize_request({"tools": [codex_ld03_namespace()]})["tools"], [])
        self.assertEqual(LD03.normalize_request({"tools": []})["tools"], [])

    def test_llama_bridge_drops_hallucinated_tool_but_drains_usage(self):
        unsupported = {"type": "response.output_item.done", "item": {
            "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "create_thread", "arguments": "{}",
        }}
        self.setup_gateway(60, {"tool": 32}, {
            "tool": b"data: " + json_bytes(unsupported) + b"\n\n" + terminal("tool", 32, 4, 7),
        }, llama_synthetic_canary=True)
        status, stream = self.post("tool", tools=[])
        self.assertEqual(status, 200)
        self.assertNotIn(b"create_thread", stream)
        self.assertIn(b"unsupported_local_tool", stream)
        snapshot = self.gateway.gate.snapshot()
        self.assertTrue(snapshot["usage_complete"])
        self.assertEqual(snapshot["observed_total_tokens"], 36)

    def test_llama_exact_count_mismatch_charges_observed_usage_and_locks_follow_up(self):
        self.setup_gateway(80, {"tool": 32}, {"tool": terminal("tool", 33, 4, 7)}, llama_synthetic_canary=True)
        self.assertEqual(self.post("tool", tools=[])[0], 200)
        self.assertEqual(self.post("tool", tools=[])[0], 503)
        self.assertEqual([event[0] for event in self.mock.events], [COUNT_PATH, CREATE_PATH])
        snapshot = self.gateway.gate.snapshot()
        self.assertFalse(snapshot["usage_complete"])
        self.assertEqual(snapshot["observed_total_tokens"], 37)

    def test_title_and_main_are_serialized_and_share_the_live_cap(self):
        self.setup_gateway(100, {"main": 60, "title": 30}, {
            "main": terminal("main", 60, 15, 20),
            "title": terminal("title", 30, 1, 12),
        }, pause=True)
        with ThreadPoolExecutor(max_workers=2) as clients:
            main = clients.submit(self.post, "main", client_metadata={"test": "synthetic"})
            self.assertTrue(self.mock.generating.wait(2))
            title = clients.submit(self.post, "title")
            self.mock.continue_generation.set()
            status, main_stream = main.result()
            denied = title.result()
        self.assertEqual(status, 200)
        self.assertIn(b"response.completed", main_stream)
        self.assertEqual(denied[0], 400)
        self.assertEqual(json.loads(denied[1])["error"]["code"], "budget_reached")
        self.assertEqual([row[0] for row in self.mock.events], [COUNT_PATH, CREATE_PATH, COUNT_PATH])
        self.assertNotIn("client_metadata", self.mock.events[0][1])
        self.assertEqual(self.mock.events[1][1]["max_output_tokens"], 40)
        snapshot = self.gateway.gate.snapshot()
        self.assertEqual(snapshot["observed_total_tokens"], 75)
        self.assertEqual(snapshot["observed_cached_input_tokens"], 20)

    def test_overshoot_charges_terminal_usage_then_blocks_count_and_generation(self):
        self.setup_gateway(80, {"main": 60}, {
            "main": terminal("main", 75, 10, 70, status="incomplete"),
        })
        self.assertEqual(self.post("main")[0], 200)
        self.assertEqual(self.post("retry")[0], 400)
        self.assertEqual([row[0] for row in self.mock.events], [COUNT_PATH, CREATE_PATH])
        snapshot = self.gateway.gate.snapshot()
        self.assertEqual(snapshot["budget_status"], "TIMEOUT_BUDGET")
        self.assertEqual(snapshot["overshoot_tokens"], 5)
        self.assertEqual(snapshot["observed_cached_input_tokens"], 70)

    def test_end_of_stream_without_usage_locks_out_retries(self):
        self.setup_gateway(80, {"main": 10}, {
            "main": frame("response.created", {"id": "resp-main"}) + b"data: [DONE]\n\n",
        })
        self.assertEqual(self.post("main")[0], 200)
        status, data = self.post("retry")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(data)["error"]["code"], "budget_meter_incomplete")
        self.assertEqual(len(self.mock.events), 2)
        self.assertFalse(self.gateway.gate.snapshot()["usage_complete"])

    def test_metered_cancellation_and_retry_each_receive_a_budget_slot(self):
        self.setup_gateway(80, {"main": 20, "retry": 25}, {
            "main": terminal("main", 20, 5, 13, status="cancelled"),
            "retry": terminal("retry", 25, 15, 17, status="completed"),
        })
        self.assertEqual(self.post("main")[0], 200)
        self.assertEqual(self.post("retry", max_output_tokens=20)[0], 200)
        self.assertEqual([row[0] for row in self.mock.events], [COUNT_PATH, CREATE_PATH] * 2)
        self.assertEqual(self.mock.events[3][1]["max_output_tokens"], 20)
        snapshot = self.gateway.gate.snapshot()
        self.assertEqual(snapshot["requests"][0]["outcome"], "cancelled")
        self.assertEqual(snapshot["observed_total_tokens"], 65)
        self.assertEqual(snapshot["observed_cached_input_tokens"], 30)

    def test_credentials_other_routes_and_browser_requests_are_never_forwarded(self):
        self.setup_gateway(100, {}, {})
        for name in ("Authorization", "Proxy-Authorization", "X-API-Key", "Cookie", "Origin"):
            with self.subTest(name=name):
                self.assertEqual(self.post("main", headers={name: "mock-sentinel"})[0], 400)
        self.assertEqual(self.post("main", path="/v1/responses/compact")[0], 404)
        self.assertEqual(self.mock.events, [])

    def test_missing_or_noninteger_input_meter_never_dispatches_generation(self):
        self.setup_gateway(100, {"main": True}, {})
        status, data = self.post("main")
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(data)["error"]["code"], "input_meter_unavailable")
        self.assertEqual([row[0] for row in self.mock.events], [COUNT_PATH])


if __name__ == "__main__":
    unittest.main()
