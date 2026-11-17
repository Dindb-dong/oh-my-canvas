"""Emit a source-independent fixture or grade normalized product observations."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import ld01
import ld03
import ld04
import ld06
from font_asset import read_font


SCHEMA = "omc-local-dev/workload-fixture/1"
WORKLOADS = {"LD01": ld01, "LD03": ld03, "LD04": ld04, "LD06": ld06}
GEOMETRY_TOLERANCE = 2


def fixture(workload, variant=None, **inputs):
    module = WORKLOADS[workload]
    variant = variant if variant is not None else next(iter(module.VARIANTS))
    contract = {
        "schema": SCHEMA,
        "workload": workload,
        "source_family_id": variant,
        "geometry_tolerance_px": GEOMETRY_TOLERANCE,
        **module.fixture(variant, **inputs),
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
                if field in {"bounds", "crop_source_px"}:
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


def _responsive(contract, evidence, copy_identity, failures):
    if not contract["private_width_registered"]:
        failures.append("probe: no private width registration")
    if evidence.get("withheld_width_commitment") != contract["withheld_width_commitment"]:
        failures.append("probe: withheld width commitment differs")
    observed = evidence.get("width_observations")
    expected = contract["responsive_steps"]
    if not isinstance(observed, list) or len(observed) != len(expected):
        failures.append("probe: missing width observations")
        return
    for index, (spec, state) in enumerate(zip(expected, observed)):
        label = f"probe step {index + 1} at {spec['width']}px"
        if not isinstance(state, dict) or state.get("width") != spec["width"]:
            failures.append(f"{label}: observed width or sequence differs")
            continue
        identity = _phase(label, spec, state, failures)
        if identity and copy_identity and identity != copy_identity:
            failures.append(f"{label}: parent or native object identities changed during resizing")


def _handoff(contract, evidence, phases, failures):
    if not contract["font_registered"]:
        failures.append("LD06 requires licensed registered font bytes")
    for first, second in (("before", "loaded"), ("loaded", "candidate")):
        if phases[first] and phases[second]:
            retained = phases[second][1]["nodes"]
            if any(retained.get(key) != identity for key, identity in phases[first][1]["nodes"].items()):
                failures.append(f"{second}: prepared editable objects were replaced")
            if phases[first][0] != phases[second][0]:
                failures.append(f"{second}: document identity was replaced")
    if contract["font_registered"]:
        expected_glyphs = {"font_sha256": contract["font"]["sha256"], "rendered": contract["required_glyphs"]}
        for phase in ("loaded", "candidate", "reopened"):
            snapshot = evidence.get(phase)
            if not isinstance(snapshot, dict) or snapshot.get("glyph_render") != expected_glyphs:
                failures.append(f"{phase}: rendered Latin/Korean glyph evidence differs")

    handoff = evidence.get("handoff")
    if not isinstance(handoff, dict):
        failures.append("handoff: missing clean-checkout evidence")
        return
    commit = handoff.get("commit")
    tree = handoff.get("source_tree_sha256")
    if (not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit)
            or not isinstance(tree, str) or not re.fullmatch(r"[a-f0-9]{64}", tree)):
        failures.append("handoff: invalid revision or source-tree identity")
    builds = handoff.get("builds")
    if (not isinstance(builds, list) or len(builds) != 2
            or any(not isinstance(build, dict) for build in builds)):
        failures.append("handoff: two independent fresh checkout builds required")
        return
    keys = [build.get("checkout_id") for build in builds]
    if any(not isinstance(key, str) or not key.strip() for key in keys) or keys[0] == keys[1]:
        failures.append("handoff: checkout identities are absent or repeated")
    for index, build in enumerate(builds, 1):
        label = f"handoff build {index}"
        if (build.get("commit") != commit or build.get("source_tree_sha256") != tree
                or build.get("clean_checkout") is not True or type(build.get("exit_code")) is not int
                or build["exit_code"] != 0):
            failures.append(f"{label}: source or build status differs")
        if build.get("external_requests") != []:
            failures.append(f"{label}: external asset access was present or unmeasured")
        if contract["font_registered"] and build.get("glyph_render") != expected_glyphs:
            failures.append(f"{label}: source-rendered glyph evidence differs")
        observations = build.get("rendered")
        expected = contract["handoff_values"]
        if not isinstance(observations, dict) or observations.keys() != expected.keys():
            failures.append(f"{label}: rendered artifact set differs")
            continue
        for key, spec in expected.items():
            item = observations[key]
            if not isinstance(item, dict):
                failures.append(f"{label}: missing {key} observation")
                continue
            if item.get("provenance") not in ("bundled", "embedded"):
                failures.append(f"{label}: {key} lacks offline asset provenance")
            for field, value in spec.items():
                matches = (_bounds_match(item.get(field), value) if field == "crop_source_px"
                           else field in item and item[field] == value)
                if not matches:
                    failures.append(f"{label}: {key}.{field} differs")


def grade(contract, evidence):
    failures = []
    if not isinstance(evidence, dict):
        return ["evidence must be an object"]
    specs = {"before": "start", "candidate": "expected", "reopened": "expected"}
    includes_probe = "probe" in contract
    if includes_probe:
        specs.update(probe="probe", after_probe_original="expected")
    if "loaded" in contract:
        specs["loaded"] = "loaded"
    phases = {
        phase: _phase(phase, contract[reference], evidence.get(phase), failures)
        for phase, reference in specs.items()
    }
    if includes_probe and evidence.get("probe_actions") != contract["probe_actions"]:
        failures.append("probe_actions: observed operations do not match the registered probe")

    candidate = phases["candidate"]
    if candidate:
        for name in ("reopened", "after_probe_original"):
            if phases.get(name) and phases[name] != candidate:
                failures.append(f"{name}: document or native identities changed")
        if phases["before"] and phases["before"][0] != candidate[0]:
            failures.append("candidate: document identity differs from the prepared starting document")
        if contract["workload"] in {"LD03", "LD04"} and phases["before"] and phases["before"] != candidate:
            failures.append("candidate: shared references or native object identities were replaced")
        if phases.get("probe") and phases["probe"][0] == candidate[0]:
            failures.append("probe: verification edits were not performed on a distinct copy")

    if contract["workload"] == "LD04":
        _responsive(contract, evidence, phases["probe"], failures)
    elif contract["workload"] == "LD06":
        _handoff(contract, evidence, phases, failures)
    return failures


def public_brief(contract):
    private = {"probe", "probe_actions", "responsive_steps", "handoff_values"}
    return {key: value for key, value in contract.items() if key not in private}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("fixture", "brief", "grade"))
    parser.add_argument("workload", choices=WORKLOADS)
    parser.add_argument("evidence", type=Path, nargs="?")
    parser.add_argument("--variant")
    parser.add_argument("--assets-dir", type=Path)
    parser.add_argument("--registration", type=Path)
    parser.add_argument("--font-file", type=Path)
    parser.add_argument("--font-license")
    args = parser.parse_args()
    module = WORKLOADS[args.workload]
    if args.variant and args.variant not in module.VARIANTS:
        parser.error("available variants: " + ", ".join(module.VARIANTS))
    variant = args.variant or next(iter(module.VARIANTS))
    if args.registration and args.workload != "LD04":
        parser.error("--registration is only for LD04")
    if (args.font_file or args.font_license) and (
            args.workload != "LD06" or not args.font_file or not args.font_license):
        parser.error("--font-file and --font-license must be supplied together for LD06")
    inputs = {}
    extra_assets = []
    try:
        if args.registration:
            inputs["private_registration"] = json.loads(args.registration.read_text(encoding="utf-8"))
            if inputs["private_registration"] is None:
                raise ValueError("LD04 registration must be an object")
        if args.font_file:
            metadata, data = read_font(args.font_file, args.font_license,
                                       module.required_glyphs(module.VARIANTS[variant]))
            inputs["font"] = metadata
            extra_assets.append((metadata, data))
        contract = fixture(args.workload, variant, **inputs)
        if args.action in {"fixture", "brief"}:
            if args.evidence:
                parser.error(f"{args.action} does not accept an evidence argument")
            if args.assets_dir:
                if args.action != "fixture" or not hasattr(module, "make_assets"):
                    parser.error("--assets-dir requires a fixture with generated assets")
                args.assets_dir.mkdir(mode=0o700)
                for metadata, data in module.make_assets(module.VARIANTS[variant]) + extra_assets:
                    with (args.assets_dir / metadata["name"]).open("xb") as output:
                        output.write(data)
            output = public_brief(contract) if args.action == "brief" else contract
            print(json.dumps(output, ensure_ascii=False, allow_nan=False))
            return 0
    except (OSError, ValueError) as error:
        parser.error(str(error))

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
