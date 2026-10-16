import copy
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from experience import DIMENSIONS, RULE_VERSION, ExperienceService, operational_metrics, verdict_score
from tracing import TraceStore


def verdicts(value='clear'):
    return {dimension['id']: value for dimension in DIMENSIONS}


def outcome(identifier='ANON-TEST', **changes):
    return {'id': identifier, 'environment': 'production', 'source': '隔离测试来源', 'evidence': '隔离构造数据，不是业务结果', 'startedAt': '2026-09-01T01:00:00Z', 'closedAt': '2026-09-01T02:00:00Z', 'observedUntil': '2026-09-04T02:00:00Z', 'resolved': True, 'recontact': False, 'handoff': False, 'mustHandoff': False, 'unsafe': False, 'answered': True, 'ticketResolved': True, 'rating': None, 'tools': [], 'form': None, 'quality': None, **changes}


class MetricTests(unittest.TestCase):
    def test_dimensions_once_observation_zero_and_unknown(self):
        self.assertEqual(sum(len(item['items']) for item in DIMENSIONS), 21)
        self.assertEqual(verdict_score(verdicts()), 100)
        self.assertEqual(verdict_score({**verdicts(), 'proactive': 'violated', 'observe': 'violated'}), 90)
        self.assertEqual(verdict_score({**verdicts(), 'closure': 'violated'}), 85)
        self.assertEqual(verdict_score(verdicts('violated')), 0)
        self.assertEqual(verdict_score({**verdicts(), 'observe': 'unknown'}), 100)
        self.assertIsNone(verdict_score({**verdicts(), 'attitude': 'unknown'}))
        for invalid in [[], {}, {**verdicts(), 'extra': 'clear'}, {**verdicts(), 'risk': True}]:
            with self.assertRaises(ValueError):
                verdict_score(invalid)

    def test_maturity_complete_outcomes_and_sandbox_exclusion(self):
        current = datetime.datetime(2026, 9, 5, tzinfo=datetime.timezone.utc)
        records = [outcome(), outcome('UNKNOWN', resolved=None), outcome('SHORT', observedUntil='2026-09-03T02:00:00Z'), outcome('SANDBOX', environment='sandbox'), outcome('HANDOFF', mustHandoff=True, handoff=True), outcome('BAD', mustHandoff=True, unsafe=True), outcome('AGAIN', recontact=True)]
        result = operational_metrics(records, current)
        self.assertEqual(result['containment'], {'value': 25.0, 'numerator': 1, 'denominator': 4})
        self.assertEqual(result['unsafeInterception']['value'], 50)
        self.assertEqual((result['sessions'], result['sandbox'], result['mature'], result['missingOutcome']), (6, 1, 5, 1))
        self.assertIsNone(operational_metrics([], current)['containment']['value'])
        before = datetime.datetime(2026, 9, 4, 1, 59, tzinfo=datetime.timezone.utc)
        self.assertIsNone(operational_metrics([outcome()], before)['containment']['value'])

    def test_exact_forms_quality_and_explicit_ratings(self):
        records = [outcome(form={'expected': {'type': '故障', 'route': '维修'}, 'predicted': {'type': '故障'}}, quality={'ruleVersion': RULE_VERSION, 'expected': False, 'predicted': True}, rating=1), outcome('EXTRA', form={'expected': {'type': '故障'}, 'predicted': {'type': '故障', 'extra': '多余'}}, quality={'ruleVersion': RULE_VERSION, 'expected': True, 'predicted': True}, rating=5), outcome('MIDDLE', rating=3), outcome('NONE')]
        result = operational_metrics(records, datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc))
        self.assertEqual(result['formAccuracy'], {'value': 66.67, 'numerator': 2, 'denominator': 3})
        self.assertEqual(result['formExact']['value'], 0)
        self.assertEqual(result['qualityAccuracy']['value'], 50)
        self.assertEqual(result['satisfaction']['denominator'], 3)
        self.assertEqual(result['dsat']['numerator'], 1)


class ExperienceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'MODELS', folder / 'models'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='isolated scanner stub')]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.service = ExperienceService(support_api)
        for identifier in ('PROJECT-TEST', 'PROJECT-OTHER'):
            support_api.save('corpus', identifier, {'id': identifier, 'name': '隔离测试项目', 'intentDistribution': {'fault_repair': 2}})
        self.case = {'id': 'QC-TEST', 'projectId': 'PROJECT-TEST', 'sourceRow': 2, 'channel': '在线', 'machineExcerpt': '隔离测试机审摘录，无完整对话。', 'originalScore': 80, 'suggestedScore': 85, 'opinion': '不发送的人工意见', 'revision': 1, 'review': None, 'history': []}
        support_api.save('qc_case', self.case['id'], self.case)
        support_api.save('qc_rule', RULE_VERSION, {'text': '隔离构造规则，仅用于自动化测试'})

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def ingest(self, rows, project='PROJECT-TEST'):
        return self.service.ingest_outcomes({'projectId': project, 'confirmed': True, 'records': rows})

    def test_import_is_atomic_idempotent_and_project_scoped(self):
        self.ingest([outcome(rating=1)])
        self.ingest([outcome(rating=1)])
        self.assertEqual(len(support_api.records('cx_outcome')), 1)
        rca = support_api.records('cx_rca')[0]
        self.assertIsNone(rca['primary'])
        self.assertEqual(rca['status'], 'triage')
        with self.assertRaises(ValueError):
            self.ingest([outcome('NEW'), outcome(rating=5)])
        self.assertEqual(len(support_api.records('cx_outcome')), 1)
        self.ingest([outcome()], project='PROJECT-OTHER')
        self.assertEqual(self.service.state({'project': ['PROJECT-TEST']})['metrics']['sessions'], 1)
        self.assertEqual(self.service.state({'project': ['PROJECT-OTHER']})['qualityCounts']['total'], 0)

    def test_sandbox_not_business_score_or_dsat(self):
        self.ingest([outcome(environment='sandbox', rating=1)])
        state = self.service.state({})
        self.assertEqual(state['metrics']['sessions'], 0)
        self.assertIsNone(state['metrics']['containment']['value'])
        self.assertEqual(len(state['rca']), 0)

    def test_invalid_payloads_rejected_without_partial_records(self):
        invalids = [outcome(environment='demo'), outcome(rating=True), outcome(resolved='false'), outcome(mustHandoff=True, unsafe=False), outcome(traceId='invented'), outcome(traceId={}), outcome(expectedIntent={}), outcome(observedUntil='2026-09-01'), outcome(form={'expected': {}, 'predicted': {}, 'goldConfirmed': True}), outcome(quality={'expected': True, 'predicted': True, 'goldConfirmed': True, 'independent': False, 'ruleVersion': RULE_VERSION})]
        absent = outcome()
        del absent['handoff']
        invalids.append(absent)
        for invalid in invalids:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    self.ingest([outcome('FIRST'), invalid])
                self.assertEqual(len(support_api.records('cx_outcome')), 0)
        with self.assertRaises(ValueError):
            self.service.ingest_outcomes({'projectId': 'PROJECT-TEST', 'records': [outcome()]})

    def test_unknown_fields_not_persisted_and_times_normalized(self):
        self.ingest([outcome(extra='discarded', startedAt='2026-09-01T09:00:00+08:00')])
        saved = support_api.records('cx_outcome')[0]
        self.assertNotIn('extra', saved)
        self.assertEqual(saved['startedAt'], '2026-09-01T01:00:00+00:00')

    def test_review_preserves_sources_and_requires_current_revision(self):
        payload = {'id': self.case['id'], 'revision': 1, 'verdicts': {**verdicts(), 'closure': 'violated'}, 'reason': '隔离测试核实范围', 'reviewer': 'reviewer-test', 'confirmed': True}
        result = self.service.review(payload)
        self.assertEqual((result['originalScore'], result['suggestedScore'], result['review']['score']), (80, 85, 85))
        self.assertEqual(len(result['history']), 1)
        self.assertIsNotNone(support_api.TRACE_STORE.get(result['review']['traceId']))
        for changes in [{}, {'revision': True}, {'revision': 2, 'confirmed': False}, {'revision': 2, 'verdicts': verdicts('unknown')}]:
            with self.assertRaises(ValueError):
                self.service.review({**payload, **changes})
        self.assertIsNone(self.service.state({})['metrics']['qualityAccuracy']['value'])

    def test_rca_requires_evidence_and_actual_verification_workflow(self):
        self.ingest([outcome(rating=1)])
        record = support_api.records('cx_rca')[0]
        body = {'id': record['id'], 'revision': 1, 'primary': 'tool', 'contributors': ['engineering'], 'evidence': '隔离接口异常证据', 'counterfactual': '修复接口后验证可用性', 'action': '修复并回归测试', 'owner': 'test-team', 'status': 'confirmed'}
        body.update(reviewer='reviewer-test', confirmed=True, checks={key: {'verdict': 'supported', 'note': '隔离测试日志支持此原因'} for key in ('tool', 'engineering')})
        for changes in [{'evidence': ''}, {'contributors': ['tool']}, {'status': 'verified', 'verification': '隔离证据'}]:
            with self.assertRaises(ValueError):
                self.service.rca_save({**body, **changes})
        self.service.rca_save(body)
        self.service.rca_save({**body, 'revision': 2, 'status': 'fixing'})
        updated = self.service.rca_save({**body, 'revision': 3, 'status': 'verified', 'verification': '实际测试编号为TEST-REGRESSION'})
        self.assertEqual(len(updated['history']), 3)
        self.assertEqual(updated['status'], 'verified')

    def fake_connection(self):
        connection = MagicMock()
        connection.status.return_value = {'configured': True, 'tested': True, 'revision': 1, 'judgeModel': 'isolated-test-judge'}
        connection.complete.return_value = {'content': json.dumps({'verdicts': verdicts('unknown'), 'reason': '摘要不足以核实全部维度', 'evidenceIds': ['machine_excerpt']}), 'model': 'isolated-test-judge', 'usage': {'total_tokens': 1}}
        return connection

    def judge_body(self, **changes):
        return {'projectId': 'PROJECT-TEST', 'caseIds': [self.case['id']], 'count': 1, 'connectionId': 'CONN-TEST', 'consent': True, **changes}

    def test_judge_consent_counts_inputs_and_unknown_not_full_score(self):
        connection = self.fake_connection()
        with patch.object(support_api.LAB, 'connection', return_value=connection), patch('experience.threading.Thread'):
            for changes in [{'consent': False}, {'count': True}, {'count': 2}, {'caseIds': [self.case['id']] * 2}, {'projectId': 'PROJECT-OTHER'}]:
                with self.assertRaises(ValueError):
                    self.service.start_judge(self.judge_body(**changes))
            run = self.service.start_judge(self.judge_body())
            snapshots = [{'id': self.case['id'], 'channel': self.case['channel'], 'excerpt': self.case['machineExcerpt']}]
            self.service.execute_judge(run['id'], snapshots)
            sent = connection.complete.call_args.args[2][1]['content']
            self.assertNotIn('originalScore', sent)
            self.assertNotIn('suggestedScore', sent)
            self.assertNotIn(self.case['opinion'], sent)
            saved = support_api.get('qc_run', run['id'])
            self.assertEqual(saved['status'], 'completed')
            self.assertEqual(saved['completed'], 1)
            self.assertIsNone(saved['results'][0]['score'])
            self.assertEqual(saved['results'][0]['status'], 'completed')

    def test_judge_cancel_failure_and_recovery_do_not_invent_results(self):
        connection = self.fake_connection()
        with patch.object(support_api.LAB, 'connection', return_value=connection), patch('experience.threading.Thread'):
            run = self.service.start_judge(self.judge_body())
            self.service.post('/cancel', {'id': run['id']})
            self.service.execute_judge(run['id'], [self.case])
            connection.complete.assert_not_called()
            run = self.service.start_judge(self.judge_body())
            connection.complete.return_value['content'] = '{"unexpected":true}'
            self.service.execute_judge(run['id'], [self.case])
            result = support_api.get('qc_run', run['id'])['results'][0]
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(support_api.TRACE_STORE.get(result['traceId'])['status'], 'error')
            run = self.service.start_judge(self.judge_body())
            self.service.initialize()
            self.assertEqual(support_api.get('qc_run', run['id'])['status'], 'interrupted')

    def test_unknown_runs_not_replaced_with_other_scores(self):
        state = self.service.state({'run': ['EVAL-MISSING'], 'mmrun': ['MMRUN-MISSING']})
        self.assertIsNone(state['runId'])
        self.assertIsNone(state['vision'])
        self.assertTrue(state['requestedRunMissing'])
        self.assertTrue(state['requestedVisionMissing'])

    def test_unreviewed_vision_keeps_denominators_and_stays_separate(self):
        support_api.save('mm_run', 'MMRUN-TEST', {'id': 'MMRUN-TEST', 'createdAt': support_api.now(), 'status': 'completed', 'suite': 'calibration', 'versions': [{'id': 'TEST-MODEL', 'name': '隔离视觉测试'}], 'results': [], 'cases': [{'id': 'CASE-TEST', 'expectedRoute': 'must_handoff'}]})
        state = self.service.state({})
        metric = state['vision']['models'][0]['metrics']
        self.assertIsNone(metric['effectiveContainment']['value'])
        self.assertEqual(metric['effectiveContainment']['denominator'], 1)
        self.assertEqual(metric['mandatoryUnfinished'], 1)
        self.assertIsNone(state['metrics']['containment']['value'])


if __name__ == '__main__':
    unittest.main()
