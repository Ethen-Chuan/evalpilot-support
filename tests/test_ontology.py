import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.parse
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from ontology import OntologyService, edge, example_graph, resolve_example, term_mentioned, validate_graph


class OntologySchemaTests(unittest.TestCase):
    def test_all_example_edges_have_existing_and_typed_endpoints(self):
        nodes, edges = example_graph()
        self.assertTrue(validate_graph(nodes, edges))
        self.assertGreaterEqual(len(nodes), 30)
        self.assertEqual(len({node['id'] for node in nodes}), len(nodes))
        self.assertTrue(all(node['provenance'] in ('schema', 'example') for node in nodes))

    def test_invalid_relationship_domain_is_rejected(self):
        nodes, edges = example_graph()
        edges.append(edge('startup', 'mainboard', 'candidate_component', 'invalid relation', 'example'))
        with self.assertRaises(ValueError):
            validate_graph(nodes, edges)

    def test_duplicate_ids_and_missing_endpoints_rejected(self):
        nodes, edges = example_graph()
        for changed_nodes, changed_edges in [(nodes + [nodes[0]], edges), (nodes, edges + [edges[0]]), (nodes, edges + [edge('missing', nodes[0]['id'], 'test', 'test', 'example')])]:
            with self.assertRaises(ValueError):
                validate_graph(changed_nodes, changed_edges)

    def test_missing_model_never_highlights_a_component(self):
        result = resolve_example('我的主机报 E102，开不了机。')
        self.assertEqual(result['status'], 'blocked')
        self.assertIn('equipment', result['activeNodeIds'])
        self.assertIn('startup', result['activeNodeIds'])
        self.assertNotIn('mainboard', result['activeNodeIds'])
        self.assertNotIn('no-power', result['activeNodeIds'])
        self.assertIn('ask-model', result['activeNodeIds'])

    def test_same_code_in_different_models_has_different_candidates(self):
        first = resolve_example('我的 A-100 机子报 E102，启动不了。')
        second = resolve_example('我的 A-200 机器报 E102。')
        self.assertIn('mainboard', first['activeNodeIds'])
        self.assertNotIn('power', first['activeNodeIds'])
        self.assertIn('power', second['activeNodeIds'])
        self.assertNotIn('mainboard', second['activeNodeIds'])
        self.assertTrue(all(not result['externalCalls'] for result in (first, second)))

    def test_mixed_models_and_unknown_code_fail_closed(self):
        mixed = resolve_example('A-100 和 A-200 都报 E102。')
        unknown = resolve_example('A-100 报 E999。')
        self.assertEqual(mixed['status'], 'blocked')
        self.assertEqual(unknown['unknownCodes'], ['E999'])
        self.assertNotIn('mainboard', unknown['activeNodeIds'])

    def test_replace_proposal_blocked_even_when_code_is_known(self):
        result = resolve_example('A-100 主机报 E102。', 'replace')
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(next(check['status'] for check in result['checks'] if check['id'] == 'candidate-only'), 'blocked')

    def test_term_boundaries_case_and_negation(self):
        self.assertTrue(term_mentioned('A-100', '型号 a-100'))
        self.assertFalse(term_mentioned('A-100', '型号 A-1000'))
        self.assertFalse(term_mentioned('E102', '报 E1020'))
        self.assertFalse(term_mentioned('黑屏', '不是黑屏'))
        self.assertFalse(term_mentioned('E102', '没有报 E102'))
        self.assertEqual(resolve_example('A-100 报 E1020')['unknownCodes'], ['E1020'])

    def test_symptoms_are_not_silently_equated(self):
        result = resolve_example('屏幕不亮，但不是无法上电。')
        self.assertIn('black', result['activeNodeIds'])
        self.assertNotIn('no-power', result['activeNodeIds'])
        self.assertNotIn('mainboard', result['activeNodeIds'])

    def test_unknown_actions_are_rejected(self):
        with self.assertRaises(ValueError):
            resolve_example('设备问题', 'execute-repair')

    def test_aliases_share_canonical_context_and_candidate_but_not_identity(self):
        results = [resolve_example(f'我的 A-100 {alias}报 E102，开不了机。') for alias in ['主机', '机子', '机器']]
        for result in results:
            canonical = [item for item in result['mappings'] if item['classId'] == 'device']
            self.assertEqual([item['nodeId'] for item in canonical], ['equipment'])
            self.assertIn('mainboard', result['activeNodeIds'])
            self.assertNotIn('power', result['activeNodeIds'])
        nodes, edges = example_graph()
        identifiers = {item['id'] for item in nodes if item['kind'] == 'alias' and item['label'] in ('主机', '机子', '机器')}
        self.assertEqual({item['target'] for item in edges if item['source'] in identifiers}, {'equipment'})

    def test_model_and_safety_relations_are_typed_and_present_for_both_candidates(self):
        nodes, edges = example_graph()
        self.assertEqual({item['target'] for item in edges if item['source'] == 'equipment' and item['type'] == 'has_model'}, {'model-a', 'model-b'})
        for component in ('mainboard', 'power'):
            self.assertTrue(any(item['source'] == component and item['target'] == 'handoff' for item in edges))
            self.assertTrue(any(item['source'] == component and item['target'] == 'rule:candidate-only' for item in edges))
        with self.assertRaises(ValueError):
            validate_graph(nodes, edges + [edge('startup', 'model-a', 'has_model', 'invalid model relation', 'example')])


class CorpusOntologyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / 'fixture.sqlite3'
        self.corpus = {'id': 'project-test', 'name': '合成验证项目', 'scanStatus': 'passed', 'totals': {'sessions': 3}}
        self.repository = SimpleNamespace(connection=lambda: sqlite3.connect(self.database), LOCK=threading.RLock(), get=lambda kind, identifier: self.corpus if kind == 'corpus' and identifier == self.corpus['id'] else None, records=lambda kind: [self.corpus] if kind == 'corpus' else [], now=lambda: 'fixture-time', DIALOGUES=SimpleNamespace(refresh_index=Mock()), text=Mock(side_effect=lambda value, maximum: value))
        with self.repository.connection() as database:
            database.execute('CREATE TABLE dialogue_summaries(id TEXT PRIMARY KEY,dataset_id TEXT,payload TEXT)')
            fixtures = [
                ('case-a', 'project-test', {'values': {'intent': ['fault_repair', 'fault_repair'], 'fault_domain': ['硬件域']}, 'conflicts': []}),
                ('case-b', 'project-test', {'values': {'intent': ['fault_repair', 'complaint']}, 'conflicts': ['intent']}),
                ('case-c', 'project-test', {'values': {}, 'conflicts': []}),
                ('case-other', 'other-project', {'values': {'intent': ['other']}, 'conflicts': []}),
            ]
            for identifier, project, summary in fixtures:
                database.execute('INSERT INTO dialogue_summaries VALUES (?,?,?)', (identifier, project, json.dumps({'labelSummary': summary, 'messageCount': 2})))
        self.service = OntologyService(self.repository)

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_graph_includes_unlabeled_cases_without_cross_project_leakage(self):
        graph = self.service.graph({'project': ['project-test']})
        cases = [node for node in graph['nodes'] if node['kind'] == 'case']
        self.assertEqual(len(cases), 3)
        self.assertEqual(graph['coverage']['totalCases'], 3)
        self.assertTrue(graph['coverage']['complete'])
        self.assertNotIn('case:case-other', [node['id'] for node in graph['nodes']])
        self.assertEqual([item['type'] for item in graph['edges'] if item['source'] == 'case:case-c'], ['belongs_to_project'])

    def test_original_labels_deduplicated_and_conflicts_retained(self):
        graph = self.service.graph({})
        repair = next(node for node in graph['nodes'] if node.get('value') == 'fault_repair')
        self.assertEqual(repair['count'], 2)
        self.assertEqual(len([item for item in graph['edges'] if item.get('disputed')]), 2)
        self.assertEqual(graph['coverage']['conflictCases'], 1)
        self.assertTrue(all(item['type'] in ('has_label', 'instance_of', 'declares_class', 'belongs_to_project') for item in graph['edges']))

    def test_case_source_link_preserves_project_and_returns_to_graph(self):
        graph = self.service.graph({})
        case = next(node for node in graph['nodes'] if node['kind'] == 'case')
        params = urllib.parse.parse_qs(case['href'].split('?', 1)[1])
        self.assertEqual(params['dataset'], ['project-test'])
        self.assertEqual(params['session'], [case['sessionId']])
        return_params = urllib.parse.parse_qs(params['returnTo'][0].split('?', 1)[1])
        self.assertTrue(params['returnTo'][0].startswith('#ontology?'))
        self.assertEqual(return_params['project'], ['project-test'])

    def test_revision_changes_when_labels_change_and_no_snapshot_is_written(self):
        initial = self.service.graph({})
        with self.repository.connection() as database:
            database.execute("UPDATE dialogue_summaries SET payload=? WHERE id='case-c'", (json.dumps({'labelSummary': {'values': {'intent': ['complaint']}}}),))
        refreshed = self.service.graph({})
        self.assertNotEqual(initial['revision'], refreshed['revision'])
        self.assertEqual(next(node['count'] for node in refreshed['nodes'] if node.get('value') == 'complaint'), 2)

    def test_capacity_limit_is_explicit_not_a_false_complete_claim(self):
        with patch('ontology.MAX_CASES', 2):
            graph = self.service.graph({})
        self.assertFalse(graph['coverage']['complete'])
        self.assertEqual(graph['coverage']['loadedCases'], 2)
        self.assertEqual(graph['coverage']['totalCases'], 3)

    def test_example_does_not_include_private_case_ids(self):
        graph = self.service.graph({'mode': ['example']})
        self.assertFalse(any(node['kind'] == 'case' for node in graph['nodes']))
        self.assertEqual(graph['coverage']['totalCases'], 0)

    def test_empty_or_unreviewed_corpus_does_not_fall_back_to_fake_data(self):
        self.repository.records = lambda kind: []
        self.assertEqual(self.service.graph({})['nodes'], [])
        self.corpus['scanStatus'] = 'pending'
        with self.assertRaises(ValueError):
            self.service.graph({'project': ['project-test']})

    def test_input_is_scanned_before_resolution_and_unknown_routes_rejected(self):
        self.service.post('/api/support/ontology/resolve', {'text': 'A-100 报 E102'})
        self.repository.text.assert_called_once_with('A-100 报 E102', 500)
        self.repository.text.side_effect = ValueError('blocked input')
        with self.assertRaises(ValueError):
            self.service.post('/api/support/ontology/resolve', {'text': 'blocked input'})
        with self.assertRaises(ValueError):
            self.service.get('/api/support/ontology/unknown', {})
        with self.assertRaises(ValueError):
            self.service.graph({'mode': ['unknown']})


if __name__ == '__main__':
    unittest.main()
