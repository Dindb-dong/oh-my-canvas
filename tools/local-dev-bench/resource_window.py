"""Sample one persistent process tree across an explicitly timed replay.

Run resource_window.py NEW_PRIVATE_DIR and send one JSON request per line.
Commands: start (root_pids, optional baseline_seconds, tail_seconds,
interval_seconds, max_tail_seconds), baseline, replay, tail (replay_complete bool), and
stop (tail_complete bool). Wait for each reply before proceeding. The parent
owns work verification and waiting for the registered minimum durations.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import time

from resources import ResourceSampler


PHASES = ("baseline", "replay", "tail")
IO_FIELDS = ("disk_read_bytes", "disk_write_bytes")
WAKEUP_FIELDS = ("package_idle_wakeups", "interrupt_wakeups")
FIELDS = ("cpu_user_ns", "cpu_system_ns") + IO_FIELDS + WAKEUP_FIELDS


def duration(args, name, default):
    value = args.get(name, default)
    if type(value) not in (int, float) or not 0 < value <= (2**63 - 1) / 1e9:
        raise ValueError(f"{name} must be a finite positive duration")
    return value


class Observation:
    """Accumulate samples whose acquisitions fall entirely inside a window."""

    def __init__(self, start, end, attested):
        self.start = start
        self.end = end
        self.attested = attested
        self.count = 0
        self.crossing = 0
        self.missing_roots = 0
        self.peak = None
        self.integral = self.integrated_s = 0
        self.max_gap = 0
        self.max_acquisition = 0
        self.previous = None
        self.counters = {}

    def add(self, row, root_ids, expected_roots):
        before = row["sample_start_monotonic_ns"]
        after = row["sample_monotonic_ns"]
        if after < self.start or before >= self.end:
            return
        if before < self.start or after >= self.end:
            self.crossing += 1
            return
        self.count += 1
        self.max_acquisition = max(self.max_acquisition, after - before)
        departed = {tuple(identity) for identity in row["departed"]}
        live_ids = set()
        for process in row["processes"]:
            identity = process["pid"], process["start_abstime"]
            if process["exit_abstime"] is None and identity not in departed:
                live_ids.add(identity)
            values = tuple(process.get(field) for field in FIELDS)
            counter = self.counters.get(identity)
            if counter is None:
                self.counters[identity] = (values, values, 1, set())
            else:
                first, last, reads, resets = counter
                resets.update(index for index, (old, new) in enumerate(zip(last, values))
                              if old is None or new is None or new < old)
                self.counters[identity] = (first, values, reads + 1, resets)
        roots_present = len(root_ids) == expected_roots and root_ids <= live_ids
        if not roots_present:
            self.missing_roots += 1
        total = row["aggregate_physical_footprint_bytes"]
        if total is not None:
            self.peak = total if self.peak is None else max(self.peak, total)
        if self.previous is not None:
            last_at, last_total = self.previous
            gap = after - last_at
            self.max_gap = max(self.max_gap, gap)
            if total is not None and last_total is not None:
                seconds = gap / 1e9
                self.integral += (total + last_total) * seconds / 2
                self.integrated_s += seconds
        self.previous = after, total

    def summarize(self, whole_metrics):
        if not self.attested or self.count and (self.missing_roots or self.peak is None):
            status = "INCOMPLETE"
        elif self.count:
            status = "COMPLETE"
        else:
            status = "NOT_OBSERVABLE"
        observed = {}
        if status == "COMPLETE":
            observed["physical_footprint_peak_bytes"] = self.peak
            observed["physical_footprint_mean_bytes"] = (
                self.integral / self.integrated_s if self.integrated_s else None
            )
            observed["physical_footprint_byte_seconds"] = self.integral if self.integrated_s else None
            repeated = [item for item in self.counters.values() if item[2] >= 2]
            for index, field in enumerate(FIELDS):
                observed[field] = (
                    sum(last[index] - first[index] for first, last, _, _ in repeated)
                    if repeated and not any(index in resets for _, _, _, resets in repeated) else None
                )
            user, system = (observed[field] for field in FIELDS[:2])
            observed["cpu_seconds"] = (user + system) / 1e9 if user is not None and system is not None else None
        metrics = {key: status for key in whole_metrics}
        if status == "COMPLETE":
            metrics = dict(whole_metrics)
            # Phase-local counter deltas omit work between edges and first-seen process counters.
            metrics["cpu"] = "INCOMPLETE" if observed["cpu_seconds"] is not None else "NOT_OBSERVABLE"
            metrics["disk_io"] = (
                "INCOMPLETE" if any(observed[key] is not None for key in IO_FIELDS) else "NOT_OBSERVABLE"
            )
            metrics["wakeups"] = (
                "INCOMPLETE" if any(observed[key] is not None for key in WAKEUP_FIELDS) else "NOT_OBSERVABLE"
            )
        return {
            "status": status,
            "attested_complete": self.attested,
            "start_monotonic_ns": self.start,
            "end_monotonic_ns": self.end,
            "duration_seconds": (self.end - self.start) / 1e9,
            "sample_count": self.count,
            "boundary_crossing_samples_excluded": self.crossing,
            "samples_missing_declared_root": self.missing_roots,
            "max_sample_gap_ms": self.max_gap / 1e6 if self.count > 1 else None,
            "max_sample_acquisition_ms": self.max_acquisition / 1e6 if self.count else None,
            "measurement_completeness": metrics,
            "observed": observed or None,
        }


def segment(path, boundaries, root_pids, whole):
    windows = {name: Observation(*times) for name, times in boundaries.items()}
    root_ids = None
    with path.open(encoding="utf-8") as log:
        for line in log:
            row = json.loads(line)
            if row["type"] != "resource.sample":
                continue
            if root_ids is None:
                root_ids = {
                    (process["pid"], process["start_abstime"]) for process in row["processes"]
                    if process["pid"] in root_pids and process["exit_abstime"] is None
                }
            for window in windows.values():
                window.add(row, root_ids, len(root_pids))
    metrics = whole["measurement_completeness"]
    if whole.get("error"):
        for window in windows.values():
            window.attested = False
    phases = {name: windows[name].summarize(metrics) for name in PHASES}
    primary = windows["replay_and_tail"].summarize(metrics)
    invalid_parts = [phases[name]["status"] for name in PHASES[1:] if phases[name]["status"] != "COMPLETE"]
    if invalid_parts:
        status = "INCOMPLETE" if "INCOMPLETE" in invalid_parts else "NOT_OBSERVABLE"
        primary.update(status=status, observed=None, measurement_completeness=dict.fromkeys(metrics, status))
    observed = (primary["observed"] or {}).get("physical_footprint_peak_bytes")
    return {
        "schema_version": "omc-local-dev/resource-window/1",
        "root_pids": root_pids,
        "phase_completeness": {phase: record["status"] for phase, record in phases.items()},
        "phases": phases,
        "primary_replay_and_tail": primary,
        "measurement_completeness": primary["measurement_completeness"],
        "physical_footprint_peak_bytes": (
            observed if primary["measurement_completeness"]["physical_footprint"] == "COMPLETE" else None
        ),
        "observed_physical_footprint_peak_bytes": observed,
        "collector_error": whole.get("error"),
        "collector_limitations": whole["limitations"],
    }


class ResourceWindow:
    def __init__(self, directory):
        self.directory = directory
        self.state = "new"
        self.sampler = None
        self.times = {}
        self.replay_complete = False

    def request(self, args):
        if not isinstance(args, dict):
            raise ValueError("request must be a JSON object")
        command = args.get("command")
        transitions = {
            "new": "start", "started": "baseline", "baseline": "replay", "replay": "tail", "tail": "stop",
        }
        if command is None or transitions.get(self.state) != command:
            raise ValueError(f"invalid command for {self.state}")
        if command == "start":
            roots = args.get("root_pids")
            if not isinstance(roots, list):
                raise ValueError("root_pids must be a list of ready process IDs")
            self.baseline = duration(args, "baseline_seconds", 60)
            self.tail = duration(args, "tail_seconds", 30)
            self.max_tail = duration(args, "max_tail_seconds", None) if "max_tail_seconds" in args else None
            if self.max_tail is not None and self.max_tail <= self.tail:
                raise ValueError("max_tail_seconds must exceed tail_seconds")
            interval = duration(args, "interval_seconds", .05)
            sampler = ResourceSampler(self.directory / "samples.jsonl", roots, interval=interval)
            self.directory.mkdir(mode=0o700)
            sampler.start()
            self.sampler = sampler
            self.state = "started"
            return {"state": self.state, "root_pids": sampler.roots,
                    "baseline_seconds": self.baseline, "tail_seconds": self.tail, "max_tail_seconds": self.max_tail}
        if command in ("tail", "stop"):
            name = "replay_complete" if command == "tail" else "tail_complete"
            if type(args.get(name)) is not bool:
                raise ValueError(f"{name} requires explicit boolean attestation")
        now = time.monotonic_ns()
        if command in ("replay", "stop"):
            prior, minimum = ("baseline", self.baseline) if command == "replay" else ("tail", self.tail)
            elapsed = (now - self.times[prior]) / 1e9
            if elapsed < minimum:
                raise ValueError(f"{prior} requires {minimum} seconds; only {elapsed:.6f} observed")
        if command == "tail":
            self.replay_complete = args["replay_complete"]
        if command == "stop":
            return self.finish(now, args["tail_complete"])
        self.times[command] = now
        self.state = command
        return {"state": self.state, "monotonic_ns": now}

    def finish(self, now, tail_complete):
        self.state = "stopped"
        whole = self.sampler.stop()
        baseline, replay, tail = (self.times[name] for name in PHASES)
        tail_deadline_exceeded = self.max_tail is not None and (now - tail) / 1e9 > self.max_tail
        within_deadline = tail_complete and not tail_deadline_exceeded
        boundaries = {
            "baseline": (baseline, replay, True),
            "replay": (replay, tail, self.replay_complete),
            "tail": (tail, now, within_deadline),
            "replay_and_tail": (replay, now, self.replay_complete and within_deadline),
        }
        result = segment(self.sampler.path, boundaries, self.sampler.roots, whole)
        result["registered_minimum_seconds"] = {"baseline": self.baseline, "tail": self.tail}
        result["registered_max_tail_seconds"] = self.max_tail
        result["tail_attested_complete"] = tail_complete
        result["tail_deadline_exceeded"] = tail_deadline_exceeded
        summary = self.directory / "summary.json"
        with summary.open("x", encoding="utf-8") as file:
            json.dump(result, file, indent=2, allow_nan=False)
            file.write("\n")
        return {"state": self.state, "monotonic_ns": now, "summary_path": str(summary.resolve()),
                "phase_completeness": result["phase_completeness"]}

    def close(self):
        if self.sampler and self.state != "stopped":
            self.sampler.stop()
            self.state = "aborted"


def serve(directory):
    window = ResourceWindow(directory)
    try:
        for line in sys.stdin:
            try:
                reply = {"ok": True, **window.request(json.loads(line))}
            except (ValueError, OSError, RuntimeError) as error:
                reply = {"ok": False, "state": window.state, "error": str(error)}
            print(json.dumps(reply, allow_nan=False), flush=True)
            if window.state == "stopped":
                return 0 if reply["ok"] else 1
        return 1 if window.state != "stopped" else 0
    finally:
        window.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    raise SystemExit(serve(args.directory))


if __name__ == "__main__":
    main()
