import copy
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import test_customer_simulator as simulator_tests
from ontology import OntologyService
import support_api


class OntologyHarnessTests(unittest.TestCase):
    def setUp(self):
        simulator_tests.CustomerSimulatorTests.setUp(self)
        self.ontology_patch = patch.object(support_api, 'ONTOLOGY', OntologyService(support_api))
        self.ontology_patch.start()

    def tearDown(self):
        self.ontology_patch.stop()
        simulator_tests.CustomerSimulatorTests.tearDown(self)

    def create(self):
        return self.simulator.create({'scenarioId': 'SIM-ONTOLOGY', 'ontologyEnabled': True})

    def turn(self, session, message):
        return self.simulator.turn({'sessionId': session['id'], 'revision': session['revision'], 'message': message})

    def test_real_harness_receives_alignment_filters_knowledge_and_records_each_gate(self):
        session = self.turn(self.create(), 'A-100 控制板开机屏幕不亮。')
        turn = session['turns'][-1]
        self.assertEqual(turn['publication']['status'], 'RELEASED')
        self.assertEqual(turn['ontology']['alignment']['slots']['component'], ['mainboard'])
        self.assertEqual(turn['ontology']['documentIds'], ['DEMO-KB-BLACK'])
        gates = [event for event in turn['events'] if event['name'] == '本体执行前校验']
        calls = [event for event in turn['events'] if event['type'] == 'tool' and event['status'] == 'succeeded']
        self.assertEqual(len(gates), len(calls))
        self.assertTrue(all(event['output']['allowed'] for event in gates))
        trace = support_api.TRACE_STORE.get(turn['traceId'])
        self.assertTrue(any(item['name'] == '领域本体 · 工具证据与输出二次校验' for item in trace['spans']))

    def test_missing_model_clarifies_then_can_continue_with_known_model(self):
        session = self.turn(self.create(), '主控板黑屏。')
        self.assertEqual(session['turns'][-1]['publication']['status'], 'BLOCKED')
        self.assertIn('型号', session['turns'][-1]['output']['answer'])
        self.assertFalse(any(event['name'] == 'lookup_service' and event['status'] == 'succeeded' for event in session['turns'][-1]['events']))
        session = self.turn(session, 'A-100 主板黑屏。')
        self.assertEqual(session['turns'][-1]['publication']['status'], 'RELEASED')

    def test_major_fault_uses_handoff_and_actual_draft_not_remote(self):
        session = self.turn(self.create(), 'A-100 冒烟了。')
        turn = session['turns'][-1]
        self.assertEqual(turn['output']['action'], 'handoff')
        self.assertTrue(turn['ontology']['outputCheck']['allowed'])
        self.assertTrue(session['drafts'])
        self.assertEqual(turn['publication']['status'], 'RELEASED')

    def test_mutated_snapshot_fails_closed_without_changing_original(self):
        session = self.create()
        session['ontology']['schema']['entities'].pop()
        support_api.save('sim_session', session['id'], session)
        session = self.turn(session, 'A-100 黑屏。')
        turn = session['turns'][-1]
        self.assertEqual(turn['ontology']['alignment']['status'], 'unavailable')
        self.assertEqual(turn['publication']['status'], 'BLOCKED')
        self.assertFalse(any(event['type'] == 'tool' and event['name'] in ('lookup_service', 'create_handoff_draft') and event['status'] == 'succeeded' for event in turn['events']))
        self.assertEqual(len(support_api.ONTOLOGY.domain().snapshot()['schema']['entities']), 26)

    def test_replay_preserves_ontology_and_versions_do_not_leak_into_old_session(self):
        session = self.create()
        registry = support_api.ONTOLOGY.domain()
        entity = copy.deepcopy(next(item for item in registry.snapshot()['schema']['entities'] if item['id'] == 'mainboard'))
        entity['aliases'].append('总控模块示例')
        preview = registry.preview({'revision': 1, 'action': 'upsert', 'group': 'entities', 'id': 'mainboard', 'item': entity, 'actor': '测试维护者', 'reason': '测试冻结版本', 'expertConfirmed': True})
        registry.commit({'token': preview['token'], 'confirmed': True})
        session = self.turn(session, 'A-100 总控模块示例黑屏。')
        self.assertEqual(session['turns'][-1]['ontology']['revision'], 1)
        self.assertFalse(session['turns'][-1]['ontology']['alignment']['slots'].get('component'))
        latest = self.turn(self.create(), 'A-100 总控模块示例黑屏。')
        self.assertEqual(latest['turns'][-1]['ontology']['revision'], 2)
        self.assertEqual(latest['turns'][-1]['ontology']['alignment']['slots']['component'], ['mainboard'])
        record = self.simulator.regression({'sessionId': session['id']})
        replay = self.simulator.replay({'regressionId': record['id']})
        self.assertEqual(replay['ontology']['revision'], 1)
        with self.assertRaises(ValueError):
            self.simulator.compare({'sessionId': session['id']})

    def test_baseline_cannot_bypass_ontology_and_no_live_call_without_consent(self):
        with self.assertRaises(ValueError):
            self.simulator.create({'scenarioId': 'SIM-ONTOLOGY', 'ontologyEnabled': True, 'profile': 'baseline'})
        with self.assertRaises(ValueError):
            self.simulator.create({'scenarioId': 'SIM-ONTOLOGY', 'ontologyEnabled': 'true'})

    def test_changed_source_cannot_mix_running_python_with_new_harness(self):
        session = self.create()
        with patch('customer_simulator.current_runtime_hash', return_value='changed-files'), patch.object(self.simulator, 'run_harness') as harness:
            with self.assertRaisesRegex(ValueError, '服务代码已更新'):
                self.create()
            with self.assertRaisesRegex(ValueError, '服务代码已更新'):
                self.turn(session, 'A-100 黑屏。')
            harness.assert_not_called()


if __name__ == '__main__':
    unittest.main()
