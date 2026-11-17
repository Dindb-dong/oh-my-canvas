import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from font_asset import read_font
import ld04
import ld06
import synthetic
from test_synthetic import observations, snapshot


REGISTRATION = {"width": 711, "nonce": "Synthetic example random nonce"}
FONT_SHA = "a" * 64


def responsive(variant):
    spec = synthetic.fixture("LD04", variant, private_registration=REGISTRATION)
    evidence = observations(spec)
    evidence["withheld_width_commitment"] = spec["withheld_width_commitment"]
    evidence["width_observations"] = [
        {"width": item["width"], **snapshot(item, "copy")} for item in spec["responsive_steps"]
    ]
    return spec, evidence


def asset_case(variant, *, register_font=True):
    font = {"family": "Fixture Korean", "sha256": FONT_SHA} if register_font else None
    spec = synthetic.fixture("LD06", variant, font=font)
    evidence = {
        "before": snapshot(spec["start"], "work"),
        "loaded": snapshot(spec["loaded"], "work"),
        "candidate": snapshot(spec["expected"], "work"),
        "reopened": snapshot(spec["expected"], "work"),
    }
    glyphs = {"font_sha256": FONT_SHA, "rendered": spec["required_glyphs"]}
    for name in ("loaded", "candidate", "reopened"):
        evidence[name]["glyph_render"] = glyphs
    commit, tree = "b" * 40, "c" * 64
    evidence["handoff"] = {
        "commit": commit,
        "source_tree_sha256": tree,
        "builds": [{
            "checkout_id": f"clean-{i}",
            "commit": commit,
            "source_tree_sha256": tree,
            "clean_checkout": True,
            "exit_code": 0,
            "external_requests": [],
            "glyph_render": copy.deepcopy(glyphs),
            "rendered": {key: {**copy.deepcopy(row), "provenance": "bundled"}
                         for key, row in spec["handoff_values"].items()},
        } for i in range(2)],
    }
    return spec, evidence


def demo_sfnt(glyphs):
    """Encode metadata tables for parser tests, without real glyph outlines."""
    groups = b"".join(struct.pack(">III", ord(char), ord(char), idx)
                      for idx, char in enumerate(sorted(glyphs), 1))
    cmap = (struct.pack(">HHHHI", 0, 1, 3, 10, 12)
            + struct.pack(">HHIII", 12, 0, 16 + len(groups), 0, len(glyphs)) + groups)
    family = "Test Fixture".encode("utf-16-be")
    name = struct.pack(">9H", 0, 1, 18, 3, 1, 0x409, 16, len(family), 0) + family
    tables = {b"cmap": cmap, b"name": name, b"maxp": struct.pack(">IH", 0x5000, len(glyphs) + 1)}
    output = bytearray(struct.pack(">I4H", 0x10000, len(tables), 0, 0, 0))
    data = bytearray()
    start = 12 + 16 * len(tables)
    for tag, table in tables.items():
        output += struct.pack(">4sIII", tag, 0, start + len(data), len(table))
        data += table
    return bytes(output + data)


class ResponsiveAndAssetTests(unittest.TestCase):
    def test_responsive_candidate_and_same_artboard_pass_at_all_widths(self):
        for variant in ld04.VARIANTS:
            spec, evidence = responsive(variant)
            self.assertEqual(synthetic.grade(spec, evidence), [])
            self.assertEqual([step["width"] for step in spec["responsive_steps"]], [768, 390, 711, 1440])

    def test_responsive_static_artboards_and_wrong_hidden_width_fail(self):
        spec, evidence = responsive("street-market")
        evidence["width_observations"][1]["nodes"][2]["native_id"] = "replacement"
        evidence["width_observations"][2]["width"] = 666
        failures = synthetic.grade(spec, evidence)
        self.assertTrue(any("identities changed" in failure for failure in failures))
        self.assertTrue(any("observed width" in failure for failure in failures))

    def test_responsive_public_brief_hides_withheld_width(self):
        spec, _ = responsive("lab-queue")
        brief = synthetic.public_brief(spec)
        self.assertEqual(brief["public_widths"], [1440, 768, 390])
        self.assertNotIn("responsive_steps", brief)
        self.assertNotIn("probe_actions", brief)
        self.assertEqual(spec["withheld_width_commitment"], brief["withheld_width_commitment"])
        shifted = synthetic.fixture("LD04", "lab-queue", private_registration={**REGISTRATION, "width": 712})
        self.assertNotEqual(brief["withheld_width_commitment"], shifted["withheld_width_commitment"])

    def test_unregistered_demo_width_cannot_pass(self):
        spec = synthetic.fixture("LD04", "street-market")
        self.assertIn("probe: no private width registration", synthetic.grade(spec, observations(spec)))

    def test_assets_are_repeatable_and_preserve_one_identical_pair(self):
        for variant, source in ld06.VARIANTS.items():
            spec, evidence = asset_case(variant)
            self.assertEqual(synthetic.grade(spec, evidence), [])
            before = {node["key"]: node.get("asset_rgba_sha256") for node in spec["loaded"]["nodes"]
                      if node["kind"] == "image"}
            after = {node["key"]: node.get("asset_rgba_sha256") for node in spec["expected"]["nodes"]
                     if node["kind"] == "image"}
            self.assertEqual(len(before), 6)
            self.assertEqual(len(set(before.values())), 5)
            self.assertEqual(len(set(after.values())), 5)
            self.assertEqual(len([key for key in before if before[key] != after[key]]), 2)
            for meta, data in ld06.make_assets(source):
                self.assertEqual(hashlib.sha256(data).hexdigest(), meta["sha256"])

    def test_handoff_external_assets_and_checkout_reuse_fail(self):
        spec, evidence = asset_case("metro-stories")
        builds = evidence["handoff"]["builds"]
        builds[0]["external_requests"] = ["http://localhost:9000/private-image"]
        builds[1]["checkout_id"] = builds[0]["checkout_id"]
        failures = synthetic.grade(spec, evidence)
        self.assertTrue(any("external asset access" in failure for failure in failures))
        self.assertTrue(any("identities are absent or repeated" in failure for failure in failures))

    def test_font_metadata_does_not_substitute_for_rendered_glyphs(self):
        spec, evidence = asset_case("garden-labels")
        evidence["reopened"]["glyph_render"] = None
        self.assertIn("reopened: rendered Latin/Korean glyph evidence differs", synthetic.grade(spec, evidence))
        missing, evidence = asset_case("garden-labels", register_font=False)
        self.assertIn("LD06 requires licensed registered font bytes", synthetic.grade(missing, evidence))

    def test_font_registration_validates_unicode_map_and_reads_hash(self):
        font_bytes = demo_sfnt(["A", "한", "글"])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "mini.ttf"
            path.write_bytes(font_bytes)
            meta, data = read_font(path, "OFL-1.1", ["A", "한"])
            self.assertEqual(meta["family"], "Test Fixture")
            self.assertEqual(meta["sha256"], hashlib.sha256(data).hexdigest())
            with self.assertRaisesRegex(ValueError, "missing required glyphs: 견"):
                read_font(path, "OFL-1.1", ["A", "견"])
            with self.assertRaisesRegex(ValueError, "redistribution license"):
                read_font(path, "", ["A"])

    def test_cli_materializes_ld06_images_content_and_registered_font(self):
        cli = Path(__file__).with_name("synthetic.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            font = root / "case.ttf"
            font.write_bytes(demo_sfnt(ld06.required_glyphs(ld06.VARIANTS["metro-stories"])))
            output = root / "assets"
            spec = json.loads(subprocess.check_output([
                sys.executable, str(cli), "fixture", "LD06", "--font-file", str(font),
                "--font-license", "OFL-1.1", "--assets-dir", str(output),
            ]))
            self.assertTrue(spec["font_registered"])
            self.assertEqual(len(list(output.iterdir())), 10)
            for asset in spec["assets"]:
                self.assertEqual(hashlib.sha256((output / asset["name"]).read_bytes()).hexdigest(),
                                 asset["sha256"])


if __name__ == "__main__":
    unittest.main()
