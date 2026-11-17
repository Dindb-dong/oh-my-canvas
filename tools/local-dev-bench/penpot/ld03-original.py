"""Grade the original Penpot LD03 path before the separate copy probe."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workloads"))
from synthetic import _phase, fixture


def main(path):
    contract = fixture("LD03", "field-relay")
    observed = json.loads(Path(path).read_text(encoding="utf-8"))
    failures = []
    snapshots = [
        _phase(phase, contract[spec], observed.get(phase), failures)
        for phase, spec in (("before", "start"), ("candidate", "expected"), ("reopened", "expected"))
    ]
    if all(snapshots) and any(state != snapshots[0] for state in snapshots[1:]):
        failures.append("Original document or native identity changed after edit or reopen")
    print(json.dumps({"scope": "original-edit-and-reopen", "passed": not failures, "failures": failures}))
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
