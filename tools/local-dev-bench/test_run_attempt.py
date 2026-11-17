import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from run_attempt import run, validate_manifest


def python(code):
    return [sys.executable, "-c", code]


WRITE = """
import os
from pathlib import Path
candidate = Path(os.environ['OMC_BENCH_CANDIDATE'])
pending = candidate.with_suffix('.tmp')
pending.write_text('{"answer":42}')
pending.replace(candidate)
"""
GRADE = """
import json, os, time
from pathlib import Path
time.sleep(0.15)
assert json.loads(Path(os.environ['OMC_BENCH_CANDIDATE']).read_text()) == {'answer':42}
"""


class AttemptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / "attempt"
        self.manifest = {
            "attempt_id": "synthetic",
            "product": "synthetic",
            "workload": "fixture",
            "argv": python("print('done')"),
            "timeout_seconds": 2,
        }

    def events(self):
        return [json.loads(line) for line in (self.output / "events.jsonl").read_text().splitlines()]

    def test_diagnostic_preserves_streams_with_no_inferred_completion(self):
        end = run(self.manifest, self.output)
        self.assertEqual(end["execution_status"], "DIAGNOSTIC")
        self.assertIsNone(end["accepted_ready_ms"])
        self.assertIsNone(end["analysis_capped_time_ms"])
        self.assertEqual((self.output / "stdout.log").read_text(), "done\n")
        self.assertEqual(end, json.loads((self.output / "result.json").read_text()))
        with self.assertRaises(FileExistsError):
            run(self.manifest, self.output)

    def test_acceptance_is_tied_to_candidate_without_grader_time(self):
        self.manifest.update(argv=python(WRITE), acceptance_argv=python(GRADE))
        start = time.monotonic()
        result = run(self.manifest, self.output)
        self.assertEqual(result["execution_status"], "PASS")
        self.assertIsNotNone(result["candidate_sha256"])
        self.assertEqual(result["accepted_ready_ms"], result["analysis_capped_time_ms"])
        self.assertGreater((time.monotonic() - start) * 1000 - result["accepted_ready_ms"], 100)
        ready, accepted = (event for event in self.events() if event["event"].startswith("candidate."))
        self.assertEqual(ready["sha256"], accepted["sha256"])
        self.assertLess(ready["monotonic_ns"], accepted["monotonic_ns"])

    def test_rejected_candidate_is_capped(self):
        self.manifest.update(argv=python(WRITE), acceptance_argv=python("raise SystemExit(5)"))
        result = run(self.manifest, self.output)
        self.assertEqual(result["execution_status"], "QUALITY_FAIL")
        self.assertIsNone(result["accepted_ready_ms"])
        self.assertEqual(result["analysis_capped_time_ms"], 2000)
        self.assertEqual(result["acceptance_returncode"], 5)

    def test_missing_candidate_does_not_run_oracle(self):
        self.manifest.update(acceptance_argv=python(GRADE))
        result = run(self.manifest, self.output)
        self.assertEqual(result["reason"], "missing_candidate")
        self.assertFalse((self.output / "acceptance.stdout.log").exists())

    def test_grader_cannot_substitute_new_candidate(self):
        self.manifest.update(
            argv=python(WRITE),
            acceptance_argv=python("import os; from pathlib import Path; "
                                   "Path(os.environ['OMC_BENCH_CANDIDATE']).write_text('changed')"),
        )
        result = run(self.manifest, self.output)
        self.assertEqual(result["execution_status"], "INVALID_RUN")
        self.assertEqual(result["reason"], "candidate_changed_during_grading")
        self.assertIsNone(result["accepted_ready_ms"])

    def test_timeout_keeps_partial_output(self):
        self.manifest.update(argv=python("import time; print('started', flush=True); time.sleep(5)"),
                             acceptance_argv=python(GRADE), timeout_seconds=0.4)
        result = run(self.manifest, self.output)
        self.assertEqual(result["execution_status"], "TIMEOUT_BUDGET")
        self.assertEqual(result["analysis_capped_time_ms"], 400)
        self.assertGreaterEqual(result["observed_wall_ms"], 400)
        self.assertLess(result["observed_wall_ms"], 2000)
        self.assertEqual((self.output / "stdout.log").read_text(), "started\n")

    def test_grader_timeout_keeps_candidate_and_marks_run_invalid(self):
        self.manifest.update(
            argv=python(WRITE), acceptance_argv=python("import time; time.sleep(3)"),
            acceptance_timeout_seconds=0.1,
        )
        result = run(self.manifest, self.output)
        self.assertEqual(result["execution_status"], "INVALID_RUN")
        self.assertIsNone(result["analysis_capped_time_ms"])
        self.assertTrue((self.output / "candidate.json").exists())

    def test_resource_tail_is_outside_candidate_time(self):
        sampler = Mock()
        sampler.stop.return_value = {
            "physical_footprint_peak_bytes": 42,
            "measurement_completeness": {"physical_footprint": "INCOMPLETE"},
        }
        self.manifest.update(
            argv=python(WRITE), acceptance_argv=python(GRADE),
            sample_resources=True, resource_tail_seconds=0.06,
        )
        with patch("resources.ResourceSampler", return_value=sampler):
            result = run(self.manifest, self.output)
        sampler.start.assert_called_once()
        sampler.stop.assert_called_once()
        self.assertEqual(result["execution_status"], "PASS")
        self.assertGreaterEqual(result["resource_tail_ms"], 60)
        self.assertEqual(result["physical_footprint_peak_bytes"], 42)
        self.assertEqual(result["observed_wall_ms"], result["accepted_ready_ms"])

    def test_captures_codex_stdout_as_a_partial_ledger(self):
        usage = {"input_tokens": 25, "cached_input_tokens": 10, "output_tokens": 7}
        raw = json.dumps({"type": "turn.completed", "usage": usage})
        self.manifest.update(argv=python(f"print({raw!r})"), usage_path="stdout")
        result = run(self.manifest, self.output)
        self.assertEqual(result["provider_input_tokens"], 25)
        self.assertEqual(result["provider_output_tokens"], 7)
        self.assertEqual(result["measurement_completeness"]["tokens"], "INCOMPLETE")
        self.assertEqual(json.loads((self.output / "stdout.log").read_text())["usage"], usage)

    def test_untrusted_manifest_arguments_are_rejected(self):
        for extra in (
            {"argv": "echo x"}, {"argv": [""]}, {"usage_path": "../other"},
            {"timeout_seconds": float("nan")}, {"timeout_seconds": True},
            {"resource_root_pids": [1]}, {"resource_tail_seconds": 20},
        ):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                validate_manifest({**self.manifest, **extra})


if __name__ == "__main__":
    unittest.main()
