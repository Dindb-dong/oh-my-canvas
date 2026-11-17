"""Describe the idle and post-close diagnostics recorded by the phase sampler."""

import argparse
import json
from pathlib import Path


SECOND = 1_000_000_000


def summarize(directory):
    with (directory / "summary.json").open(encoding="utf-8") as source:
        summary = json.load(source)
    idle = summary["phases"]["baseline"]
    closed = summary["phases"]["tail"]
    idle_elapsed = idle["duration_seconds"]
    idle_cpu = (idle.get("observed") or {}).get("cpu_seconds")
    start = closed["start_monotonic_ns"]
    checkpoints = {
        second: {"target_monotonic_ns": start + second * SECOND, "sample": None}
        for second in (60, 300)
    }
    observed_processes = set()
    if closed["status"] == "COMPLETE":
        with (directory / "samples.jsonl").open(encoding="utf-8") as source:
            for line in source:
                row = json.loads(line)
                if row["type"] != "resource.sample" or row["sample_start_monotonic_ns"] < start:
                    continue
                at = row["sample_monotonic_ns"]
                if at >= closed["end_monotonic_ns"]:
                    break
                departed = {tuple(identity) for identity in row["departed"]}
                live = {
                    (process["pid"], process["start_abstime"]) for process in row["processes"]
                    if process["exit_abstime"] is None
                } - departed
                observed_processes.update(live)
                for checkpoint in checkpoints.values():
                    target = checkpoint["target_monotonic_ns"]
                    if at <= target:
                        checkpoint["sample"] = {
                            "sample_monotonic_ns": at,
                            "seconds_after_close": (at - start) / SECOND,
                            "seconds_before_checkpoint": (target - at) / SECOND,
                            "observed_physical_footprint_bytes": row["aggregate_physical_footprint_bytes"],
                            "observed_live_processes": len(live),
                        }
    return {
        "kind": "idle-and-post-close-resource-diagnostic",
        "idle_with_document": idle,
        "idle_observed_cpu_seconds_per_minute": (
            idle_cpu * 60 / idle_elapsed if idle_cpu is not None and idle_elapsed > 0 else None
        ),
        "verify_and_close": summary["phases"]["replay"],
        "post_close": closed,
        "post_close_checkpoints_seconds": checkpoints,
        "post_close_observed_process_instances": len(observed_processes),
        "polling_network_bytes": None,
        "collector_limitations": summary["collector_limitations"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product_resources", type=Path)
    parser.add_argument("new_output", type=Path)
    args = parser.parse_args()
    result = summarize(args.product_resources)
    with args.new_output.open("x", encoding="utf-8") as file:
        json.dump(result, file, indent=2, allow_nan=False)
        file.write("\n")


if __name__ == "__main__":
    main()
