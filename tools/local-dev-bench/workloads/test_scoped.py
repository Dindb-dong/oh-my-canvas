from collections import Counter
import copy
import unittest

import synthetic
from test_synthetic import snapshot


def evidence(spec):
    observed = {}
    for phase, data in {
        "before": "start", "candidate": "expected", "reopened": "expected", "after_probe_original": "expected",
        "copy_before": "start", "copy_edited": "expected", "copy_undo": "start", "copy_redo": "expected",
    }.items():
        document = "copy" if phase.startswith("copy_") else "work"
        observed[phase] = snapshot(spec[data], document)
    for label in ("before", "copy_before"):
        observed[label]["selected_native_ids"] = []
    observed["edit"] = copy.deepcopy(spec["edit"])
    observed["copy_history"] = {"undo_count": 1, "redo_count": 1}
    return observed


class ScopedWorkloadTests(unittest.TestCase):
    def setUp(self):
        self.spec = synthetic.fixture("LD02", "conservation-atlas")

    def test_counts_near_names_and_semantically_unique_target(self):
        nodes = self.spec["start"]["nodes"]
        self.assertEqual(len(self.spec["start"]["pages"]), 10)
        self.assertEqual(Counter(Counter(node["page"] for node in nodes).values()), {100: 10})
        by_parent = {node["parent"]: node["text"] for node in nodes if node.get("name") == "receipt"}
        exact_names = [node for node in nodes if node.get("name") == "Ceramics review"]
        self.assertGreater(len(exact_names), 1)
        matches = [node for node in exact_names if by_parent[node["key"]] == "AC-270"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["page"], self.spec["working_page"])
        self.assertFalse({"start", "expected", "working_page", "edit"} & synthetic.public_brief(self.spec).keys())
        self.assertNotIn(matches[0]["key"], synthetic.public_brief(self.spec)["brief"])

    def test_only_registered_edits_and_automatic_layout_delta(self):
        before = {item["key"]: item for item in self.spec["start"]["nodes"]}
        changes = {}
        for node in self.spec["expected"]["nodes"]:
            old = before[node["key"]]
            for field in node.keys() - {"bounds"}:
                if node[field] != old[field]:
                    changes[(node["key"], field)] = (old[field], node[field])
        self.assertEqual(changes, {(row["key"], row["field"]): (row["from"], row["to"]) for row in self.spec["edit"]})
        self.assertEqual(synthetic.grade(self.spec, evidence(self.spec)), [])

    def test_rejects_page_replacement_and_unrelated_changes(self):
        observed = evidence(self.spec)
        observed["candidate"]["pages"][0]["native_id"] = "replacement-page"
        observed["reopened"]["nodes"][2]["text"] = "Wrong content"
        failures = synthetic.grade(self.spec, observed)
        self.assertTrue(any(item.startswith("candidate: page or native") for item in failures))
        self.assertTrue(any(item.startswith("reopened: document or native") for item in failures))
        self.assertTrue(any(item.endswith(".text differs") for item in failures))

    def test_rejects_fake_undo_and_probe_on_original(self):
        observed = evidence(self.spec)
        observed["copy_before"]["document_id"] = "work"
        observed["copy_redo"] = snapshot(self.spec["start"], "copy")
        observed["copy_history"]["undo_count"] = 0
        failures = synthetic.grade(self.spec, observed)
        self.assertIn("copy_before: Undo/Redo verification requires a distinct document", failures)
        self.assertIn("copy_history: actual native Undo and Redo counts are required", failures)
        self.assertTrue(any(item.startswith("copy_redo: arrival") for item in failures))

    def test_rejects_transient_extra_edit_and_uncleared_selection(self):
        observed = evidence(self.spec)
        observed["edit"].append({"key": "other", "field": "radius", "from": 4, "to": 10})
        observed["before"]["selected_native_ids"] = ["already-selected-target"]
        self.assertEqual(synthetic.grade(self.spec, observed), [
            "before: starting selection was not independently observed clear",
            "edit: expected exactly the three registered field writes",
        ])
