import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from tui_session import completed_main_messages, deadline_ns, drive
from run_attempt import run


class TerminalTests(unittest.TestCase):
    def test_hands_off_after_real_task_completion(self):
        code = """
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
title = root / 'interactive/trace/title/payloads'
title.mkdir(parents=True)
(title / 'request.json').write_text(json.dumps({'input': [], 'stream': True, 'tools': []}))
(title / 'complete.json').write_text(json.dumps({'type': 'task_complete'}))
assert input('Type start: ') == 'start'
main = root / 'interactive/trace/main/payloads'
main.mkdir(parents=True)
(main / 'request.json').write_text(json.dumps({'input': [], 'stream': True, 'tools': ['fixture']}))
(main / 'complete.json').write_text(json.dumps({'type': 'task_complete'}))
try:
    input()
except EOFError:
    assert input('Session outcome: ') == 'candidate'
else:
    raise AssertionError('expected terminal EOF')
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = drive([sys.executable, '-c', code, directory], os.environ, root, deadline_ns(2))
            self.assertEqual(result['native_exit'], 0)
            self.assertIsNotNone(result['main_completed_at_ns'])
            self.assertIn(b'Session outcome', (root / 'terminal.log').read_bytes())

    def test_main_terminal_marker_retains_transport_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            main = root / "interactive/trace/main/payloads"
            main.mkdir(parents=True)
            (main / "request.json").write_text('{"input":[],"stream":true,"tools":["fixture"]}')
            (main / "complete.json").write_text('{"type":"task_complete","error":{"message":"stream disconnected"}}')
            self.assertEqual(completed_main_messages(root),
                             [{"task_complete": None, "error": {"message": "stream disconnected"}}])

    def test_timeout_reaps_the_detached_terminal_and_descendant(self):
        code = """
from pathlib import Path
import subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'])
Path(sys.argv[1], 'descendant.pid').write_text(str(child.pid))
time.sleep(20)
"""
        for outer in (False, True):
            with self.subTest(outer_runner=outer), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                deadline = deadline_ns(0.65)
                argv = [sys.executable, '-c', code, directory]
                if outer:
                    source = str(Path(__file__).resolve().parent)
                    adapter = ('import os,sys; from pathlib import Path; '
                               f'sys.path.insert(0,{source!r}); '
                               'from tui_session import deadline_ns,drive; '
                               'drive(sys.argv[2:],os.environ,Path(sys.argv[1]),deadline_ns(20))')
                    result = run({'attempt_id': 'timeout', 'product': 'mock', 'workload': 'fixture',
                                  'timeout_seconds': 0.65,
                                  'argv': [sys.executable, '-c', adapter, directory, *argv]}, root / 'attempt')
                    self.assertEqual(result['execution_status'], 'TIMEOUT_BUDGET')
                else:
                    result = drive(argv, os.environ, root, deadline)
                    self.assertEqual(result['native_exit'], 124)
                    self.assertTrue(result['timed_out'])
                self.assertLess(time.monotonic_ns() - deadline, 500_000_000)
                pid = int((root / 'descendant.pid').read_text())
                # A CI container's description of a reparented zombie varies by init.
                for _ in range(30):
                    status = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)],
                                            capture_output=True, text=True).stdout.strip()
                    if not status or status.startswith('Z'):
                        break
                    time.sleep(0.01)
                else:
                    self.fail('terminal descendant is still running')
