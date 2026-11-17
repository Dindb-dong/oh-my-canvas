"""Validate a credential-free registration for a common operator-routed provider.

This preflight opens only the supplied registration and four frozen tool
inventories. It sends no requests and does not inspect any account state.
Passing validates a proposal for qualification, not the upstream's availability
or its billing or dispatch behavior.
"""

import argparse
from datetime import date
from hashlib import sha256
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from budget_gate import _object


ARMS = ("omc-native", "paper-desktop", "figma-remote", "penpot-webgl")
SCHEMA = "omc-local-dev/provider-registration/1"
ROLES = ("main", "title", "retry", "compaction", "subagent", "cancelled_or_incomplete")
RATE_FIELDS = ("uncached_input", "cached_input", "cache_write_30m", "cache_write_12h", "output")
WORKLOADS = {
    "LD01": (900, 120_000), "LD02": (600, 80_000), "LD03": (900, 120_000),
    "LD04": (900, 120_000), "LD05": (1800, 240_000), "LD06": (900, 120_000),
}
JSON_LIMIT = 8 * 1024 * 1024


def read_json(path):
    with path.open("rb") as stream:
        raw = stream.read(JSON_LIMIT + 1)
    return _object(raw, JSON_LIMIT), sha256(raw).hexdigest()


def exact_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError(f"{label} fields do not match the registration contract")
    return value


def identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][-A-Za-z0-9._:/]{0,127}", value):
        raise ValueError(f"invalid {label} identifier")


def hash_string(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError(f"invalid {label} SHA-256")


def route_address(value):
    if not isinstance(value, str):
        raise ValueError("a separately scoped operator endpoint is required")
    # Restrict the input itself, before URL parsing can strip whitespace or controls.
    if not re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}/v1", value):
        raise ValueError("the provider endpoint must be a credential-free IPv4 loopback /v1 URL")
    if urlsplit(value).port is None:
        raise ValueError("invalid provider endpoint port")


def price_terms(price):
    if price is None:
        return "NOT_REGISTERED"
    exact_keys(price, (
        "revision", "observed_date", "source_url", "currency", "processing_tier",
        "context_tier", "region", "rates_per_million",
    ), "published price")
    for field in ("revision", "processing_tier", "context_tier", "region"):
        identifier(price[field], f"price {field}")
    if not isinstance(price["currency"], str) or not re.fullmatch(r"[A-Z]{3}", price["currency"]):
        raise ValueError("invalid price currency")
    if not isinstance(price["observed_date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", price["observed_date"]):
        raise ValueError("invalid price date")
    date.fromisoformat(price["observed_date"])
    url = price["source_url"]
    if not isinstance(url, str) or not re.fullmatch(r"https://[^\s]+", url):
        raise ValueError("a public HTTPS price source is required")
    parsed = urlsplit(url)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid public price source")
    rates = exact_keys(price["rates_per_million"], RATE_FIELDS, "price rates")
    for rate in rates.values():
        if rate is not None and (not isinstance(rate, str) or not re.fullmatch(r"\d{1,16}(?:\.\d{1,12})?", rate)):
            raise ValueError("rates must be nonnegative decimal strings or null")
    return "PUBLISHED_RATE_ESTIMATE_ONLY" if all(rate is not None for rate in rates.values()) else "INCOMPLETE_RATES"


def verify_inventory(directory, arm, proposal):
    exact_keys(proposal, ("transport", "inventory_sha256", "required_tools"), f"{arm} MCP")
    identifier(proposal["transport"], "MCP transport")
    hash_string(proposal["inventory_sha256"], "MCP tool inventory")
    wanted = proposal["required_tools"]
    if not isinstance(wanted, list) or not wanted:
        raise ValueError(f"{arm} needs required MCP tools")
    for tool in wanted:
        identifier(tool, "MCP tool")
    if len(set(wanted)) != len(wanted):
        raise ValueError(f"{arm} has duplicate required MCP tools")

    artifact = directory / f"{arm}.tools.json"
    if artifact.is_symlink() or not artifact.is_file():
        raise ValueError(f"{arm} requires a regular tool inventory artifact")
    inventory, digest = read_json(artifact)
    if digest != proposal["inventory_sha256"]:
        raise ValueError(f"{arm} tool inventory digest differs from the registration")
    tools = exact_keys(inventory, ("tools",), f"{arm} tool inventory")["tools"]
    if not isinstance(tools, list):
        raise ValueError(f"{arm} tool inventory is malformed")
    discovered = set()
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(tool.get("inputSchema"), dict):
            raise ValueError(f"{arm} is missing an MCP input schema")
        identifier(tool.get("name"), "discovered MCP tool")
        if tool["name"] in discovered:
            raise ValueError(f"{arm} has a duplicate discovered tool")
        discovered.add(tool["name"])
    if not set(wanted) <= discovered:
        raise ValueError(f"{arm} tool inventory lacks a required tool")
    return {"inventory_sha256": digest, "tool_count": len(discovered)}


def validate(registration, directory):
    exact_keys(registration, (
        "schema", "mode", "provider", "workload", "wall_seconds", "token_cap", "minimum_output_tokens",
        "mcp", "route_coverage", "price",
    ), "registration")
    if registration["schema"] != SCHEMA or registration["mode"] not in ("operator_candidate", "synthetic"):
        raise ValueError("unsupported registration schema or mode")
    provider = exact_keys(registration["provider"], (
        "base_url", "name", "model", "model_revision", "codex_version", "reasoning_effort",
        "transport", "credential_custody", "capture_sha256",
    ), "provider")
    route_address(provider["base_url"])
    for field in ("name", "model", "model_revision", "codex_version", "reasoning_effort"):
        identifier(provider[field], f"provider {field}")
    hash_string(provider["capture_sha256"], "provider capture execution configuration")
    if provider["transport"] != "responses_http_sse":
        raise ValueError("the provider must use attached Responses HTTP SSE")
    expected_custody = "none" if registration["mode"] == "synthetic" else "operator_upstream_only"
    if provider["credential_custody"] != expected_custody:
        raise ValueError("the Codex client must have no managed or upstream provider credential")
    workload = registration["workload"]
    identifier(workload, "workload")
    bounds = registration["wall_seconds"], registration["token_cap"]
    if tuple(type(value) for value in bounds) != (int, int) or WORKLOADS.get(workload) != bounds:
        raise ValueError("workload limits do not match the pinned benchmark defaults")
    floor = registration["minimum_output_tokens"]
    if type(floor) is not int or not 0 < floor < bounds[1]:
        raise ValueError("invalid provider output control floor")

    coverage = exact_keys(registration["route_coverage"], ROLES, "route coverage")
    for role, treatment in coverage.items():
        allowed = ("routed", "disabled_by_registered_config") if role in ("compaction", "subagent") else ("routed",)
        if treatment not in allowed:
            raise ValueError(f"unaccounted provider role: {role}")
    pricing_status = price_terms(registration["price"])
    arm_entries = exact_keys(registration["mcp"], ARMS, "MCP arm inventory")
    inventories = {arm: verify_inventory(directory, arm, arm_entries[arm]) for arm in ARMS}
    return {
        "status": "SYNTHETIC_REGISTRATION_VALID" if registration["mode"] == "synthetic" else "READY_FOR_OPERATOR_QUALIFICATION",
        "workload": workload,
        "mcp": inventories,
        "pricing": pricing_status,
        "billed_cost_status": "NOT_RECONCILED",
        "required_runtime_cases": [
            "title and main use one ledger",
            "remaining input bound plus output floor admits with exact floor",
            "one token less than input bound plus output floor denies before generation",
            "known exhaustion denies before input count",
            "final-call overshoot retained in full as TIMEOUT_BUDGET",
            "missing terminal usage blocks renewed dispatch",
            "metered retry and cancellation reconcile to provider request IDs",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registration", type=Path, help="Credential-free JSON with adjacent <arm>.tools.json files")
    args = parser.parse_args()
    try:
        registration, digest = read_json(args.registration)
        result = validate(registration, args.registration.parent)
    except (OSError, ValueError) as error:
        parser.exit(1, json.dumps({"status": "BLOCKED", "reason": str(error)}) + "\n")
    print(json.dumps(result | {"registration_sha256": digest}, indent=2))


if __name__ == "__main__":
    main()
