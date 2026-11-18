"""Keep the immutable published measurements intact when reorganizing their files."""
import csv
import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / 'docs/benchmarks/results/2026-11-18'
COUNTS = {'LD01': 8, 'LD02': 4, 'LD03': 16, 'LD04': 11, 'LD05': 8,
          'LD06': 10, 'LD07': 2, 'LD08': 9, 'LD09': 7, 'LD11': 3}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode()).hexdigest()


class PublishedResultsTests(unittest.TestCase):
    def test_all_original_json_records_and_provenance_are_preserved(self):
        records = []
        metadata = []
        for workload, count in COUNTS.items():
            data = json.loads((RESULTS / workload / 'attempts.json').read_text())
            self.assertEqual(len(data['attempts']), count)
            self.assertTrue(all(row['result']['workload_id'] == workload for row in data['attempts']))
            records.extend(data.pop('attempts'))
            metadata.append(data)
        self.assertEqual(len({row['attempt_id'] for row in records}), 78)
        self.assertTrue(all(value == metadata[0] for value in metadata))
        self.assertEqual(metadata[0]['measurement_source_commit'],
                         'c0a63518b9f084b6ab18a52cb1a99698efbf3c75')
        # Canonical digest of the original combined JSON, before this file reorganization.
        self.assertEqual(digest(records), '4f066e42566e7805089e8b69f3d1cfec198edd93dc32440e39437232febf02e4')

    def test_every_original_csv_field_and_row_is_preserved(self):
        rows = []
        for workload, count in COUNTS.items():
            with (RESULTS / workload / 'attempts.csv').open(newline='') as stream:
                group = list(csv.DictReader(stream))
            self.assertEqual(len(group), count)
            self.assertTrue(all(row['workload'] == workload for row in group))
            rows.extend(group)
        self.assertEqual(len({row['attempt_id'] for row in rows}), 78)
        self.assertEqual(digest(rows), 'f30a8f05e8625b59238609735660da0360ce4ffd93b56836ffdbe43c5a0a990f')

    def test_incomplete_experiments_have_status_pages_without_invented_data(self):
        self.assertFalse((RESULTS / 'attempts.csv').exists())
        self.assertFalse((RESULTS / 'attempts.json').exists())
        for workload in ['LD10', 'LD12', 'LD13']:
            self.assertTrue((RESULTS / workload / 'README.md').is_file())
            self.assertFalse((RESULTS / workload / 'attempts.csv').exists())
            self.assertFalse((RESULTS / workload / 'attempts.json').exists())
        earlier = json.loads((RESULTS / 'LD03/earlier-tokens.json').read_text())
        self.assertEqual(set(earlier['products']), {'OMC', 'Paper', 'Figma', 'Penpot'})


if __name__ == '__main__':
    unittest.main()
