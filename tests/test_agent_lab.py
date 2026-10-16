import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from agent_lab import AgentLab, ACTIONS, CANDIDATE_PROMPT, PROTOCOL, digest, extract_case, group_split, metrics, valid_candidate, valid_judgment
from aftersales_provider import ProviderVault, ProviderError
from tracing import TraceStore


def synthetic_session(identifier='SAMPLE-ONE', participant='GROUP-ONE'):
    return {'id': identifier, 'datasetId': 'test-corpus', 'title': '测试构造的匿名故障', 'provenance': {'participant': participant}, 'labelSummary': {'values': {'intent': ['fault_repair'], 'is_invalid': ['否']}, 'conflicts': []}, 'messages': [{'id': 'question', 'role': 'user', 'content': '设备开机之后持续黑屏，已经检查了电源。', 'metadata': {}}, {'id': 'greeting', 'role': 'human', 'content': '您好，很高兴为您服务，正在查看您的问题', 'metadata': {}}, {'id': 'answer', 'role': 'human', 'content': '请问设备具体是什么型号？', 'metadata': {}}, {'id': 'future', 'role': 'user', 'content': '这是不应该进入候选上下文的后续信息。', 'metadata': {}}]}


class DataProtocolTests(unittest.TestCase):
    def test_target_excludes_greeting_and_future(self):
        case, reason = extract_case(synthetic_session())
        self.assertIsNone(reason)
        self.assertEqual(case['reference']['id'], 'answer')
        self.assertEqual([message['id'] for message in case['prefix']], ['question', 'greeting'])
        self.assertNotIn('future', [message['id'] for message in case['prefix']])
        self.assertEqual(len(case['sourceSnapshot']['messages']), 4)
        self.assertEqual(case['action'], 'clarify')

    def test_invalid_and_conflicting_sessions_excluded(self):
        session = synthetic_session()
        session['labelSummary']['values']['is_invalid'] = ['是']
        self.assertEqual(extract_case(session)[1], 'invalid')
        session['labelSummary']['values']['is_invalid'] = ['否']
        session['labelSummary']['conflicts'] = ['intent']
        self.assertEqual(extract_case(session)[1], 'ambiguous_intent')

    def test_group_split_connects_customer_and_duplicates(self):
        cases = [{'sessionId': 'ONE', 'participant': 'P1', 'requestGroup': 'Q1'}, {'sessionId': 'TWO', 'participant': 'P1', 'requestGroup': 'Q2'}, {'sessionId': 'THREE', 'participant': 'P2', 'requestGroup': 'Q2'}, {'sessionId': 'FOUR', 'participant': 'P3', 'requestGroup': 'Q3'}]
        first = group_split(copy.deepcopy(cases))
        second = group_split(copy.deepcopy(list(reversed(cases))))
        self.assertEqual(len({case['split'] for case in first[:3]}), 1)
        self.assertEqual(len({case['group'] for case in first[:3]}), 1)
        self.assertEqual({case['sessionId']: case['split'] for case in first}, {case['sessionId']: case['split'] for case in second})

    def test_no_media_false_positive_for_empty_attachment_counts(self):
        session = synthetic_session()
        session['messages'][0]['metadata']['attachments'] = {'img': 0, 'video': 0}
        self.assertFalse(extract_case(session)[0]['contextLimited'])
        session['messages'][0]['metadata']['attachments']['img'] = 1
        self.assertTrue(extract_case(session)[0]['contextLimited'])

    def test_candidate_rejects_unknown_actions_empty_or_excess_fields(self):
        good = {'intent': 'fault_repair', 'action': 'clarify', 'answer': '请描述现象。'}
        self.assertEqual(valid_candidate(good), good)
        for value in [[], {**good, 'action': 'execute_payment'}, {**good, 'answer': ''}, {**good, 'extra': 'unwanted'}]:
            with self.assertRaises(ValueError):
                valid_candidate(value)

    def test_judge_strict_bounds_and_evidence(self):
        good = {'dimensions': {'relevance': 3, 'next_step': None, 'boundary': 4}, 'reason': '测试结论', 'evidenceIds': ['question']}
        self.assertEqual(valid_judgment(good, {'question'}), good)
        for score in [True, 5, -1, float('nan'), 2.5]:
            candidate = copy.deepcopy(good)
            candidate['dimensions']['relevance'] = score
            with self.assertRaises(ValueError):
                valid_judgment(candidate, {'question'})
        with self.assertRaises(ValueError):
            valid_judgment({**good, 'evidenceIds': ['invented']}, {'question'})

    def test_metrics_missing_not_zero_or_success(self):
        value = metrics([], 10)
        self.assertIsNone(value['intentAccuracy'])
        self.assertIsNone(value['p95Ms'])
        self.assertIsNone(value['judge']['relevance']['mean'])
        self.assertEqual(value['pending'], 10)
        value = metrics([{'status': 'failed'}], 1)
        self.assertEqual(value['failed'], 1)
        self.assertEqual(value['completed'], 0)


class LabServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'MODELS', folder / 'models'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='synthetic test scanner stub')]
        for patcher in self.patchers:
            patcher.start()
        self.lab = AgentLab(support_api)
        support_api.initialize()
        self.bundle = {'id': 'BUNDLE-TEST', 'datasetId': 'test-corpus', 'createdAt': support_api.now(), 'splits': {'train': 10, 'validation': 5, 'test': 3}}
        support_api.save('lab_bundle', self.bundle['id'], self.bundle)
        self.versions = [{'id': 'V-ONE', 'name': '本地 v1', 'family': 'local-family', 'kind': 'local', 'provider': 'local', 'bundleId': self.bundle['id'], 'createdAt': support_api.now()}, {'id': 'V-TWO', 'name': '本地 v2', 'family': 'local-family', 'kind': 'local', 'provider': 'local', 'bundleId': self.bundle['id'], 'createdAt': support_api.now()}]
        for version in self.versions:
            support_api.save('lab_version', version['id'], version)
        for index in range(3):
            case, _ = extract_case(synthetic_session('CASE-' + str(index)))
            case.update(id='CASE-' + str(index), bundleId=self.bundle['id'], split='test', group='GROUP-' + str(index))
            support_api.save('lab_case', case['id'], case)

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def create(self, **changes):
        with patch('agent_lab.threading.Thread'):
            return self.lab.start_run({'bundleId': self.bundle['id'], 'versionIds': ['V-ONE', 'V-TWO'], 'count': 3, **changes})

    def finish_fake(self, run_id):
        run = support_api.get('lab_run', run_id)
        rows = []
        for case_id in run['caseIds']:
            case = support_api.get('lab_case', case_id)
            for version in run['versions']:
                rows.append({'caseId': case_id, 'sessionId': case['sessionId'], 'group': case['group'], 'versionId': version['id'], 'status': 'completed', 'intentMatch': True, 'actionMatch': version['id'] == 'V-TWO', 'expectedIntent': 'fault_repair', 'output': {'intent': 'fault_repair'}, 'latencyMs': 1})
        run.update(status='completed', results=rows, completed=len(rows))
        support_api.save('lab_run', run_id, run)
        return run

    def test_counts_selection_limits_and_no_training_cases(self):
        for count in [0, 4, 201, True, 1.5]:
            with self.assertRaises(ValueError):
                self.create(count=count)
        for ids in [['CASE-0', 'CASE-0'], ['UNKNOWN'], [], [{}]]:
            with self.assertRaises(ValueError):
                self.create(caseIds=ids)
        for ids in [[{}], ['V-ONE', 'V-ONE']]:
            with self.assertRaises(ValueError):
                self.create(versionIds=ids)
        self.assertEqual(self.create(count=2)['total'], 4)

    def test_case_hash_order_independent_and_rerun_lineage(self):
        first = self.create()
        parent = self.finish_fake(first['id'])
        rerun = self.create(caseIds=list(reversed(parent['caseIds'])), parentRunId=parent['id'])
        self.assertEqual(first['caseHash'], rerun['caseHash'])
        self.assertEqual(rerun['parentRunId'], parent['id'])
        self.assertEqual(len(support_api.get('lab_run', parent['id'])['results']), 6)

    def test_explicit_comparison_mode_guards_model_pair_and_count(self):
        for changes in [{'comparisonMode': 'horizontal'}, {'comparisonMode': 'invalid'}, {'comparisonMode': 'vertical', 'versionIds': ['V-ONE']}, {'comparisonMode': 'vertical', 'count': 1}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.create(**changes)
        self.assertEqual(support_api.records('lab_run'), [])
        started = self.create(comparisonMode='vertical', count=2)
        self.assertEqual(started['comparisonMode'], 'vertical')
        self.assertEqual(started['total'], 4)
        self.finish_fake(started['id'])
        other = {**self.versions[1], 'id': 'V-OTHER', 'family': 'different-family'}
        support_api.save('lab_version', other['id'], other)
        horizontal = self.create(versionIds=['V-ONE', 'V-OTHER'], comparisonMode='horizontal')
        self.assertEqual(horizontal['comparisonMode'], 'horizontal')

    def test_provider_difference_is_not_hidden_by_equal_family_labels(self):
        started = self.create()
        completed = self.finish_fake(started['id'])
        completed['versions'][1]['provider'] = 'different-provider'
        support_api.save('lab_run', completed['id'], completed)
        result = self.lab.compare({'sides': [{'runId': completed['id'], 'versionId': 'V-ONE'}, {'runId': completed['id'], 'versionId': 'V-TWO'}]})
        self.assertEqual(result['mode'], 'horizontal')

    def test_pair_comparison_and_mismatch_rejected(self):
        first = self.create()
        parent = self.finish_fake(first['id'])
        sides = [{'runId': parent['id'], 'versionId': 'V-ONE'}, {'runId': parent['id'], 'versionId': 'V-TWO'}]
        compared = self.lab.compare({'sides': sides})
        self.assertEqual(compared['wins'], 3)
        self.assertEqual(compared['delta'], 100)
        self.assertEqual(compared['mode'], 'vertical')
        self.assertEqual(compared['groups'], 3)
        second = self.create(count=2)
        self.finish_fake(second['id'])
        sides[1]['runId'] = second['id']
        with self.assertRaises(ValueError):
            self.lab.compare({'sides': sides})

    def test_failed_cases_excluded_from_paired_denominator(self):
        first = self.create()
        parent = self.finish_fake(first['id'])
        parent['results'][0]['status'] = 'failed'
        support_api.save('lab_run', parent['id'], parent)
        result = self.lab.compare({'sides': [{'runId': parent['id'], 'versionId': 'V-ONE'}, {'runId': parent['id'], 'versionId': 'V-TWO'}]})
        self.assertEqual(result['n'], 2)
        self.assertEqual(result['excluded'], 1)

    def test_cancel_does_not_run_next_case(self):
        first = self.create()
        self.lab.post('/api/support/lab/cancel', {'runId': first['id']})
        with patch.object(self.lab, 'evaluate_case') as runner:
            self.lab.execute(first['id'])
        runner.assert_not_called()
        self.assertEqual(support_api.get('lab_run', first['id'])['status'], 'cancelled')

    def test_restart_recovers_interrupted_without_success(self):
        first = self.create()
        self.lab.initialize()
        run = support_api.get('lab_run', first['id'])
        self.assertEqual(run['status'], 'interrupted')
        self.assertEqual(run['results'], [])

    def test_outbound_gate_fails_closed(self):
        first = self.create(versionIds=['V-ONE'])
        run = support_api.get('lab_run', first['id'])
        with patch.object(support_api, 'local_scan', side_effect=ValueError('unit-test blocked')), patch.object(self.lab, 'connection') as connect:
            with self.assertRaises(ValueError):
                self.lab.call(run, 'NO-CONNECTION', 'candidate', [{'role': 'user', 'content': 'anonymous'}])
            connect.assert_not_called()

    def test_external_requires_configuration_test_and_consent(self):
        version = {**self.versions[0], 'id': 'EXTERNAL', 'kind': 'external', 'connectionId': 'CONNECTION', 'provider': 'deepseek', 'promptHash': digest(CANDIDATE_PROMPT)}
        support_api.save('lab_version', version['id'], version)
        with self.assertRaises(ValueError):
            self.create(versionIds=['EXTERNAL'])
        vault = MagicMock()
        vault.status.return_value = {'configured': True, 'tested': True, 'revision': 'revision'}
        self.lab.connections['CONNECTION'] = vault
        with self.assertRaises(ValueError):
            self.create(versionIds=['EXTERNAL'])
        vault.status.return_value['tested'] = False
        with self.assertRaises(ValueError):
            self.create(versionIds=['EXTERNAL'], consent=True)

    def test_external_candidate_receives_no_future_or_labels(self):
        first = self.create(versionIds=['V-ONE'])
        run = support_api.get('lab_run', first['id'])
        case = support_api.get('lab_case', run['caseIds'][0])
        version = {'id': 'EXTERNAL', 'kind': 'external', 'connectionId': 'CONNECTION'}
        response = {'content': json.dumps({'intent': 'fault_repair', 'action': 'clarify', 'answer': '请描述具体设备现象。'}), 'usage': {}}
        with patch.object(self.lab, 'call', return_value=response) as call:
            row = self.lab.evaluate_case(run, version, case)
        material = json.loads(call.call_args.args[3][1]['content'])
        self.assertEqual([message['id'] for message in material['prefix']], ['question', 'greeting'])
        self.assertNotIn('reference', material)
        self.assertNotIn('expectedIntent', material)
        self.assertEqual(row['status'], 'completed')
        self.assertFalse(row['sandbox']['productionExecuted'])
        self.assertIsNotNone(support_api.TRACE_STORE.get(row['traceId']))

    def test_configuration_never_persists_key(self):
        key = 'unit-test-placeholder-only'
        record = self.lab.configure({'provider': 'deepseek', 'name': '测试版本', 'family': '测试族', 'apiKey': key, 'candidateModel': 'test-model', 'judgeModel': 'test-judge', 'confirmed': True})
        self.assertNotIn(key, json.dumps(self.lab.state()))
        self.assertNotIn(key, json.dumps(support_api.records('lab_connection')))
        self.assertNotIn(key, json.dumps(support_api.records('lab_version')))
        self.assertFalse(self.lab.state()['connections'][0]['tested'])
        self.lab.post('/api/support/lab/connections/clear', {'id': record['id']})
        self.assertFalse(self.lab.state()['connections'][0]['configured'])

    def test_export_gate_and_full_snapshots(self):
        first = self.create()
        run = self.finish_fake(first['id'])
        payload = self.lab.get('/api/support/lab/runs/' + run['id'] + '/export', {})
        self.assertEqual(len(payload['cases']), 3)
        self.assertEqual(len(payload['cases'][0]['sourceSnapshot']['messages']), 4)
        self.assertNotIn('connectionRevisions', payload)
        with patch.object(support_api, 'local_scan', side_effect=ValueError('blocked')):
            with self.assertRaises(ValueError):
                self.lab.get('/api/support/lab/runs/' + run['id'] + '/export', {})


class ProviderContractTests(unittest.TestCase):
    def setUp(self):
        self.vault = ProviderVault()
        self.status = self.vault.configure({'provider': 'deepseek', 'apiKey': 'unit-test-placeholder-only', 'candidateModel': 'test-model', 'judgeModel': 'test-model', 'confirmed': True})

    def call_with(self, status=200, payload=None):
        response = MagicMock()
        response.status = status
        response.read.return_value = json.dumps(payload or {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"ok":true}'}}], 'usage': {'total_tokens': 3}}).encode()
        connection = MagicMock()
        connection.getresponse.return_value = response
        return patch('aftersales_provider.http.client.HTTPSConnection', return_value=connection), connection

    def test_no_redirect_or_raw_provider_error_echo(self):
        for status in [302, 401, 429, 500]:
            patcher, connection = self.call_with(status=status)
            with patcher, self.assertRaises(ProviderError) as error:
                self.vault.complete(self.status['revision'], 'judge', [])
            self.assertNotIn('unit-test-placeholder-only', str(error.exception))
            connection.close.assert_called_once()

    def test_incomplete_response_rejected(self):
        patcher, _ = self.call_with(payload={'choices': [{'finish_reason': 'length', 'message': {'content': '{"ok":'}}]})
        with patcher, self.assertRaises(ProviderError):
            self.vault.complete(self.status['revision'], 'judge', [])

    def test_success_and_secret_not_returned(self):
        patcher, _ = self.call_with()
        with patcher:
            result = self.vault.complete(self.status['revision'], 'judge', [], json_output=True)
        self.assertEqual(result['usage']['total_tokens'], 3)
        self.assertNotIn('unit-test-placeholder-only', json.dumps(result))

    def test_revision_and_clear(self):
        with self.assertRaises(ProviderError):
            self.vault.complete('stale-revision', 'judge', [])
        self.vault.clear()
        self.assertFalse(self.vault.status()['configured'])


if __name__ == '__main__':
    unittest.main()
