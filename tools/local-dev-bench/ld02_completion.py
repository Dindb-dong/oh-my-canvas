"""Explicit LD02/LD03 stop receipts after a broker confirms the registered edit."""

from hashlib import sha256
import json
import os
import re
from pathlib import Path
from uuid import uuid4

from budget_gate import _object


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class EditCompletion:
    def __init__(self, config_path):
        self.config_path = Path(config_path)
        config = _object(self.config_path.read_bytes(), 4096)
        self.arguments = config["expected_arguments"]
        expected = self.arguments
        self.workload = config.get("workload", "LD02")
        self.expected_result = expected
        self.tool_name = "edit_section"
        if self.workload == "LD03":
            def valid_values(value):
                return (isinstance(value, dict) and set(value) == {"accent", "spacing_px"}
                        and isinstance(value["accent"], str)
                        and re.fullmatch(r"#[0-9a-f]{6}", value["accent"]) is not None
                        and type(value["spacing_px"]) is int and 0 <= value["spacing_px"] <= 128)

            result = config.get("expected_result")
            if (set(config) != {"workload", "expected_arguments", "expected_result", "receipt_path"}
                    or not valid_values(expected) or not isinstance(result, dict)
                    or set(result) != {"target", "archive"}
                    or not all(valid_values(result[key]) for key in ("target", "archive"))
                    or result["target"] != expected):
                raise ValueError("invalid expected LD03 edit")
            self.expected_result = result
            self.tool_name = "set_shared_values"
        elif self.workload != "LD02" or (
            set(config) != {"expected_arguments", "receipt_path"}
            or not isinstance(expected, dict)
            or set(expected) != {"name", "receipt", "text", "gap_px", "radius_px"}
            or not all(isinstance(expected[key], str) and expected[key] for key in ("name", "receipt", "text"))
            or any(type(expected[key]) is not int or not 0 <= expected[key] <= 128 for key in ("gap_px", "radius_px"))
        ):
            raise ValueError("invalid expected LD02 edit")
        self.path = Path(config["receipt_path"])
        if not self.path.is_absolute() or self.path == self.config_path:
            raise ValueError("expected a separate absolute receipt path")
        registered = ({"arguments": expected, "result": self.expected_result}
                      if self.workload == "LD03" else expected)
        self.expected_digest = sha256(canonical(registered)).hexdigest()
        self.schema = self.workload.lower() + "-guarded-edit/1"

    def observe(self, params, reply):
        arguments = params.get("arguments")
        if self.workload == "LD02" and isinstance(arguments, dict) and isinstance(arguments.get("name"), str):
            if arguments["name"].lower() == self.arguments["name"].lower():
                arguments = {**arguments, "name": self.arguments["name"]}
        if self.workload == "LD03" and isinstance(arguments, dict) and isinstance(arguments.get("accent"), str):
            arguments = {**arguments, "accent": arguments["accent"].lower()}
        try:
            exact = (params.get("name") == self.tool_name and not reply.get("error")
                     and canonical(arguments) == canonical(self.arguments)
                     and canonical(reply.get("result")) == canonical(self.expected_result))
        except (TypeError, ValueError):
            return
        if not exact:
            return
        receipt = {"schema": self.schema, "arguments_sha256": self.expected_digest}
        temporary = self.path.with_name(self.path.name + "." + uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                os.chmod(temporary, 0o600)
                stream.write(canonical(receipt))
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def completed(self):
        try:
            receipt = _object(self.path.read_bytes(), 4096)
        except FileNotFoundError:
            return False
        return receipt == {"schema": self.schema, "arguments_sha256": self.expected_digest}
