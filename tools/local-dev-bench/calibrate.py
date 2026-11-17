"""Simulate the registered analysis on independent, paired source families.

Usage: python3 calibrate.py CONFIG.json or python3 calibrate.py --example
Each family independently draws one shared latent state from its workload's
mixture (or a common mixture). Conditional on that state, product attempts
and repetitions are independent Bernoulli trials. Each state registers token
spend for either outcome and ready time for successes. Expanded scenarios also
register peak bytes under full replay and the probability of complete replay.
The finite mixture supplies exact population estimands for coverage checks.
"""

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import random

import analysis
import bootstrap


SCHEMA = "omc-local-dev/calibration/1"
MARGINS = {
    "success_rate_difference": -.05, "token_ratio": .75,
    "capped_time_ratio": .80, "memory_ratio": .75,
}


def integer(value, name, minimum):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{name} requires an integer >= {minimum}")
    return value


def quantity(value, name, *, integral=False, maximum=2**63 - 1, positive=False):
    result = analysis.number(value, name, integer=integral)
    if result is None or result > maximum or (positive and result == 0):
        raise ValueError(f"{name} is out of range")
    return result


def weight_sum(values, name):
    if not math.isclose(math.fsum(values), 1, rel_tol=0, abs_tol=1e-12):
        raise ValueError(f"{name} must sum to one")


def mixture(raw, products, expanded, budget):
    if not isinstance(raw, list) or not raw:
        raise ValueError("states must be a nonempty list")
    states = []
    for state in raw:
        if not isinstance(state, dict) or not isinstance(state.get("products"), dict):
            raise ValueError("state requires a products object")
        mass = quantity(state.get("probability"), "state probability", maximum=1, positive=True)
        profiles = {}
        for product in products:
            profile = state["products"].get(product)
            if not isinstance(profile, dict):
                raise ValueError(f"state requires a profile for {product}")
            fields = {
                "success_probability": {"maximum": 1},
                "severe_given_failure": {"maximum": 1},
                "tokens_on_success": {"integral": True},
                "tokens_on_failure": {"integral": True},
                "ready_ms": {"maximum": budget},
            }
            if expanded:
                fields.update(memory_bytes={"integral": True}, replay_success_probability={"maximum": 1})
            profiles[product] = {
                field: quantity(
                    profile.get(field, 0 if field == "severe_given_failure" else None), field, **options
                )
                for field, options in fields.items()
            }
        states.append((mass, profiles))
    weight_sum((mass for mass, _ in states), "state probabilities")
    return states


def truths(workloads, states_by_workload, products, ref, expanded):
    metrics = {}
    paired_discordance = {product: Counter() for product in products if product != ref}
    for product in products:
        totals = Counter()
        for workload, (weight, budget) in workloads.items():
            states = states_by_workload[workload]
            for mass, profiles in states:
                profile = profiles[product]
                p = profile["success_probability"]
                w = weight * mass
                totals["success"] += w * p
                totals["tokens"] += w * (p * profile["tokens_on_success"] + (1 - p) * profile["tokens_on_failure"])
                totals["time"] += w * (p * profile["ready_ms"] + (1 - p) * budget)
                totals["severe"] += w * (1 - p) * profile["severe_given_failure"]
                if product != ref:
                    ref_p = profiles[ref]["success_probability"]
                    paired_discordance[product]["reference_only"] += w * ref_p * (1 - p)
                    paired_discordance[product]["baseline_only"] += w * (1 - ref_p) * p
                if expanded:
                    totals["memory"] += w * profile["memory_bytes"]
                    totals["replay_failure"] += w * (1 - profile["replay_success_probability"])
        totals["per_accepted"] = totals["tokens"] / totals["success"] if totals["success"] else "Infinity"
        metrics[product] = dict(totals)
    def ratio(numerator, denominator):
        value = analysis.ratio(numerator, denominator)
        return "Infinity" if isinstance(value, float) and math.isinf(value) else value

    leader = metrics[ref]
    comparisons = {}
    for product in products:
        if product == ref:
            continue
        base = metrics[product]
        comparison = {
            "success_rate_difference": leader["success"] - base["success"],
            "token_ratio": ratio(leader["per_accepted"], base["per_accepted"]),
        }
        if expanded:
            comparison.update(
                capped_time_ratio=ratio(leader["time"], base["time"]),
                memory_ratio=ratio(leader["memory"], base["memory"]),
            )
        comparisons[product] = comparison
    return metrics, comparisons, {product: dict(row) for product, row in paired_discordance.items()}


def simulate(workloads, states_by_workload, products, ref, allocation, repeats, inner, rng, expanded):
    slots, resources = [], []

    def digest(label):
        return hashlib.sha256(label.encode()).hexdigest()

    for workload, (weight, budget) in workloads.items():
        count = allocation[workload]
        masses, profiles = zip(*states_by_workload[workload])
        for family_number, state in enumerate(rng.choices(profiles, weights=masses, k=count)):
            family = f"{workload}:{family_number}"
            block = {
                "source_family_id": family, "source_sha256": digest(family),
                "workload_id": workload, "stratum_id": workload,
            }
            for repeat in range(repeats):
                slot_id = f"{family}:{repeat}"
                attempts = {}
                for product, profile in state.items():
                    passed = rng.random() < profile["success_probability"]
                    severe = not passed and rng.random() < profile["severe_given_failure"]
                    tokens = profile["tokens_on_success"] if passed else profile["tokens_on_failure"]
                    attempts[product] = {
                        "execution_status": "PASS" if passed else "QUALITY_FAIL",
                        "accepted_ready_ms": profile["ready_ms"] if passed else None,
                        "provider_input_tokens": tokens, "provider_output_tokens": 0,
                        "severe_correctness_violation": severe,
                        "measurement_completeness": {"time": "COMPLETE", "tokens": "COMPLETE"},
                    }
                slots.append({
                    **block, "slot_id": slot_id, "fixture_sha256": digest(slot_id),
                    "weight": weight / (count * repeats), "budget_ms": budget, "attempts": attempts,
                })
            if expanded:
                attempts = {}
                for product, profile in state.items():
                    passed = rng.random() < profile["replay_success_probability"]
                    attempts[product] = {
                        "execution_status": "PASS" if passed else "QUALITY_FAIL",
                        "equivalent_replay": True,
                        "physical_footprint_peak_bytes": profile["memory_bytes"] if passed else None,
                        "phase_completeness": {"replay": "COMPLETE", "tail": "COMPLETE"},
                        "measurement_completeness": {"physical_footprint": "COMPLETE"},
                    }
                slot_id = f"{family}:replay"
                resources.append({
                    **block, "slot_id": slot_id, "fixture_sha256": digest(slot_id),
                    "weight": weight / count, "attempts": attempts,
                })
    return {
        "schema_version": analysis.SCHEMA, "products": products, "reference_product": ref,
        "agent_slots": slots, "resource_slots": resources if expanded else None,
        "bootstrap": inner,
    }


def hurdle(endpoint, value, *, truth=False):
    if value in (None, "Infinity"):
        return False
    if endpoint == "success_rate_difference":
        return value > MARGINS[endpoint]
    return value < MARGINS[endpoint] if truth else value <= MARGINS[endpoint]


def proportion(count, total):
    if total == 0:
        return None
    z = 1.959963984540054
    p = count / total
    scale = 1 + z**2 / total
    center = (p + z**2 / (2 * total)) / scale
    radius = z * math.sqrt(p * (1 - p) / total + z**2 / (4 * total**2)) / scale
    return {"count": count, "total": total, "rate": p, "monte_carlo_95_ci": (
        max(0, center - radius), min(1, center + radius)
    )}


def observe(config, workloads, states, products, allocation, truth, rng, precision, repeats, expanded):
    ref = config["reference_product"]
    totals = Counter()
    bounds = {}
    for _ in range(config["outer_replicates"]):
        reg = simulate(workloads, states, products, ref, allocation, repeats, config["bootstrap"], rng, expanded)
        report = bootstrap.estimate(reg)
        all_outcomes = [row for slot in reg["agent_slots"] for row in slot["attempts"].values()]
        observed_success = analysis.weighted(
            [(slot["weight"], {"pass": slot["attempts"][ref]["execution_status"] == "PASS"})
             for slot in reg["agent_slots"]], "pass"
        )
        gated = observed_success >= .95 and not any(row["severe_correctness_violation"] for row in all_outcomes)
        covered, precise = True, True
        for baseline, comparisons in report["comparisons"].items():
            for endpoint, result in comparisons.items():
                cell = bounds.setdefault((baseline, endpoint), {"usable": 0, "covered": 0, "widths": []})
                bound, point, target = result["bound"], result["point"], truth[baseline][endpoint]
                finite = bound is not None
                cell["usable"] += finite
                # An undefined truth has no coverage interpretation.
                covers = finite and target is not None and (
                    target >= bound if result["bound_side"] == "lower" else (
                        target != "Infinity" and target <= bound
                    )
                )
                cell["covered"] += covers
                covered &= covers
                gated &= hurdle(endpoint, bound)
                if finite:
                    width = abs(bound - point)
                    cell["widths"].append(width)
                    precise &= width <= precision.get(endpoint, math.inf)
                elif endpoint in precision:
                    precise = False
        totals["joint_gate"] += gated
        totals["joint_coverage"] += covered
        totals["joint_precision"] += precise
        totals["joint_gate_and_precision"] += gated and precise
    outer = config["outer_replicates"]
    comparison_report = {baseline: {} for baseline in truth}
    for (baseline, endpoint), cell in bounds.items():
        widths = cell["widths"]
        target = truth[baseline][endpoint]
        comparison_report[baseline][endpoint] = {
            "true_value": target,
            "usable": proportion(cell["usable"], outer),
            "coverage_all_replicates": proportion(cell["covered"], outer) if target is not None else None,
            "coverage_given_usable": proportion(cell["covered"], cell["usable"]) if target is not None else None,
            "absolute_bound_point_distance": {
                "median": bootstrap.quantile(widths, .5), "p90": bootstrap.quantile(widths, .9),
            } if widths else None,
        }
    return {
        "endpoints": comparison_report,
        **{name: proportion(totals[name], outer) for name in (
            "joint_gate", "joint_coverage", "joint_precision", "joint_gate_and_precision"
        )},
    }


def calibrate(config):
    if not isinstance(config, dict) or config.get("schema_version") != SCHEMA:
        raise ValueError(f"calibration requires schema_version {SCHEMA}")
    seed = integer(config.get("seed"), "seed", 0)
    integer(config.get("outer_replicates"), "outer_replicates", 1)
    repeats = integer(config.get("attempts_per_family"), "attempts_per_family", 1)
    ref = analysis.label(config.get("reference_product"), "reference_product")
    inner = config.get("bootstrap")
    if not isinstance(inner, dict) or not isinstance(inner.get("comparisons"), list):
        raise ValueError("bootstrap requires registered comparison IDs")
    baselines = [analysis.label(product, "baseline") for product in inner["comparisons"]]
    _, statements = bootstrap.options(inner, [product for product in baselines if product != ref])
    alpha = .05 / statements
    if inner.get("success_profile") != "weighted_hoeffding":
        raise ValueError("joint calibration requires registered weighted_hoeffding success inference")
    products = [ref, *baselines]
    expanded = inner["claim_family"] == "expanded"
    power_target = quantity(config.get("joint_power_target"), "joint_power_target", maximum=1, positive=True)
    precision = config.get("max_bound_point_distance")
    allowed = set(MARGINS) if expanded else {"success_rate_difference", "token_ratio"}
    if not isinstance(precision, dict) or not precision or set(precision) - allowed:
        raise ValueError("max_bound_point_distance must set thresholds for registered endpoints")
    precision = {name: quantity(value, name) for name, value in precision.items()}
    raw_workloads = config.get("workloads")
    if not isinstance(raw_workloads, dict) or not raw_workloads:
        raise ValueError("workloads requires weighted strata")
    workloads = {}
    for key, profile in sorted(raw_workloads.items()):
        analysis.label(key, "workload")
        if not isinstance(profile, dict):
            raise ValueError("workload requires weight and budget_ms")
        workloads[key] = (
            quantity(profile.get("weight"), "workload weight", maximum=1, positive=True),
            quantity(profile.get("budget_ms"), "budget_ms", positive=True),
        )
    weight_sum((weight for weight, _ in workloads.values()), "workload weights")
    allocations = config.get("families_per_workload")
    if not isinstance(allocations, list) or not allocations:
        raise ValueError("families_per_workload requires candidate family counts")
    candidates = sorted(set(
        integer(value, "families_per_workload", inner["minimum_families_per_stratum"])
        for value in allocations
    ))
    scenarios = config.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("scenarios requires registered family mixtures")
    registered = {}
    sizing = []
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            raise ValueError("scenario must be an object")
        name = analysis.label(scenario.get("id"), "scenario id")
        if name in registered:
            raise ValueError(f"duplicate scenario: {name}")
        overrides = scenario.get("states_by_workload", {})
        if not isinstance(overrides, dict) or set(overrides) - set(workloads):
            raise ValueError("states_by_workload must use registered workload IDs")
        states = {
            workload: mixture(overrides.get(workload, scenario.get("states")), products, expanded, budget)
            for workload, (_, budget) in workloads.items()
        }
        metrics, comparison, discordance = truths(workloads, states, products, ref, expanded)
        favorable = (
            metrics[ref]["success"] >= .95
            and not any(metrics[product]["severe"] for product in products)
            and all(hurdle(key, value, truth=True) for row in comparison.values() for key, value in row.items())
        )
        is_sizing = scenario.get("sizing_target", False)
        if type(is_sizing) is not bool or is_sizing and not favorable:
            raise ValueError("sizing_target requires a favorable population scenario")
        if is_sizing:
            sizing.append(name)
        registered[name] = (states, metrics, comparison, discordance, favorable)
    results = {}
    provisionally_adequate = []
    for count in candidates:
        allocation = dict.fromkeys(workloads, count)
        trial = {}
        for name, (states, metrics, comparison, discordance, favorable) in registered.items():
            rng = random.Random(f"{seed}:{name}:{count}")
            summary = observe(config, workloads, states, products, allocation, comparison,
                              rng, precision, repeats, expanded)
            trial[name] = {
                "gate_rate_interpretation": "POWER" if favorable else "GATE_RATE_OUTSIDE_TARGET",
                "population_products": metrics,
                "population_paired_discordance": discordance,
                **summary,
            }
        if sizing and all(
            trial[name]["joint_gate_and_precision"]["monte_carlo_95_ci"][0] >= power_target for name in sizing
        ):
            provisionally_adequate.append(count)
        results[str(count)] = {
            "independent_families": count * len(workloads),
            "agent_attempts_per_product": count * len(workloads) * repeats,
            "scenarios": trial,
        }
    # If all pass, the observed difference is zero and the registered success margin is strict.
    all_pass_boundary = (
        2 * math.fsum(weight**2 for weight, _ in workloads.values())
        * math.log(1 / alpha) / MARGINS["success_rate_difference"]**2
    )
    return {
        "schema_version": SCHEMA, "mode": "SYNTHETIC_PROVISIONAL",
        "confirmatory_claim_eligible": False,
        "configuration": config,
        "one_sided_nominal_coverage": 1 - alpha,
        "joint_nominal_coverage": .95,
        "all_pass_hoeffding_min_families_per_workload": math.floor(all_pass_boundary) + 1,
        "provisional_families_per_workload": min(provisionally_adequate, default=None),
        "allocations": results,
    }


def example():
    def state(probability, ref, figma, paper):
        return {"probability": probability, "products": {
            product: {
                "success_probability": success, "tokens_on_success": tokens,
                "tokens_on_failure": tokens * 2, "ready_ms": 200 if product == "OMC" else 350,
            }
            for product, (success, tokens) in zip(("OMC", "Figma", "Paper"), (ref, figma, paper), strict=True)
        }}

    return {
        "schema_version": SCHEMA, "seed": 6184746, "outer_replicates": 8,
        "attempts_per_family": 2, "reference_product": "OMC", "joint_power_target": .8,
        "max_bound_point_distance": {"success_rate_difference": .05, "token_ratio": .15},
        "families_per_workload": [2],
        "workloads": {f"LD{index:02}": {"weight": 1 / 6, "budget_ms": 1_000} for index in range(1, 7)},
        "bootstrap": {
            "interval_method": "percentile", "seed": 2026, "draws": 10_000,
            "minimum_families_per_stratum": 2, "claim_family": "token_only",
            "success_profile": "weighted_hoeffding", "comparisons": ["Figma", "Paper"],
        },
        "scenarios": [
            {"id": "all_pass", "sizing_target": True, "states": [state(1, (1, 40), (1, 100), (1, 80))]},
            {"id": "sparse", "sizing_target": True, "states": [
                state(.98, (.995, 40), (.999, 100), (.995, 80)),
                state(.02, (.5, 100), (.7, 150), (.8, 130)),
            ]},
            {"id": "asymmetric", "states": [
                state(.88, (.999, 40), (.999, 100), (.998, 80)),
                state(.12, (.15, 80), (.85, 115), (.7, 130)),
            ]},
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("configuration", nargs="?", type=Path)
    group.add_argument("--example", action="store_true", help="run the synthetic six-workload pilot profile")
    args = parser.parse_args()
    try:
        config = example() if args.example else json.loads(args.configuration.read_text(encoding="utf-8"))
        report = calibrate(config)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
