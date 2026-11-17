"""Explicit LD02 stop receipt after a broker confirms the registered edit."""

from hashlib import sha256
import json
import os
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
        if (
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
        self.expected_digest = sha256(canonical(expected)).hexdigest()

    def observe(self, params, reply):
        arguments = params.get("arguments")
        if isinstance(arguments, dict) and isinstance(arguments.get("name"), str):
            if arguments["name"].lower() == self.arguments["name"].lower():
                arguments = {**arguments, "name": self.arguments["name"]}
        if (
            params.get("name") != "edit_section" or canonical(arguments) != canonical(self.arguments)
            or reply.get("error") or canonical(reply.get("result")) != canonical(self.arguments)
        ):
            return
        receipt = {"schema": "ld02-guarded-edit/1", "arguments_sha256": self.expected_digest}
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
        return receipt == {"schema": "ld02-guarded-edit/1", "arguments_sha256": self.expected_digest}
