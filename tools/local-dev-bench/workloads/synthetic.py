"""Emit a source-independent fixture or grade normalized product observations."""
import argparse
import hashlib
import json
from pathlib import Path

import ld01
import ld03


SCHEMA = "omc-local-dev/workload-fixture/1"
WORKLOADS = {"LD01": ld01, "LD03": ld03}
GEOMETRY_TOLERANCE = 2


def fixture(workload, variant=None):
    module = WORKLOADS[workload]
    variant = variant if variant is not None else next(iter(module.VARIANTS))
    contract = {
        "schema": SCHEMA,
        "workload": workload,
        "source_family_id": variant,
        "geometry_tolerance_px": GEOMETRY_TOLERANCE,
        **module.fixture(variant),
    }
    canonical = json.dumps(contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {**contract, "fixture_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}


def _indexed(rows):
    if not isinstance(rows, list) or any(
        not isinstance(row, dict) or not isinstance(row.get("key"), str) or not row["key"]
        for row in rows
    ):
        return None
    index = {row["key"]: row for row in rows}
    return index if len(index) == len(rows) else None


def _ids(index):
    ids = {key: item.get("native_id") for key, item in index.items()}
    if any(not isinstance(value, str) or not value.strip() for value in ids.values()):
        return None
    return ids if len(set(ids.values())) == len(ids) else None


def _bounds_match(actual, expected):
    return isinstance(actual, list) and len(actual) == len(expected) and all(
        type(a) in (int, float) and abs(a - e) <= GEOMETRY_TOLERANCE
        for a, e in zip(actual, expected)
    )


def _phase(phase, expected, observation, failures):
    if not isinstance(observation, dict):
        failures.append(f"{phase}: missing observation")
        return None
    identity = observation.get("document_id")
    if not isinstance(identity, str) or not identity.strip():
        failures.append(f"{phase}: missing observed document identity")
        return None
    actual = {}
    ids = {}
    for collection in ("nodes", "styles"):
        actual[collection] = _indexed(observation.get(collection))
        expected_index = _indexed(expected[collection])
        if actual[collection] is None or actual[collection].keys() != expected_index.keys():
            failures.append(f"{phase}: {collection} have missing, duplicate, or unexpected logical keys")
            return None
        ids[collection] = _ids(actual[collection])
        if ids[collection] is None:
            failures.append(f"{phase}: {collection} have missing or duplicate native IDs")
            return None

    for collection in ("nodes", "styles"):
        for required in expected[collection]:
            key = required["key"]
            row = actual[collection][key]
            if collection == "nodes" and row.get("editable") is not True:
                failures.append(f"{phase}: {key} is not independently editable")
            for field, value in required.items():
                if field == "bounds":
                    matches = _bounds_match(row.get(field), value)
                elif field == "bindings":
                    matches = row.get(field) == {prop: ids["styles"][style] for prop, style in value.items()}
                else:
                    matches = field in row and row[field] == value
                if not matches:
                    failures.append(f"{phase}: {key}.{field} differs")
            if collection == "nodes" and "bindings" not in required and row.get("bindings"):
                failures.append(f"{phase}: {key} unexpectedly depends on shared styles")
    return identity, ids


def grade(contract, evidence):
    failures = []
    if not isinstance(evidence, dict):
        return ["evidence must be an object"]
    phases = {
        phase: _phase(phase, contract[reference], evidence.get(phase), failures)
        for phase, reference in (
            ("before", "start"), ("candidate", "expected"), ("reopened", "expected"),
            ("probe", "probe"), ("after_probe_original", "expected"),
        )
    }
    if evidence.get("probe_actions") != contract["probe_actions"]:
        failures.append("probe_actions: observed operations do not match the registered probe")

    candidate = phases["candidate"]
    if candidate:
        for name in ("reopened", "after_probe_original"):
            if phases[name] and phases[name] != candidate:
                failures.append(f"{name}: document or native identities changed")
        if phases["before"] and phases["before"][0] != candidate[0]:
            failures.append("candidate: document identity differs from the prepared starting document")
        if contract["workload"] == "LD03" and phases["before"] and phases["before"] != candidate:
            failures.append("candidate: shared references or native object identities were replaced")
        if phases["probe"] and phases["probe"][0] == candidate[0]:
            failures.append("probe: verification edits were not performed on a distinct copy")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("fixture", "grade"))
    parser.add_argument("workload", choices=WORKLOADS)
    parser.add_argument("evidence", type=Path, nargs="?")
    parser.add_argument("--variant")
    parser.add_argument("--assets-dir", type=Path)
    args = parser.parse_args()
    module = WORKLOADS[args.workload]
    if args.variant and args.variant not in module.VARIANTS:
        parser.error("available variants: " + ", ".join(module.VARIANTS))
    contract = fixture(args.workload, args.variant)
    if args.action == "fixture":
        if args.evidence:
            parser.error("fixture does not accept an evidence argument")
        if args.assets_dir:
            if args.workload != "LD01":
                parser.error("selected workload does not have generated assets")
            args.assets_dir.mkdir(mode=0o700)
            for metadata, data in ld01.make_assets(module.VARIANTS[contract["source_family_id"]]):
                with (args.assets_dir / metadata["name"]).open("xb") as output:
                    output.write(data)
        print(json.dumps(contract, ensure_ascii=False, allow_nan=False))
        return 0

    if args.assets_dir or not args.evidence:
        parser.error("grade requires an evidence JSON path")
    try:
        evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    failures = grade(contract, evidence)
    print(json.dumps({"passed": not failures, "failures": failures}))
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
