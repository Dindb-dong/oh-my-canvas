"""Run independent local-development benchmark attempts and retain all outcomes."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import sys


ATTEMPT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}")


def plan(paths, jobs):
    if jobs < 1:
        raise ValueError("--jobs must be at least 1")
    attempts = {}
    for path in paths:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        attempt_id = manifest["attempt_id"]
        if not isinstance(attempt_id, str) or not ATTEMPT_ID.fullmatch(attempt_id):
            raise ValueError(f"invalid attempt id in {path}")
        if attempt_id in attempts:
            raise ValueError(f"duplicate attempt id: {attempt_id}")
        if jobs > 1 and (manifest.get("sample_resources") or manifest.get("resource_root_pids")):
            raise ValueError("use --jobs 1 for attempts with process resource sampling")
        attempts[attempt_id] = path.resolve()
    return attempts


def run_suite(paths, output, jobs):
    attempts = plan(paths, jobs)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    runner = Path(__file__).with_name("run_attempt.py")
    schedule = {
        "schema_version": "omc-local-dev/1",
        "schedule": list(attempts),
        "jobs": jobs,
        "host_contention": "parallel-benchmark-attempts" if jobs > 1 else "one-at-a-time",
    }
    (output / "schedule.json").write_text(json.dumps(schedule, indent=2) + "\n", encoding="utf-8")

    def run(entry):
        attempt_id, path = entry
        attempt_output = output / attempt_id
        with (output / f"{attempt_id}.runner.log").open("wb") as log:
            process = subprocess.Popen(
                [sys.executable, str(runner), str(path), str(attempt_output)],
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            return {"attempt_id": attempt_id, "runner_exit_code": process.wait()}

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = list(pool.map(run, attempts.items()))
    (output / "suite.json").write_text(
        json.dumps({**schedule, "attempts": results}, indent=2) + "\n", encoding="utf-8"
    )
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("manifests", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        results = run_suite(args.manifests, args.output.resolve(), args.jobs)
    except (KeyError, OSError, ValueError) as error:
        parser.error(str(error))
    for result in results:
        print(f'{result["attempt_id"]}: runner exit {result["runner_exit_code"]}')
    return int(any(result["runner_exit_code"] != 0 for result in results))


if __name__ == "__main__":
    sys.exit(main())
