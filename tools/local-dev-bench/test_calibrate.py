import json
import math
import unittest

from calibrate import calibrate, covers_truth, example, mixture, proportion, truths


class CalibrationTest(unittest.TestCase):
    def test_coverage_keeps_numeric_equality_without_hiding_material_misses(self):
        bound = 240 / 670
        self.assertTrue(covers_truth(bound, math.nextafter(bound, 1), "upper"))
        self.assertTrue(covers_truth(bound, math.nextafter(bound, 0), "lower"))
        self.assertFalse(covers_truth(bound, bound + 1e-12, "upper"))
        self.assertFalse(covers_truth(bound, bound - 1e-12, "lower"))
        self.assertFalse(covers_truth(None, bound, "upper"))
        self.assertFalse(covers_truth(bound, "Infinity", "upper"))

    def config(self):
        value = example()
        value["workloads"] = {"LD02": {"weight": 1, "budget_ms": 1000}}
        value["outer_replicates"] = 2
        return value

    def test_exact_finite_mixture_truth_includes_failure_spend(self):
        value = self.config()
        raw = value["scenarios"][2]["states"]
        products = ["OMC", "Figma", "Paper"]
        states = mixture(raw, products, False, 1000)
        metrics, comparison, discordance = truths(
            {"LD02": (1, 1000)}, {"LD02": states}, products, "OMC", False
        )
        ref_p = .88 * .999 + .12 * .15
        self.assertAlmostEqual(metrics["OMC"]["success"], ref_p)
        expected_tokens = .88 * (.999 * 40 + .001 * 80) + .12 * (.15 * 80 + .85 * 160)
        self.assertAlmostEqual(metrics["OMC"]["tokens"], expected_tokens)
        self.assertAlmostEqual(metrics["OMC"]["time"], ref_p * 200 + (1 - ref_p) * 1000)
        self.assertAlmostEqual(
            discordance["Figma"]["reference_only"] - discordance["Figma"]["baseline_only"],
            comparison["Figma"]["success_rate_difference"],
        )

    def test_runs_all_pass_sparse_and_asymmetric_with_known_truth(self):
        value = self.config()
        result = calibrate(value)
        self.assertEqual(result, calibrate(value))
        self.assertFalse(result["confirmatory_claim_eligible"])
        self.assertEqual(result["all_pass_hoeffding_min_families_per_workload"], 3506)
        self.assertIsNone(result["provisional_families_per_workload"])
        allocation = result["allocations"]["2"]
        self.assertEqual(allocation["independent_families"], 2)
        self.assertEqual(allocation["agent_attempts_per_product"], 4)
        scenarios = allocation["scenarios"]
        all_pass = scenarios["all_pass"]
        self.assertEqual(all_pass["gate_rate_interpretation"], "POWER")
        self.assertEqual(all_pass["joint_coverage"]["rate"], 1)
        self.assertEqual(all_pass["joint_gate"]["rate"], 0)
        success = all_pass["endpoints"]["Paper"]["success_rate_difference"]
        self.assertEqual(success["absolute_bound_point_distance"]["median"], 1)
        self.assertGreater(scenarios["sparse"]["population_paired_discordance"]["Paper"]["baseline_only"], 0)
        self.assertEqual(scenarios["asymmetric"]["gate_rate_interpretation"], "GATE_RATE_OUTSIDE_TARGET")
        json.dumps(result, allow_nan=False)

    def test_expanded_replay_failure_stays_in_joint_denominator(self):
        value = self.config()
        value["bootstrap"]["claim_family"] = "expanded"
        value["scenarios"] = [value["scenarios"][0]]
        for product, profile in value["scenarios"][0]["states"][0]["products"].items():
            profile["memory_bytes"] = 100 if product == "OMC" else 200
            profile["replay_success_probability"] = 0 if product == "OMC" else 1
        result = calibrate(value)
        row = result["allocations"]["2"]["scenarios"]["all_pass"]
        self.assertEqual(row["joint_gate"]["rate"], 0)
        self.assertEqual(row["joint_coverage"]["rate"], 0)
        memory = row["endpoints"]["Figma"]["memory_ratio"]
        self.assertEqual(memory["true_value"], .5)
        self.assertEqual(memory["usable"]["rate"], 0)
        self.assertIsNone(memory["coverage_given_usable"])

    def test_rejects_postulated_truth_outside_sizing_target(self):
        value = self.config()
        value["scenarios"][2]["sizing_target"] = True
        with self.assertRaisesRegex(ValueError, "favorable population"):
            calibrate(value)

    def test_reports_monte_carlo_uncertainty_at_all_pass(self):
        low, high = proportion(8, 8)["monte_carlo_95_ci"]
        self.assertLess(low, .8)
        self.assertEqual(high, 1)
        self.assertIsNone(proportion(0, 0))


if __name__ == "__main__":
    unittest.main()
