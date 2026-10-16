import unittest

from test_experience import support_api
from trace_categories import describe, listing


class TraceCategoryTests(unittest.TestCase):
    def summary(self, source='experience.replay', **changes):
        trace = {'id': 'isolated-test-trace', 'source': source, 'origin': 'local_instrumented', 'status': 'ok', 'issues': [], 'input': {}, 'attributes': {'runId': 'RUN-TEST'}, 'durationMs': 25, 'startedAt': '2026-10-14T00:00:00Z', **changes}
        return support_api.trace_summary(trace)

    def test_classification_covers_sources_and_preserves_external_origin(self):
        self.assertEqual(self.summary()['category'], 'text_eval')
        self.assertEqual(self.summary('experience.rca.review')['category'], 'rca')
        self.assertIn('不是人工', self.summary('quality.review')['durationScope'])
        self.assertEqual(self.summary(origin='external_reported')['category'], 'external')
        self.assertEqual(self.summary('unknown')['category'], 'other')

    def test_batch_search_combined_filters_and_counts_are_consistent(self):
        rows = [self.summary(), self.summary('quality.judge', status='error', durationMs=2000), self.summary('experience.learning', durationMs=None, status='interrupted')]
        selected = listing(rows, {'category': ['text_eval'], 'q': ['RUN-TEST']})
        self.assertEqual(selected['total'], 1)
        self.assertEqual(selected['stats']['total'], 1)
        self.assertEqual(sum(item['count'] for item in selected['categories']), 3)
        self.assertEqual(listing(rows, {'minMs': ['100']})['total'], 1)
        self.assertEqual(listing(rows, {'category': ['training']})['total'], 1)
        self.assertEqual(listing(rows, {'category': ['training'], 'minMs': ['100']})['total'], 0)
        self.assertEqual(listing(rows, {'status': ['error']})['stats']['errors'], 1)
        self.assertEqual(listing(rows, {'page': ['99']})['page'], 1)
        for query in [{'category': ['invalid']}, {'minMs': ['nan']}, {'minMs': ['-1']}]:
            with self.assertRaises(ValueError):
                listing(rows, query)


if __name__ == '__main__':
    unittest.main()
