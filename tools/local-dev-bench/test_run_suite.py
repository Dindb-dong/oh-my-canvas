import json
from pathlib import Path
import tempfile
import unittest

from run_suite import plan


class ScheduleTest(unittest.TestCase):
    def test_routes_sequential_resources_and_parallel_agent_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "first.json", root / "second.json"
            first.write_text(json.dumps({"attempt_id": "a"}))
            second.write_text(json.dumps({"attempt_id": "b", "sample_resources": True}))
            self.assertEqual(list(plan([second, first], 1)), ["b", "a"])
            self.assertEqual(list(plan([first], 2)), ["a"])
            with self.assertRaisesRegex(ValueError, "use --jobs 1"):
                plan([first, second], 2)
            with self.assertRaisesRegex(ValueError, "duplicate"):
                plan([first, first], 1)
            with self.assertRaisesRegex(ValueError, "at least 1"):
                plan([first], 0)
            first.write_text(json.dumps({"attempt_id": "../other"}))
            with self.assertRaisesRegex(ValueError, "invalid attempt id"):
                plan([first], 1)


if __name__ == "__main__":
    unittest.main()
