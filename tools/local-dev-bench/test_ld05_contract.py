import unittest

from ld05_contract import FAMILIES, fixture, grade


class RoundTripTests(unittest.TestCase):
    def evidence(self, contract):
        source = "1" * 64
        cycles = []
        for i, wanted in enumerate(contract["cycles"], start=1):
            result = str(2 * i + 1) * 64
            cycles.append({
                "source_parent_sha256": source,
                "source_patch_sha256": str(2 * i) * 64,
                "result_checkout_sha256": result,
                "refreshed_canvas": dict(wanted["source_state"]),
                "source_result": dict(wanted["result"]),
                "reopened_canvas": dict(wanted["result"]),
                "checked_widths": contract["widths"],
                "canvas_editable": True,
                "clean_build": True,
                "behavior_tests_passed": True,
                "component_reused": True,
                "no_missing_assets": True,
            })
            source = result
        return {"fixture_sha256": contract["fixture_sha256"], "starting_source_sha256": "1" * 64, "cycles": cycles}

    def test_two_families_require_fresh_canvas_in_every_cycle(self):
        for family in FAMILIES:
            contract = fixture(family)
            evidence = self.evidence(contract)
            self.assertEqual(grade(contract, evidence), [])
            evidence["cycles"][2]["refreshed_canvas"] = evidence["cycles"][1]["refreshed_canvas"]
            self.assertIn("cycle 3: refreshed canvas did not reflect the new source state", grade(contract, evidence))

    def test_acceptance_rejects_missing_source_behavior_and_reset_checkout(self):
        contract = fixture("route-board")
        evidence = self.evidence(contract)
        final = evidence["cycles"][2]
        final["behavior_tests_passed"] = False
        final["source_parent_sha256"] = evidence["starting_source_sha256"]
        self.assertEqual(grade(contract, evidence), [
            "cycle 3: source/result lineage missing",
            "cycle 3: behavior_tests_passed not established",
        ])
