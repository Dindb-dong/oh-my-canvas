"""Record local, versioned benchmark provenance without activating applications."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import subprocess


def command(*argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=True)
    return result.stdout.strip()


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def app_info(path):
    with (path / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    executable = info.get("CFBundleExecutable")
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        raise ValueError("application bundle lacks a valid CFBundleExecutable")
    return {
        "bundle_id": info.get("CFBundleIdentifier"),
        "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"),
        "executable": executable,
        "executable_sha256": sha256(path / "Contents/MacOS" / executable),
    }


def named(values):
    entries = {}
    for value in values:
        label, separator, path = value.partition("=")
        if not separator or not label or not path or label in entries:
            raise ValueError("inputs must have unique NAME=PATH assignments")
        entries[label] = Path(path).resolve(strict=True)
    return entries


def host_info():
    host = {"os": platform.system(), "architecture": platform.machine(),
            "kernel": platform.release(), "logical_cpus": None, "ram_bytes": None}
    if host["os"] == "Darwin":
        power_lines = command("pmset", "-g", "ps").splitlines()
        host.update(
            os_version=command("sw_vers", "-productVersion"),
            os_build=command("sw_vers", "-buildVersion"),
            machine_model=command("sysctl", "-n", "hw.model"),
            logical_cpus=int(command("sysctl", "-n", "hw.logicalcpu")),
            ram_bytes=int(command("sysctl", "-n", "hw.memsize")),
            power_source=power_lines[0] if power_lines else None,
        )
    return host


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", action="append", default=[], metavar="NAME=PATH")
    parser.add_argument("--binary", action="append", default=[], metavar="NAME=PATH")
    parser.add_argument("--schema-file", action="append", default=[], metavar="NAME=PATH")
    args = parser.parse_args()
    try:
        cwd_revision = command("git", "rev-parse", "HEAD")
        cwd_changed = bool(command("git", "status", "--porcelain"))
        result = {
            "schema_version": "omc-local-dev/environment/1",
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "collector_revision": cwd_revision,
            "collector_worktree_changed": cwd_changed,
            "host": host_info(),
            "apps": {key: app_info(path) for key, path in named(args.app).items()},
            "binary_sha256": {key: sha256(path) for key, path in named(args.binary).items()},
            "schema_sha256": {key: sha256(path) for key, path in named(args.schema_file).items()},
        }
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
