import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from dialogues import DialogueService
from dataset_labels import FIELDS, parse_filters


def fixture_session(index, dataset='LABEL-TEST', values=None, conflicts=None):
    return {'id': f'LABEL-CASE-{index:03}', 'title': f'匿名标签案例 {index}', 'datasetId': dataset, 'origin': 'user_imported', 'sourceLabel': '隔离构造数据', 'createdAt': '2026-10-20T00:00:00+00:00', 'updatedAt': '2026-10-20T00:00:00+00:00', 'messages': [{'id': f'LABEL-USER-{index}', 'role': 'user', 'content': f'匿名测试问题 {index}', 'traceId': None, 'at': None, 'metadata': {}}, {'id': f'LABEL-HUMAN-{index}', 'role': 'human', 'content': '匿名答复', 'traceId': None, 'at': None, 'metadata': {}}], 'labelSummary': {'values': values or {}, 'conflicts': conflicts or []}, 'annotationSets': [], 'completeness': '隔离测试构造'}


class DatasetLabelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.patcher = patch.object(support_api, 'DATABASE', self.folder / 'labels.sqlite3')
        self.patcher.start()
        with support_api.connection() as database:
            database.execute('CREATE TABLE documents(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))')
        self.service = DialogueService(support_api)
        self.service.initialize_index()
        support_api.save('corpus', 'LABEL-TEST', {'id': 'LABEL-TEST'})
        support_api.save('corpus', 'LABEL-OTHER', {'id': 'LABEL-OTHER'})
        for index in range(32):
            values = {'is_invalid': ['否'], 'direct_handoff': ['否'], 'intent': ['fault_repair'], 'emotion': ['平稳（正常沟通）'], 'product_line': ['类别-PRODUCTA'], 'fault_domain': ['硬件域'], 'type': ['报修'], 'kb_expectation': ['has_answer'], 'expected_system': ['类别-SYSTEMA'], 'knowledge_category': ['常见故障']}
            if index < 8:
                values['intent'] = ['complaint', 'fault_repair', 'complaint']
                values['emotion'] = ['不满（安抚话术）']
            if index >= 24:
                values.pop('knowledge_category')
            if index >= 30:
                values.pop('is_invalid')
                values.pop('direct_handoff')
            elif index >= 28:
                values['direct_handoff'] = ['是']
            elif index >= 26:
                values['is_invalid'] = ['是']
                values['direct_handoff'] = ['是']
            session = fixture_session(index, values=values, conflicts=['intent'] if index == 0 else [])
            support_api.save('imported_dialogue', session['id'], session)
        foreign = fixture_session(999, dataset='LABEL-OTHER', values={'intent': ['foreign-label']})
        support_api.save('imported_dialogue', foreign['id'], foreign)

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def listing(self, labels=None, **changes):
        query = {'dataset': ['LABEL-TEST'], 'facets': ['1'], **{key: [str(value)] for key, value in changes.items()}}
        if labels is not None:
            query['labels'] = [json.dumps(labels, ensure_ascii=False)]
        return self.service.sessions(query)

    def dimension(self, listing, field):
        return next(item for item in listing['facets']['dimensions'] if item['field'] == field)

    def test_all_rows_not_current_page_are_counted_without_project_leakage(self):
        first = self.listing()
        second = self.listing(page=2)
        self.assertEqual((first['total'], len(first['sessions']), len(second['sessions'])), (32, 20, 12))
        self.assertEqual(first['facets'], second['facets'])
        intent = self.dimension(first, 'intent')
        self.assertEqual({item['value']: item['count'] for item in intent['values']}, {'complaint': 8, 'fault_repair': 32})
        self.assertEqual(intent['covered'], 32)
        self.assertEqual(intent['multiValueSessions'], 8)
        self.assertEqual(intent['conflictSessions'], 1)
        self.assertEqual(first['facets']['projectTotal'], 32)

    def test_every_label_and_missing_count_matches_drilled_list(self):
        original = self.listing()
        for dimension in original['facets']['dimensions']:
            for value in dimension['values']:
                result = self.listing({dimension['field']: value['value']})
                self.assertEqual(result['total'], value['count'])
                self.assertEqual(result['facets']['total'], value['count'])
            missing = self.listing({dimension['field']: None})
            self.assertEqual(missing['total'], dimension['missing'])
        self.assertEqual(self.dimension(original, 'knowledge_category')['coverage'], .75)

    def test_scope_partition_is_explicit_and_does_not_drop_unknown(self):
        scopes = {item['id']: item['count'] for item in self.listing()['facets']['scopes']}
        self.assertEqual(scopes, {'all': 32, 'regular': 26, 'invalid': 2, 'handoff': 2, 'unclassified': 2})
        for scope, count in scopes.items():
            result = self.listing(scope=scope)
            self.assertEqual(result['total'], count)
            self.assertEqual(result['facets']['total'], count)
            self.assertEqual(result['facets']['scopes'], self.listing()['facets']['scopes'])

    def test_intersections_search_status_and_legacy_intent_share_denominator(self):
        filtered = self.listing({'intent': 'complaint', 'emotion': '不满（安抚话术）'}, scope='regular')
        self.assertEqual(filtered['total'], 8)
        self.assertTrue(all(item['ratio'] == 1 for item in self.dimension(filtered, 'intent')['values']))
        self.assertEqual(self.listing(intent='complaint')['total'], 8)
        searched = self.listing({'intent': 'complaint'}, q='LABEL-CASE-003')
        self.assertEqual(searched['total'], 1)
        self.assertEqual(searched['facets']['total'], 1)
        self.assertEqual(self.listing(status='label_conflict')['total'], 1)
        self.assertEqual(self.listing(scope='regular', status='invalid')['total'], 0)

    def test_empty_results_have_null_rates_not_fabricated_percentages(self):
        result = self.listing({'intent': 'not-present'})
        self.assertEqual(result['total'], 0)
        for dimension in result['facets']['dimensions']:
            self.assertIsNone(dimension['coverage'])
            self.assertEqual(dimension['values'], [])
            self.assertEqual(dimension['missing'], 0)

    def test_changed_labels_are_reindexed_and_source_records_are_not_modified(self):
        before = copy.deepcopy(support_api.records('imported_dialogue'))
        self.listing()
        self.assertEqual(before, support_api.records('imported_dialogue'))
        session = support_api.get('imported_dialogue', 'LABEL-CASE-003')
        session['labelSummary']['values']['intent'] = ['info_query']
        support_api.save('imported_dialogue', session['id'], session)
        self.assertEqual(self.listing({'intent': 'complaint'})['total'], 7)
        self.assertEqual(self.listing({'intent': 'info_query'})['total'], 1)

    def test_unknown_field_injection_and_malformed_filters_are_rejected(self):
        for labels in ('[]', '{bad', '{"intent": true}', '{"intent": 12}', '{"intent": ["complaint"]}', '{"password": "value"}', '{"intent\u0027)": "value"}', '{"intent": ""}'):
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                parse_filters({'labels': [labels]})
        with self.assertRaises(ValueError):
            self.listing(scope='unsupported')
        with self.assertRaises(ValueError):
            self.listing({'intent': 'complaint'}, intent='fault_repair')
        self.assertEqual(self.listing({'intent': "' OR 1=1 --"})['total'], 0)

    def test_only_registered_projects_can_request_facets(self):
        for dataset in ('', 'missing'):
            with self.subTest(dataset=dataset), self.assertRaises(ValueError):
                self.listing(dataset=dataset)
        result = self.service.sessions({})
        self.assertNotIn('facets', result)
        self.assertEqual(result['total'], 33)

    def test_final_label_summary_ignores_cancelled_or_draft_opinions(self):
        session = support_api.get('imported_dialogue', 'LABEL-CASE-000')
        session['annotationSets'] = [{'state': 'draft', 'cancelled': False, 'results': [{'field': 'intent', 'values': ['draft-only']}]}, {'state': 'final', 'cancelled': True, 'results': [{'field': 'intent', 'values': ['cancelled-only']}]}]
        support_api.save('imported_dialogue', session['id'], session)
        values = {item['value'] for item in self.dimension(self.listing(), 'intent')['values']}
        self.assertNotIn('draft-only', values)
        self.assertNotIn('cancelled-only', values)


if __name__ == '__main__':
    unittest.main()
