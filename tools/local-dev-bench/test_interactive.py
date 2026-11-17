import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from interactive import capture, reduce_trace
from test_usage import trace


class InteractiveTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "output"
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_text("synthetic registered prompt", encoding="utf-8")
        self.args = argparse.Namespace(
            output=self.output, prompt_file=self.prompt,
            cwd=self.root, model="test-model", profile="test-profile",
            wall_seconds=5, token_cap=32,
        )

    def test_handoff_to_native_terminal_and_reduction(self):
        def run(argv, **kwargs):
            if argv[1] == "--no-daemon":
                self.assertEqual(argv, [
                    "/bin/codex", "--no-daemon", "--no-alt-screen", "--cd", str(self.root.resolve()),
                    "--model", "test-model", "--profile", "test-profile",
                    "--", "synthetic registered prompt",
                ])
                self.assertNotIn("stdin", kwargs)
                self.assertNotIn("stdout", kwargs)
                self.assertNotIn("stderr", kwargs)
                self.assertEqual(kwargs["timeout"], 5)
                bundle = Path(kwargs["env"]["CODEX_ROLLOUT_TRACE_ROOT"]) / "bundle"
                bundle.mkdir()
                (bundle / "manifest.json").touch()
            else:
                self.assertEqual(argv[:3], ["/bin/codex", "debug", "trace-reduce"])
                Path(argv[-1]).write_text(json.dumps(trace(2)), encoding="utf-8")
            return subprocess.CompletedProcess(argv, 0)

        with (
            patch("interactive.subprocess.check_output", return_value="codex-cli 0.169.0\n"),
            patch("interactive.subprocess.run", side_effect=run),
            patch("interactive.termios.tcgetattr", return_value=[]),
            patch("interactive.termios.tcsetattr"),
            patch("builtins.input", side_effect=["start", "candidate"]),
            patch.dict(os.environ, {"CODEX_ROLLOUT_TRACE_ROOT": str(self.root / "global")}),
        ):
            self.assertEqual(capture("/bin/codex", self.args), 124)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        metadata = json.loads((self.output / "interactive.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["operator_outcome"], "candidate")
        self.assertEqual(metadata["budget_status"], "TIMEOUT_BUDGET")
        self.assertFalse(metadata["live_token_cap_enforced"])
        self.assertEqual(metadata["prompt_sha256"], hashlib.sha256(self.prompt.read_bytes()).hexdigest())
        usage = json.loads((self.output / "usage.json").read_text(encoding="utf-8"))
        self.assertEqual(usage["usage"]["total_tokens"], 34)
        self.assertEqual(usage["bundles"][0]["bundle"], "trace/bundle")

    def test_wall_timeout_restores_terminal_and_preserves_failure(self):
        with (
            patch("interactive.subprocess.check_output", return_value="codex-cli 0.169.0\n"),
            patch("interactive.subprocess.run", side_effect=subprocess.TimeoutExpired("codex", 5)),
            patch("interactive.termios.tcgetattr", return_value=[]),
            patch("interactive.termios.tcsetattr") as restore,
            patch("builtins.input", side_effect=["start", "stopped"]),
        ):
            self.assertEqual(capture("/bin/codex", self.args), 124)
        restore.assert_called_once()
        metadata = json.loads((self.output / "interactive.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["budget_status"], "TIMEOUT_BUDGET")
        self.assertEqual(metadata["operator_outcome"], "stopped")

    def test_decline_leaves_no_capture(self):
        with (
            patch("interactive.subprocess.check_output", return_value="codex-cli 0.169.0\n"),
            patch("interactive.subprocess.run") as run,
            patch("builtins.input", return_value="stop"),
        ):
            self.assertEqual(capture("/bin/codex", self.args), 1)
        self.assertFalse(self.output.exists())
        run.assert_not_called()

    def test_absent_bundle_keeps_usage_unknown(self):
        with patch("interactive.subprocess.run") as run:
            result = reduce_trace("/bin/codex", self.output)
        self.assertEqual(result["usage"]["status"], "NOT_OBSERVABLE")
        run.assert_not_called()

    def test_multiple_bundles_retain_metered_requests(self):
        for name in ("helper", "task"):
            bundle = self.output / "trace" / name
            bundle.mkdir(parents=True)
            (bundle / "manifest.json").touch()

        def run(argv, **kwargs):
            if Path(argv[3]).name == "helper" and helper_failed:
                return subprocess.CompletedProcess(argv, 1)
            Path(argv[-1]).write_text(json.dumps(trace(2)), encoding="utf-8")
            return subprocess.CompletedProcess(argv, 0)

        for helper_failed in (False, True):
            with self.subTest(helper_failed=helper_failed), patch("interactive.subprocess.run", side_effect=run):
                result = reduce_trace("/bin/codex", self.output)
            self.assertEqual(len(result["bundles"]), 2)
            self.assertEqual(result["usage"]["status"], "INCOMPLETE" if helper_failed else "COMPLETE")
            self.assertEqual(result["usage"]["total_tokens"], 34 if helper_failed else 68)


if __name__ == "__main__":
    unittest.main()
