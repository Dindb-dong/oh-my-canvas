"""Expose the two registered LD03 operations over MCP stdio."""

import json
import socket
import sys

from llama_canary import LD03_TOOLS


def call(path, params):
    request = {"name": params.get("name"), "arguments": params.get("arguments", {})}
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(45)
            connection.connect(path)
            connection.sendall((json.dumps(request) + "\n").encode())
            with connection.makefile("rb") as reader:
                raw = reader.readline(2049)
        if not raw.endswith(b"\n") or len(raw) > 2048:
            raise ValueError("Incomplete reply")
        reply = json.loads(raw)
    except (OSError, ValueError):
        reply = {"error": "LD03 broker unavailable"}
    error = reply.get("error")
    message = error if error else json.dumps(reply["result"], sort_keys=True)
    return {"content": [{"type": "text", "text": message}], "isError": bool(error)}


def main(path):
    for line in sys.stdin:
        event = json.loads(line)
        if "id" not in event:
            continue
        method = event.get("method")
        params = event.get("params", {})
        reply = {"jsonrpc": "2.0", "id": event["id"]}
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "bench_ld03", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": LD03_TOOLS}
        elif method == "tools/call":
            result = call(path, params)
        elif method == "ping":
            result = {}
        else:
            reply["error"] = {"code": -32601, "message": "Method not found"}
        if "error" not in reply:
            reply["result"] = result
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
