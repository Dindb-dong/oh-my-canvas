import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import synthetic


def observations(spec):
    def snapshot(phase, document):
        data = copy.deepcopy(spec[phase])
        styles = {style["key"]: f"{document}/style/{style['key']}" for style in data["styles"]}
        for style in data["styles"]:
            style["native_id"] = styles[style["key"]]
        for node in data["nodes"]:
            node.update(native_id=f"{document}/node/{node['key']}", editable=True)
            if "bindings" in node:
                node["bindings"] = {prop: styles[key] for prop, key in node["bindings"].items()}
        return {"document_id": document, **data}

    return {
        "before": snapshot("start", "work"),
        "candidate": snapshot("expected", "work"),
        "reopened": snapshot("expected", "work"),
        "probe": snapshot("probe", "copy"),
        "after_probe_original": snapshot("expected", "work"),
        "probe_actions": copy.deepcopy(spec["probe_actions"]),
    }


class SyntheticWorkloadTests(unittest.TestCase):
    def test_expected_observations_pass_for_all_variants(self):
        for workload, module in synthetic.WORKLOADS.items():
            for variant in module.VARIANTS:
                with self.subTest(workload=workload, variant=variant):
                    spec = synthetic.fixture(workload, variant)
                    self.assertEqual(synthetic.grade(spec, observations(spec)), [])
                    self.assertEqual(len(spec["expected"]["nodes"]), spec["logical_objects"])
                    if workload == "LD01":
                        self.assertTrue(80 <= spec["logical_objects"] <= 150)
                    else:
                        self.assertEqual(spec["target_references"], 40)
                        self.assertEqual(spec["local_overrides"], 4)

    def test_dashboard_rejects_flattening_wrong_asset_and_layout_drift(self):
        spec = synthetic.fixture("LD01")
        evidence = observations(spec)
        candidate = {node["key"]: node for node in evidence["candidate"]["nodes"]}
        candidate["header/title"]["editable"] = False
        candidate["detail/map"]["asset_rgba_sha256"] = "wrong"
        candidate["nav"]["bounds"][0] += 3
        self.assertEqual(synthetic.grade(spec, evidence), [
            "candidate: nav.bounds differs",
            "candidate: header/title is not independently editable",
            "candidate: detail/map.asset_rgba_sha256 differs",
        ])

    def test_dashboard_accepts_subpixel_layout_difference(self):
        spec = synthetic.fixture("LD01")
        evidence = observations(spec)
        evidence["reopened"]["nodes"][0]["bounds"][0] += 1.25
        self.assertEqual(synthetic.grade(spec, evidence), [])

    def test_style_copy_with_same_appearance_fails_native_binding(self):
        spec = synthetic.fixture("LD03")
        evidence = observations(spec)
        for node in evidence["candidate"]["nodes"]:
            if node.get("bindings", {}).get("fill") == "work/style/target.accent":
                node["bindings"]["fill"] = "work/style/keep.accent"
                break
        self.assertTrue(any("bindings differs" in failure for failure in synthetic.grade(spec, evidence)))

    def test_probe_copy_identity_and_actions_must_match(self):
        spec = synthetic.fixture("LD03")
        evidence = observations(spec)
        evidence["probe"]["document_id"] = "work"
        evidence["probe_actions"].append({"op": "set_node", "key": "board", "value": "unregistered"})
        self.assertEqual(synthetic.grade(spec, evidence), [
            "probe_actions: observed operations do not match the registered probe",
            "probe: verification edits were not performed on a distinct copy",
        ])

    def test_lookalike_and_local_style_values_must_be_unchanged_after_probe(self):
        spec = synthetic.fixture("LD03")
        evidence = observations(spec)
        for node in evidence["probe"]["nodes"]:
            if node.get("bindings", {}).get("gap") == "copy/style/keep.spacing":
                node["gap"] = 500
                break
        self.assertTrue(any("probe: keep/" in failure for failure in synthetic.grade(spec, evidence)))

    def test_cli_emits_deterministic_asset_bytes(self):
        cli = Path(__file__).with_name("synthetic.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "assets"
            spec = json.loads(subprocess.check_output([
                sys.executable, str(cli), "fixture", "LD01", "--variant", "reading-room",
                "--assets-dir", str(output),
            ]))
            self.assertEqual({asset["name"] for asset in spec["assets"]}, {"badge.png", "detail-map.png"})
            for asset in spec["assets"]:
                data = (output / asset["name"]).read_bytes()
                self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
                self.assertEqual(hashlib.sha256(data).hexdigest(), asset["sha256"])

    def test_cli_reports_rejected_evidence(self):
        cli = Path(__file__).with_name("synthetic.py")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invalid.json"
            path.write_text("{}")
            result = subprocess.run([
                sys.executable, str(cli), "grade", "LD03", str(path)
            ], capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["passed"])


if __name__ == "__main__":
    unittest.main()
