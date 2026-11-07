import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from agent_lab import AgentLab
from customer_simulator import CASES, CustomerSimulator, evaluate
from tracing import TraceStore


class CustomerSimulatorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        folder = Path(self.directory.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'LAB', AgentLab(support_api)), patch.object(support_api, 'local_scan', return_value='synthetic test scanner')]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.simulator = CustomerSimulator(support_api)

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.directory.cleanup()

    def create(self, **changes):
        return self.simulator.create({'scenarioId': CASES[0]['id'], **changes})

    def turn(self, session, message=None, **changes):
        return self.simulator.turn({'sessionId': session['id'], 'revision': session['revision'], 'message': message or session['scenario']['question'], **changes})

    def test_health_exposes_capabilities_without_reading_user_state(self):
        with patch.object(self.simulator, 'state', side_effect=AssertionError('health must not read state')), patch.object(self.simulator, 'recover_attempts', side_effect=AssertionError('health must not recover attempts')):
            health = self.simulator.get('/api/support/simulator/health', {})
        self.assertEqual(health['connectionProtocol'], 'support-providers-qwen-v1')
        self.assertEqual(health['providers'], ['deepseek', 'qwen'])
        self.assertTrue(health['available'])
        self.assertNotIn('connections', health)

    def test_replay_capability_does_not_offer_old_or_live_records(self):
        session = self.turn(self.create(profile='baseline'))
        record = self.simulator.regression({'sessionId': session['id']})
        state = self.simulator.state()
        self.assertEqual(state['harness']['runtimeHash'], session['runtimeHash'])
        self.assertTrue(state['regressions'][0]['replayAvailable'])
        for changes in [{'mode': 'live'}, {'runtimeHash': 'old-runtime'}, {'rubricVersion': 'old'}, {'policyVersion': 'old'}]:
            support_api.save('sim_regression', record['id'], {**record, **changes})
            self.assertFalse(self.simulator.state()['regressions'][0]['replayAvailable'])
        self.assertNotIn('replayAvailable', support_api.get('sim_regression', record['id']))

    def test_all_openings_guarded_pass_baseline_fails_with_real_harness(self):
        for scenario in CASES:
            with self.subTest(scenario=scenario['id']):
                guarded = self.turn(self.create(scenarioId=scenario['id']))
                baseline = self.turn(self.create(scenarioId=scenario['id'], profile='baseline'))
                self.assertEqual(guarded['turns'][0]['evaluation']['status'], 'PASS')
                self.assertEqual(baseline['turns'][0]['evaluation']['status'], 'FAIL')
                trace = support_api.TRACE_STORE.get(guarded['turns'][0]['traceId'])
                self.assertEqual(trace['sessionId'], guarded['id'])
                self.assertTrue(any(item['name'] == 'read_policy' for item in trace['spans']))

    def test_multiturn_comparison_and_replay_preserve_snapshot(self):
        session = self.turn(self.create(profile='baseline'))
        session = self.turn(session, '菜单可以打开，接的是 HDMI。')
        session = self.turn(session, '我想找人工')
        with patch.object(self.simulator, 'scenarios', return_value=[]):
            comparison = self.simulator.compare({'sessionId': session['id']})
            record = self.simulator.regression({'sessionId': session['id']})
            replay = self.simulator.replay({'regressionId': record['id']})
        self.assertTrue(comparison['sameInputs'])
        self.assertEqual(replay['scenarioHash'], session['scenarioHash'])
        self.assertEqual([item['output']['action'] for item in replay['turns']], ['clarify', 'troubleshoot', 'handoff'])
        self.assertTrue(all(item['evaluation']['status'] == 'PASS' for item in replay['turns']))
        self.assertEqual(len(replay['drafts'][0]['history']), 4)
        saved = support_api.get('sim_regression', record['id'])
        self.assertEqual(saved['humanReview'], 'pending')
        self.assertEqual(saved['status'], '断言通过 · 待人工复核')
        self.assertEqual(CustomerSimulator(support_api).state()['regressions'][0]['id'], record['id'])

    def test_all_authored_followups_remain_consistent(self):
        for scenario in CASES:
            session = self.turn(self.create(scenarioId=scenario['id']))
            for message in scenario['followups']:
                session = self.turn(session, message)
                self.assertEqual(session['turns'][-1]['evaluation']['status'], 'PASS', (scenario['id'], message))

    def test_revision_concurrency_and_turn_limits(self):
        session = self.create()
        with self.assertRaises(ValueError):
            self.turn(session, revision=True)
        self.simulator.active.add(session['id'])
        with self.assertRaisesRegex(ValueError, '正在运行'):
            self.turn(session)
        self.simulator.active.clear()
        session['turns'] = [{}] * 12
        support_api.save('sim_session', session['id'], session)
        with self.assertRaisesRegex(ValueError, '上限'):
            self.turn(session)

    def test_private_input_blocks_before_storage_and_dispatch(self):
        session = self.create()
        with patch.object(self.simulator, 'run_harness') as harness:
            with self.assertRaises(ValueError):
                self.turn(session, 'phone: ' + '138' + '12345678')
            with patch.object(support_api, 'local_scan', side_effect=ValueError('privacy gate')):
                with self.assertRaises(ValueError):
                    self.turn(session)
            harness.assert_not_called()
        self.assertEqual(support_api.get('sim_session', session['id'])['revision'], 0)

    def test_live_consent_destination_key_clear_and_no_reference_leak(self):
        connection = support_api.LAB.configure({'provider': 'deepseek', 'apiKey': 'fixture-only-not-secret', 'confirmed': True, 'candidateModel': 'fixture', 'judgeModel': 'fixture', 'name': 'Synthetic connection', 'family': 'DeepSeek'})
        session = self.create(mode='live', connectionId=connection['id'])
        with patch.object(self.simulator, 'run_harness', side_effect=ValueError('stub transport stopped')) as harness:
            for consent in [None, False, 1]:
                with self.assertRaises(ValueError):
                    self.turn(session, consent=consent)
            harness.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'stub transport stopped'):
                self.turn(session, consent=True)
            payload = harness.call_args.args[0]
            self.assertEqual(set(payload['scenario']), {'id', 'facts'})
            self.assertIn('knowledge', payload)
            self.assertNotIn('reference', payload)
            support_api.LAB.connection(connection['id']).clear()
            with self.assertRaises(ValueError):
                self.turn(session, consent=True)
            self.assertEqual(harness.call_count, 1)
        with self.assertRaises(ValueError):
            self.simulator.compare({'sessionId': session['id']})
        self.assertNotIn('fixture-only-not-secret', json.dumps(support_api.records('sim_session')))

    def test_qwen_live_connection_selected_and_bound_to_authorized_region(self):
        endpoint = 'https://workspace-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
        connection = support_api.LAB.configure({'provider': 'qwen', 'endpoint': endpoint, 'apiKey': 'fixture-only-not-secret', 'confirmed': True, 'candidateModel': 'fixture', 'judgeModel': 'fixture', 'name': 'Synthetic Qwen', 'family': 'Qwen'})
        self.assertIn(connection['id'], [item['id'] for item in self.simulator.state()['connections']])
        session = self.create(mode='live', connectionId=connection['id'])
        self.assertEqual(session['modelProvider'], 'qwen')
        self.assertEqual(session['modelEndpoint'], endpoint)
        with patch.object(self.simulator, 'run_harness', side_effect=ValueError('isolated stop')) as harness:
            with self.assertRaises(ValueError):
                self.turn(session, consent=False)
            harness.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'isolated stop'):
                self.turn(session, consent=True)
            payload = harness.call_args.args[0]
            self.assertEqual(payload['provider'], 'qwen')
            self.assertEqual(payload['endpoint'], endpoint)
            self.assertNotIn('apiKey', payload)
            self.assertNotIn('intent', payload['scenario'])
            vault = support_api.LAB.connection(connection['id'])
            vault.configuration['endpoint'] = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
            with self.assertRaisesRegex(ValueError, '目的地'):
                self.turn(session, consent=True)
            self.assertEqual(harness.call_count, 1)

    def test_safe_qwen_failure_codes_reach_user_without_raw_errors(self):
        original = subprocess.Popen
        for code in ['QWEN_HTTP_401', 'QWEN_HTTP_404', 'QWEN_HTTP_429']:
            packet = json.dumps({'kind': 'error', 'code': code, 'error': 'untrusted upstream text'}) + '\n'
            script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" + json.dumps(packet) + '));'
            with patch('customer_simulator.subprocess.Popen', side_effect=lambda command, **kwargs: original([command[0], '-e', script], **kwargs)):
                with self.assertRaisesRegex(ValueError, code[-3:]) as error:
                    self.simulator.run_harness({})
                self.assertNotIn('untrusted upstream text', str(error.exception))

    def test_subprocess_timeout_malformed_secret_and_unregistered_tool_output(self):
        good = {'output': {'answer': '请补充现象。', 'action': 'clarify', 'intent': 'fault_repair'}, 'events': [], 'steps': 1, 'finishReason': 'stop'}
        original = subprocess.Popen

        def child_for(response):
            packet = json.dumps({'kind': 'result', 'result': response}) + '\n'
            script = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" + json.dumps(packet) + '));'
            def child(command, **kwargs):
                self.assertLessEqual(set(kwargs['env']), {'PATH', 'TMPDIR', 'LANG'})
                return original([command[0], '-e', script], **kwargs)
            return child

        for response in [{}, {**good, 'steps': 6}, {**good, 'events': [{'type': 'tool', 'name': 'shell'}]}, {**good, 'output': {**good['output'], 'answer': 'fixture-only-not-secret'}}]:
            with patch('customer_simulator.subprocess.Popen', side_effect=child_for(response)):
                with self.assertRaises(ValueError):
                    self.simulator.run_harness({}, 'fixture-only-not-secret')
        with patch('customer_simulator.subprocess.Popen', side_effect=child_for(good)), patch('customer_simulator.time.monotonic', side_effect=[0, 100]):
            with self.assertRaisesRegex(ValueError, '未发布部分答案'):
                self.simulator.run_harness({})
        with patch('customer_simulator.subprocess.Popen', side_effect=child_for(good)):
            self.simulator.run_harness({})
        with patch('customer_simulator.subprocess.Popen', side_effect=child_for(good)), patch.object(support_api, 'local_scan', side_effect=ValueError('reject')):
            with self.assertRaisesRegex(ValueError, '隐私复核'):
                self.simulator.run_harness({})

    def test_only_scanned_imports_and_historical_prefix_are_available(self):
        support_api.save('corpus', 'approved', {'id': 'approved', 'scanStatus': 'passed'})
        support_api.save('lab_bundle', 'bundle', {'id': 'bundle', 'datasetId': 'approved'})
        case = {'id': 'imported', 'title': '匿名样例', 'bundleId': 'bundle', 'sessionId': 'history', 'intent': 'fault_repair', 'action': 'clarify', 'prefix': [{'role': 'user', 'content': '设备黑屏。'}, {'role': 'human', 'content': '您好。'}], 'reference': {'content': 'SECRET_FUTURE_REFERENCE'}}
        support_api.save('lab_case', case['id'], case)
        imported = self.simulator.scenarios()[-1]
        self.assertTrue(imported['imported'])
        self.assertEqual(imported['question'], '设备黑屏。')
        self.assertNotIn('SECRET_FUTURE_REFERENCE', json.dumps(imported))
        support_api.save('corpus', 'approved', {'id': 'approved', 'scanStatus': 'blocked'})
        self.assertEqual({item['id'] for item in self.simulator.scenarios()}, {item['id'] for item in CASES} | {'SIM-ONTOLOGY'})

    def test_changed_protocol_replay_rejected(self):
        session = self.turn(self.create())
        record = self.simulator.regression({'sessionId': session['id']})
        record['harnessVersion'] = 'outdated'
        support_api.save('sim_regression', record['id'], record)
        with self.assertRaisesRegex(ValueError, '已经变化'):
            self.simulator.replay({'regressionId': record['id']})

    def test_refund_negation_is_not_scored_as_a_promise(self):
        scenario = next(item for item in CASES if item['id'] == 'SIM-REFUND')
        for answer, expected in [('我不能保证今天到账。', 'PASS'), ('无法保证今天到账。', 'PASS'), ('我保证今天到账。', 'FAIL')]:
            result = evaluate(scenario, scenario['question'], {'answer': answer, 'action': 'explain', 'intent': 'policy_inquiry'}, [])
            self.assertEqual(next(item for item in result['checks'] if item['id'] == 'promise')['status'], expected)


if __name__ == '__main__':
    unittest.main()
