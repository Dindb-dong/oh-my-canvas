"""Compute uncalibrated one-sided bounds for registered paired benchmark panels.

Usage: python3 bootstrap.py REGISTRATION.json
Adds a bootstrap object to analysis.py's input. Register interval_method
(percentile), seed, draws (>= 10000), minimum_families_per_stratum (>= 2),
claim_family (token_only or expanded), and the comparison product IDs.
Success supports the optional weighted_hoeffding profile. Each positive-weight
slot requires stratum_id, shared by every slot from one source family per panel.
Repeated blocks keep their registered relative weights within each stratum.
Resampling preserves each stratum's registered total weight.
"""

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import random

import analysis


METRICS = {
    "agent": ("success", "complete_tokens", "capped_time"),
    "resource": ("qualified_peak",),
}


def options(config, products):
    if not isinstance(config, dict):
        raise ValueError("registration requires a bootstrap object")
    if config.get("interval_method") != "percentile":
        raise ValueError("register the percentile interval method")
    for key, minimum in (("seed", 0), ("draws", 10_000), ("minimum_families_per_stratum", 2)):
        if type(config.get(key)) is not int or config[key] < minimum:
            raise ValueError(f"bootstrap.{key} must be an integer >= {minimum}")
    if config.get("success_profile") not in (None, "weighted_hoeffding"):
        raise ValueError("unsupported success inference profile")
    comparisons = config.get("comparisons")
    if (
        not isinstance(comparisons, list) or not comparisons
        or any(not isinstance(item, str) or item not in products for item in comparisons)
        or len(set(comparisons)) != len(comparisons)
    ):
        raise ValueError("bootstrap.comparisons must list distinct registered baselines")
    family = config.get("claim_family")
    if family not in ("token_only", "expanded"):
        raise ValueError("register the token_only or expanded claim_family")
    return comparisons, (2 if family == "token_only" else 4) * len(comparisons)


def prepare(raw_slots, products, kind, minimum, family_index, used_runs):
    slots = analysis.read_panel(raw_slots, products, kind, family_index, used_runs)
    source_strata = {}
    strata = {}
    fields = METRICS[kind]
    for raw, slot in zip(raw_slots, slots, strict=True):
        if not slot["weight"]:
            continue
        stratum = analysis.label(raw.get("stratum_id"), "stratum_id")
        family = slot["source_family_id"]
        if source_strata.setdefault(family, stratum) != stratum:
            raise ValueError(f"{kind} family {family} spans strata; register its matched block in one stratum")
        strata.setdefault(stratum, {}).setdefault(family, []).append(slot)
    result = {}
    for stratum, families in sorted(strata.items()):
        if len(families) < minimum:
            raise ValueError(f"{kind} stratum {stratum} has {len(families)} independent families, requires {minimum}")
        blocks = {}
        for family, slots in sorted(families.items()):
            weight = math.fsum(slot["weight"] for slot in slots)
            values = []
            for product in products:
                rows = [(slot["weight"], slot["attempts"][product]) for slot in slots]
                values.extend(analysis.weighted(rows, field) for field in fields)
            blocks[family] = (weight, tuple(values))
        mass = math.fsum(weight for weight, _ in blocks.values())
        result[(stratum, tuple(blocks))] = (mass, blocks)
    return result


def resample(panel, samples):
    pieces = []
    for key, (mass, blocks) in panel.items():
        selected = [(count, *blocks[family]) for family, count in samples[key].items()]
        sampled_mass = math.fsum(count * weight for count, weight, _ in selected)
        pieces.append(tuple(
            None if None in values else mass * math.fsum(
                (count * weight / sampled_mass) * value
                for (count, weight, _), value in zip(selected, values, strict=True)
            )
            for values in zip(*(values for _, _, values in selected), strict=True)
        ))
    mass = math.fsum(stratum_mass for stratum_mass, _ in panel.values())
    return tuple(
        None if None in values else math.fsum(values) / mass
        for values in zip(*pieces, strict=True)
    )


def draw_endpoints(values, resource_values, index, include_expanded):
    success, tokens, capped = values[:3]
    base_success, base_tokens, base_capped = values[3 * index:3 * index + 3]

    def divide(endpoint, numerator, denominator):
        if numerator is None or denominator is None:
            return None, f"{endpoint}_incomplete"
        if denominator == 0:
            return None, f"{endpoint}_zero_baseline"
        value = numerator / denominator
        if not math.isfinite(value):
            return "Infinity", f"{endpoint}_unbounded"
        return value, None

    if None in (success, tokens, base_success, base_tokens):
        token_ratio = (None, "token_incomplete")
    elif success == 0 and base_success == 0:
        token_ratio = (None, "zero_both_accepted")
    elif base_success == 0:
        token_ratio = (None, "zero_baseline_accepted")
    elif base_tokens == 0:
        token_ratio = (None, "token_zero_baseline")
    elif success == 0:
        token_ratio = ("Infinity", "zero_reference_accepted")
    else:
        token_ratio = divide("token", tokens / success, base_tokens / base_success)

    delta = success - base_success if success is not None and base_success is not None else None
    endpoints = {
        "success_rate_difference": (delta, "success_incomplete" if delta is None else None),
        "token_ratio": token_ratio,
    }
    if include_expanded:
        endpoints["capped_time_ratio"] = divide("time", capped, base_capped)
        endpoints["memory_ratio"] = divide("memory", resource_values[0], resource_values[index])
    return endpoints


def quantile(values, q):
    return sorted(values)[max(0, math.ceil(q * len(values)) - 1)]


def estimate(registration):
    descriptive = analysis.analyze(registration)
    ref = descriptive["reference_product"]
    config = registration.get("bootstrap")
    baselines = [product for product in registration["products"] if product != ref]
    comparisons, statements = options(config, baselines)
    products = [ref, *comparisons]
    include_expanded = config["claim_family"] == "expanded"
    if include_expanded and "resource" not in descriptive:
        raise ValueError("expanded claim family requires the registered resource panel")
    panels = {}
    family_index, used_runs = {"id": {}, "hash": {}}, set()
    for kind in ("agent", "resource") if include_expanded else ("agent",):
        # Validate extra descriptive products, then sample only the registered comparisons.
        raw_slots = [{**raw, "attempts": {
            product: row for product, row in raw.get("attempts", {}).items() if product in products
        }} for raw in registration[f"{kind}_slots"]]
        panels[kind] = prepare(
            raw_slots, products, kind, config["minimum_families_per_stratum"], family_index, used_runs
        )
    # Panels with the same sampling frame reuse its draw; different frames retain their own distribution.
    draw_keys = sorted({key for panel in panels.values() for key in panel})
    alpha = 0.05 / statements
    agent_panel = panels["agent"]
    sum_squared_family_weights = math.fsum(
        weight**2 for _, blocks in agent_panel.values() for weight, _ in blocks.values()
    ) / math.fsum(mass for mass, _ in agent_panel.values())**2
    results = {}
    draws = {}
    for baseline in comparisons:
        points = descriptive["agent"]["comparisons"][baseline]
        endpoints = ("success_rate_difference", "token_ratio")
        if include_expanded:
            endpoints += ("capped_time_ratio", "memory_ratio")
            points = {**points, **descriptive["resource"]["comparisons"][baseline]}
        results[baseline] = {}
        for endpoint in endpoints:
            point = points[endpoint]
            if isinstance(point, float) and math.isinf(point):
                point = "Infinity"
            results[baseline][endpoint] = {"point": point, "invalid_draws": {}}
        draws[baseline] = {endpoint: [] for endpoint in endpoints}
    rng = random.Random(config["seed"])
    for draw_id in range(config["draws"]):
        samples = {key: Counter(rng.choices(key[1], k=len(key[1]))) for key in draw_keys}
        values = resample(agent_panel, samples)
        resource_values = resample(panels["resource"], samples) if include_expanded else ()
        for index, baseline in enumerate(comparisons, start=1):
            for endpoint, (value, reason) in draw_endpoints(values, resource_values, index, include_expanded).items():
                if reason is None:
                    draws[baseline][endpoint].append(value)
                else:
                    failures = results[baseline][endpoint]["invalid_draws"]
                    failures.setdefault(reason, []).append(draw_id)
    for baseline, endpoints in results.items():
        for endpoint, result in endpoints.items():
            values = draws[baseline][endpoint]
            result["finite_draws"] = len(values)
            result["bound"] = None
            result["bound_side"] = "lower" if endpoint == "success_rate_difference" else "upper"
            if result["point"] in (None, "Infinity") or result["invalid_draws"]:
                result["bound_status"] = "INCOMPLETE_OR_SPARSE"
            elif endpoint == "success_rate_difference":
                result["bound_status"] = "SUCCESS_PROFILE_REQUIRED"
                if config.get("success_profile") == "weighted_hoeffding":
                    radius = math.sqrt(2 * sum_squared_family_weights * math.log(1 / alpha))
                    result["bound"] = max(-1, result["point"] - radius)
                    result["bound_status"] = "PROVISIONAL"
                result["empirically_constant"] = min(values) == max(values)
            else:
                result["bound"] = quantile(values, 1 - alpha)
                result["bound_status"] = "PROVISIONAL"
    return {
        "schema_version": "omc-local-dev/bootstrap/1",
        "mode": "UNCALIBRATED",
        "confirmatory_claim_eligible": False,
        "reference_product": ref,
        "configuration": config,
        "one_sided_alpha": alpha,
        "registered_statements": statements,
        "agent_family_weight_square_sum": sum_squared_family_weights,
        "stratum_counts": {
            kind: {stratum: len(families) for stratum, families in panel} for kind, panel in panels.items()
        },
        "comparisons": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registration", type=Path)
    args = parser.parse_args()
    try:
        report = estimate(json.loads(args.registration.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
