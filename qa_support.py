import json
import subprocess
import time

def launch(stack, argv, **options):
    proc = subprocess.Popen(argv, **options)

    def stop():
        if proc.stdin:
            proc.stdin.close()
            try:
                proc.wait(timeout=3)
                return
            except subprocess.TimeoutExpired:
                pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

    stack.callback(stop)
    return proc

def connect(stack, binary, profile, dialect):
    proc = launch(
        stack,
        [binary / "omc-cli", "--connect-only", "--profile", profile, "--dialect", dialect],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    sequence = 0

    def request(method, params, notification=False):
        nonlocal sequence
        sequence += 1
        message = dict(jsonrpc="2.0", method=method, params=params)
        if not notification:
            message["id"] = sequence
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()
        if notification:
            return None
        response = json.loads(proc.stdout.readline())
        assert "result" in response and response.get("id") == sequence, response
        result = response["result"]
        assert not result.get("isError"), (method, result.get("content"))
        return result.get("structuredContent", result)

    request("initialize", dict(
        protocolVersion="2025-06-18", capabilities={},
        clientInfo=dict(name="native-home-qa", version="1"),
    ))
    request("notifications/initialized", {}, notification=True)
    return lambda name, **arguments: request("tools/call", dict(name=name, arguments=arguments))

def wait_for(description, read, check=bool):
    deadline = time.monotonic() + 15
    value = None
    while time.monotonic() < deadline:
        value = read()
        if check(value):
            return value
        time.sleep(0.1)
    if isinstance(value, dict):
        value = {key: item for key, item in value.items() if key not in {"controls", "documents"}}
    raise AssertionError(f"{description} timed out, last state {value}")

def launch_service(stack, binary, profile):
    launch(stack, [binary / "omc-service", "--profile", profile, "--port", "0"])
    wait_for("isolated service descriptor", (profile / "native-v1/service.json").is_file)
