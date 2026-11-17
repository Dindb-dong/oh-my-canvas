"""Capture a human-operated Codex TUI diagnostic and its private usage evidence."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import termios
import time

from usage import COUNTERS, summarize_usage
from tui_session import deadline_ns, remaining


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def foreground_terminal():
    return (
        all(stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr))
        and os.tcgetpgrp(sys.stdin.fileno()) == os.getpgrp()
    )


def reduce_trace(codex, output, deadline=None):
    bundles = sorted(path.parent for path in (output / "trace").glob("*/manifest.json"))
    if not bundles:
        return {"bundles": [], "usage": summarize_usage(None)}
    records = []
    with (output / "reduce.log").open("w", encoding="utf-8") as log:
        for index, trace in enumerate(bundles, 1):
            state = output / ("state.json" if len(bundles) == 1 else f"state-{index}.json")
            timeout = remaining(deadline) if deadline is not None else None
            try:
                result = subprocess.run(
                    [codex, "debug", "trace-reduce", str(trace), "--output", str(state)],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=timeout,
                ) if timeout != 0 else None
            except subprocess.TimeoutExpired:
                result = None
            reduced = result is not None and result.returncode == 0
            records.append({
                "bundle": str(trace.relative_to(output)),
                "reducer_exit_code": result.returncode if result is not None else 124,
                "state": state.name if reduced else None,
                "usage": summarize_usage(state if reduced else None),
            })
    metering = [record["usage"] for record in records if record["usage"]["record_count"]]
    issues = [
        f"bundle {index}: {issue}"
        for index, record in enumerate(records, 1)
        if record["usage"]["status"] != "COMPLETE"
        for issue in (record["usage"]["issues"] or ["metered trace unavailable"])
    ]
    usage = {
        "status": "INCOMPLETE" if issues else "COMPLETE",
        "normalization_version": 1,
        "source": "codex-rollout",
        "record_count": sum(usage["record_count"] for usage in metering),
        "issues": issues,
        **{
            field: (
                sum(usage[field] for usage in metering)
                if metering and all(usage[field] is not None for usage in metering)
                else None
            )
            for field in COUNTERS
        },
    }
    return {"bundles": records, "usage": usage}


def capture(codex, args):
    output = args.output.resolve()
    prompt = args.prompt_file.read_bytes()
    prompt_text = prompt.decode("utf-8")
    if not prompt_text.strip() or "\0" in prompt_text:
        raise ValueError("the prompt must contain nonempty UTF-8 text without NUL")
    root = args.cwd.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("the work directory must be a directory")
    version = subprocess.check_output([codex, "--version"], text=True).strip()
    argv = [codex, "--no-daemon", "--no-alt-screen", "--cd", str(root), "--model", args.model]
    if args.profile:
        argv.extend(("--profile", args.profile))
    argv.extend(("--", prompt_text))

    print("This diagnostic records model inputs and outputs in a private trace directory.")
    print("The token cap is checked after the session. Use Codex to interrupt ongoing work.")
    if input("Type start to launch the measured Codex terminal session: ").strip() != "start":
        return 1
    output.mkdir(mode=0o700)
    trace_root = output / "trace"
    trace_root.mkdir(mode=0o700)
    env = dict(os.environ, CODEX_ROLLOUT_TRACE_ROOT=str(trace_root))
    session = {
        "codex_version": version,
        "model": args.model,
        "profile": args.profile,
        "cwd": str(root),
        "prompt_sha256": hashlib.sha256(prompt).hexdigest(),
        "operator_started_at": datetime.now(timezone.utc).isoformat(),
        "operator_outcome": None,
        "wall_seconds": args.wall_seconds,
        "token_cap": args.token_cap,
        "live_token_cap_enforced": False,
    }
    metadata = output / "interactive.json"
    write_json(metadata, session)
    started = time.monotonic()
    outer_deadline = os.environ.get("OMC_BENCH_DEADLINE_NS")
    deadline = deadline_ns(args.wall_seconds) if outer_deadline else None
    terminal = termios.tcgetattr(sys.stdin.fileno())
    wall_timed_out = False
    try:
        # Codex owns all TUI I/O, including its actual approval prompts.
        timeout = remaining(deadline) if deadline is not None else args.wall_seconds
        result = subprocess.run(argv, cwd=root, env=env, timeout=timeout)
        session["codex_exit_code"] = result.returncode
    except subprocess.TimeoutExpired:
        session["codex_exit_code"] = 124
        wall_timed_out = True
    except KeyboardInterrupt:
        session["codex_exit_code"] = 130
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, terminal)
        session["tui_elapsed_seconds"] = time.monotonic() - started
        session["tui_exited_at"] = datetime.now(timezone.utc).isoformat()
        write_json(metadata, session)

    try:
        outcome = input("Session outcome (candidate / stopped / blocked): ").strip()
    except (EOFError, KeyboardInterrupt):
        outcome = ""
    if outcome in {"candidate", "stopped", "blocked"}:
        session["operator_outcome"] = outcome
        session["operator_outcome_at"] = datetime.now(timezone.utc).isoformat()
    evidence = reduce_trace(codex, output, int(outer_deadline) if outer_deadline else None)
    tokens = evidence["usage"]["total_tokens"]
    if wall_timed_out or (tokens is not None and tokens > args.token_cap):
        session["budget_status"] = "TIMEOUT_BUDGET"
    elif evidence["usage"]["status"] != "COMPLETE":
        session["budget_status"] = "UNKNOWN"
    else:
        session["budget_status"] = "WITHIN_CAPTURED_BUDGET"
    write_json(metadata, session)
    write_json(output / "usage.json", evidence)
    print(f"Private interactive capture saved to {output}")
    return 124 if session["budget_status"] == "TIMEOUT_BUDGET" else session["codex_exit_code"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New private directory")
    parser.add_argument("--cwd", type=Path, required=True, help="Task workspace")
    parser.add_argument("--model", required=True, help="Codex model for this trial")
    parser.add_argument("--profile", help="Optional operator-configured Codex profile")
    parser.add_argument("--prompt-file", type=Path, required=True, help="Registered UTF-8 prompt")
    parser.add_argument("--wall-seconds", type=int, required=True, help="TUI wall-time cutoff")
    parser.add_argument("--token-cap", type=int, required=True, help="Post-run token ceiling")
    args = parser.parse_args()
    if args.wall_seconds <= 0 or args.token_cap <= 0:
        parser.error("budget limits must be positive")
    if not foreground_terminal():
        parser.error("launch this command in an operator's foreground terminal")
    codex = shutil.which("codex")
    if not codex:
        parser.error("codex executable is unavailable")
    try:
        return capture(str(Path(codex).resolve()), args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Interactive capture failed: {error}\n")


if __name__ == "__main__":
    sys.exit(main())
