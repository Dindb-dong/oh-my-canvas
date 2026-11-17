"""Project narrowly approved benchmark namespaces through local llama Responses."""

from dataclasses import dataclass
import re

from budget_gate import _object


NAMESPACE = "mcp__bench_readonly"
FUNCTION = "get_canary"
LLAMA_NAME = "bench_get_canary"
LD03_NAMESPACE = "mcp__bench_ld03"
LD03_INSPECT = "inspect_shared_values"
LD03_APPLY = "set_shared_values"
LD02_ATLAS_NAMESPACE = "mcp__bench_ld02_atlas"
LD02_ATLAS_FIND = "find_section"
LD02_ATLAS_EDIT = "edit_section"
EMPTY_PARAMETERS = {"type": "object", "properties": {}, "additionalProperties": False}
LD03_APPLY_PARAMETERS = {
    "type": "object",
    "properties": {
        "accent": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"},
        "spacing_px": {"type": "integer", "minimum": 0, "maximum": 128},
    },
    "required": ["accent", "spacing_px"],
    "additionalProperties": False,
}
LD03_CODEX_PARAMETERS = {
    **LD03_APPLY_PARAMETERS,
    "properties": {"accent": {"type": "string"}, "spacing_px": {"type": "integer"}},
}


def parameters(properties):
    return {"type": "object", "properties": properties, "required": list(properties),
            "additionalProperties": False}


PRINTABLE_LINE = {"type": "string", "minLength": 1, "maxLength": 128, "pattern": r"^[^\u0000-\u001F\u007F]+$"}
PIXELS = {"type": "integer", "minimum": 0, "maximum": 128}
ATLAS_SELECTOR = {"name": PRINTABLE_LINE, "receipt": {"type": "string", "pattern": "^[A-Z]{2}-[0-9]{3}$"}}
ATLAS_FIND_PARAMETERS = parameters(ATLAS_SELECTOR)
ATLAS_EDIT_PARAMETERS = parameters({**ATLAS_SELECTOR, "text": PRINTABLE_LINE, "gap_px": PIXELS, "radius_px": PIXELS})


def matches_field(value, field):
    if field["type"] == "string":
        return (
            isinstance(value, str)
            and field.get("minLength", 0) <= len(value) <= field.get("maxLength", 4096)
            and re.fullmatch(field["pattern"], value) is not None
        )
    return type(value) is int and field["minimum"] <= value <= field["maximum"]


def validate_arguments(raw, *, parameters):
    if not isinstance(raw, str):
        raise ValueError("invalid local tool arguments")
    arguments = _object(raw.encode(), 4096)
    fields = parameters["properties"]
    if arguments.keys() != fields.keys() or any(not matches_field(arguments[key], field) for key, field in fields.items()):
        raise ValueError("local tool arguments do not match the registered schema")


@dataclass(frozen=True)
class Function:
    name: str
    alias: str
    parameters: dict
    description: str | None = None
    codex_parameters: dict | None = None

    def flatten(self, declared):
        description = declared.get("description")
        strict = declared.get("strict")
        parameters = declared.get("parameters")
        if (
            declared.get("type") != "function"
            or (parameters != self.parameters and (self.codex_parameters is None or parameters != self.codex_parameters))
            or not isinstance(description, str) or type(strict) is not bool
            or (self.description is not None and (description != self.description or strict))
        ):
            raise ValueError("invalid local tool declaration")
        return {
            "type": "function", "name": self.alias, "description": description,
            "parameters": self.parameters, "strict": strict,
        }


@dataclass(frozen=True)
class ToolBridge:
    namespace: str
    functions: tuple[Function, ...]

    def normalize_request(self, request):
        """Expose only the registered benchmark tools and translate call history."""
        if request.get("tool_choice", "auto") != "auto":
            raise ValueError("local tool bridge requires automatic tool choice")
        declared = request.get("tools", [])
        if not isinstance(declared, list) or any(not isinstance(tool, dict) for tool in declared):
            raise ValueError("invalid tool declarations")
        namespaces = [
            tool for tool in declared if tool.get("type") == "namespace" and tool.get("name") == self.namespace
        ]
        if len(namespaces) > 1:
            raise ValueError("duplicate local tool namespace")
        tools = []
        if namespaces:
            functions = namespaces[0].get("tools")
            if (
                not isinstance(functions, list) or len(functions) != len(self.functions)
                or any(not isinstance(function, dict) or not isinstance(function.get("name"), str)
                       for function in functions)
            ):
                raise ValueError("invalid local namespace declarations")
            by_name = {function["name"]: function for function in functions}
            if by_name.keys() != {function.name for function in self.functions}:
                raise ValueError("unexpected local tool name")
            tools = [function.flatten(by_name[function.name]) for function in self.functions]
        normalized = {**request, "tools": tools}
        if isinstance(request.get("input"), list):
            normalized["input"] = [self.normalize_item(item, enabled=bool(tools)) for item in request["input"]]
        return normalized

    def normalize_item(self, item, *, enabled):
        if not isinstance(item, dict) or not isinstance(item.get("type"), str) or not item["type"].endswith("_call"):
            return item
        function = next((function for function in self.functions if function.name == item.get("name")), None)
        if not enabled or item["type"] != "function_call" or item.get("namespace") != self.namespace or function is None:
            raise ValueError("unexpected local tool call history")
        validate_arguments(item.get("arguments"), parameters=function.parameters)
        normalized = {**item, "name": function.alias}
        normalized.pop("namespace")
        return normalized

    def restore_item(self, item, *, completed, enabled):
        if not isinstance(item, dict) or not isinstance(item.get("type"), str) or not item["type"].endswith("_call"):
            return item
        function = next((function for function in self.functions if function.alias == item.get("name")), None)
        if not enabled or item["type"] != "function_call" or function is None:
            raise ValueError("unexpected local tool call")
        if completed:
            validate_arguments(item.get("arguments"), parameters=function.parameters)
        return {**item, "namespace": self.namespace, "name": function.name}

    def restore_event(self, event, *, enabled):
        """Restore native client identity without changing metering or call IDs."""
        kind = event.get("type")
        if not isinstance(kind, str):
            raise ValueError("invalid local tool event")
        if kind in {"response.output_item.added", "response.output_item.done"}:
            item = event.get("item")
            restored = self.restore_item(item, completed=kind == "response.output_item.done", enabled=enabled)
            if restored is not item:
                return {**event, "item": restored}
        if kind in {"response.completed", "response.incomplete"}:
            response = event.get("response")
            if isinstance(response, dict) and isinstance(response.get("output"), list):
                items = response["output"]
                restored = [self.restore_item(item, completed=True, enabled=enabled) for item in items]
                if any(a is not b for a, b in zip(items, restored)):
                    return {**event, "response": {**response, "output": restored}}
        return event


CANARY = ToolBridge(NAMESPACE, (Function(FUNCTION, LLAMA_NAME, EMPTY_PARAMETERS),))
LD03 = ToolBridge(LD03_NAMESPACE, (
    Function(LD03_INSPECT, "bench_inspect_shared_values", EMPTY_PARAMETERS,
             "Read the four shared values in the current synthetic LD03 document."),
    Function(LD03_APPLY, "bench_set_shared_values", LD03_APPLY_PARAMETERS,
             "Set the target accent and target spacing in the current synthetic LD03 document.",
             # Codex strips MCP pattern/range keywords before advertising namespace tools.
             LD03_CODEX_PARAMETERS),
))

LD02_ATLAS = ToolBridge(LD02_ATLAS_NAMESPACE, (
    Function(LD02_ATLAS_FIND, "bench_find_section", ATLAS_FIND_PARAMETERS,
             "Find a section by its exact name and receipt in the current synthetic Atlas document."),
    Function(LD02_ATLAS_EDIT, "bench_edit_section", ATLAS_EDIT_PARAMETERS,
             "Set the status text, section gap and marker radius of a section already found by name and receipt."),
))


def mcp_tools(bridge):
    return [
        {"name": function.name, "description": function.description, "inputSchema": function.parameters}
        for function in bridge.functions
    ]


LD03_TOOLS = mcp_tools(LD03)
LD02_ATLAS_TOOLS = mcp_tools(LD02_ATLAS)
