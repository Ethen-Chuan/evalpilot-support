import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from ontology import OntologyService, example_graph
import ontology_workflow as workflow


class OntologyWorkflowTests(unittest.TestCase):
    def test_alias_normalization_changes_retrieval_not_repair_authority(self):
        result = workflow.run_workflow('我的主机开不了机。')
        self.assertEqual(result['comparison']['literal'], [])
        self.assertEqual([item['id'] for item in result['comparison']['normalized']], ['DEMO-STARTUP'])
        self.assertEqual([item['id'] for item in result['comparison']['selected']], ['DEMO-STARTUP'])
        self.assertEqual(result['outcome']['candidateIds'], [])
        self.assertFalse(result['outcome']['externalActionExecuted'])

    def test_canonical_control_has_no_artificial_gain(self):
        result = workflow.run_workflow('整机启动异常。')
        self.assertEqual([item['id'] for item in result['comparison']['literal']], [item['id'] for item in result['comparison']['selected']])

    def test_model_scoping_filters_shared_code_candidates(self):
        result = workflow.run_workflow('A-200 主机报 E102。')
        self.assertEqual({item['id'] for item in result['comparison']['literal']}, {'DEMO-FAULT-A', 'DEMO-FAULT-B'})
        self.assertEqual([item['id'] for item in result['comparison']['selected']], ['DEMO-FAULT-B'])
        self.assertEqual(result['outcome']['candidateIds'], ['power'])
        self.assertNotIn('mainboard', result['graph']['activeNodeIds'])
        self.assertEqual(result['comparison']['excluded'][0]['id'], 'DEMO-FAULT-A')

    def test_gate_is_enforced_before_tool_not_only_a_warning(self):
        for text in ['主机报 E102。', 'A-999 主机报 E102。', 'A-100 和 A-200 报 E102。', 'A-100 报 E999。', 'A-100 报 E102、E103。']:
            with self.subTest(text=text), patch.object(workflow, 'lookup_knowledge', side_effect=AssertionError('must not call')):
                result = workflow.run_workflow(text)
                self.assertEqual(result['query']['tool'], 'skipped')
                self.assertEqual(result['outcome']['candidateIds'], [])
                self.assertEqual(next(step['status'] for step in result['steps'] if step['id'] == 'lookup'), 'skipped')

    def test_follow_up_unlocks_query_but_conflict_does_not_override_input(self):
        result = workflow.run_workflow('主机报 E102。', 'model-a')
        self.assertEqual(result['outcome']['candidateIds'], ['mainboard'])
        self.assertEqual(result['context']['confirmedModel'], 'model-a')
        conflict = workflow.run_workflow('A-100 主机报 E102。', 'model-b')
        self.assertEqual(conflict['outcome']['nextAction'], 'clarify_model')
        self.assertEqual(conflict['context']['modelIds'], ['model-a', 'model-b'])
        self.assertEqual(conflict['comparison']['selected'], [])

    def test_unknown_codes_and_negated_symptoms_never_invent_causes(self):
        result = workflow.run_workflow('屏幕不亮，但不是无法上电。')
        self.assertEqual(result['context']['symptomIds'], ['black'])
        self.assertEqual(result['outcome']['candidateIds'], [])
        self.assertEqual(result['comparison']['selected'][0]['id'], 'DEMO-BLACK')
        self.assertEqual(workflow.run_workflow('A-100 报 E1020')['graph']['unknownCodes'], ['E1020'])

    def test_empty_knowledge_keeps_gap_instead_of_using_graph_as_answer(self):
        with patch.object(workflow, 'KNOWLEDGE', {**workflow.KNOWLEDGE, 'documents': []}):
            result = workflow.run_workflow('A-100 报 E102。')
        self.assertEqual(result['outcome']['nextAction'], 'manual_review')
        self.assertEqual(result['outcome']['candidateIds'], [])
        self.assertEqual(result['outcome']['draft']['references'], [])

    def test_unknown_input_is_not_marked_solved(self):
        result = workflow.run_workflow('请帮我处理一下。')
        self.assertEqual(result['outcome']['nextAction'], 'clarify_context')
        self.assertEqual(result['comparison']['selected'], [])

    def test_draft_preserves_reported_code_and_unknown_model_without_confirming_them(self):
        result = workflow.run_workflow('我的 A-999 主机报 E102。')
        facts = {item['label']: item['basis'] for item in result['outcome']['draft']['facts']}
        self.assertIn('未核验', facts['E102'])
        self.assertIn('未覆盖', facts['A-999'])
        self.assertEqual(result['outcome']['candidateIds'], [])

    def test_repair_and_ticket_are_not_executed(self):
        result = workflow.run_workflow('A-100 主机报 E102。', proposed_action='replace')
        self.assertTrue(result['outcome']['actionBlocked'])
        self.assertEqual(result['outcome']['nextAction'], 'professional_review')
        self.assertFalse(result['externalCalls'])
        self.assertFalse(result['persisted'])
        self.assertNotIn('ticket-example', result['graph']['activeNodeIds'])

    def test_traces_and_graph_edges_have_exact_observable_provenance(self):
        nodes, edges = example_graph()
        indexed = {edge['id']: edge for edge in edges}
        for case in workflow.ACCEPTANCE['cases']:
            inputs = case['input']
            result = workflow.run_workflow(inputs['text'], inputs['confirmedModel'], inputs['proposedAction'])
            self.assertEqual([step['id'] for step in result['steps']], ['normalize', 'compare', 'gate', 'lookup', 'decision', 'verify'])
            for step in result['steps']:
                self.assertGreaterEqual(step['durationMs'], 0)
                for identifier in step['edgeIds']:
                    self.assertIn(indexed[identifier]['source'], step['nodeIds'])
                    self.assertIn(indexed[identifier]['target'], step['nodeIds'])
            for identifier in result['graph']['activeEdgeIds']:
                self.assertIn(indexed[identifier]['source'], result['graph']['activeNodeIds'])
                self.assertIn(indexed[identifier]['target'], result['graph']['activeNodeIds'])
            self.assertTrue(all(check['passed'] for check in result['checks']))

    def test_fixture_expectations_are_independent_and_mutation_fails(self):
        suite = workflow.verify_acceptance()
        self.assertEqual(suite['total'], 12)
        self.assertEqual(suite['passed'], suite['total'])
        changed = copy.deepcopy(workflow.ACCEPTANCE)
        changed['cases'][0]['expected']['candidates'] = ['mainboard']
        with patch.object(workflow, 'ACCEPTANCE', changed):
            changed_suite = workflow.verify_acceptance()
        self.assertEqual(changed_suite['passed'], 11)
        self.assertNotEqual(suite['suiteHash'], changed_suite['suiteHash'])

    def test_knowledge_requires_valid_typed_reference(self):
        changed = copy.deepcopy(workflow.KNOWLEDGE)
        changed['documents'][0]['nodeId'] = 'mainboard'
        with patch.object(workflow, 'KNOWLEDGE', changed), self.assertRaises(ValueError):
            workflow.knowledge_records()

    def test_api_scans_inputs_and_rejects_extra_fields(self):
        repository = SimpleNamespace(text=Mock(side_effect=lambda value, limit: value))
        service = OntologyService(repository)
        body = {'text': 'A-100 报 E102。', 'confirmedModel': '', 'proposedAction': 'review'}
        service.post('/api/support/ontology/business/run', body)
        repository.text.assert_called_once_with(body['text'], 500)
        repository.text.side_effect = ValueError('scan blocked')
        with patch.object(workflow, 'run_workflow') as run, self.assertRaises(ValueError):
            service.post('/api/support/ontology/business/run', body)
        run.assert_not_called()
        for body in [{}, {'confirmSynthetic': False}, {'confirmSynthetic': True, 'expected': {}}]:
            with self.assertRaises(ValueError):
                service.post('/api/support/ontology/business/verify', body)
        with self.assertRaises(ValueError):
            service.post('/api/support/ontology/business/run', {'text': 'test', 'url': 'unexpected'})

    def test_input_types_and_unsupported_actions_rejected(self):
        for text, model, action in [('', '', 'review'), ('x' * 501, '', 'review'), ('主机', ['model-a'], 'review'), ('主机', 'unregistered', 'review'), ('主机', '', 'execute')]:
            with self.assertRaises(ValueError):
                workflow.run_workflow(text, model, action)


if __name__ == '__main__':
    unittest.main()
