"""Freeze three independently verified canvas/source cycles for each LD05 brief."""

import argparse
import hashlib
import json
from pathlib import Path
import re


FAMILIES = {
    "route-board": {
        "title": "Service route board",
        "component": "RouteCard",
        "initial_cards": ["Depot 03", "North quay"],
        "extra_card": "Harbor transfer",
        "control": "Pin route",
        "initial_state": "Route unpinned",
        "changed_state": "Route pinned",
        "field": "Dispatch note",
        "error": "Enter at least four characters.",
        "input": "Meet at gate five",
        "success": "Dispatch note saved",
        "initial_asset": "city-route.png",
        "updated_asset": "quay-route.png",
        "edited_copy": "Last pickup 17:40",
        "variant": "priority",
        "widths": [360, 768, 1200],
        "styles": [{"gap": 20, "radius": 14, "heading_size": 24},
                   {"accent": "#145467", "wrap": True},
                   {"variant_border": "#8C3822"}],
    },
    "supply-ledger": {
        "title": "Studio supply ledger",
        "component": "StockCard",
        "initial_cards": ["Print stock", "Studio tools", "Thread boxes"],
        "extra_card": "Backorder envelopes",
        "control": "Mark counted",
        "initial_state": "Count outstanding",
        "changed_state": "Count recorded",
        "field": "Storage bin",
        "error": "Enter a bin such as B12.",
        "input": "B12",
        "success": "Storage bin saved",
        "initial_asset": "sample-roll.png",
        "updated_asset": "coral-roll.png",
        "edited_copy": "12 units in reserve",
        "variant": "backorder",
        "widths": [384, 840, 1280],
        "styles": [{"gap": 18, "radius": 10, "heading_size": 22},
                   {"accent": "#553565", "wrap": True},
                   {"variant_border": "#215342"}],
    },
}

SHA = re.compile(r"[0-9a-f]{64}")


def fixture(family):
    brief = FAMILIES[family]
    first = {
        "check_control_name": brief["control"],
        "keyboard_before": brief["initial_state"],
        "keyboard_after": brief["changed_state"],
        "component": brief["component"],
        "asset": brief["initial_asset"],
        "cards": brief["initial_cards"],
    }
    second = {
        **first,
        "field_name": brief["field"],
        "invalid_result": brief["error"],
        "submitted_value": brief["input"],
        "valid_result": brief["success"],
    }
    third = {
        **second,
        "asset": brief["updated_asset"],
        "copy": brief["edited_copy"],
        "variant": brief["variant"],
        "cards": [*brief["initial_cards"], brief["extra_card"]],
    }
    styles = brief["styles"]
    data = {
        "schema": "omc-local-dev/ld05/1",
        "workload_id": "LD05",
        "source_family_id": family,
        "title": brief["title"],
        "widths": brief["widths"],
        "budget_seconds": 1800,
        "budget_tokens": 240_000,
        "cycles": [
            {"source_patch": "Add an accessible selected-status announcement to the existing button.",
             "source_state": {**first, "status_visible": True},
             "result": {**first, "status_visible": True, **styles[0]}},
            {"source_patch": "Add the labeled input, validation, and retained successful value.",
             "source_state": {**second, "status_visible": True, **styles[0]},
             "result": {**second, "status_visible": True, **styles[0], **styles[1]}},
            {"source_patch": "Add the conditional entry to the source list and exercise its visible state.",
             "source_state": {**second, "cards": third["cards"], "status_visible": True, **styles[0], **styles[1]},
             "result": {**third, "status_visible": True, **styles[0], **styles[1], **styles[2]}},
        ],
    }
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {**data, "fixture_sha256": hashlib.sha256(canonical.encode()).hexdigest()}


def grade(contract, evidence):
    issues = []
    if not isinstance(evidence, dict) or evidence.get("fixture_sha256") != contract["fixture_sha256"]:
        return ["wrong or missing fixture hash"]
    initial = evidence.get("starting_source_sha256")
    cycles = evidence.get("cycles")
    if not isinstance(initial, str) or not SHA.fullmatch(initial):
        return ["missing starting source archive hash"]
    if not isinstance(cycles, list) or len(cycles) != len(contract["cycles"]):
        return ["expected exactly three ordered cycle records"]

    previous = initial
    for number, (wanted, observed) in enumerate(zip(contract["cycles"], cycles), 1):
        if not isinstance(observed, dict):
            issues.append(f"cycle {number}: evidence must be an object")
            continue
        source = observed.get("source_patch_sha256")
        ancestor = observed.get("source_parent_sha256")
        result = observed.get("result_checkout_sha256")
        if ancestor != previous or not all(isinstance(item, str) and SHA.fullmatch(item) for item in (source, result)):
            issues.append(f"cycle {number}: source/result lineage missing")
        elif len({previous, source, result}) != 3:
            issues.append(f"cycle {number}: lineage did not advance through source and design changes")
        previous = result
        if observed.get("refreshed_canvas") != wanted["source_state"]:
            issues.append(f"cycle {number}: refreshed canvas did not reflect the new source state")
        if observed.get("source_result") != wanted["result"]:
            issues.append(f"cycle {number}: accepted source semantics or design properties differ")
        if observed.get("reopened_canvas") != wanted["result"]:
            issues.append(f"cycle {number}: reopened canvas differs")
        if observed.get("checked_widths") != contract["widths"]:
            issues.append(f"cycle {number}: missing viewport coverage")
        for key in ("canvas_editable", "clean_build", "behavior_tests_passed", "component_reused", "no_missing_assets"):
            if observed.get(key) is not True:
                issues.append(f"cycle {number}: {key} not established")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("family", choices=FAMILIES)
    parser.add_argument("--grade", type=Path, help="Grade evidence produced by independent collectors")
    args = parser.parse_args()
    contract = fixture(args.family)
    if not args.grade:
        print(json.dumps(contract, ensure_ascii=False, allow_nan=False))
        return 0
    failures = grade(contract, json.loads(args.grade.read_text(encoding="utf-8")))
    print(json.dumps({"passed": not failures, "failures": failures}))
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
