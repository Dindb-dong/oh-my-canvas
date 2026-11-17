"""Smoke-check the sampler against real kernel counters and missing coverage."""

import json
import os
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
size = int(sys.argv[1])
started = time.process_time_ns()
while time.process_time_ns() - started < 40_000_000:
    pass
block = mmap.mmap(-1, size)
for page in range(0, size, mmap.PAGESIZE):
    block[page] = 1
with open(sys.argv[2], "wb", buffering=0) as file:
    file.write(bytes(1024 ** 2))
    os.fsync(file.fileno())
print("ready", flush=True)
sys.stdin.readline()
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "resources.jsonl"
            sampler = ResourceSampler(path, [os.getpid(), os.getpid()], interval=0.025)
            sampler.start()
            try:
                data_path = Path(directory) / "child-data"
                with subprocess.Popen([sys.executable, "-c", child_program, str(size), str(data_path)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
                    try:
                        self.assertEqual(child.stdout.readline().strip(), "ready")
                        deadline = time.monotonic() + 3
                        while True:
                            samples = [json.loads(line) for line in path.read_text().splitlines()]
                            child_rows = [r for s in samples for r in s.get("processes", [])
                                          if r["pid"] == child.pid]
                            if any(r["physical_footprint_bytes"] >= size and r["disk_write_bytes"] > 0
                                   for r in child_rows):
                                break
                            self.assertLess(time.monotonic(), deadline, "child footprint and disk writes did not appear")
                            time.sleep(0.01)
                    finally:
                        child.stdin.close()
                        child.wait(timeout=3)
            finally:
                summary = sampler.stop()

            self.assertEqual(summary["observed_process_instances"], 2)
            self.assertGreaterEqual(summary["physical_footprint_peak_bytes"], size)
            self.assertGreaterEqual(summary["cpu_seconds"], 0.03)
            self.assertLess(summary["cpu_seconds"], 1)
            self.assertGreater(summary["disk_write_bytes"], 0)
            self.assertGreater(summary["physical_footprint_byte_seconds"], 0)
            self.assertGreater(summary["sample_count"], 1)
            self.assertEqual(summary["measurement_completeness"]["cpu"], "INCOMPLETE")
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertTrue(any(identity[0] == child.pid for r in rows for identity in r.get("departed", [])))
            self.assertFalse(summary["counter_anomalies"])

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
