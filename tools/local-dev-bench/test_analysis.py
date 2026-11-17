import copy
import hashlib
import json
import unittest

from analysis import SCHEMA, analyze


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def attempt(status="PASS", *, ready=100, tokens=50, complete=True, wall=100):
    passed = status == "PASS"
    return {
        "execution_status": status,
        "accepted_ready_ms": ready if passed else None,
        "observed_wall_ms": wall,
        "provider_input_tokens": tokens,
        "provider_output_tokens": 0,
        "measurement_completeness": {"time": "COMPLETE", "tokens": "COMPLETE" if complete else "INCOMPLETE"},
    }


def slot(sid, weight, attempts, *, family=None, workload="LD02", budget=400):
    family = family or f"family-{sid}"
    return {
        "slot_id": sid,
        "source_family_id": family,
        "source_sha256": sha(family),
        "fixture_sha256": sha(sid),
        "workload_id": workload,
        "weight": weight,
        "budget_ms": budget,
        "attempts": attempts,
    }


def registration(*slots, products=None, resources=None):
    return {
        "schema_version": SCHEMA,
        "reference_product": "OMC",
        "products": products or ["OMC", "Paper"],
        "agent_slots": list(slots),
        "resource_slots": resources,
    }


class DescriptiveAnalysisTest(unittest.TestCase):
    def test_registered_weights_include_failures_and_cap_early_stops(self):
        first = slot("a", .75, {"OMC": attempt(ready=300, tokens=30), "Paper": attempt(ready=600, tokens=40)},
                     budget=1000)
        second = slot("b", .25, {
            "OMC": attempt("QUALITY_FAIL", tokens=10, wall=20),
            "Paper": attempt(ready=100, tokens=100),
        }, workload="LD01")
        agent = analyze(registration(first, second))["agent"]
        omc = agent["products"]["OMC"]
        paper = agent["products"]["Paper"]
        comparison = agent["comparisons"]["Paper"]
        self.assertEqual(agent["independent_source_families"], 2)
        self.assertEqual(omc["success_rate"], .75)
        self.assertEqual(omc["mean_tokens_all_attempts"], 25)
        self.assertEqual(omc["tokens_per_accepted_result"], 25 / .75)
        self.assertEqual(omc["mean_capped_time_ms"], 325)
        self.assertEqual(omc["raw_observed_valid"]["observed_tokens"], {"sum": 40, "observed_slots": 2})
        self.assertEqual(omc["raw_observed_valid"]["wall"], {"sum": 120, "observed_slots": 2})
        self.assertEqual(omc["accepted_ready_times_ms"], [300])
        self.assertEqual(paper["tokens_per_accepted_result"], 55)
        self.assertEqual(paper["mean_capped_time_ms"], 475)
        self.assertEqual(comparison["success_rate_difference"], -.25)
        self.assertEqual(comparison["capped_time_ratio"], 325 / 475)
        self.assertEqual(comparison["token_ratio"], (25 / .75) / 55)
        self.assertEqual(comparison["paired_outcomes"]["baseline_only"], 1)
        self.assertEqual(comparison["both_successful_only"]["Paper"]["mean_tokens"], 40)
        self.assertEqual(agent["by_workload"]["LD01"]["OMC"]["mean_capped_time_ms"], 400)

    def test_incomplete_usage_does_not_erase_accepted_time(self):
        omc = attempt(tokens=17, complete=False)
        omc["phase_completeness"] = {"task": "COMPLETE"}
        agent = analyze(registration(slot("a", 1, {"OMC": omc, "Paper": attempt()})))["agent"]
        result = agent["products"]["OMC"]
        self.assertEqual(result["success_rate"], 1)
        self.assertEqual(result["mean_capped_time_ms"], 100)
        self.assertIsNone(result["tokens_per_accepted_result"])
        self.assertEqual(result["raw_observed_valid"]["input_tokens"]["sum"], 17)
        self.assertEqual(agent["products"]["Paper"]["phase_completeness"], {"task": {"MISSING": 1}})
        self.assertIsNone(agent["comparisons"]["Paper"]["token_ratio"])

    def test_missing_or_unsupported_slots_block_means_without_reweighting(self):
        first = slot("a", .6, {"OMC": attempt(), "Paper": attempt(), "Penpot": attempt("UNSUPPORTED")})
        second = slot("b", .4, {"OMC": attempt(), "Paper": attempt()})
        result = analyze(registration(first, second, products=["OMC", "Paper", "Penpot"]))["agent"]
        penpot = result["products"]["Penpot"]
        self.assertEqual(penpot["outcomes"], {"UNSUPPORTED": 1, "MISSING": 1})
        self.assertIsNone(penpot["success_rate"])
        self.assertIsNone(penpot["mean_capped_time_ms"])
        self.assertEqual(result["comparisons"]["Paper"]["token_ratio"], 1)
        self.assertEqual(result["comparisons"]["Penpot"]["paired_outcomes"]["unclassified"], 2)

    def test_zero_success_infinite_with_undefined_baseline_ratio(self):
        failed = attempt("TIMEOUT_BUDGET", tokens=3)
        failed["measurement_completeness"]["time"] = "INCOMPLETE"
        report = analyze(registration(slot("a", 1, {"OMC": attempt(), "Paper": failed})))
        self.assertEqual(report["agent"]["products"]["Paper"]["tokens_per_accepted_result"], "Infinity")
        self.assertEqual(report["agent"]["products"]["Paper"]["mean_capped_time_ms"], 400)
        self.assertIsNone(report["agent"]["comparisons"]["Paper"]["token_ratio"])
        json.dumps(report, allow_nan=False)

    def test_service_outage_after_valid_start_is_failure(self):
        outage = attempt("SERVICE_UNAVAILABLE")
        outage["started"] = True
        first = slot("a", .5, {"OMC": outage, "Paper": attempt()})
        second = slot("b", .5, {"OMC": attempt(), "Paper": attempt()})
        complete = analyze(registration(first, second))["agent"]["products"]["OMC"]
        self.assertEqual(complete["success_rate"], .5)
        self.assertEqual(complete["mean_capped_time_ms"], 250)
        outage["started"] = False
        blocked = analyze(registration(first, second))["agent"]["products"]["OMC"]
        self.assertIsNone(blocked["success_rate"])
        self.assertEqual(blocked["raw_observed_nonvalid"]["input_tokens"]["sum"], 50)

    def test_zero_weight_only_changes_raw_coverage(self):
        first = slot("a", 1, {"OMC": attempt(), "Paper": attempt()})
        second = slot("b", 0, {})
        result = analyze(registration(first, second))["agent"]["products"]["OMC"]
        self.assertEqual(result["outcomes"], {"PASS": 1, "MISSING": 1})
        self.assertEqual(result["mean_tokens_all_attempts"], 50)

    def test_ram_endpoint_requires_equivalent_work_pass_and_complete_tail(self):
        def replay(peak):
            return {
                "execution_status": "PASS",
                "equivalent_replay": True,
                "phase_completeness": {"replay": "COMPLETE", "tail": "COMPLETE"},
                "measurement_completeness": {"physical_footprint": "COMPLETE"},
                "physical_footprint_peak_bytes": peak,
            }

        agent = slot("a", 1, {"OMC": attempt(), "Paper": attempt()})
        base_a, base_b = replay(20), replay(100)
        res = [
            slot("r1", .25, {"OMC": replay(20), "Paper": base_a}),
            slot("r2", .75, {"OMC": replay(40), "Paper": base_b}),
        ]
        supplied = registration(agent, resources=res)
        result = analyze(supplied)["resource"]
        self.assertEqual(result["products"]["Paper"]["mean_peak_physical_footprint_bytes"], 80)
        self.assertEqual(result["products"]["OMC"]["mean_peak_physical_footprint_bytes"], 35)
        self.assertEqual(result["comparisons"]["Paper"]["memory_ratio"], 35 / 80)
        self.assertEqual(result["by_source_family"]["family-r2"]["Paper"]["observed_max_footprint_peak_bytes"], 100)

        for edit in (
            {"execution_status": "EXECUTION_FAIL"},
            {"phase_completeness": {"replay": "COMPLETE"}},
            {"equivalent_replay": False},
            {"severe_correctness_violation": True},
            {"measurement_completeness": {"physical_footprint": "INCOMPLETE"}},
        ):
            with self.subTest(edit=edit):
                damaged = copy.deepcopy(supplied)
                damaged["resource_slots"][1]["attempts"]["Paper"].update(edit)
                result = analyze(damaged)["resource"]
                self.assertIsNone(result["products"]["Paper"]["mean_peak_physical_footprint_bytes"])
                self.assertEqual(result["products"]["Paper"]["observed_max_footprint_peak_bytes"], 100)
                self.assertIsNone(result["comparisons"]["Paper"]["memory_ratio"])

    def test_repeated_fixture_variants_are_one_source_family(self):
        first = slot("a", .5, {}, family="orders")
        second = slot("b", .5, {}, family="orders")
        self.assertEqual(analyze(registration(first, second))["agent"]["independent_source_families"], 1)
        second["source_family_id"] = "alias"
        with self.assertRaisesRegex(ValueError, "one-to-one"):
            analyze(registration(first, second))

    def test_rejects_bad_weights_duplicate_runs_and_inconsistent_results(self):
        first = slot("a", .5, {"OMC": attempt()})
        with self.assertRaisesRegex(ValueError, "weights"):
            analyze(registration(first))
        second = slot("b", .5, {"OMC": attempt()})
        first["attempts"]["OMC"]["run_id"] = second["attempts"]["OMC"]["run_id"] = "reused"
        with self.assertRaisesRegex(ValueError, "reused run_id"):
            analyze(registration(first, second))
        first["attempts"]["OMC"]["accepted_ready_ms"] = 401
        with self.assertRaisesRegex(ValueError, "deadline"):
            analyze(registration(first, second))


if __name__ == "__main__":
    unittest.main()
