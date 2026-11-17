from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from budget_gate import BudgetGate
from provider_preflight import ARMS, ROLES, SCHEMA, validate
from responses_gateway import json_bytes
from test_responses_gateway import terminal


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        tools = {
            "omc-native": ["document_snapshot", "document_command"],
            "paper-desktop": ["get_children", "write_html"],
            "figma-remote": ["get_metadata", "use_figma"],
            "penpot-webgl": ["penpot_execute", "penpot_get_file"],
        }
        mcp = {}
        for arm, names in tools.items():
            data = json_bytes({"tools": [{"name": name, "inputSchema": {"type": "object"}} for name in names]})
            (self.root / f"{arm}.tools.json").write_bytes(data)
            mcp[arm] = {"transport": "synthetic-http", "required_tools": names, "inventory_sha256": sha256(data).hexdigest()}
        self.registration = {
            "schema": SCHEMA,
            "mode": "synthetic",
            "provider": {
                "base_url": "http://127.0.0.1:29000/v1", "name": "synthetic",
                "model": "mock-model", "model_revision": "mock-v1", "codex_version": "0.169.0",
                "reasoning_effort": "low", "transport": "responses_http_sse",
                "credential_custody": "none", "capture_sha256": "a" * 64,
            },
            "workload": "LD02",
            "wall_seconds": 600,
            "token_cap": 80_000,
            "minimum_output_tokens": 16,
            "mcp": mcp,
            "route_coverage": dict.fromkeys(ROLES, "routed"),
            "price": None,
        }

    def test_synthetic_registration_validates_all_frozen_mcp_schema_artifacts(self):
        result = validate(self.registration, self.root)
        self.assertEqual(result["status"], "SYNTHETIC_REGISTRATION_VALID")
        self.assertEqual(result["pricing"], "NOT_REGISTERED")
        self.assertEqual(tuple(result["mcp"]), ARMS)
        self.assertTrue(all(row["tool_count"] == 2 for row in result["mcp"].values()))

        (self.root / "figma-remote.tools.json").write_text('{"tools":[]}')
        with self.assertRaisesRegex(ValueError, "digest differs"):
            validate(self.registration, self.root)

    def test_nonloopback_credentials_and_missing_routes_are_rejected(self):
        for url in (None, "http://127.0.0.1:65536/v1", "https://example.org/v1",
                    "http://127.0.0.1:29000/v1?token=redacted", "http://user@127.0.0.1:29000/v1"):
            registration = deepcopy(self.registration)
            registration["provider"]["base_url"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate(registration, self.root)
        registration = deepcopy(self.registration)
        registration["provider"]["credential_custody"] = "managed"
        with self.assertRaisesRegex(ValueError, "must have no managed"):
            validate(registration, self.root)
        for role in ("title", "retry", "cancelled_or_incomplete"):
            registration = deepcopy(self.registration)
            registration["route_coverage"][role] = "disabled_by_registered_config"
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, "unaccounted"):
                validate(registration, self.root)

    def test_pricing_metadata_never_claims_reconciled_billing(self):
        registration = self.registration
        registration["mode"] = "operator_candidate"
        registration["provider"]["credential_custody"] = "operator_upstream_only"
        registration["price"] = {
            "revision": "mock-rates-v1", "observed_date": "2026-11-17", "source_url": "https://example.com/pricing",
            "currency": "USD", "processing_tier": "standard", "context_tier": "short", "region": "global",
            "rates_per_million": dict.fromkeys(("uncached_input", "cached_input", "cache_write_30m",
                                                 "cache_write_12h", "output"), "2.50"),
        }
        result = validate(registration, self.root)
        self.assertEqual(result["status"], "READY_FOR_OPERATOR_QUALIFICATION")
        self.assertEqual(result["pricing"], "PUBLISHED_RATE_ESTIMATE_ONLY")
        self.assertEqual(result["billed_cost_status"], "NOT_RECONCILED")
        registration["price"]["rates_per_million"]["cache_write_12h"] = None
        self.assertEqual(validate(registration, self.root)["pricing"], "INCOMPLETE_RATES")

    def test_registered_near_limit_cases_with_gateway_terminal_framing(self):
        registration = self.registration
        gate = BudgetGate(registration["token_cap"], minimum_output_tokens=registration["minimum_output_tokens"])
        body = json_bytes({"model": "mock-model", "stream": True, "input": "Synthetic fixture"})
        cap = registration["token_cap"]
        floor = registration["minimum_output_tokens"]
        with self.assertRaisesRegex(ValueError, "insufficient budget"):
            gate.admit("would-not-fit", "main", body, minimum_input_tokens=cap - floor + 1)
        admission = gate.admit("boundary", "main", body, minimum_input_tokens=cap - floor)
        self.assertEqual(admission.max_output_tokens, floor)
        event = terminal("boundary", cap - floor + 2, floor, 20)
        payload = b"\n".join(line[5:].strip() for line in event.splitlines() if line.startswith(b"data:"))
        self.assertTrue(gate.record_event("boundary", payload))
        result = gate.snapshot()
        self.assertEqual(result["budget_status"], "TIMEOUT_BUDGET")
        self.assertEqual(result["observed_total_tokens"], cap + 2)
        self.assertEqual(result["observed_cached_input_tokens"], 20)
        with self.assertRaisesRegex(ValueError, "insufficient budget"):
            gate.admit("later", "title", body, minimum_input_tokens=0)


if __name__ == "__main__":
    unittest.main()
