from collections import Counter
import hashlib
from itertools import pairwise
import unittest

from schedule import PRIMARY, PRODUCTS, pilot_schedule


class PilotScheduleTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = [
            {"workload_id": workload, "source_family_id": f"{workload}-{family}",
             "fixture_sha256": hashlib.sha256(f"{workload}-{family}".encode()).hexdigest()}
            for workload in PRIMARY for family in ("a", "b")
        ]

    def test_blocks_balance_positions_and_adjacent_products(self):
        result = pilot_schedule(self.fixtures, 7)
        self.assertEqual(result["planned_attempts"], 96)
        self.assertEqual(result, pilot_schedule(list(reversed(self.fixtures)), 7))
        self.assertNotEqual(result["schedule_sha256"], pilot_schedule(self.fixtures, 8)["schedule_sha256"])
        for workload in PRIMARY:
            blocks = [block for block in result["paired_blocks"] if block["workload_id"] == workload]
            self.assertEqual(sorted(Counter(block["source_family_id"] for block in blocks).values()), [2, 2])
            for position in zip(*(block["product_order"] for block in blocks)):
                self.assertCountEqual(position, PRODUCTS)
            adjacent = [pair for block in blocks for pair in pairwise(block["product_order"])]
            self.assertCountEqual(adjacent, [(a, b) for a in PRODUCTS for b in PRODUCTS if a != b])

    def test_rejects_duplicate_or_missing_fixture_families(self):
        with self.assertRaisesRegex(ValueError, "two distinct"):
            pilot_schedule(self.fixtures[1:], 7)
        with self.assertRaisesRegex(ValueError, "unique"):
            pilot_schedule(self.fixtures[:-1] + self.fixtures[:1], 7)
