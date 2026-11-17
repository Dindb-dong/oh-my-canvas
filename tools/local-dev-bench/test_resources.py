"""Smoke-check the sampler against real kernel counters and missing coverage."""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from resources import ResourceSampler


class ResourceSamplerTest(unittest.TestCase):
    def test_unavailable_platform_has_null_measurements(self):
        with tempfile.TemporaryDirectory() as directory, patch("resources.sys.platform", "linux"):
            path = Path(directory) / "resources.jsonl"
            sampler = ResourceSampler(path, [os.getpid()])
            sampler.start()
            summary = sampler.stop()
            self.assertEqual(summary["measurement_completeness"]["physical_footprint"], "NOT_OBSERVABLE")
            self.assertIsNone(summary["physical_footprint_peak_bytes"])
            self.assertIsNone(summary["cpu_seconds"])
            self.assertEqual([json.loads(x)["type"] for x in path.read_text().splitlines()],
                             ["resource.header", "resource.summary"])

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS libproc")
    def test_observes_child_memory_cpu_disk_and_exit(self):
        size = 16 * 1024 ** 2
        child_program = """
import mmap
import os
import sys
import time
print(os.getpid(), flush=True)
sys.stdin.readline()
size = int(sys.argv[1])
started = time.process_time_ns()
while time.process_time_ns() - started < 80_000_000:
    pass
block = mmap.mmap(-1, size)
for page in range(0, size, mmap.PAGESIZE):
    block[page] = 1
with open(sys.argv[2], "wb", buffering=0) as file:
    file.write(bytes(1024 ** 2))
    os.fsync(file.fileno())
print("allocated", flush=True)
sys.stdin.readline()
block.close()
print("released", flush=True)
sys.stdin.readline()
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "resources.jsonl"
            data_path = Path(directory) / "child-data"
            command = ["/usr/bin/time", "-lp", sys.executable, "-c", child_program, str(size), str(data_path)]
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True) as child:
                try:
                    child_pid = int(child.stdout.readline())
                    sampler = ResourceSampler(path, [child.pid, child_pid], interval=0.025)
                    sampler.start()
                    try:
                        child.stdin.write("work\n")
                        child.stdin.flush()
                        self.assertEqual(child.stdout.readline().strip(), "allocated")

                        def samples_matching(condition):
                            deadline = time.monotonic() + 3
                            while True:
                                rows = [r for line in path.read_text().splitlines()
                                        for r in json.loads(line).get("processes", []) if r["pid"] == child_pid]
                                if rows and condition(rows):
                                    return rows
                                self.assertLess(time.monotonic(), deadline, "expected child state not sampled")
                                time.sleep(0.01)

                        allocated_rows = samples_matching(lambda rows: rows[-1]["disk_write_bytes"] >= 1024 ** 2)
                        measured = allocated_rows[-1]["physical_footprint_bytes"]
                        footprint = subprocess.run(
                            ["/usr/bin/footprint", "--noCategories", "-f", "bytes", "-p", str(child_pid)],
                            capture_output=True, check=True, text=True, timeout=5,
                        ).stdout
                        independent = int(re.search(r"^\s*phys_footprint: (\d+) B$", footprint, re.M)[1])
                        self.assertLess(abs(independent - measured), 1024 ** 2)
                        stat = subprocess.check_output(
                            ["/usr/bin/stat", "-f", "%z %b", data_path], text=True, timeout=5,
                        ).split()
                        self.assertEqual(int(stat[0]), 1024 ** 2)
                        self.assertGreater(int(stat[1]), 0)

                        child.stdin.write("release\n")
                        child.stdin.flush()
                        self.assertEqual(child.stdout.readline().strip(), "released")
                        released_rows = samples_matching(
                            lambda rows: rows[-1]["physical_footprint_bytes"] < measured - size + 1024 ** 2
                        )
                        cpu_key = ("cpu_user_ns", "cpu_system_ns")
                        observed_cpu = sum(released_rows[-1][k] - released_rows[0][k] for k in cpu_key) / 1e9
                        self.assertGreater(observed_cpu, 0.07)
                        child.stdin.close()
                        self.assertEqual(child.wait(timeout=3), 0)
                        timing = child.stderr.read()
                        os_cpu = sum(float(re.search(rf"^{prefix} (\d+\.\d+)$", timing, re.M)[1])
                                     for prefix in ("user", "sys"))
                        self.assertLess(abs(observed_cpu - os_cpu), 0.05)
                    finally:
                        summary = sampler.stop()
                finally:
                    if not child.stdin.closed:
                        child.stdin.close()
                    child.wait(timeout=3)

            self.assertEqual(summary["observed_process_instances"], 2)
            self.assertGreaterEqual(summary["physical_footprint_peak_bytes"], size)
            self.assertGreaterEqual(summary["cpu_seconds"], 0.07)
            self.assertGreater(summary["disk_write_bytes"], 0)
            self.assertGreater(summary["physical_footprint_byte_seconds"], 0)
            self.assertEqual(summary["measurement_completeness"]["cpu"], "INCOMPLETE")
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertTrue(any(pid == child_pid for row in rows for pid, _ in row.get("departed", [])))
            self.assertFalse(summary["counter_anomalies"])

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS kqueue")
    def test_fork_triggers_observation_before_first_regular_tick(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "resources.jsonl"
            sampler = ResourceSampler(path, [os.getpid()], interval=2)
            sampler.start()
            try:
                child = subprocess.Popen(["/bin/sleep", "0.2"])
                child.wait(timeout=3)
            finally:
                summary = sampler.stop()
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            first_sample = rows[1]["sample_monotonic_ns"]
            self.assertEqual(rows[0]["lifecycle"], "kqueue.EVFILT_PROC")
            self.assertGreater(summary["fork_notifications"], 0)
            self.assertGreater(summary["observed_exit_notifications"], 0)
            self.assertTrue(any(
                sample["sample_monotonic_ns"] - first_sample < 2_000_000_000
                and any(pid == child.pid for pid, _ in sample.get("joined", []))
                for sample in rows if sample["type"] == "resource.sample"
            ))
            self.assertTrue(any(
                event["exit"] and event["identity"][0] == child.pid
                for row in rows for event in row.get("lifecycle_notifications", [])
            ))

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS libproc")
    def test_missing_root_does_not_become_measured_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            sampler = ResourceSampler(Path(directory) / "resources.jsonl", [2 ** 31 - 1])
            sampler.start()
            summary = sampler.stop()
            self.assertIsNone(summary["physical_footprint_peak_bytes"])
            self.assertIsNone(summary["cpu_seconds"])
            self.assertGreater(summary["read_or_discovery_errors"], 0)


if __name__ == "__main__":
    unittest.main()
