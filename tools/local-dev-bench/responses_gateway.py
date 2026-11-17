"""Loopback Responses budget gateway for a credential-free synthetic upstream."""

import argparse
from contextlib import closing
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from select import select
import signal
from socket import MSG_PEEK
from threading import Event, Lock
from uuid import uuid4

from budget_gate import BudgetGate, _object


LOOPBACK = "127.0.0.1"
CREATE_PATH = "/v1/responses"
COUNT_PATH = "/v1/responses/input_tokens"
TIMEOUT_SECONDS = 10
MAX_STREAM_BYTES = 32 * 1024 * 1024
CREDENTIAL_HEADERS = {"authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"}
COUNT_FIELDS = {
    "conversation", "input", "instructions", "model", "parallel_tool_calls",
    "previous_response_id", "reasoning", "text", "tool_choice", "tools", "truncation",
}


def json_bytes(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def sse_frames(response, event_limit):
    """Yield normalized frame bytes and JSON data from a bounded SSE stream."""
    frame, data = [], []
    frame_size = stream_size = 0
    while line := response.readline(event_limit + 1):
        frame_size += len(line)
        stream_size += len(line)
        if frame_size > event_limit or stream_size > MAX_STREAM_BYTES:
            raise ValueError("upstream SSE exceeded its byte limit")
        if not line.endswith(b"\n"):
            raise ValueError("upstream SSE line was truncated")
        if line in (b"\n", b"\r\n"):
            if data:
                yield b"".join(frame) + line, b"\n".join(data)
            frame, data = [], []
            frame_size = 0
            continue
        frame.append(line)
        line = line.rstrip(b"\r\n")
        if line == b"data" or line.startswith(b"data:"):
            data.append(line.partition(b":")[2].removeprefix(b" "))
    if data:
        raise ValueError("upstream SSE event was truncated")


class ResponsesHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(TIMEOUT_SECONDS)
        super().setup()

    def log_message(self, *_):
        pass

    def reply_error(self, status, code):
        body = json_bytes({"error": {"code": code, "message": code.replace("_", " ")}})
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            self.handle_response_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def client_disconnected(self):
        readable, _, _ = select([self.connection], [], [], 0)
        return bool(readable) and not self.connection.recv(1, MSG_PEEK)

    def handle_response_request(self):
        if self.path != CREATE_PATH:
            return self.reply_error(404, "unsupported_route")
        if CREDENTIAL_HEADERS.intersection(name.lower() for name in self.headers):
            return self.reply_error(400, "credentials_are_not_accepted")
        if "Origin" in self.headers or "Transfer-Encoding" in self.headers:
            return self.reply_error(400, "unsupported_transport")
        if self.headers.get_content_type() != "application/json":
            return self.reply_error(415, "expected_json")
        gate = self.server.gate
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not 0 < int(lengths[0]) <= gate.max_json_bytes:
                raise ValueError
            length = int(lengths[0])
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError
            request = _object(body, gate.max_json_bytes)
            background = request.get("background")
            if request.get("stream") is not True or (background is not None and background is not False):
                raise ValueError
        except ValueError:
            return self.reply_error(400, "invalid_request")

        # Title calls, follow-ups, and retries share the same count/generate/drain critical section.
        with self.server.admissions:
            if self.server.stopping.is_set() or self.client_disconnected():
                return self.reply_error(503, "gateway_stopping")
            snapshot = gate.snapshot()
            if not snapshot["usage_complete"]:
                return self.reply_error(503, "budget_meter_incomplete")
            if gate.token_cap - snapshot["observed_total_tokens"] < gate.minimum_output_tokens:
                return self.reply_error(400, "budget_reached")
            try:
                minimum_input = self.server.count_input(request)
            except (ValueError, OSError, HTTPException):
                return self.reply_error(502, "input_meter_unavailable")
            if self.server.stopping.is_set() or self.client_disconnected():
                return self.reply_error(503, "gateway_stopping")
            request_id = uuid4().hex
            try:
                admission = gate.admit(request_id, "responses", body, minimum_input_tokens=minimum_input)
            except ValueError as error:
                if str(error).startswith("insufficient budget"):
                    return self.reply_error(400, "budget_reached")
                return self.reply_error(400, "invalid_request")
            request["max_output_tokens"] = admission.max_output_tokens
            self.relay_response(request_id, request)

    def relay_response(self, request_id, request):
        gate = self.server.gate
        ended, started, downstream_gone = False, False, False
        try:
            with closing(self.server.connection()) as upstream:
                response = self.server.post(upstream, CREATE_PATH, request)
                if response.status != 200 or response.headers.get_content_type() != "text/event-stream":
                    raise ValueError("upstream did not return SSE")
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    started = True
                except OSError:
                    downstream_gone = True
                for frame, data in sse_frames(response, gate.max_json_bytes):
                    if data == b"[DONE]":
                        break
                    ended = gate.record_event(request_id, data)
                    if not downstream_gone:
                        try:
                            self.wfile.write(frame)
                            self.wfile.flush()
                        except OSError:
                            # Drain for authoritative final usage even when the caller has left.
                            downstream_gone = True
                    if ended:
                        break
        except (OSError, HTTPException, ValueError):
            if not started and not downstream_gone:
                self.reply_error(502, "upstream_response_unavailable")
        finally:
            if not ended:
                outcome = "cancelled" if downstream_gone else "stream_ended"
                gate.end_unmetered(request_id, outcome if started or downstream_gone else "transport_failed")


class ResponsesGateway(ThreadingHTTPServer):
    def __init__(self, upstream_port, token_cap, *, port=0, minimum_output_tokens=1,
                 upstream_timeout=TIMEOUT_SECONDS):
        if type(upstream_port) is not int or not 0 < upstream_port < 65536:
            raise ValueError("invalid loopback upstream port")
        if type(upstream_timeout) is not int or upstream_timeout <= 0:
            raise ValueError("invalid loopback upstream socket timeout")
        self.upstream_port = upstream_port
        self.upstream_timeout = upstream_timeout
        self.gate = BudgetGate(token_cap, minimum_output_tokens=minimum_output_tokens)
        self.admissions = Lock()
        self.stopping = Event()
        super().__init__((LOOPBACK, port), ResponsesHandler)
        if self.server_port == self.upstream_port:
            self.server_close()
            raise ValueError("upstream and gateway ports must differ")

    def connection(self):
        return HTTPConnection(LOOPBACK, self.upstream_port, timeout=self.upstream_timeout)

    @staticmethod
    def post(connection, path, body):
        accept = "text/event-stream" if path == CREATE_PATH else "application/json"
        connection.request("POST", path, json_bytes(body), {
            "Content-Type": "application/json", "Accept": accept,
        })
        return connection.getresponse()

    def count_input(self, request):
        fields = {key: value for key, value in request.items() if key in COUNT_FIELDS}
        with closing(self.connection()) as upstream:
            response = self.post(upstream, COUNT_PATH, fields)
            if response.status != 200 or response.headers.get_content_type() != "application/json":
                raise ValueError("invalid upstream meter response")
            count = _object(response.read(self.gate.max_json_bytes + 1), self.gate.max_json_bytes)
        tokens = count.get("input_tokens")
        if type(tokens) is not int or tokens < 0:
            raise ValueError("upstream input meter is missing")
        return tokens


def interrupted(*_):
    raise KeyboardInterrupt


def private_open(path, flags):
    return os.open(path, flags, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-port", type=int, required=True)
    parser.add_argument("--token-cap", type=int, required=True)
    parser.add_argument("--minimum-output-tokens", type=int, default=1)
    parser.add_argument("--upstream-timeout", type=int, default=TIMEOUT_SECONDS,
                        help="Upstream socket inactivity timeout in seconds")
    parser.add_argument("--ledger", type=Path, required=True, help="New private JSON evidence file")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    with (
        ResponsesGateway(args.upstream_port, args.token_cap,
                         minimum_output_tokens=args.minimum_output_tokens,
                         upstream_timeout=args.upstream_timeout) as gateway,
        open(args.ledger, "x", encoding="utf-8", opener=private_open) as ledger,
    ):
        print(json.dumps({"base_url": f"http://{LOOPBACK}:{gateway.server_port}/v1"}), flush=True)
        try:
            gateway.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            gateway.stopping.set()
            with gateway.admissions:
                json.dump(gateway.gate.snapshot(), ledger, indent=2)
                ledger.write("\n")


if __name__ == "__main__":
    main()
