import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from conversation_learning import replay_metrics
from experience import ExperienceService
from tracing import TraceStore


class ExperimentRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'MODELS', folder / 'models'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='isolated scanner stub')]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.service = ExperienceService(support_api)
        self.records = self.service.learning.experiments
        for identifier in ('PROJECT-TEST', 'PROJECT-OTHER'):
            support_api.save('corpus', identifier, {'id': identifier, 'files': [], 'totals': {}})
        for index in range(37):
            record = {'id': f'LEARN-TEST-{index:03}', 'projectId': 'PROJECT-TEST', 'status': 'completed', 'createdAt': f'2026-10-14T00:00:{index:02}+00:00', 'total': 5, 'completed': 5, 'trainCount': 30, 'trainingPercent': (25, 60, 100)[index % 3], 'sourceHash': 'isolated-source', 'caseHash': 'isolated-case', 'protocol': 'isolated', 'traceId': 'isolated-trace', 'results': [{'isolated': True}], 'metrics': replay_metrics([], 5)}
            support_api.save('cx_replay', record['id'], record)
        other = {**record, 'id': 'LEARN-OTHER', 'projectId': 'PROJECT-OTHER'}
        support_api.save('cx_replay', other['id'], other)

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def listing(self, **changes):
        return self.records.listing({key: [value] for key, value in {'project': 'PROJECT-TEST', **changes}.items()})

    def update(self, identifier='LEARN-TEST-036', revision=0, **changes):
        return self.service.post('/api/support/experience/experiment-update', {'projectId': 'PROJECT-TEST', 'id': identifier, 'revision': revision, **changes})

    def archive(self, entries=None, **changes):
        return self.service.post('/api/support/experience/experiment-archive', {'projectId': 'PROJECT-TEST', 'records': entries or [{'id': 'LEARN-TEST-036', 'revision': 0}], 'archived': True, 'confirmed': True, **changes})

    def test_every_historical_record_is_paged_and_searchable(self):
        first = self.listing()
        self.assertEqual((first['total'], first['pages'], len(first['records'])), (37, 4, 10))
        identifiers = [record['id'] for page in range(1, 5) for record in self.listing(page=str(page))['records']]
        self.assertEqual(len(set(identifiers)), 37)
        self.assertEqual(identifiers[0], 'LEARN-TEST-036')
        self.assertEqual(self.listing(q='test-000')['records'][0]['id'], 'LEARN-TEST-000')
        self.assertEqual(self.listing(page='999')['page'], 4)
        self.assertEqual(self.listing(q='missing')['pages'], 1)
        self.assertEqual(self.listing(project='PROJECT-OTHER')['total'], 1)
        self.assertNotIn('results', first['records'][0])
        self.assertNotIn('metrics', first['records'][0])
        self.assertEqual(self.service.learning.overview('PROJECT-TEST')['recordCount'], 37)

    def test_name_notes_favorites_filter_and_durable_metadata(self):
        before = support_api.get('cx_replay', 'LEARN-TEST-036')
        result = self.update(name='演示基线', note='本次补充分类样本', favorite=True)
        self.assertEqual(result['metadata']['revision'], 1)
        self.assertEqual(self.listing(q='分类样本', scope='favorites', training='25')['total'], 1)
        self.assertEqual(self.listing(status='running')['total'], 0)
        self.assertEqual(self.listing(scope='favorites')['counts']['favorites'], 1)
        support_api.save('cx_replay', before['id'], before)
        reopened = ExperienceService(support_api).learning.overview('PROJECT-TEST', before['id'])
        self.assertEqual(reopened['run']['metadata']['name'], '演示基线')
        self.assertEqual(reopened['history'][-1]['metadata']['name'], '演示基线')
        self.assertEqual(before, support_api.get('cx_replay', before['id']))
        self.update(revision=1, name='', note='', favorite=False)
        self.assertEqual(self.listing()['records'][0]['metadata']['name'], '小样本基线 · 5例回放')
        self.assertEqual(self.listing(scope='favorites')['total'], 0)
        support_api.local_scan.assert_any_call(['演示基线'])

    def test_archive_is_reversible_preserves_history_and_exact_links(self):
        snapshot = copy.deepcopy(support_api.records('cx_replay'))
        before_history = self.service.learning.overview('PROJECT-TEST')['history']
        self.update(favorite=True)
        self.archive([{'id': 'LEARN-TEST-036', 'revision': 1}, {'id': 'LEARN-TEST-035', 'revision': 0}])
        self.assertEqual(self.listing()['total'], 35)
        self.assertEqual(self.listing()['counts'], {'all': 37, 'active': 35, 'favorites': 0, 'archived': 2})
        self.assertEqual(self.listing(scope='archived')['total'], 2)
        self.assertEqual(self.service.learning.overview('PROJECT-TEST')['run']['id'], 'LEARN-TEST-034')
        archived = self.service.learning.overview('PROJECT-TEST', 'LEARN-TEST-036')
        self.assertTrue(archived['run']['metadata']['archived'])
        self.assertEqual(len(archived['history']), len(before_history))
        self.assertEqual([item['form'] for item in archived['history']], [item['form'] for item in before_history])
        self.archive([{'id': 'LEARN-TEST-036', 'revision': 2}], archived=False)
        self.assertEqual(self.listing(scope='favorites')['total'], 1)
        self.assertEqual(snapshot, support_api.records('cx_replay'))
        self.assertEqual(ExperienceService(support_api).learning.experiments.listing({'project': ['PROJECT-TEST'], 'scope': ['archived']})['total'], 1)

    def test_all_archived_does_not_silently_show_another_projects_run(self):
        self.archive([{'id': f'LEARN-TEST-{index:03}', 'revision': 0} for index in range(37)])
        self.assertIsNone(self.service.learning.overview('PROJECT-TEST')['run'])
        self.assertEqual(self.listing()['total'], 0)
        self.assertEqual(self.listing(scope='archived')['total'], 37)
        self.assertIsNotNone(self.service.learning.overview('PROJECT-TEST', 'LEARN-TEST-000')['run'])

    def test_batch_is_atomic_for_stale_or_cross_project_entries(self):
        for invalid in [{'id': 'LEARN-TEST-035', 'revision': 2}, {'id': 'LEARN-OTHER', 'revision': 0}, {'id': 'MISSING', 'revision': 0}]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.archive([{'id': 'LEARN-TEST-036', 'revision': 0}, invalid])
            self.assertEqual(support_api.records('cx_replay_meta'), [])
        self.update(name='版本命名')
        with self.assertRaises(ValueError):
            self.update(note='旧页面的备注')
        self.assertEqual(self.listing()['records'][0]['metadata']['note'], '')

    def test_running_experiment_may_be_named_but_cannot_be_hidden(self):
        run = support_api.get('cx_replay', 'LEARN-TEST-036')
        run['status'] = 'running'
        support_api.save('cx_replay', run['id'], run)
        self.update(name='运行中实验')
        with self.assertRaises(ValueError):
            self.archive([{'id': run['id'], 'revision': 1}])
        self.assertEqual(self.listing(status='running')['total'], 1)

    def test_invalid_inputs_credentials_and_scanner_failure_never_persist(self):
        for changes in [{'name': None}, {'note': '字' * 501}, {'name': '字' * 81}, {'favorite': 1}, {'metrics': {}}, {'archived': True}, {'revision': True, 'name': '命名'}, {'name': 'api' + '_key: ' + 'x' * 24}]:
            with self.subTest(fields=list(changes)), self.assertRaises(ValueError):
                self.update(**changes)
        with patch.object(support_api, 'local_scan', side_effect=ValueError('scanner unavailable')), self.assertRaises(ValueError):
            self.update(name='安全检查失败')
        self.assertEqual(support_api.records('cx_replay_meta'), [])
        for changes in [{'confirmed': False}, {'archived': 'true'}, {'records': [{'id': 'LEARN-TEST-036', 'revision': 0}] * 2}, {'records': [{'id': [], 'revision': 0}]}, {'extra': 'bad'}]:
            with self.subTest(fields=list(changes)), self.assertRaises(ValueError):
                self.archive(**changes)
        for changes in [{'project': 'MISSING'}, {'page': '0'}, {'page': '-1'}, {'page': '1.2'}, {'scope': 'other'}, {'status': 'bad'}, {'training': '50'}, {'q': 'x' * 201}]:
            with self.subTest(fields=list(changes)), self.assertRaises(ValueError):
                self.listing(**changes)
        self.assertEqual(support_api.records('cx_replay_meta'), [])


if __name__ == '__main__':
    unittest.main()
