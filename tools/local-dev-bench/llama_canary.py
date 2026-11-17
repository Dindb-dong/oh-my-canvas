"""Project one synthetic MCP tool through the installed llama Responses API."""

import json


NAMESPACE = "mcp__bench_readonly"
FUNCTION = "get_canary"
LLAMA_NAME = "bench_get_canary"
EMPTY_PARAMETERS = {"type": "object", "properties": {}, "additionalProperties": False}


def normalize_request(request):
    """Expose only the diagnostic canary and translate history with the same name."""
    if request.get("tool_choice", "auto") != "auto":
        raise ValueError("canary bridge requires automatic tool choice")
    declared = request.get("tools", [])
    if not isinstance(declared, list) or any(not isinstance(tool, dict) for tool in declared):
        raise ValueError("invalid tool declarations")
    namespaces = [tool for tool in declared if tool.get("type") == "namespace" and tool.get("name") == NAMESPACE]
    if len(namespaces) > 1:
        raise ValueError("duplicate canary namespace")
    tools = []
    if namespaces:
        functions = namespaces[0].get("tools")
        if not isinstance(functions, list) or len(functions) != 1 or not isinstance(functions[0], dict):
            raise ValueError("canary namespace must declare one tool")
        function = functions[0]
        if (
            function.get("type") != "function" or function.get("name") != FUNCTION
            or function.get("parameters") != EMPTY_PARAMETERS
            or not isinstance(function.get("description"), str)
            or type(function.get("strict")) is not bool
        ):
            raise ValueError("invalid canary tool declaration")
        tools.append({
            "type": "function", "name": LLAMA_NAME, "description": function["description"],
            "parameters": EMPTY_PARAMETERS, "strict": function["strict"],
        })
    normalized = {**request, "tools": tools}
    if isinstance(request.get("input"), list):
        normalized["input"] = [normalize_item(item, canary_enabled=bool(tools)) for item in request["input"]]
    return normalized


def normalize_item(item, *, canary_enabled):
    if not isinstance(item, dict) or item.get("type") != "function_call":
        return item
    if not canary_enabled or (item.get("namespace"), item.get("name")) != (NAMESPACE, FUNCTION):
        raise ValueError("unexpected canary call history")
    normalized = {**item, "name": LLAMA_NAME}
    normalized.pop("namespace")
    return normalized


def restore_item(item, *, completed, canary_enabled):
    if not isinstance(item, dict) or item.get("type") != "function_call":
        return item
    if not canary_enabled or item.get("name") != LLAMA_NAME:
        raise ValueError("unexpected local tool call")
    if completed:
        try:
            arguments = json.loads(item.get("arguments", ""))
        except (ValueError, TypeError) as error:
            raise ValueError("invalid canary call arguments") from error
        if arguments != {}:
            raise ValueError("canary call must use empty arguments")
    return {**item, "namespace": NAMESPACE, "name": FUNCTION}


def restore_event(event, *, canary_enabled):
    """Restore Codex's namespace identity without modifying metering or call IDs."""
    kind = event.get("type")
    if kind in {"response.output_item.added", "response.output_item.done"}:
        item = event.get("item")
        restored = restore_item(item, completed=kind == "response.output_item.done", canary_enabled=canary_enabled)
        if restored is not item:
            return {**event, "item": restored}
    if kind in {"response.completed", "response.incomplete"}:
        response = event.get("response")
        if isinstance(response, dict) and isinstance(response.get("output"), list):
            items = response["output"]
            restored = [restore_item(item, completed=True, canary_enabled=canary_enabled) for item in items]
            if any(a is not b for a, b in zip(items, restored)):
                return {**event, "response": {**response, "output": restored}}
    return event
