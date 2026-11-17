from collections import Counter
import json
import math
import unittest

import analysis
from bootstrap import estimate, prepare, resample
from test_analysis import attempt, registration, slot


def row(sid, weight, omc, paper, *, stratum="create", family=None):
    result = slot(sid, weight, {"OMC": omc, "Paper": paper}, family=family)
    result["stratum_id"] = stratum
    return result


def registered(*rows, resources=None, expanded=False):
    result = registration(*rows, resources=resources)
    result["bootstrap"] = {
        "interval_method": "percentile", "seed": 206, "draws": 10_000,
        "claim_family": "expanded" if expanded else "token_only",
        "comparisons": ["Paper"], "minimum_families_per_stratum": 2,
    }
    return result


def replay(peak):
    return {
        "execution_status": "PASS", "equivalent_replay": True,
        "measurement_completeness": {"physical_footprint": "COMPLETE"},
        "phase_completeness": {"replay": "COMPLETE", "tail": "COMPLETE"},
        "physical_footprint_peak_bytes": peak,
    }


class BootstrapTest(unittest.TestCase):
    def test_whole_family_and_fixed_stratum_masses(self):
        rows = [
            row("a", .10, attempt(tokens=10), attempt(tokens=20), family="paired-variant"),
            row("b", .20, attempt(tokens=40), attempt(tokens=80), family="paired-variant"),
            row("c", .20, attempt(tokens=500), attempt(tokens=1000)),
            row("d", .15, attempt(tokens=100), attempt(tokens=200), stratum="edit"),
            row("e", .35, attempt(tokens=60), attempt(tokens=120), stratum="edit"),
        ]
        panel = prepare(rows, ["OMC", "Paper"], "agent", 2, {"id": {}, "hash": {}}, set())
        selected = {
            key: Counter({"paired-variant" if key[0] == "create" else "family-d": 2})
            for key in panel
        }
        values = resample(panel, selected)
        self.assertAlmostEqual(values[1], .5 * ((.10 * 10 + .20 * 40) / .30) + .5 * 100)
        self.assertEqual(values[4], 2 * values[1])

    def test_registered_point_and_shared_draws_with_hoeffding(self):
        result = registered(
            row("a", .2, attempt(tokens=5), attempt(tokens=10)),
            row("b", .8, attempt(tokens=500), attempt(tokens=1000)),
        )
        output = estimate(result)
        self.assertEqual(output, estimate(result))
        self.assertFalse(output["confirmatory_claim_eligible"])
        self.assertEqual(output["one_sided_alpha"], .025)
        comparison = output["comparisons"]["Paper"]
        self.assertEqual(comparison["token_ratio"]["point"], .5)
        self.assertEqual(comparison["token_ratio"]["bound"], .5)
        self.assertEqual(comparison["token_ratio"]["finite_draws"], 10_000)
        success = comparison["success_rate_difference"]
        self.assertTrue(success["empirically_constant"])
        self.assertIsNone(success["bound"])
        result["bootstrap"]["success_profile"] = "weighted_hoeffding"
        comparison = estimate(result)["comparisons"]["Paper"]
        radius = math.sqrt(2 * (.2**2 + .8**2) * math.log(1 / .025))
        self.assertEqual(comparison["success_rate_difference"]["bound"], max(-1, -radius))

    def test_sparse_zero_denominator_draws_are_retained(self):
        result = registered(
            row("a", .6, attempt("QUALITY_FAIL"), attempt()),
            row("b", .4, attempt(), attempt("QUALITY_FAIL")),
        )
        tokens = estimate(result)["comparisons"]["Paper"]["token_ratio"]
        self.assertTrue(tokens["invalid_draws"]["zero_baseline_accepted"])
        self.assertTrue(tokens["invalid_draws"]["zero_reference_accepted"])
        ids = [v for group in tokens["invalid_draws"].values() for v in group]
        self.assertEqual(len(set(ids)) + tokens["finite_draws"], 10_000)
        self.assertAlmostEqual(tokens["point"], 1.5)
        self.assertIsNone(tokens["bound"])
        self.assertEqual(tokens["bound_status"], "INCOMPLETE_OR_SPARSE")
        json.dumps(tokens, allow_nan=False)

    def test_missing_inputs_cannot_be_resampled_away(self):
        result = registered(
            row("a", .5, attempt(), attempt()),
            row("b", .5, attempt(complete=False), attempt()),
        )
        tokens = estimate(result)["comparisons"]["Paper"]["token_ratio"]
        self.assertIsNone(tokens["point"])
        self.assertIsNone(tokens["bound"])
        self.assertGreater(tokens["finite_draws"], 0)

    def test_expanded_memory_blocks_on_incomplete_replay(self):
        result = registered(
            row("a", .5, attempt(ready=50), attempt(ready=100)),
            row("b", .5, attempt(ready=100), attempt(ready=200)),
            expanded=True, resources=[
                row("a", .5, replay(30), replay(60)),
                row("b", .5, replay(100), replay(200)),
            ],
        )
        output = estimate(result)
        self.assertEqual(output["one_sided_alpha"], .0125)
        comparison = output["comparisons"]["Paper"]
        self.assertEqual(comparison["capped_time_ratio"]["bound"], .5)
        self.assertEqual(comparison["memory_ratio"]["bound"], .5)
        result["resource_slots"][0]["attempts"]["OMC"]["phase_completeness"]["tail"] = "INCOMPLETE"
        memory = estimate(result)["comparisons"]["Paper"]["memory_ratio"]
        self.assertIsNone(memory["bound"])
        self.assertTrue(memory["invalid_draws"]["memory_incomplete"])

    def test_refuses_underregistered_or_split_sources(self):
        result = registered(
            row("a", .5, attempt(), attempt(), family="same"),
            row("b", .5, attempt(), attempt(), family="same"),
        )
        with self.assertRaisesRegex(ValueError, "requires 2"):
            estimate(result)
        result["agent_slots"][1]["stratum_id"] = "edit"
        with self.assertRaisesRegex(ValueError, "spans strata"):
            estimate(result)
        result["bootstrap"]["draws"] = 9999
        with self.assertRaisesRegex(ValueError, ">= 10000"):
            estimate(result)
        result["bootstrap"]["draws"] = 10_000
        result["bootstrap"]["comparisons"] = ["OMC"]
        with self.assertRaisesRegex(ValueError, "registered baselines"):
            estimate(result)

    def test_comparison_register_counts_and_synchronizes_each_baseline(self):
        result = registered(
            row("a", .4, attempt(tokens=5), attempt(tokens=10)),
            row("b", .6, attempt(tokens=500), attempt(tokens=1000)),
        )
        result["products"].extend(["Figma", "Penpot"])
        result["bootstrap"]["comparisons"].append("Figma")
        for item in result["agent_slots"]:
            item["attempts"]["Figma"] = attempt(tokens=4 * item["attempts"]["OMC"]["provider_input_tokens"])
        output = estimate(result)
        self.assertEqual(output["registered_statements"], 4)
        self.assertEqual(output["one_sided_alpha"], .0125)
        self.assertEqual(output["comparisons"]["Paper"]["token_ratio"]["bound"], .5)
        self.assertEqual(output["comparisons"]["Figma"]["token_ratio"]["bound"], .25)
        self.assertNotIn("Penpot", output["comparisons"])

    def test_points_match_descriptive_analysis(self):
        result = registered(
            row("a", .25, attempt("TIMEOUT_BUDGET", tokens=5), attempt(tokens=90)),
            row("b", .75, attempt(tokens=60), attempt("QUALITY_FAIL", tokens=10)),
        )
        point = analysis.analyze(result)["agent"]["comparisons"]["Paper"]["token_ratio"]
        self.assertEqual(estimate(result)["comparisons"]["Paper"]["token_ratio"]["point"], point)


if __name__ == "__main__":
    unittest.main()
