"""Exercise phase boundaries independently and through the JSONL bridge."""

import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

from resource_window import ResourceWindow, segment


def line(start, completed, peak, *, identity=99):
    return {
        "type": "resource.sample",
        "sample_start_monotonic_ns": start,
        "sample_monotonic_ns": completed,
        "aggregate_physical_footprint_bytes": peak,
        "departed": [],
        "processes": [{
            "pid": 123, "start_abstime": identity, "exit_abstime": None,
            "cpu_user_ns": completed, "cpu_system_ns": 0,
            "disk_read_bytes": completed, "disk_write_bytes": 0,
        }],
    }


def fixture(path, rows, *, replay=True, tail=True):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    boundaries = {
        "baseline": (0, 10, True), "replay": (10, 20, replay), "tail": (20, 30, tail),
        "replay_and_tail": (10, 30, replay and tail),
    }
    whole = {
        "measurement_completeness": dict.fromkeys(("physical_footprint", "cpu", "disk_io"), "INCOMPLETE"),
        "limitations": [],
    }
    return segment(path, boundaries, (123,), whole)


class ResourceWindowTest(unittest.TestCase):
    def test_primary_peak_uses_full_acquisitions_in_union_and_excludes_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            result = fixture(Path(directory) / "samples", [
                line(1, 2, 1000), line(9, 10, 3000), line(11, 12, 100), line(19, 20, 800),
                line(21, 22, 200), line(25, 26, 300),
            ])
        phases = result["phases"]
        self.assertEqual(phases["baseline"]["observed"]["physical_footprint_peak_bytes"], 1000)
        self.assertEqual(phases["replay"]["observed"]["physical_footprint_peak_bytes"], 100)
        self.assertEqual(phases["tail"]["observed"]["physical_footprint_peak_bytes"], 300)
        self.assertEqual(phases["tail"]["observed"]["disk_read_bytes"], 4)
        self.assertEqual(result["observed_physical_footprint_peak_bytes"], 800)
        self.assertIsNone(result["physical_footprint_peak_bytes"])
        self.assertEqual(result["measurement_completeness"]["physical_footprint"], "INCOMPLETE")

    def test_failed_attestation_and_changed_pid_identity_invalidate_phases(self):
        with tempfile.TemporaryDirectory() as directory:
            result = fixture(Path(directory) / "samples", [
                line(1, 2, 100), line(11, 12, 200), line(21, 22, 300, identity=100),
            ], replay=False)
        self.assertEqual(result["phase_completeness"], {
            "baseline": "COMPLETE", "replay": "INCOMPLETE", "tail": "INCOMPLETE"
        })
        self.assertIsNone(result["phases"]["replay"]["observed"])
        self.assertIsNone(result["phases"]["tail"]["observed"])
        self.assertIsNone(result["observed_physical_footprint_peak_bytes"])

    def test_absent_samples_do_not_certify_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            result = fixture(Path(directory) / "samples", [line(1, 2, 100), line(11, 12, 200)])
        self.assertEqual(result["phase_completeness"]["tail"], "NOT_OBSERVABLE")
        self.assertIsNone(result["primary_replay_and_tail"]["observed"])

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS libproc")
    def test_stdio_handshake_with_persistent_synthetic_child(self):
        script = Path(__file__).with_name("resource_window.py")
        child_program = """
import mmap
import sys
print("ready", flush=True)
sys.stdin.readline()
size = 12 * 1024 ** 2
block = mmap.mmap(-1, size)
for offset in range(0, size, mmap.PAGESIZE):
    block[offset] = 1
print("allocated", flush=True)
sys.stdin.readline()
"""

        def read_line(process):
            self.assertTrue(select.select([process.stdout], [], [], 8)[0], "missing bridge reply")
            message = process.stdout.readline()
            self.assertTrue(message, "unexpected EOF")
            return message

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "measurement"
            with subprocess.Popen(
                [sys.executable, "-c", child_program], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            ) as fixture_child, subprocess.Popen(
                [sys.executable, str(script), str(output)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            ) as bridge:
                try:
                    self.assertEqual(read_line(fixture_child).strip(), "ready")

                    def send(command, **fields):
                        bridge.stdin.write(json.dumps({"command": command, **fields}) + "\n")
                        bridge.stdin.flush()
                        return json.loads(read_line(bridge))

                    started = send("start", root_pids=[fixture_child.pid], baseline_seconds=.25,
                                   tail_seconds=.25, interval_seconds=.01)
                    self.assertTrue(started["ok"], started)
                    self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
                    self.assertTrue(send("baseline")["ok"])
                    self.assertFalse(send("replay")["ok"])
                    time.sleep(.28)
                    self.assertTrue(send("replay")["ok"])
                    fixture_child.stdin.write("allocate\n")
                    fixture_child.stdin.flush()
                    self.assertEqual(read_line(fixture_child).strip(), "allocated")
                    time.sleep(.13)
                    self.assertFalse(send("tail")["ok"])
                    self.assertTrue(send("tail", replay_complete=True)["ok"])
                    self.assertFalse(send("stop", tail_complete=True)["ok"])
                    time.sleep(.28)
                    finished = send("stop", tail_complete=True)
                    self.assertTrue(finished["ok"], finished)
                    self.assertEqual(bridge.wait(timeout=8), 0)
                    result = json.loads(Path(finished["summary_path"]).read_text())
                    self.assertEqual(set(result["phase_completeness"].values()), {"COMPLETE"})
                    self.assertGreaterEqual(result["phases"]["baseline"]["duration_seconds"], .25)
                    self.assertGreaterEqual(result["phases"]["tail"]["duration_seconds"], .25)
                    baseline = result["phases"]["baseline"]["observed"]["physical_footprint_peak_bytes"]
                    self.assertGreater(result["observed_physical_footprint_peak_bytes"], baseline + 8 * 1024 ** 2)
                finally:
                    fixture_child.stdin.close()
                    fixture_child.wait(timeout=8)
                    if bridge.poll() is None:
                        bridge.stdin.close()
                        bridge.wait(timeout=8)

    def test_expired_registered_tail_is_incomplete_even_with_caller_attestation(self):
        with tempfile.TemporaryDirectory() as directory:
            window = ResourceWindow(Path(directory))
            path = window.directory / "samples.jsonl"
            rows = [line(1, 2, 100), line(11, 12, 200), line(21, 22, 300)]
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            window.sampler = SimpleNamespace(path=path, roots=(123,), stop=lambda: {
                "measurement_completeness": dict.fromkeys(("physical_footprint", "cpu", "disk_io"), "INCOMPLETE"),
                "limitations": [],
            })
            window.times = {"baseline": 0, "replay": 10, "tail": 20}
            window.baseline, window.tail, window.max_tail = 10e-9, 10e-9, 15e-9
            window.replay_complete = True
            reply = window.finish(40, True)
            summary = json.loads(Path(reply["summary_path"]).read_text())
        self.assertEqual(summary["phase_completeness"]["tail"], "INCOMPLETE")
        self.assertTrue(summary["tail_deadline_exceeded"])
        self.assertTrue(summary["tail_attested_complete"])
        self.assertIsNone(summary["observed_physical_footprint_peak_bytes"])

    def test_refuses_existing_output_directory(self):
        script = Path(__file__).with_name("resource_window.py")
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(script), directory], text=True, capture_output=True, timeout=8,
                input=json.dumps({"command": "start", "root_pids": [os.getpid()]}) + "\n",
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)["ok"])
            self.assertFalse(list(Path(directory).iterdir()))


if __name__ == "__main__":
    unittest.main()
