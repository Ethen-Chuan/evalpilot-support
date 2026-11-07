import copy
import json
import subprocess
import unittest
from unittest.mock import patch

import test_customer_simulator as fixtures
from customer_simulator import CustomerSimulator, runtime_hash
from simulator_knowledge import BASE_DOCUMENTS, context_for, inspect_proposal, search
from simulator_rubric import apply_review, definition, score


class SimulatorGovernanceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CustomerSimulatorTests()
        self.fixture.setUp()
        self.simulator = self.fixture.simulator
        self.repo = fixtures.support_api

    def tearDown(self):
        self.fixture.tearDown()

    def refund_result(self):
        session = self.fixture.turn(self.fixture.create(scenarioId='SIM-REFUND'))
        turn = session['turns'][0]
        return {'output': turn['proposal'], 'events': turn['events'], 'durationMs': 1, 'steps': turn['steps'], 'finishReason': 'stop'}

    def inject(self, result):
        def run(payload, credential=None, on_event=None):
            if on_event:
                for event in result['events']:
                    on_event(event)
            return copy.deepcopy(result)
        return patch.object(self.simulator, 'run_harness', side_effect=run)

    def test_paraphrased_free_text_never_reaches_customer_or_future_context(self):
        result = self.refund_result()
        for answer in ['已为你退款，今天一定到账。', '这笔退款已经处理完成，款项今天必定进入你的账户。']:
            result['output'] = {'answer': answer, 'action': 'explain', 'intent': 'policy_inquiry'}
            session = self.fixture.create(scenarioId='SIM-REFUND')
            with self.inject(result):
                session = self.fixture.turn(session)
            turn = session['turns'][0]
            self.assertEqual(turn['publication']['status'], 'BLOCKED')
            self.assertNotIn(answer, turn['output']['answer'])
            self.assertEqual(turn['proposal']['answer'], answer)
            self.assertEqual(turn['evaluation']['rubric']['verdict'], 'BLOCK')
            self.assertEqual(len([item for item in self.repo.records('sim_regression') if item['sessionId'] == session['id']]), 1)
            with patch.object(self.simulator, 'run_harness', side_effect=ValueError('stop')) as harness:
                with self.assertRaises(ValueError):
                    self.fixture.turn(session, '请说明依据')
                history = harness.call_args.args[0]['history']
                self.assertNotIn(answer, json.dumps(history, ensure_ascii=False))

    def test_forged_citation_missing_evidence_and_wrong_action_block(self):
        good = self.refund_result()
        variants = [
            {**good, 'events': []},
            {**good, 'output': {**good['output'], 'evidenceIds': ['fake@1']}},
            {**good, 'output': {**good['output'], 'responseCodes': ['refund_progress', 'boundary', 'invented']}},
            {**good, 'output': {**good['output'], 'action': 'dispatch'}},
            {**good, 'output': {**good['output'], 'answer': '不应直接发布的额外文本'}},
        ]
        for result in variants:
            with self.subTest(proposal=result['output']), self.inject(result):
                session = self.fixture.turn(self.fixture.create(scenarioId='SIM-REFUND'))
                self.assertEqual(session['turns'][0]['publication']['status'], 'BLOCKED')

    def test_policy_validity_and_current_question_scope_are_verified(self):
        result = self.refund_result()
        scenario = next(item for item in fixtures.CASES if item['id'] == 'SIM-REFUND')
        context = context_for(scenario, scenario['question'], [])
        for change in [{'status': 'draft'}, {'expiresAt': '2026-01-01'}, {'effectiveFrom': '2099-01-01'}]:
            documents = [{**item, **change} if item['id'] == 'KB-REFUND' else item for item in BASE_DOCUMENTS]
            gate = inspect_proposal(result['output'], result['events'], documents, context, '2026-11-04', scenario['question'])
            self.assertFalse(gate['allowed'])
        gate = inspect_proposal(result['output'], result['events'], BASE_DOCUMENTS, context, '2026-11-04', '黑屏菜单怎么打开')
        self.assertFalse(gate['allowed'])

    def test_rubric_weights_anchors_missing_scores_and_human_evidence(self):
        rubric_definition = definition()
        self.assertEqual(sum(item['weight'] for item in rubric_definition['dimensions']), 100)
        self.assertTrue(all(len(item['anchors']) == 5 for item in rubric_definition['dimensions']))
        session = self.fixture.turn(self.fixture.create())
        turn = session['turns'][0]
        rubric = turn['evaluation']['rubric']
        self.assertEqual(rubric['automaticPoints'], 80)
        self.assertEqual(rubric['scoreRange'], [80, 100])
        self.assertIsNone(rubric['finalScore'])
        self.assertEqual(rubric['verdict'], 'PENDING_REVIEW')
        body = {'sessionId': session['id'], 'turnId': turn['id'], 'confirmed': True, 'redline': False, 'levels': {'resolution': 4, 'communication': 3}, 'evidence': {key: {'quote': '请确认屏幕自身菜单能否打开', 'reason': '明确提供了可执行的核对步骤和边界'} for key in ('resolution', 'communication')}}
        invalid = copy.deepcopy(body)
        invalid['evidence']['resolution']['quote'] = '不存在的原句'
        with self.assertRaises(ValueError):
            self.simulator.review_turn(invalid)
        reviewed = self.simulator.review_turn(body)['turns'][0]['evaluation']['rubric']
        self.assertEqual(reviewed['finalScore'], 98.75)
        self.assertEqual(reviewed['verdict'], 'PASS')
        self.assertEqual(reviewed['coverage'], 100)
        with self.assertRaisesRegex(ValueError, '冻结'):
            self.simulator.review_turn(body)

    def test_redlines_and_minimum_human_levels_cannot_be_averaged_away(self):
        session = self.fixture.turn(self.fixture.create())
        rubric = session['turns'][0]['evaluation']['rubric']
        notes = {'resolution': '测试依据', 'communication': '测试依据'}
        low_level = apply_review(rubric, {'resolution': 4, 'communication': 1}, notes, False, self.repo.now())
        self.assertGreaterEqual(low_level['finalScore'], 85)
        self.assertEqual(low_level['verdict'], 'FAIL')
        flagged = apply_review(rubric, {'resolution': 4, 'communication': 4}, notes, True, self.repo.now())
        self.assertEqual(flagged['finalScore'], 100)
        self.assertEqual(flagged['verdict'], 'FAIL')
        with self.assertRaises(ValueError):
            apply_review(rubric, {'resolution': True, 'communication': 4}, notes, False, self.repo.now())

    def test_unknown_followup_does_not_invent_a_gold_intent(self):
        session = self.fixture.turn(self.fixture.create(), '请问黑屏怎么核实输入源？')
        rubric = session['turns'][0]['evaluation']['rubric']
        self.assertFalse(rubric['goldAvailable'])
        self.assertEqual(next(item for item in rubric['dimensions'] if item['id'] == 'task')['level'], 3)
        self.assertEqual(rubric['automaticPoints'], 75)

    def test_machine_anchors_use_independent_proofs_not_binary_gate_result(self):
        result = self.refund_result()
        scenario = next(item for item in fixtures.CASES if item['id'] == 'SIM-REFUND')
        context = context_for(scenario, scenario['question'], [])

        def graded(proposal=None, events=None, expected=None, conditions=None):
            proposal = proposal if proposal is not None else result['output']
            events = events if events is not None else result['events']
            gate = inspect_proposal(proposal, events, BASE_DOCUMENTS, conditions or context, '2026-11-04', scenario['question'])
            rubric = score(gate, proposal, expected or scenario, scenario['question'], events)
            return {item['id']: item['level'] for item in rubric['dimensions']}, rubric

        without = lambda name: [event for event in result['events'] if event.get('name') != name]
        forged = {**result['output'], 'evidenceIds': ['invented@1']}
        incomplete = {**result['output'], 'evidenceIds': ['KB-REFUND@1.0']}
        evidence_examples = [graded(forged), graded(events=without('read_policy')), graded(incomplete), graded(events=without('lookup_service')), graded()]
        self.assertEqual([levels['evidence'] for levels, _rubric in evidence_examples], list(range(5)))
        self.assertIn('必要状态查询', evidence_examples[3][1]['dimensions'][0]['evidence'])
        self.assertEqual(evidence_examples[3][1]['verdict'], 'BLOCK')
        self.assertEqual(evidence_examples[3][1]['dimensions'][0]['points'], 18.75)

        task_examples = [graded({**result['output'], 'action': 'dispatch'}), graded(events=without('lookup_service')), graded(expected={**scenario, 'action': 'clarify'}), graded({**result['output'], 'intent': 'fault_repair'}), graded()]
        self.assertEqual([levels['task'] for levels, _rubric in task_examples], list(range(5)))

        handoff = {'action': 'handoff', 'intent': 'complaint', 'responseCodes': ['handoff', 'boundary'], 'evidenceIds': ['KB-HANDOFF@1.0', 'KB-BOUNDARY@1.0']}
        context_examples = [graded(events=without('read_case_memory')), graded(events=without('search_knowledge')), graded(conditions={**context, 'handoff': True}), graded(handoff), graded()]
        self.assertEqual([levels['context'] for levels, _rubric in context_examples], list(range(5)))

        no_boundary = {**result['output'], 'responseCodes': ['refund_progress'], 'evidenceIds': ['KB-REFUND@1.0']}
        boundary_examples = [graded(forged), graded(handoff, conditions={**context, 'risk': True, 'handoff': True}), graded(no_boundary), graded(events=without('lookup_service')), graded()]
        self.assertEqual([levels['boundary'] for levels, _rubric in boundary_examples], list(range(5)))

    def test_orphan_attempts_recover_without_replay_or_losing_events(self):
        session = self.fixture.create()
        attempt = {'id': 'ATTEMPT-ORPHAN', 'sessionId': session['id'], 'status': 'running', 'createdAt': self.repo.now(), 'traceId': 'synthetic-trace', 'lastStep': 'search_knowledge', 'eventCount': 1, 'events': [{'name': 'read_case_memory', 'status': 'succeeded'}]}
        self.repo.save('sim_attempt', attempt['id'], attempt)
        self.simulator.active.add(session['id'])
        self.simulator.state()
        self.assertEqual(self.repo.get('sim_attempt', attempt['id'])['status'], 'running')
        self.simulator.active.clear()
        with patch.object(self.simulator, 'run_harness') as harness:
            self.simulator.state()
            harness.assert_not_called()
        recovered = self.repo.get('sim_attempt', attempt['id'])
        self.assertEqual(recovered['status'], 'interrupted')
        self.assertEqual(recovered['events'], attempt['events'])
        self.assertEqual(self.repo.get('sim_session', session['id'])['revision'], 0)
        self.simulator.state()
        self.assertEqual(self.repo.get('sim_attempt', attempt['id']), recovered)

    def test_recovery_prefers_committed_turn_over_orphan_status(self):
        session = self.fixture.turn(self.fixture.create())
        attempt = self.repo.get('sim_attempt', session['turns'][0]['attemptId'])
        attempt['status'] = 'running'
        self.repo.save('sim_attempt', attempt['id'], attempt)
        recovered = CustomerSimulator(self.repo)
        recovered.state()
        self.assertEqual(self.repo.get('sim_attempt', attempt['id'])['status'], 'completed')
        self.assertEqual(self.repo.get('sim_session', session['id']), session)

    def test_runtime_failure_keeps_streamed_events_and_no_partial_answer(self):
        event = {'type': 'tool', 'name': 'read_case_memory', 'status': 'succeeded', 'sequence': 1, 'input': {}, 'output': {'facts': '匿名测试事实'}, 'offsetMs': 1, 'durationMs': 1}
        packets = json.dumps({'kind': 'event', 'event': event}) + '\n' + json.dumps({'kind': 'error', 'error': 'safe failure'}) + '\n'
        script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" + json.dumps(packets) + '));'
        original = subprocess.Popen
        session = self.fixture.create()
        with patch('customer_simulator.subprocess.Popen', side_effect=lambda command, **kwargs: original([command[0], '-e', script], **kwargs)):
            with self.assertRaises(ValueError):
                self.fixture.turn(session)
        attempt = self.repo.records('sim_attempt')[-1]
        self.assertEqual(attempt['status'], 'failed')
        self.assertEqual(attempt['eventCount'], 1)
        self.assertEqual(attempt['events'][0]['name'], 'read_case_memory')
        self.assertEqual(self.repo.get('sim_session', session['id'])['revision'], 0)
        trace = self.repo.TRACE_STORE.get(attempt['traceId'])
        self.assertTrue(any(item['name'] == 'read_case_memory' for item in trace['spans']))

    def test_preflight_rejection_is_traced_without_private_body(self):
        session = self.fixture.create()
        with patch.object(self.repo, 'local_scan', side_effect=ValueError('privacy gate')):
            with self.assertRaises(ValueError):
                self.fixture.turn(session, '匿名内容也用于验证扫描器故障')
        attempt = self.repo.records('sim_attempt')[-1]
        trace = self.repo.TRACE_STORE.get(attempt['traceId'])
        self.assertTrue(any(item['kind'] == 'guardrail' and item['status'] == 'error' for item in trace['spans']))
        self.assertNotIn('匿名内容也用于验证扫描器故障', json.dumps(trace, ensure_ascii=False))

    def create_candidate(self):
        session = self.fixture.turn(self.fixture.create(), '大屏变成了一块墨布，现在该怎么办？')
        self.assertEqual(session['turns'][0]['publication']['status'], 'BLOCKED')
        record = self.simulator.regression({'sessionId': session['id']})
        candidate = self.simulator.experience_create({'regressionId': record['id'], 'documentId': 'KB-BLACKSCREEN', 'aliases': ['墨布'], 'rationale': '该用户以墨布描述画面全黑，现有检索没有对应别名'})
        return session, candidate

    def test_review_validate_publish_fresh_session_and_rollback_closed_loop(self):
        source, candidate = self.create_candidate()
        old_version = source['knowledgeVersion']
        with self.assertRaises(ValueError):
            self.simulator.experience_publish({'experienceId': candidate['id'], 'confirmed': True})
        with self.assertRaises(ValueError):
            self.simulator.experience_validate({'experienceId': candidate['id']})
        self.simulator.experience_review({'experienceId': candidate['id'], 'confirmed': True, 'note': '已核对客户用墨布描述黑屏，仅作为检索别名不改变政策'})
        validated = self.simulator.experience_validate({'experienceId': candidate['id']})
        self.assertTrue(validated['validation']['passed'], validated['validation']['rows'])
        self.assertEqual(len(validated['validation']['rows']), 8)
        self.assertEqual(validated['validation']['runtimeHash'], runtime_hash())
        published = self.simulator.experience_publish({'experienceId': candidate['id'], 'confirmed': True})
        fresh = self.fixture.turn(self.fixture.create(), '又成了墨布一样，该怎么检查？')
        self.assertEqual(fresh['knowledgeVersion'], published['publishedVersion'])
        self.assertEqual(fresh['turns'][0]['publication']['status'], 'RELEASED')
        self.assertNotEqual(fresh['knowledgeVersion'], old_version)
        old = self.fixture.turn(source, '还是墨布一样，看不清楚。')
        self.assertEqual(old['knowledgeVersion'], old_version)
        self.assertEqual(old['turns'][-1]['publication']['status'], 'BLOCKED')
        self.simulator.knowledge_rollback({'confirmed': True, 'versionId': published['publishedVersion']})
        self.assertEqual(self.simulator.knowledge.active()['id'], old_version)
        reverted = self.fixture.turn(self.fixture.create(), '墨布一样怎么处理？')
        self.assertEqual(reverted['turns'][0]['publication']['status'], 'BLOCKED')

    def test_unapproved_candidate_never_affects_search_and_tampering_invalidates_review(self):
        _source, candidate = self.create_candidate()
        self.assertEqual(search(self.simulator.knowledge.active()['documents'], '墨布', '2026-11-04'), [])
        self.simulator.experience_review({'experienceId': candidate['id'], 'confirmed': True, 'note': '已核对语义归属及误匹配风险，仅调整检索别名'})
        edited = self.repo.get('sim_experience', candidate['id'])
        edited['aliases'] = ['另一个表达']
        self.repo.save('sim_experience', edited['id'], edited)
        with self.assertRaisesRegex(ValueError, '审核版本'):
            self.simulator.experience_validate({'experienceId': candidate['id']})

    def test_validation_cannot_publish_when_runtime_or_day_has_changed(self):
        _source, candidate = self.create_candidate()
        documents = self.simulator.candidate_documents(candidate)
        from simulator_knowledge import digest
        candidate.update(status='validated', validation={'passed': True, 'candidateHash': digest(documents), 'runtimeHash': 'outdated', 'validOn': '2026-11-04'})
        self.repo.save('sim_experience', candidate['id'], candidate)
        with self.assertRaises(ValueError):
            self.simulator.experience_publish({'experienceId': candidate['id'], 'confirmed': True})


if __name__ == '__main__':
    unittest.main()
