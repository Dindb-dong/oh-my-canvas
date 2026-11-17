import copy
import unittest

import ld07
from ld01 import png_asset
import synthetic
from test_synthetic import snapshot


def observation(spec, screenshot):
    repairs = copy.deepcopy(spec["repair_actions"])
    return {
        "before": snapshot(spec["start"], "work"),
        "candidate": snapshot(spec["expected"], "work"),
        "reopened": snapshot(spec["expected"], "work"),
        "diagnoses": [{key: value for key, value in row.items() if key != "to"} for row in repairs],
        "repair_actions": repairs,
        "symptom_capture": {**ld07.screenshot_metadata(screenshot), "document_id": "work", "phase": "before"},
    }


class DefectWorkloadTests(unittest.TestCase):
    def setUp(self):
        pixels = b"\x00\x00\x00\xff" * 2
        self.screenshot = png_asset("symptom.png", 2, 2, [pixels, pixels])[1]

    def test_private_fixtures_inject_and_reverse_two_real_defects(self):
        for variant in ld07.VARIANTS:
            with self.subTest(variant=variant):
                spec = synthetic.fixture("LD07", variant)
                self.assertEqual(ld07.apply_operations(spec["expected"], spec["injections"]), spec["start"])
                with self.assertRaises(ValueError):
                    ld07.apply_operations(spec["start"], spec["injections"])
                self.assertEqual(ld07.apply_operations(spec["start"], spec["repair_actions"]), spec["expected"])
                start = {row["key"]: row for row in spec["start"]["nodes"]}
                fixed = {row["key"]: row for row in spec["expected"]["nodes"]}
                self.assertNotEqual(start["board/flow/4"]["bounds"], fixed["board/flow/4"]["bounds"])
                self.assertNotEqual(start["board/service"]["fill"], fixed["board/service"]["fill"])
                self.assertEqual(start["board/notice"], fixed["board/notice"])
                evidence = observation(spec, self.screenshot)
                self.assertEqual(synthetic.grade(spec, evidence, symptom_screenshot=self.screenshot), [])

    def test_brief_does_not_disclose_fixture_or_repairs(self):
        brief = synthetic.public_brief(synthetic.fixture("LD07"))
        self.assertEqual(set(brief), {
            "schema", "workload", "source_family_id", "fixture_sha256", "brief", "symptom_screenshot_name",
        })

    def test_rejects_replacement_extra_edit_false_diagnosis_and_changed_screenshot(self):
        spec = synthetic.fixture("LD07", "clinic-check-in")
        evidence = observation(spec, self.screenshot)
        evidence["candidate"]["nodes"][0]["native_id"] = "recreated"
        evidence["reopened"]["nodes"][0]["native_id"] = "recreated"
        evidence["diagnoses"][1]["key"] = "notice/accent"
        evidence["repair_actions"].append(evidence["repair_actions"][0].copy())
        failures = synthetic.grade(spec, evidence, symptom_screenshot=self.screenshot[:-1])
        self.assertEqual(len(failures), 4)
        self.assertTrue(failures[0].startswith("candidate"))
        self.assertTrue(failures[1].startswith("symptom_capture"))
        self.assertTrue(failures[2].startswith("diagnoses"))
        self.assertTrue(failures[3].startswith("repair_actions"))

    def test_rejects_edit_to_the_nearby_notice_even_with_correct_repair_trace(self):
        spec = synthetic.fixture("LD07")
        evidence = observation(spec, self.screenshot)
        notice = next(node for node in evidence["reopened"]["nodes"] if node["key"] == "board/notice/label")
        notice["text"] = "Temporarily unavailable"
        self.assertEqual(synthetic.grade(spec, evidence, symptom_screenshot=self.screenshot), [
            "reopened: board/notice/label.text differs",
        ])
