"""Build a reproducible, paired pilot schedule from frozen fixture hashes."""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import random
import re


PRIMARY = tuple(f"LD{index:02}" for index in range(1, 7))
PRODUCTS = ("omc-native", "paper-desktop", "figma-remote", "penpot-local")
SHA = re.compile(r"[0-9a-f]{64}")


def pilot_schedule(fixtures, seed):
    if not isinstance(fixtures, list):
        raise ValueError("expected a fixture manifest array")
    grouped = defaultdict(list)
    ids = set()
    hashes = set()
    for fixture in fixtures:
        family = fixture.get("source_family_id")
        digest = fixture.get("fixture_sha256")
        if (not isinstance(family, str) or not family or family in ids
                or not isinstance(digest, str) or not SHA.fullmatch(digest) or digest in hashes):
            raise ValueError("fixture families and SHA-256 hashes must be unique")
        ids.add(family)
        hashes.add(digest)
        grouped[fixture.get("workload_id")].append((family, digest))
    if set(grouped) != set(PRIMARY) or any(len(grouped[workload]) != 2 for workload in PRIMARY):
        raise ValueError("pilot requires two distinct planned fixture families per LD01–LD06 workload")

    rng = random.Random(seed)
    blocks = []
    # Williams order: each arm uses each position once per workload and each
    # ordered pair occurs once as adjacent arms across the four paired blocks.
    shape = (0, 1, 3, 2)
    for workload in PRIMARY:
        products = list(PRODUCTS)
        rng.shuffle(products)
        families = sorted(grouped[workload])
        rng.shuffle(families)
        rotations = list(range(len(PRODUCTS)))
        rng.shuffle(rotations)
        for index, rotation in enumerate(rotations):
            family, digest = families[index % len(families)]
            blocks.append({
                "paired_block_id": f"{workload}-{index + 1}",
                "workload_id": workload,
                "source_family_id": family,
                "fixture_sha256": digest,
                "replicate": 1 + index // len(families),
                "product_order": [products[(item + rotation) % len(products)] for item in shape],
            })
    rng.shuffle(blocks)
    result = {"schema_version": "omc-local-dev/pilot-schedule/1", "seed": seed, "paired_blocks": blocks,
              "planned_attempts": len(blocks) * len(PRODUCTS)}
    canonical = json.dumps(result, sort_keys=True, separators=(",", ":"))
    return {**result, "schedule_sha256": hashlib.sha256(canonical.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.fixtures.read_text(encoding="utf-8"))
        schedule = pilot_schedule(manifest, args.seed)
    except (OSError, ValueError, AttributeError) as error:
        parser.error(str(error))
    print(json.dumps(schedule, indent=2))


if __name__ == "__main__":
    main()
