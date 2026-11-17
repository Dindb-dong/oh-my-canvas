import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from idle_report import SECOND, summarize


def sample(start, begin_seconds, end_seconds, ram):
    return {
        "type": "resource.sample",
        "sample_start_monotonic_ns": start + int(begin_seconds * SECOND),
        "sample_monotonic_ns": start + int(end_seconds * SECOND),
        "departed": [[11, 1]],
        "processes": [{"pid": pid, "start_abstime": 1, "exit_abstime": None} for pid in (10, 11)],
        "aggregate_physical_footprint_bytes": ram,
    }


class IdleReportTest(unittest.TestCase):
    def test_uses_last_in_window_samples_and_reports_actual_checkpoint_age(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            start = 601 * SECOND
            phases = {
                "baseline": {"duration_seconds": 600, "observed": {"cpu_seconds": 12}},
                "replay": {"duration_seconds": .25},
                "tail": {"status": "COMPLETE", "start_monotonic_ns": start,
                         "end_monotonic_ns": start + 300 * SECOND},
            }
            (directory / "summary.json").write_text(json.dumps({"phases": phases, "collector_limitations": []}))
            rows = [
                sample(start, -.01, .02, 500),
                sample(start, 59.90, 59.95, 300),
                sample(start, 60.00, 60.05, 200),
                sample(start, 299.90, 299.95, 150),
                sample(start, 299.99, 300.02, 100),
            ]
            (directory / "samples.jsonl").write_text("\n".join(map(json.dumps, rows)))
            report = summarize(directory)
        self.assertAlmostEqual(report["idle_observed_cpu_seconds_per_minute"], 1.2)
        checkpoints = report["post_close_checkpoints_seconds"]
        self.assertEqual(checkpoints[60]["sample"]["observed_physical_footprint_bytes"], 300)
        self.assertEqual(checkpoints[300]["sample"]["observed_physical_footprint_bytes"], 150)
        self.assertAlmostEqual(checkpoints[60]["sample"]["seconds_before_checkpoint"], .05)
        self.assertEqual(report["post_close_observed_process_instances"], 1)
