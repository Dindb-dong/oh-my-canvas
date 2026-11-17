"""Sample the macOS physical footprint of declared process trees."""

import ctypes
import json
import math
import os
import select
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


RUSAGE_INFO_V2 = 2


class RusageInfoV2(ctypes.Structure):
    # Layout from <sys/resource.h>. Child counters overlap the sampled descendants.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (field, ctypes.c_uint64)
        for field in (
            "user", "system", "package_wakeups", "interrupt_wakeups", "pageins",
            "wired", "resident", "physical", "start_abstime", "exit_abstime",
            "child_user", "child_system", "child_package_wakeups",
            "child_interrupt_wakeups", "child_pageins", "child_elapsed",
            "disk_read", "disk_write",
        )
    ]


class DarwinProcessCounters:
    """Read public libproc counters without spawning a polling subprocess."""

    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.lib.mach_timebase_info.argtypes = [ctypes.c_void_p]
        self.lib.mach_absolute_time.restype = ctypes.c_uint64
        ratio = (ctypes.c_uint32 * 2)()
        if self.lib.mach_timebase_info(ratio) or not all(ratio):
            raise OSError("Unable to read the Mach timebase")
        self.numer, self.denom = ratio
        self.pid_buffer = (ctypes.c_int * 64)()

    def absolute_time(self):
        return self.lib.mach_absolute_time()

    def read(self, pid):
        info = RusageInfoV2()
        ctypes.set_errno(0)
        if self.lib.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(info)) != 0:
            return None, ctypes.get_errno()
        return {
            "pid": pid,
            "start_abstime": info.start_abstime,
            "exit_abstime": info.exit_abstime or None,
            "physical_footprint_bytes": info.physical,
            "cpu_user_ns": info.user * self.numer // self.denom,
            "cpu_system_ns": info.system * self.numer // self.denom,
            "disk_read_bytes": info.disk_read,
            "disk_write_bytes": info.disk_write,
            "package_idle_wakeups": info.package_wakeups,
            "interrupt_wakeups": info.interrupt_wakeups,
        }, None

    def children(self, pid):
        while True:
            ctypes.set_errno(0)
            count = self.lib.proc_listchildpids(pid, self.pid_buffer, ctypes.sizeof(self.pid_buffer))
            error = ctypes.get_errno()
            if count < 0 or (count == 0 and error):
                return (), error
            if count < len(self.pid_buffer):
                return tuple(child for child in self.pid_buffer[:count] if child > 0), None
            self.pid_buffer = (ctypes.c_int * (len(self.pid_buffer) * 2))()


class ResourceSampler:
    """Write JSONL and return observed estimates at the end of a measurement window."""

    _counter_fields = (
        "cpu_user_ns", "cpu_system_ns", "disk_read_bytes", "disk_write_bytes",
        "package_idle_wakeups", "interrupt_wakeups",
    )

    def __init__(self, path, root_pids, interval=0.05):
        self.path = Path(path)
        roots = tuple(root_pids)
        if not roots or any(type(pid) is not int or not 0 < pid < 2 ** 31 for pid in roots):
            raise ValueError("root_pids must contain positive process IDs")
        self.roots = tuple(sorted(set(roots)))
        if not math.isfinite(interval) or interval <= 0:
            raise ValueError("interval must be a finite positive number")
        self.interval = interval
        self._halt = threading.Event()
        self._thread = None
        self._output = None

    def start(self):
        if self._output is not None:
            raise RuntimeError("ResourceSampler instances are single use")
        self._counter = None
        self._failure = None
        self._queue = None
        self._wake = None
        self._pending_events = []
        self._lifecycle_error = None
        self._fork_notifications = 0
        self._exit_observed = set()
        if sys.platform == "darwin":
            try:
                self._counter = DarwinProcessCounters()
            except OSError as error:
                self._failure = str(error)
        self._tracked = set()
        self._first = {}
        self._last = {}
        self._final = set()
        self._lost = set()
        self._counter_anomalies = set()
        self._read_failures = 0
        self._sample_count = 0
        self._peak = None
        self._previous = None
        self._first_sample_completed = None
        self._max_gap_ns = 0
        self._max_acquisition_ns = 0
        self._integral_byte_s = 0.0
        self._integrated_s = 0.0
        self._start_abstime = self._counter.absolute_time() if self._counter else None
        self._output = self.path.open("x", encoding="utf-8", buffering=1)
        try:
            if self._counter and hasattr(select, "kqueue"):
                self._open_lifecycle()
            self._write({
                "type": "resource.header",
                "schema_version": 1,
                "platform": sys.platform,
                "accounting": "libproc.proc_pid_rusage(RUSAGE_INFO_V2)" if self._counter else None,
                "clock": "monotonic_ns",
                "wall_utc": datetime.now(timezone.utc).isoformat(),
                "interval_ms": self.interval * 1000,
                "root_pids": self.roots,
                "scope": "declared_roots_and_observed_descendants",
                "lifecycle": "kqueue.EVFILT_PROC" if self._queue else "polling",
                "lifecycle_error": self._lifecycle_error,
                "error": self._failure,
            })
            if self._counter:
                self._sample(initial=True)
                self._thread = threading.Thread(target=self._run, name="resource-sampler", daemon=True)
                self._thread.start()
        except Exception:
            self._close_lifecycle()
            self._output.close()
            raise

    def _write(self, entry):
        self._output.write(json.dumps(entry, separators=(",", ":")) + "\n")

    def _open_lifecycle(self):
        try:
            self._queue = select.kqueue()
            self._wake = os.pipe()
            wake_event = select.kevent(
                self._wake[0], filter=select.KQ_FILTER_READ,
                flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
            )
            self._queue.control([wake_event], 0, 0)
        except OSError as error:
            self._lifecycle_error = str(error)
            self._close_lifecycle()

    def _close_lifecycle(self):
        if self._queue:
            self._queue.close()
            self._queue = None
        if self._wake:
            for descriptor in self._wake:
                os.close(descriptor)
            self._wake = None

    def _watch(self, identity):
        pid, started = identity
        self._queue.control([select.kevent(
            pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
            fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT, udata=started,
        )], 0, 0)

    def _events(self, timeout):
        return [
            event for event in self._queue.control(None, 256, timeout)
            if event.filter == select.KQ_FILTER_PROC
        ]

    def _run(self):
        deadline = time.monotonic() + self.interval
        try:
            while not self._halt.is_set():
                timeout = max(0, deadline - time.monotonic())
                if self._queue:
                    events = self._events(timeout)
                    if self._halt.is_set():
                        self._pending_events = events
                        return
                else:
                    if self._halt.wait(timeout):
                        return
                    events = []
                self._sample(events=events)
                now = time.monotonic()
                if now >= deadline:
                    deadline = max(deadline + self.interval, now + self.interval / 2)
        except OSError as error:
            self._failure = str(error)

    def _sample(self, initial=False, events=()):
        started = time.monotonic_ns()
        notifications = []
        exits = set()
        for event in events:
            identity = event.ident, event.udata
            fork = bool(event.fflags & select.KQ_NOTE_FORK)
            exited = bool(event.fflags & select.KQ_NOTE_EXIT)
            self._fork_notifications += int(fork)
            notifications.append({"identity": identity, "fork": fork, "exit": exited})
            if exited:
                exits.add(identity)
        self._exit_observed.update(exits)
        queue = deque(sorted(self._tracked | exits))
        if initial:
            queue.extend((pid, None) for pid in self.roots)
        seen = set()
        reads = {}
        rows = {}
        live = set()
        errors = []
        while queue:
            pid, expected = queue.popleft()
            if (pid, expected) in seen:
                continue
            seen.add((pid, expected))
            if pid not in reads:
                reads[pid] = self._counter.read(pid)
            row, error = reads[pid]
            if row is None:
                errors.append({"pid": pid, "start_abstime": expected, "errno": error, "operation": "read"})
                continue
            identity = pid, row["start_abstime"]
            if expected is not None and expected != identity[1]:
                errors.append({"pid": pid, "start_abstime": expected, "operation": "pid_reused"})
                continue
            if identity in rows:
                continue
            rows[identity] = row
            if row["exit_abstime"] is not None:
                self._final.add(identity)
                continue
            if identity in self._exit_observed:
                continue
            live.add(identity)
            if self._queue and identity not in self._first:
                try:
                    self._watch(identity)
                except OSError as error:
                    errors.append({"pid": pid, "start_abstime": identity[1], "errno": error.errno,
                                   "operation": "lifecycle_watch"})
            children, error = self._counter.children(pid)
            if error is not None:
                errors.append({"pid": pid, "start_abstime": identity[1], "errno": error, "operation": "children"})
            queue.extend((child, None) for child in children)

        joined = rows.keys() - self._first.keys()
        for identity, row in rows.items():
            counters = tuple(row[field] for field in self._counter_fields)
            if identity not in self._first:
                started_in_window = identity[1] >= self._start_abstime
                self._first[identity] = (0,) * len(counters) if started_in_window else counters
            previous = self._last.get(identity, self._first[identity])
            self._counter_anomalies.update(
                field for field, prior, value in zip(self._counter_fields, previous, counters) if value < prior
            )
            self._last[identity] = counters
        departed = (self._tracked - live) | exits
        missing_final = departed - self._final
        self._lost.update(missing_final)
        self._read_failures += len(errors)
        self._tracked = live

        completed = time.monotonic_ns()
        if initial:
            self._first_sample_completed = completed
        total = sum(rows[key]["physical_footprint_bytes"] for key in live) if live else None
        if total is not None:
            self._peak = max(total, self._peak) if self._peak is not None else total
        gap = None
        if self._previous is not None:
            prior_at, prior_bytes = self._previous
            gap = completed - prior_at
            self._max_gap_ns = max(self._max_gap_ns, gap)
            if total is not None and prior_bytes is not None:
                seconds = gap / 1e9
                self._integral_byte_s += (prior_bytes + total) * seconds / 2
                self._integrated_s += seconds
        self._previous = completed, total
        self._max_acquisition_ns = max(self._max_acquisition_ns, completed - started)
        self._sample_count += 1
        self._write({
            "type": "resource.sample",
            "sample_start_monotonic_ns": started,
            "sample_monotonic_ns": completed,
            "acquisition_ns": completed - started,
            "gap_ns": gap,
            "processes": list(rows.values()),
            "joined": sorted(joined),
            "departed": sorted(departed),
            "departed_without_final_counters": sorted(missing_final),
            "lifecycle_notifications": notifications,
            "aggregate_physical_footprint_bytes": total,
            "errors": errors,
        })

    def stop(self):
        if self._output is None or self._output.closed:
            raise RuntimeError("ResourceSampler has no open window")
        self._halt.set()
        if self._wake and self._thread.is_alive():
            os.write(self._wake[1], b" ")
        if self._thread:
            self._thread.join()
            if not self._failure:
                try:
                    events = self._pending_events
                    if self._queue:
                        events = events + self._events(0)
                    self._sample(events=events)
                except OSError as error:
                    self._failure = str(error)
        counters = {}
        for index, field in enumerate(self._counter_fields):
            if self._last and field not in self._counter_anomalies:
                counters[field] = sum(end[index] - self._first[key][index] for key, end in self._last.items())
        cpu_s = None
        if {"cpu_user_ns", "cpu_system_ns"} <= counters.keys():
            cpu_s = (counters["cpu_user_ns"] + counters["cpu_system_ns"]) / 1e9
        completeness = "INCOMPLETE" if self._counter else "NOT_OBSERVABLE"
        summary = {
            "type": "resource.summary",
            "measurement_completeness": {
                "physical_footprint": completeness,
                "cpu": completeness,
                "disk_io": completeness,
                "wakeups": completeness,
            },
            "physical_footprint_peak_bytes": self._peak,
            "physical_footprint_mean_bytes": (
                self._integral_byte_s / self._integrated_s if self._integrated_s else None
            ),
            "physical_footprint_byte_seconds": self._integral_byte_s if self._integrated_s else None,
            "integrated_duration_seconds": self._integrated_s,
            "sampling_window_seconds": (
                (self._previous[0] - self._first_sample_completed) / 1e9 if self._previous else None
            ),
            "cpu_seconds": cpu_s,
            "disk_read_bytes": counters.get("disk_read_bytes"),
            "disk_write_bytes": counters.get("disk_write_bytes"),
            "package_idle_wakeups": counters.get("package_idle_wakeups"),
            "interrupt_wakeups": counters.get("interrupt_wakeups"),
            "sample_count": self._sample_count,
            "max_sample_gap_ms": self._max_gap_ns / 1e6 if self._sample_count > 1 else None,
            "max_acquisition_ms": self._max_acquisition_ns / 1e6 if self._sample_count else None,
            "observed_process_instances": len(self._last),
            "departed_without_final_counters": len(self._lost - self._final),
            "fork_notifications": self._fork_notifications,
            "observed_exit_notifications": len(self._exit_observed),
            "read_or_discovery_errors": self._read_failures,
            "counter_anomalies": sorted(self._counter_anomalies),
            "error": self._failure,
            "limitations": [
                "Coalesced fork notifications may miss helpers that exit before discovery.",
                "CPU and disk I/O are observed deltas. Departed processes may lack final counters.",
                "Memory is the sampled sum of kernel footprints without shared-page de-duplication.",
                "Independent helpers require explicit roots. Guest, GPU, and shared system accounting is separate.",
            ],
        }
        try:
            self._write(summary)
        finally:
            self._close_lifecycle()
            self._output.close()
        return summary
