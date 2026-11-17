"""Expose the two registered LD03 operations over MCP stdio."""

import json
import os
import socket
import sys

from llama_canary import LD03_TOOLS


def call(path, params, server_name, completion=None):
    if completion is not None and completion.completed():
        return {"content": [{"type": "text", "text": "The registered edit is complete; independent verification follows."}],
                "isError": True}
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
        reply = {"error": f"{server_name.removeprefix('bench_').upper()} broker unavailable"}
    if completion is not None:
        completion.observe(params, reply)
    error = reply.get("error")
    message = error if error else json.dumps(reply["result"], sort_keys=True)
    return {"content": [{"type": "text", "text": message}], "isError": bool(error)}


def main(path, *, server_name="bench_ld03", tools=LD03_TOOLS):
    completion = None
    if server_name == "bench_ld02_atlas" and os.environ.get("LD02_COMPLETION_CONFIG"):
        from ld02_completion import EditCompletion
        completion = EditCompletion(os.environ["LD02_COMPLETION_CONFIG"])
    for line in sys.stdin:
        event = json.loads(line)
        if "id" not in event:
            continue
        method = event.get("method")
        params = event.get("params", {})
        reply = {"jsonrpc": "2.0", "id": event["id"]}
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {}}, "serverInfo": {"name": server_name, "version": "1"}}
        elif method == "tools/list":
            result = {"tools": tools}
        elif method == "tools/call":
            result = call(path, params, server_name, completion)
        elif method == "ping":
            result = {}
        else:
            reply["error"] = {"code": -32601, "message": "Method not found"}
        if "error" not in reply:
            reply["result"] = result
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
