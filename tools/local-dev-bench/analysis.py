"""Describe fixed paired panels without making inferential claims.

Usage: python3 analysis.py REGISTRATION.json
Registration schema omc-local-dev/analysis/1 contains reference_product, products,
agent_slots and optional resource_slots. Each slot declares slot_id, workload_id,
source_family_id, source_sha256, fixture_sha256, weight and attempts (inline
run_attempt results keyed by product). Agent slots also declare budget_ms.
Resource results attest equivalent_replay and COMPLETE replay and tail phases.
"""

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re


SCHEMA = "omc-local-dev/analysis/1"
COMPLETE = "COMPLETE"
COMPLETENESS = {COMPLETE, "INCOMPLETE", "NOT_OBSERVABLE"}
VALID = {"PASS", "QUALITY_FAIL", "EXECUTION_FAIL", "TIMEOUT_BUDGET"}
STATUSES = VALID | {
    "UNSUPPORTED", "ACCESS_BLOCKED", "ENVIRONMENT_BLOCKED", "SERVICE_UNAVAILABLE",
    "INVALID_RUN", "NOT_RUN", "DIAGNOSTIC",
}
RESOURCE_PHASES = ("replay", "tail")


def label(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} requires a non-empty string")
    return value


def digest(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"{field} requires a lowercase SHA-256 digest")
    return value


def number(value, field, *, integer=False):
    if value is None:
        return None
    if type(value) not in ((int,) if integer else (int, float)) or not 0 <= value <= 2**63 - 1:
        raise ValueError(f"{field} requires a finite nonnegative {'integer' if integer else 'number'}")
    return value


def observations(value, field):
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not isinstance(status, str) or status not in COMPLETENESS
        for key, status in value.items()
    ):
        raise ValueError(f"{field} contains invalid completeness statuses")
    return value


def read_attempt(attempt, product, slot, budget, used_runs):
    if attempt is None:
        return {"status": "MISSING", "valid": False, "metrics": {}, "phases": {}}
    if not isinstance(attempt, dict):
        raise ValueError("an attempt must be an object")
    status = label(attempt.get("execution_status"), "execution_status")
    if status not in STATUSES:
        raise ValueError(f"invalid execution status: {status}")
    run_id = attempt.get("run_id")
    if run_id is not None:
        label(run_id, "run_id")
        if run_id in used_runs:
            raise ValueError(f"reused run_id: {run_id}")
        used_runs.add(run_id)
    for field, expected in (
        ("product_profile", product), ("workload_id", slot["workload_id"]),
        ("fixture_sha256", slot["fixture_sha256"]), ("source_sha256", slot["source_sha256"]),
    ):
        if field in attempt and attempt[field] != expected:
            raise ValueError(f"{slot['slot_id']}: attempt {field} does not match the registration")

    metrics = observations(attempt.get("measurement_completeness", {}), "measurement_completeness")
    phases = observations(attempt.get("phase_completeness", {}), "phase_completeness")
    valid = status in VALID or (status == "SERVICE_UNAVAILABLE" and attempt.get("started") is True)
    passed = status == "PASS"
    ready = number(attempt.get("accepted_ready_ms"), "accepted_ready_ms")
    if ready is not None and (not passed or (budget is not None and ready > budget)):
        raise ValueError(f"{slot['slot_id']}: inconsistent acceptance or deadline")
    wall = number(attempt.get("observed_wall_ms"), "observed_wall_ms")
    input_tokens = number(attempt.get("provider_input_tokens"), "provider_input_tokens", integer=True)
    output_tokens = number(attempt.get("provider_output_tokens"), "provider_output_tokens", integer=True)
    peak = number(attempt.get("physical_footprint_peak_bytes"), "physical_footprint_peak_bytes", integer=True)
    if status == "NOT_RUN" and any(x is not None for x in (ready, wall, input_tokens, output_tokens, peak)):
        raise ValueError(f"{slot['slot_id']}: NOT_RUN must have null measurements")
    eligible_tokens = valid and metrics.get("tokens") == COMPLETE
    eligible_time = valid and metrics.get("time") == COMPLETE
    observed_tokens = input_tokens + output_tokens if input_tokens is not None and output_tokens is not None else None
    severe = attempt.get("severe_correctness_violation") is True
    eligible_peak = (
        passed and not severe and attempt.get("equivalent_replay") is True
        and metrics.get("physical_footprint") == COMPLETE
        and all(phases.get(phase) == COMPLETE for phase in RESOURCE_PHASES)
    )
    return {
        "status": status, "valid": valid, "metrics": metrics, "phases": phases,
        "severe": severe,
        "success": int(passed) if valid else None,
        "wall": wall,
        "ready": ready if eligible_time else None,
        "capped_time": (ready if eligible_time else None) if passed else budget if valid else None,
        "input_tokens": input_tokens, "output_tokens": output_tokens,
        "observed_tokens": observed_tokens,
        "complete_tokens": observed_tokens if eligible_tokens else None,
        "observed_peak": peak, "qualified_peak": peak if eligible_peak else None,
    }


def read_panel(items, products, kind, hashed_families, used_runs):
    if not isinstance(items, list) or not items:
        raise ValueError(f"{kind}_slots must be a non-empty list")
    slots = []
    identifiers = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError(f"{kind} slot must be an object")
        slot = {key: label(raw.get(key), key) for key in ("slot_id", "workload_id", "source_family_id")}
        sid = slot["slot_id"]
        if sid in identifiers:
            raise ValueError(f"duplicate {kind} slot_id: {sid}")
        identifiers.add(sid)
        for key in ("source_sha256", "fixture_sha256"):
            slot[key] = digest(raw.get(key), key)
        family, source = slot["source_family_id"], slot["source_sha256"]
        previous_source = hashed_families["id"].setdefault(family, source)
        previous_family = hashed_families["hash"].setdefault(source, family)
        if previous_source != source or previous_family != family:
            raise ValueError("source-family IDs and origin digests must match one-to-one")
        slot["weight"] = number(raw.get("weight"), "weight")
        if slot["weight"] is None or slot["weight"] > 1:
            raise ValueError("weight must be provided between zero and one")
        budget = number(raw.get("budget_ms"), "budget_ms") if kind == "agent" else None
        if kind == "agent" and not budget:
            raise ValueError("agent slot requires positive budget_ms")
        attempts = raw.get("attempts", {})
        if not isinstance(attempts, dict) or set(attempts) - set(products):
            raise ValueError(f"{sid}: attempts must be keyed by registered product")
        slot["attempts"] = {
            product: read_attempt(attempts.get(product), product, slot, budget, used_runs)
            for product in products
        }
        slots.append(slot)
    if not math.isclose(math.fsum(slot["weight"] for slot in slots), 1, rel_tol=0, abs_tol=1e-12):
        raise ValueError(f"{kind} slot weights must sum to one")
    return slots


def weighted(rows, field):
    positive = [(weight, row.get(field)) for weight, row in rows if weight > 0]
    if not positive or any(value is None for _, value in positive):
        return None
    return math.fsum(weight * value for weight, value in positive) / math.fsum(weight for weight, _ in positive)


def sums(rows, fields):
    result = {}
    for field in fields:
        values = [row[field] for row in rows if row.get(field) is not None]
        result[field] = {"sum": sum(values) if values else None, "observed_slots": len(values)}
    return result


def coverage(rows, field, required):
    labels = sorted(set(required) | {key for row in rows for key in row[field]})
    return {key: dict(Counter(row[field].get(key, "MISSING") for row in rows)) for key in labels}


def describe(slots, product, kind):
    weighted_rows = [(slot["weight"], slot["attempts"][product]) for slot in slots]
    rows = [row for _, row in weighted_rows]
    valid = [row for row in rows if row["valid"]]
    accepted = [(weight, row) for weight, row in weighted_rows if row.get("success") == 1]
    required_phases = set(RESOURCE_PHASES if kind == "resource" else ())
    for slot in slots:
        for row in slot["attempts"].values():
            required_phases.update(row["phases"])
    summary = {
        "registered_slots": len(rows),
        "valid_attempts": len(valid),
        "accepted": len(accepted),
        "outcomes": dict(Counter(row["status"] for row in rows)),
        "severe_correctness_violations": sum(row.get("severe", False) for row in rows),
        "phase_completeness": coverage(rows, "phases", required_phases),
    }
    if kind == "resource":
        observed = [row["observed_peak"] for row in rows if row.get("observed_peak") is not None]
        summary.update(
            measurement_completeness=coverage(rows, "metrics", ("physical_footprint",)),
            qualified_replays=sum(row.get("qualified_peak") is not None for row in rows),
            mean_peak_physical_footprint_bytes=weighted(weighted_rows, "qualified_peak"),
            observed_max_footprint_peak_bytes=max(observed, default=None),
        )
        return summary

    success = weighted(weighted_rows, "success")
    mean_tokens = weighted(weighted_rows, "complete_tokens")
    per_accepted = (
        "Infinity" if success == 0 else mean_tokens / success
        if success is not None and mean_tokens is not None else None
    )
    fields = ("input_tokens", "output_tokens", "observed_tokens", "wall")
    summary.update(
        measurement_completeness=coverage(rows, "metrics", ("time", "tokens")),
        success_rate=success,
        mean_tokens_all_attempts=mean_tokens,
        tokens_per_accepted_result=per_accepted,
        mean_capped_time_ms=weighted(weighted_rows, "capped_time"),
        raw_observed_valid=sums(valid, fields),
        raw_observed_nonvalid=sums([row for row in rows if not row["valid"]], fields),
        accepted_ready_times_ms=sorted(row["ready"] for _, row in accepted if row["ready"] is not None),
        successful_only={
            "accepted_slots": len(accepted),
            "complete_token_slots": sum(row["complete_tokens"] is not None for _, row in accepted),
            "mean_tokens": weighted(accepted, "complete_tokens"),
            "mean_ready_ms": weighted(accepted, "ready"),
        },
    )
    return summary


def ratio(numerator, denominator):
    if numerator is None or denominator in (None, "Infinity", 0):
        return None
    return "Infinity" if numerator == "Infinity" else numerator / denominator


def agent_comparison(slots, summaries, ref, baseline):
    first = summaries[ref]
    second = summaries[baseline]
    paired = Counter(dict.fromkeys(("both_pass", "reference_only", "baseline_only", "both_fail", "unclassified"), 0))
    both = []
    for slot in slots:
        a, b = (slot["attempts"][name].get("success") for name in (ref, baseline))
        if a is None or b is None:
            paired["unclassified"] += 1
        else:
            paired[("both_fail", "baseline_only", "reference_only", "both_pass")[2 * a + b]] += 1
            if a == b == 1:
                both.append(slot)
    p, q = first["success_rate"], second["success_rate"]
    return {
        "paired_outcomes": dict(paired),
        "success_rate_difference": p - q if p is not None and q is not None else None,
        "token_ratio": ratio(first["tokens_per_accepted_result"], second["tokens_per_accepted_result"]),
        "capped_time_ratio": ratio(first["mean_capped_time_ms"], second["mean_capped_time_ms"]),
        "both_successful_only": {
            product: describe(both, product, "agent")["successful_only"] for product in (ref, baseline)
        },
    }


def analyze(registration):
    if not isinstance(registration, dict) or registration.get("schema_version") != SCHEMA:
        raise ValueError(f"registration requires schema_version {SCHEMA}")
    products = registration.get("products")
    if not isinstance(products, list) or len(products) < 2:
        raise ValueError("register at least two products")
    products = [label(product, "product") for product in products]
    ref = registration.get("reference_product")
    if len(set(products)) != len(products) or ref not in products:
        raise ValueError("reference_product must be in the distinct products list")
    output = {"schema_version": SCHEMA, "mode": "DESCRIPTIVE", "reference_product": ref}
    family_index = {"id": {}, "hash": {}}
    used_runs = set()
    for kind in ("agent", "resource"):
        raw = registration.get(f"{kind}_slots")
        if kind == "resource" and raw is None:
            continue
        slots = read_panel(raw, products, kind, family_index, used_runs)
        summaries = {product: describe(slots, product, kind) for product in products}
        groups = {}
        for slot in slots:
            groups.setdefault(slot["workload_id"], []).append(slot)
        report = {
            "independent_source_families": len({slot["source_family_id"] for slot in slots}),
            "products": summaries,
            "by_workload": {
                workload: {product: describe(group, product, kind) for product in products}
                for workload, group in sorted(groups.items())
            },
            "comparisons": {},
        }
        if kind == "resource":
            by_family = {}
            for slot in slots:
                by_family.setdefault(slot["source_family_id"], []).append(slot)
            report["by_source_family"] = {
                family: {product: describe(group, product, kind) for product in products}
                for family, group in sorted(by_family.items())
            }
        for product in products:
            if product == ref:
                continue
            if kind == "agent":
                comparison = agent_comparison(slots, summaries, ref, product)
            else:
                key = "mean_peak_physical_footprint_bytes"
                comparison = {"memory_ratio": ratio(summaries[ref][key], summaries[product][key])}
            report["comparisons"][product] = comparison
        output[kind] = report
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registration", type=Path)
    args = parser.parse_args()
    try:
        report = analyze(json.loads(args.registration.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
