import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from modelops import ModelOpsService, metrics
from tracing import TraceStore
from trace_categories import describe


class ModelOpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='isolated scanner stub')]
        for patcher in self.patchers:
            patcher.start()
        support_api.TRACE_STORE.initialize()
        with support_api.connection() as database:
            database.execute('CREATE TABLE documents(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))')
        self.service = ModelOpsService(support_api)

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def post(self, action, **body):
        return self.service.post('/api/support/modelops/' + action, {'revision': self.service.state()['revision'], **body})

    def start(self):
        self.post('initialize', confirmed=True)

    def register(self, template='balanced'):
        self.post('register', template=template, name=f'匿名{template}版本')
        return self.service.state()['versions'][-1]['id']

    def candidate(self, template='balanced'):
        version = self.register(template)
        self.post('evaluate', versionId=version)
        self.post('canary', versionId=version, percent=50, confirmed=True)
        return version

    def replay(self, fault='none', count=20):
        self.post('replay', fault=fault, count=count, confirmed=True)
        return self.service.state()['batches'][-1]

    def test_initialization_executes_baseline_without_touching_business_data(self):
        support_api.save('corpus', 'private-project', {'private': 'untouched'})
        self.assertFalse(self.service.state()['initialized'])
        self.assertEqual(support_api.TRACE_STORE.all(), [])
        self.start()
        state = self.service.state()
        self.assertEqual((state['evaluations'][0]['passed'], state['evaluations'][0]['total']), (7, 8))
        self.assertTrue(state['versions'][0]['gate']['passed'])
        self.assertEqual(state['metrics']['total'], 0)
        self.assertEqual(len(support_api.TRACE_STORE.all()), 9)
        self.assertEqual(support_api.get('corpus', 'private-project'), {'private': 'untouched'})
        with self.assertRaises(ValueError):
            self.start()
        self.assertEqual(ModelOpsService(support_api).state(), self.service.state())

    def test_actual_labels_not_fed_to_executor(self):
        self.start()
        state = self.service.state()
        case = copy.deepcopy(state['cases'][0])
        case['expected'] = 'reject'
        result = self.service.run_case(state, state['versions'][0], case)
        self.assertEqual(result['primary']['action'], 'lookup')
        self.assertFalse(result['primaryOk'])
        self.assertFalse(result['fallback'])

    def test_gate_blocks_missing_failed_and_tampered_evidence(self):
        self.start()
        version = self.register('unsafe')
        with self.assertRaisesRegex(ValueError, '门禁'):
            self.post('canary', versionId=version, percent=50, confirmed=True)
        self.post('evaluate', versionId=version)
        evaluation = self.service.state()['evaluations'][-1]
        self.assertEqual(evaluation['criticalPassed'], 2)
        self.assertFalse(evaluation['gatePassed'])
        with self.assertRaisesRegex(ValueError, '门禁'):
            self.post('canary', versionId=version, percent=50, confirmed=True)
        workspace = self.service.workspace()
        workspace['versions'][-1]['config']['retry'] = 8
        support_api.save('modelops_workspace', 'sandbox', workspace)
        with self.assertRaisesRegex(ValueError, '指纹'):
            self.post('evaluate', versionId=version)

    def test_gray_release_promotion_and_rollback_are_real_persisted_transitions(self):
        self.start()
        baseline = self.service.state()['release']['stable']
        version = self.candidate()
        with self.assertRaises(ValueError):
            self.post('promote', confirmed=True)
        batch = self.replay()
        self.assertEqual({event['versionId'] for event in batch['events']}, {baseline, version})
        self.assertTrue(self.service.state()['promotion']['allowed'])
        self.post('promote', confirmed=True)
        release = self.service.state()['release']
        self.assertEqual((release['stable'], release['previous'], release['candidate']), (version, baseline, None))
        self.post('rollback', reason='匿名回滚检查', confirmed=True)
        self.assertEqual(self.service.state()['release']['stable'], baseline)
        self.assertEqual(len(self.service.state()['batches']), 1)
        with self.assertRaises(ValueError):
            self.post('rollback', reason='无法继续回滚', confirmed=True)

    def test_shared_tool_failures_are_not_hidden_by_fallback(self):
        self.start()
        self.candidate()
        batch = self.replay('transient_tool')
        self.assertEqual(batch['metrics']['primaryRate'], 0)
        self.assertEqual(batch['metrics']['finalRate'], 0)
        self.assertGreater(batch['metrics']['fallback'], 0)
        self.assertIsNotNone(batch['alert'])
        self.assertFalse(self.service.state()['promotion']['allowed'])
        self.assertEqual(len(self.service.state()['issues']), 2)
        self.assertEqual(sum(issue['occurrences'] for issue in self.service.state()['issues']), 20)
        self.replay('none')
        self.assertFalse(self.service.state()['promotion']['allowed'])
        event = batch['events'][0]
        trace = support_api.TRACE_STORE.get(event['traceId'])
        self.assertEqual(describe(trace)['category'], 'modelops')
        self.assertGreater(trace['errorCount'], 0)
        self.assertGreater(event['durationMs'], 0)

    def test_resilient_stable_can_fallback_without_hiding_candidate_failure(self):
        self.start()
        stable = self.candidate('resilient')
        self.replay()
        self.post('promote', confirmed=True)
        self.candidate('balanced')
        batch = self.replay('transient_tool')
        self.assertLess(batch['metrics']['primaryRate'], 1)
        self.assertEqual(batch['metrics']['finalRate'], 1)
        self.assertEqual(self.service.state()['release']['stable'], stable)
        self.assertFalse(self.service.state()['promotion']['allowed'])

    def test_feedback_invalidates_gates_and_retests_same_fault_before_closing(self):
        self.start()
        self.candidate()
        self.replay('transient_tool')
        issue = self.service.state()['issues'][0]
        with self.assertRaisesRegex(ValueError, '归因'):
            self.post('feedback', issueId=issue['id'], confirmed=True)
        self.post('review', issueId=issue['id'], cause='tool', note='匿名只读工具首次失败，缺少重试')
        self.post('feedback', issueId=issue['id'], confirmed=True)
        state = self.service.state()
        self.assertTrue(all(not version['gate']['passed'] for version in state['versions']))
        self.assertEqual(state['cases'][-1]['fault'], 'transient_tool')
        with self.assertRaises(ValueError):
            self.post('feedback', issueId=issue['id'], confirmed=True)
        with self.assertRaises(ValueError):
            self.post('verify', issueId=issue['id'], versionId=state['versions'][1]['id'])
        failed_version = state['versions'][1]['id']
        self.post('evaluate', versionId=failed_version)
        self.assertFalse(self.service.state()['evaluations'][-1]['gatePassed'])
        fixed = self.register('resilient')
        self.post('evaluate', versionId=fixed)
        evaluation = self.service.state()['evaluations'][-1]
        self.assertEqual(evaluation['regressionPassed'], 1)
        self.post('verify', issueId=issue['id'], versionId=fixed)
        self.assertEqual(self.service.state()['issues'][0]['status'], 'closed')
        self.assertEqual(self.service.state()['issues'][0]['verifications'][0]['evaluationId'], evaluation['id'])
        self.assertEqual(self.service.state()['release']['candidate'], failed_version)

    def test_persistent_fault_cannot_be_repaired_by_one_retry(self):
        self.start()
        self.replay('persistent_tool')
        issue = self.service.state()['issues'][0]
        self.post('review', issueId=issue['id'], cause='tool', note='匿名持续故障证据')
        self.post('feedback', issueId=issue['id'], confirmed=True)
        fixed = self.register('resilient')
        self.post('evaluate', versionId=fixed)
        self.assertFalse(self.service.state()['evaluations'][-1]['gatePassed'])
        with self.assertRaises(ValueError):
            self.post('verify', issueId=issue['id'], versionId=fixed)

    def test_revision_conflicts_and_privacy_gate_fail_without_mutation(self):
        self.start()
        before = self.service.workspace()
        with patch.object(support_api, 'local_scan', side_effect=ValueError('scanner unavailable')):
            with self.assertRaises(ValueError):
                self.register()
        self.assertEqual(before, self.service.workspace())
        with self.assertRaisesRegex(ValueError, '变化'):
            self.service.post('/api/support/modelops/register', {'revision': 0, 'template': 'balanced', 'name': '匿名版本'})
        self.assertEqual(before, self.service.workspace())
        revision = before['revision']
        def concurrent_register():
            try:
                self.service.post('/api/support/modelops/register', {'revision': revision, 'template': 'balanced', 'name': '并发匿名版本'})
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda index: concurrent_register(), range(2)))
        self.assertEqual(sum(results), 1)

    def test_request_schema_is_strict(self):
        for confirmation in ('true', 1, False, None):
            with self.subTest(confirmation=confirmation), self.assertRaises(ValueError):
                self.post('initialize', confirmed=confirmation)
        self.start()
        for body in ({'count': True, 'fault': 'none'}, {'count': 50000, 'fault': 'none'}, {'count': 10, 'fault': []}, {'count': 10, 'fault': 'none', 'externalUrl': 'invalid'}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.post('replay', confirmed=True, **body)
        with self.assertRaises(ValueError):
            self.post('register', template=[], name='匿名')

    def test_metrics_use_actual_denominators_and_nearest_rank(self):
        self.assertIsNone(metrics([])['primaryRate'])
        self.assertIsNone(metrics([])['p95Ms'])
        events = [{'primaryOk': index < 10, 'finalOk': True, 'fallback': index >= 10, 'durationMs': index + 1} for index in range(20)]
        measured = metrics(events)
        self.assertEqual((measured['primaryRate'], measured['finalRate'], measured['fallbackRate'], measured['p95Ms']), (.5, 1, .5, 19))
        self.assertIsNone(measured['cost'])

    def test_dispatch_get_contract(self):
        with patch.object(support_api, 'MODELOPS', self.service):
            payload, content_type, filename = support_api.dispatch_get('/api/support/modelops/state', {})
            self.assertFalse(payload['initialized'])
            self.assertIsNone(content_type)
            self.assertIsNone(filename)


if __name__ == '__main__':
    unittest.main()
