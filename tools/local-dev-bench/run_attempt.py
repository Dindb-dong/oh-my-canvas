"""Run one local-development benchmark attempt and retain raw evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time

from usage import RESPONSES_LEDGER_FORMAT, summarize_usage

SCHEMA = "omc-local-dev/1"


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    for key in ("attempt_id", "product", "workload"):
        value = manifest.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} must be a nonempty string")
    for key in ("argv", "acceptance_argv"):
        if key != "argv" and key not in manifest:
            continue
        value = manifest.get(key)
        if (not isinstance(value, list) or not value or not value[0]
                or not all(isinstance(arg, str) and "\0" not in arg for arg in value)):
            raise ValueError(f"{key} must be an argv array with a nonempty executable")
    for key in ("timeout_seconds", "acceptance_timeout_seconds"):
        if key not in manifest:
            continue
        value = manifest.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be a finite positive number")
    if "sample_resources" in manifest and type(manifest["sample_resources"]) is not bool:
        raise ValueError("sample_resources must be a boolean")
    publish = manifest.get("candidate_ready_on_publish", False)
    if type(publish) is not bool or (publish and "acceptance_argv" not in manifest):
        raise ValueError("candidate_ready_on_publish requires an independent oracle")
    roots = manifest.get("resource_root_pids", [])
    if not isinstance(roots, list) or any(type(pid) is not int or pid <= 0 for pid in roots):
        raise ValueError("resource_root_pids must list positive process IDs")
    if roots and not manifest.get("sample_resources"):
        raise ValueError("resource_root_pids requires sample_resources")
    tail = manifest.get("resource_tail_seconds", 0)
    if type(tail) not in (int, float) or not 0 <= tail <= 300:
        raise ValueError("resource_tail_seconds must be between 0 and 300")
    if tail and not manifest.get("sample_resources"):
        raise ValueError("resource_tail_seconds requires sample_resources")
    if "usage_path" in manifest:
        value = manifest["usage_path"]
        if (not isinstance(value, str) or not value or "\0" in value
                or Path(value).name != value or value in {".", ".."}):
            raise ValueError("usage_path must be 'stdout' or a file name in the output directory")
    if "usage_format" in manifest:
        if manifest["usage_format"] != RESPONSES_LEDGER_FORMAT or "usage_path" not in manifest:
            raise ValueError("usage_format must name the supported Responses ledger and requires usage_path")
    if "token_budget" in manifest:
        budget = manifest["token_budget"]
        if type(budget) is not int or budget <= 0 or "usage_path" not in manifest:
            raise ValueError("token_budget requires a positive integer and usage_path")


def stop_group(proc):
    def send(sig):
        try:
            os.killpg(proc.pid, sig)
        except PermissionError:
            # Darwin can deny signals to an exited leader until it is reaped.
            proc.poll()
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                return False
        except ProcessLookupError:
            return False
        return True

    if send(signal.SIGTERM):
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        send(signal.SIGKILL)
    proc.wait()


def candidate_hash(path):
    if path.is_symlink() or not path.is_file():
        return None
    with path.open("rb") as file:
        digest = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def run(manifest, output):
    validate_manifest(manifest)
    output = Path(output).resolve()
    output.mkdir(mode=0o700)
    candidate = output / "candidate.json"
    env = {
        **os.environ,
        "OMC_BENCH_OUTPUT_DIR": str(output),
        "OMC_BENCH_CANDIDATE": str(candidate),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = {
        "schema_version": SCHEMA,
        "run_id": manifest["attempt_id"],
        "workload_id": manifest["workload"],
        "product_profile": manifest["product"],
        "execution_status": None,
        "reason": None,
        "observed_wall_ms": None,
        "published_ready_ms": None,
        "cleanup_ms": None,
        "accepted_ready_ms": None,
        "analysis_capped_time_ms": None,
        "candidate_sha256": None,
        "returncode": None,
        "acceptance_returncode": None,
        "usage": None,
        "resources": None,
        "resource_tail_ms": None,
        "provider_input_tokens": None,
        "provider_output_tokens": None,
        "physical_footprint_peak_bytes": None,
        "cpu_seconds": None,
        "measurement_completeness": {
            "time": "INCOMPLETE",
            "tokens": "NOT_OBSERVABLE",
            "physical_footprint": "NOT_OBSERVABLE",
            "cpu": "NOT_OBSERVABLE",
            "presentation": "NOT_OBSERVABLE",
        },
    }
    proc = grader = sampler = None
    ready_ns = None
    cap_ms = manifest.get("timeout_seconds", 60) * 1000
    publish = manifest.get("candidate_ready_on_publish", False)

    with (output / "events.jsonl").open("x", encoding="utf-8", buffering=1) as events:
        def event(name, stamp=None, **fields):
            events.write(json.dumps({
                "schema_version": SCHEMA,
                "run_id": result["run_id"],
                "clock_domain": "runner.time.monotonic_ns",
                "monotonic_ns": time.monotonic_ns() if stamp is None else stamp,
                "utc": datetime.now(timezone.utc).isoformat(),
                "event": name,
                **fields,
            }) + "\n")

        start_ns = time.monotonic_ns()
        deadline = start_ns + int(cap_ms * 1e6)
        env["OMC_BENCH_DEADLINE_NS"] = str(deadline)
        event("attempt.start", start_ns)

        def observe_candidate():
            nonlocal ready_ns
            seen_ns = time.monotonic_ns()
            if seen_ns >= deadline or ready_ns is not None:
                return
            digest = candidate_hash(candidate)
            if digest is not None:
                ready_ns = seen_ns
                result["candidate_sha256"] = digest
                result["published_ready_ms"] = (ready_ns - start_ns) / 1e6
                event("candidate.ready", ready_ns, sha256=digest)

        try:
            with (output / "stdout.log").open("xb") as stdout, (output / "stderr.log").open("xb") as stderr:
                proc = subprocess.Popen(
                    manifest["argv"], env=env, stdout=stdout, stderr=stderr,
                    stdin=subprocess.DEVNULL, start_new_session=True,
                )
                event("process.started", pid=proc.pid)
                if manifest.get("sample_resources"):
                    from resources import ResourceSampler
                    try:
                        sampler = ResourceSampler(
                            output / "resources.jsonl",
                            [proc.pid, *manifest.get("resource_root_pids", [])],
                        )
                        sampler.start()
                    except (OSError, RuntimeError, ValueError) as error:
                        event("resources.error", reason=str(error))
                        result["resources"] = {"reason": "sampler_start_failed"}
                try:
                    if publish:
                        while proc.poll() is None and time.monotonic_ns() < deadline:
                            observe_candidate()
                            try:
                                proc.wait(timeout=min(0.02, max(0, (deadline - time.monotonic_ns()) / 1e9)))
                            except subprocess.TimeoutExpired:
                                continue
                        observe_candidate()
                    else:
                        proc.wait(timeout=max(0, (deadline - time.monotonic_ns()) / 1e9))
                    finished_ns = time.monotonic_ns()
                    result["observed_wall_ms"] = (finished_ns - start_ns) / 1e6
                    if finished_ns >= deadline:
                        result.update(execution_status="TIMEOUT_BUDGET", reason="wall_time_limit")
                    elif proc.returncode:
                        result.update(execution_status="EXECUTION_FAIL", reason="attempt_command_failed")
                    elif "acceptance_argv" not in manifest:
                        result.update(execution_status="DIAGNOSTIC", reason="no_registered_oracle")
                    elif not publish:
                        result["candidate_sha256"] = candidate_hash(candidate)
                        if result["candidate_sha256"] is None:
                            result.update(execution_status="QUALITY_FAIL", reason="missing_candidate")
                        else:
                            ready_ns = finished_ns
                            event("candidate.ready", ready_ns, sha256=result["candidate_sha256"])
                    elif ready_ns is None:
                        result.update(execution_status="QUALITY_FAIL", reason="missing_candidate")
                except subprocess.TimeoutExpired:
                    result.update(execution_status="TIMEOUT_BUDGET", reason="wall_time_limit")
        except OSError as error:
            event("harness.error", reason=str(error))
            result.update(execution_status="INVALID_RUN", reason="command_or_capture_unavailable")
        except KeyboardInterrupt:
            result.update(execution_status="INVALID_RUN", reason="operator_interrupted")
        finally:
            if result["observed_wall_ms"] is None:
                result["observed_wall_ms"] = (time.monotonic_ns() - start_ns) / 1e6
            event("attempt.stop", execution_status=result["execution_status"],
                  awaiting_independent_acceptance=ready_ns is not None)
            cleanup_start_ns = time.monotonic_ns()
            stopped_at_deadline = proc is not None and proc.returncode is None
            if stopped_at_deadline:
                stop_group(proc)
            if sampler is not None:
                tail_seconds = manifest.get("resource_tail_seconds", 0)
                if tail_seconds and not stopped_at_deadline and proc.returncode == 0:
                    tail_start_ns = time.monotonic_ns()
                    event("tail.start", tail_start_ns)
                    try:
                        time.sleep(tail_seconds)
                        tail_end_ns = time.monotonic_ns()
                        result["resource_tail_ms"] = (tail_end_ns - tail_start_ns) / 1e6
                        event("tail.complete", tail_end_ns)
                    except KeyboardInterrupt:
                        ready_ns = None
                        result.update(execution_status="INVALID_RUN", reason="operator_interrupted")
                try:
                    result["resources"] = sampler.stop()
                except (OSError, RuntimeError, ValueError) as error:
                    event("resources.error", reason=str(error))
                    result["resources"] = {"reason": "sampler_stop_failed"}
            if proc is not None:
                if not stopped_at_deadline:
                    stop_group(proc)
                result["returncode"] = proc.returncode
            result["cleanup_ms"] = (time.monotonic_ns() - cleanup_start_ns) / 1e6

        if "usage_path" in manifest:
            leaf = manifest["usage_path"]
            path = output / ("stdout.log" if leaf == "stdout" else leaf)
            usage = (
                {"status": "INCOMPLETE", "issues": ["usage path is not a regular file"]}
                if path.is_symlink() or (path.exists() and not path.is_file())
                else summarize_usage(path, usage_format=manifest.get("usage_format"),
                                     expected_token_cap=manifest.get("token_budget"))
            )
            result["usage"] = usage
            result["measurement_completeness"]["tokens"] = usage["status"]
            result["provider_input_tokens"] = usage.get("input_tokens")
            result["provider_output_tokens"] = usage.get("output_tokens")
            budget = manifest.get("token_budget")
            actual = usage.get("total_tokens")
            if (budget is not None and actual is not None and actual > budget
                    and result["execution_status"] != "INVALID_RUN"):
                event("budget.exceeded", token_budget=budget, observed_tokens=actual)
                if result["execution_status"] != "TIMEOUT_BUDGET":
                    result.update(execution_status="TIMEOUT_BUDGET", reason="token_budget_exceeded")

        if ready_ns is not None and result["execution_status"] is None:
            try:
                if candidate_hash(candidate) != result["candidate_sha256"]:
                    raise ValueError("published candidate changed before grading")
                with (output / "acceptance.stdout.log").open("xb") as stdout, (
                    output / "acceptance.stderr.log"
                ).open("xb") as stderr:
                    grader = subprocess.Popen(
                        manifest["acceptance_argv"], env=env, stdout=stdout, stderr=stderr,
                        stdin=subprocess.DEVNULL, start_new_session=True,
                    )
                    result["acceptance_returncode"] = grader.wait(
                        timeout=manifest.get("acceptance_timeout_seconds", cap_ms / 1000)
                    )
                if candidate_hash(candidate) != result["candidate_sha256"]:
                    result.update(execution_status="INVALID_RUN", reason="candidate_changed_during_grading")
                elif result["acceptance_returncode"] == 0:
                    result.update(
                        execution_status="PASS",
                        accepted_ready_ms=(ready_ns - start_ns) / 1e6,
                    )
                    event("candidate.accepted", sha256=result["candidate_sha256"])
                else:
                    result.update(execution_status="QUALITY_FAIL", reason="oracle_rejected_candidate")
            except ValueError as error:
                event("acceptance.error", reason=str(error))
                result.update(execution_status="INVALID_RUN", reason="candidate_changed_before_grading")
            except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                event("acceptance.error", reason=str(error))
                result.update(execution_status="INVALID_RUN", reason="independent_oracle_unavailable")
            finally:
                if grader is not None:
                    stop_group(grader)

        status = result["execution_status"]
        if "acceptance_argv" in manifest and status != "INVALID_RUN":
            result["measurement_completeness"]["time"] = "COMPLETE"
            result["analysis_capped_time_ms"] = (
                result["accepted_ready_ms"] if status == "PASS" else cap_ms
            )
        if manifest.get("sample_resources"):
            resources = result["resources"] or {}
            completeness = resources.get("measurement_completeness", {})
            for measure in ("physical_footprint", "cpu"):
                result["measurement_completeness"][measure] = completeness.get(measure, "INCOMPLETE")
            for key in ("physical_footprint_peak_bytes", "cpu_seconds"):
                result[key] = resources.get(key)
        event("attempt.finalized", execution_status=status, reason=result["reason"])

    path = output / "result.json"
    with path.open("x", encoding="utf-8") as file:
        json.dump(result, file, indent=2, allow_nan=False)
        file.write("\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        result = run(manifest, args.output)
    except (OSError, ValueError) as error:
        parser.exit(2, f"run_attempt: {error}\n")
    print(json.dumps(result, allow_nan=False))
    return 0 if result["execution_status"] in ("PASS", "DIAGNOSTIC") else 1


if __name__ == "__main__":
    raise SystemExit(main())
