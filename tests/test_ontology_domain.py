import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from ontology_domain import SEED, align, execute_local, graph_payload, plan_calls, runtime_contract, validate_call, validate_harness_output, validate_output, validate_schema
from ontology_domain_acceptance import verify
from ontology_registry import OntologyRegistry, alias_rows


def workbook(change=None):
    files = {'xl/workbook.xml': '<workbook><sheets><sheet name="Aliases"/></sheets></workbook>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>entityId</t></is></c><c r="B1" t="inlineStr"><is><t>alias</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>mainboard</t></is></c><c r="B2" t="inlineStr"><is><t>控制模块示例</t></is></c></row></sheetData></worksheet>'}
    if change:
        change(files)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return base64.b64encode(stream.getvalue()).decode()


class DomainLogicTests(unittest.TestCase):
    def test_seed_and_independent_acceptance(self):
        self.assertTrue(validate_schema(SEED))
        result = verify(SEED)
        self.assertEqual(result['passed'], 13)
        self.assertEqual(result['total'], 13)

    def test_invalid_schema_shapes_rejected_without_type_errors(self):
        changes = [lambda schema: schema['entities'][0].update(modelIds=[{}]), lambda schema: schema['entities'][0].update(modelIds=['absent']), lambda schema: schema['entities'][0].update(enabled='yes'), lambda schema: schema['entities'][0].update(aliases=['主控板']), lambda schema: schema['entities'][0].update(**{'class': []}), lambda schema: schema['relations'][0].update(source=[]), lambda schema: schema['relations'][0].update(target='absent'), lambda schema: schema['relations'][0].update(type='has_spare'), lambda schema: schema['rules'][0].update(actionId='remote'), lambda schema: schema['rules'][0].update(enabled=False), lambda schema: schema['classes'].pop(), lambda schema: schema['documents'][0].update(entityIds=[{}])]
        for change in changes:
            schema = copy.deepcopy(SEED)
            change(schema)
            with self.subTest(change=changes.index(change)), self.assertRaises(ValueError):
                validate_schema(schema)

    def test_contradictory_relations_and_references(self):
        for relation in [dict(SEED['relations'][8], id='conflict', type='forbids_action'), {'id': 'conflict', 'source': 'black', 'target': 'mainboard', 'type': 'excludes_part', 'modelIds': ['model-a']}]:
            schema = copy.deepcopy(SEED)
            schema['relations'].append(relation)
            with self.assertRaises(ValueError):
                validate_schema(schema)
        schema = copy.deepcopy(SEED)
        schema['entities'] = [item for item in schema['entities'] if item['id'] != 'mainboard']
        with self.assertRaises(ValueError):
            validate_schema(schema)

    def test_negation_removes_history_and_longest_names_do_not_overlap(self):
        history = [{'role': 'user', 'content': 'A-100 主控板黑屏。'}]
        result = align(SEED, '不是黑屏。', history)
        self.assertEqual(result['slots']['symptom'], [])
        self.assertEqual(result['status'], 'clarify')
        for message in ['现在不黑屏了。', '黑屏好了。', '不再黑屏了。']:
            self.assertFalse(align(SEED, message, history)['slots'].get('symptom'))
        result = align(SEED, '换成 B-999。', history)
        self.assertIsNone(result['modelId'])
        self.assertEqual(result['unknownModels'], ['B-999'])
        self.assertFalse(result['slots'].get('component'))
        result = align(SEED, '不是 A-100。', history)
        self.assertIsNone(result['modelId'])
        self.assertFalse(result['slots'].get('component'))
        result = align(SEED, 'A-090 已停产主板备件示例。')
        self.assertEqual(result['slots']['spare'], ['spare-old'])
        self.assertFalse(result['slots'].get('component'))

    def test_current_conflict_disabled_unknown_and_model_switch(self):
        self.assertEqual(align(SEED, 'A-100 和 A-200 都黑屏。')['status'], 'clarify')
        self.assertEqual(align(SEED, 'A-999 黑屏。')['unknownModels'], ['A-999'])
        history = [{'role': 'user', 'content': 'A-100 主板黑屏。'}]
        result = align(SEED, '另一台 A-200。', history)
        self.assertEqual(result['modelId'], 'model-b')
        self.assertFalse(result['slots'].get('symptom'))
        schema = copy.deepcopy(SEED)
        next(item for item in schema['entities'] if item['id'] == 'mainboard')['enabled'] = False
        self.assertIn('mainboard', align(schema, 'A-100 主板黑屏')['disabledEntityIds'])
        self.assertEqual(align(SEED, 'A-100 黑屏，属于轻微告警和重大故障。')['status'], 'clarify')

    def test_six_customer_turns_not_assistant_claims(self):
        history = [{'role': 'assistant', 'content': 'A-100 主板黑屏。'}]
        self.assertIsNone(align(SEED, '能维修吗？', history)['modelId'])
        history = [{'role': 'user', 'content': 'A-100 黑屏。'}] + [{'role': 'user', 'content': '好的。'}] * 5
        result = align(SEED, '继续。', history)
        self.assertIsNone(result['modelId'])
        self.assertEqual(result['window'], {'limit': 6, 'retainedUserTurns': 6, 'droppedUserTurns': 1})

    def test_tool_parameter_and_output_evidence(self):
        alignment = align(SEED, 'A-100 主板黑屏。')
        planned = plan_calls(SEED, alignment)
        call = planned[0]
        for changed in [dict(call, tool='shell'), dict(call, arguments={}), dict(call, arguments={**call['arguments'], 'modelId': 'model-b'}), dict(call, arguments={**call['arguments'], 'actionId': 'onsite'})]:
            self.assertFalse(validate_call(SEED, alignment, changed)['allowed'])
        proposal = {'partIds': ['mainboard'], 'spareIds': [], 'actionIds': []}
        self.assertFalse(validate_output(SEED, alignment, proposal, [])['allowed'])
        evidence = [{'call': call, 'status': 'succeeded', 'output': execute_local(SEED, call)}]
        self.assertTrue(validate_output(SEED, alignment, proposal, evidence)['allowed'])
        self.assertFalse(validate_output(SEED, alignment, {**proposal, 'productionExecuted': True}, evidence)['allowed'])

    def test_graph_aliases_classes_and_scope_have_explicit_edges(self):
        graph = graph_payload(SEED)
        identifiers = {node['id'] for node in graph['nodes']}
        self.assertTrue(all(edge['source'] in identifiers and edge['target'] in identifiers for edge in graph['edges']))
        aliases = [node for node in graph['nodes'] if node['label'] in ['主控板', '控制板']]
        self.assertEqual(len(aliases), 2)
        self.assertTrue(all(any(edge['source'] == node['id'] and edge['target'] == 'mainboard' for edge in graph['edges']) for node in aliases))
        self.assertTrue(any(edge['source'] == 'model-a' and edge['target'] == 'mainboard' for edge in graph['edges']))

    def test_graph_projects_actual_rules_without_changing_schema_or_evidence_ids(self):
        original = copy.deepcopy(SEED)
        graph = graph_payload(SEED)
        nodes = {node['id']: node for node in graph['nodes']}
        edges = {edge['id']: edge for edge in graph['edges']}
        for rule in SEED['rules']:
            self.assertEqual(nodes['rule:' + rule['id']]['description'], rule['description'])
            self.assertEqual(nodes['rule:' + rule['id']]['enabled'], rule['enabled'])
            self.assertEqual(edges[rule['id']]['ruleId'], rule['id'])
        self.assertEqual(edges['rule-major']['source'], 'rule:rule-major')
        self.assertEqual(edges['rule-major']['target'], 'onsite')
        self.assertEqual(edges['rule-major:trigger']['source'], 'major')
        self.assertEqual(edges['rule-retired']['target'], 'class:spare')
        self.assertEqual(SEED, original)
        self.assertEqual(len(nodes), len(graph['nodes']))
        self.assertEqual(len(edges), len(graph['edges']))

    def test_graph_keeps_entity_and_alias_model_scope_and_disabled_state(self):
        schema = copy.deepcopy(SEED)
        next(entity for entity in schema['entities'] if entity['id'] == 'mainboard')['enabled'] = False
        graph = graph_payload(schema)
        board = next(node for node in graph['nodes'] if node['id'] == 'mainboard')
        alias = next(node for node in graph['nodes'] if node['label'] == '主控板')
        self.assertEqual(board['modelIds'], alias['modelIds'])
        self.assertFalse(alias['enabled'])
        model_alias = next(node for node in graph['nodes'] if node['label'] == '示例二型')
        self.assertEqual(model_alias['modelIds'], ['model-b'])

    def test_harness_contract_and_output_share_versioned_rules(self):
        missing = runtime_contract(SEED, '主板黑屏。', [])
        self.assertNotIn('lookup_service', missing['allowedHarnessTools'])
        self.assertEqual(missing['knowledgeIds'], [])
        normal = runtime_contract(SEED, 'A-100 控制板开机屏幕不亮。', [])
        self.assertIn('KB-BLACKSCREEN', normal['knowledgeIds'])
        self.assertIn('开机黑屏', normal['canonicalQuery'])
        major = runtime_contract(SEED, 'A-100 冒烟。', [])
        self.assertEqual(major['requiredAction'], 'handoff')
        self.assertFalse(validate_harness_output(major, {'action': 'handoff'}, [])['allowed'])


class AliasImportTests(unittest.TestCase):
    def test_csv_and_xlsx_scan_before_use(self):
        scan = Mock()
        csv_content = base64.b64encode('entityId,alias\nmainboard,控制模块示例\n'.encode()).decode()
        for filename, value in [('aliases.csv', csv_content), ('aliases.xlsx', workbook())]:
            rows = alias_rows(filename, value, scan)
            self.assertEqual(rows, [{'entityId': 'mainboard', 'alias': '控制模块示例'}])
        self.assertEqual(scan.call_count, 2)
        with self.assertRaisesRegex(ValueError, 'privacy gate'):
            alias_rows('aliases.xlsx', workbook(), Mock(side_effect=ValueError('privacy gate')))

    def test_unsupported_hidden_formula_macro_external_and_oversize_rejected(self):
        variants = [lambda files: files.update({'xl/vbaProject.bin': 'test'}), lambda files: files.update({'unknown.bin': 'test'}), lambda files: files.update({'xl/_rels/workbook.xml.rels': '<Relationships><Relationship TargetMode="External" Target="https://invalid.invalid"/></Relationships>'}), lambda files: files.update({'xl/workbook.xml': '<workbook><sheets><sheet state="hidden"/></sheets></workbook>'}), lambda files: files.update({'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row hidden="true"/></sheetData></worksheet>'}), lambda files: files.update({'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c><f>1+1</f></c></row></sheetData></worksheet>'}), lambda files: files.update({'extra.xml': '<test>' + ' ' * 2100000 + '</test>'}), lambda files: files.update({'xl/workbook.xml': '<!DOCTYPE test [<!ENTITY secret "no">]><workbook/>'})]
        for change in variants:
            with self.subTest(change=variants.index(change)), self.assertRaises(ValueError):
                alias_rows('aliases.xlsx', workbook(change), Mock())
        for filename, content in [('file.xls', ''), ('file.xlsx', 'invalid base64'), ('file.csv', base64.b64encode(b'wrong,header\nx,y').decode()), ('file.csv', base64.b64encode(b'entityId,alias\nmainboard,=HYPERLINK()').decode())]:
            with self.assertRaises(ValueError):
                alias_rows(filename, content, Mock())


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.repo = SimpleNamespace(DATA=Path(self.directory.name), local_scan=Mock(return_value='synthetic test'))
        self.registry = OntologyRegistry(self.repo)

    def tearDown(self):
        self.directory.cleanup()

    def preview(self, **changes):
        entity = copy.deepcopy(next(item for item in self.registry.snapshot()['schema']['entities'] if item['id'] == 'mainboard'))
        entity['aliases'].append('总控模块示例')
        return self.registry.preview({'action': 'upsert', 'group': 'entities', 'id': entity['id'], 'item': entity, 'revision': self.registry.snapshot()['revision'], 'actor': '本机测试', 'reason': '合成测试变更', 'expertConfirmed': True, **changes})

    def run_case(self, **changes):
        return self.registry.run({'message': 'A-100 主板屏幕黑屏，需要上门修。', 'requestId': uuid.uuid4().hex, **changes})

    def test_preview_confirm_idempotent_and_rollback(self):
        preview = self.preview()
        self.assertEqual(self.registry.snapshot()['revision'], 1)
        with self.assertRaises(ValueError):
            self.registry.commit({'token': preview['token']})
        result = self.registry.commit({'token': preview['token'], 'confirmed': True})
        self.assertEqual(result['revision'], 2)
        self.assertTrue(self.registry.commit({'token': preview['token'], 'confirmed': True})['replayed'])
        self.assertEqual(align(self.registry.snapshot()['schema'], 'A-100 总控模块示例黑屏')['slots']['component'], ['mainboard'])
        rollback = self.preview(action='rollback', targetRevision=1)
        self.registry.commit({'token': rollback['token'], 'confirmed': True})
        self.assertEqual(self.registry.snapshot()['revision'], 3)
        self.assertEqual(self.registry.snapshot()['schema'], SEED)

    def test_stale_expired_and_unconfirmed_change_does_not_write(self):
        with self.assertRaises(ValueError):
            self.preview(expertConfirmed=False)
        preview, other = self.preview(), self.preview()
        self.registry.commit({'token': other['token'], 'confirmed': True})
        with self.assertRaises(ValueError):
            self.registry.commit({'token': preview['token'], 'confirmed': True})
        rollback = self.preview(action='rollback', targetRevision=1)
        with patch('ontology_registry.time.time', return_value=time.time() + 700), self.assertRaises(ValueError):
            self.registry.commit({'token': rollback['token'], 'confirmed': True})

    def test_conflicting_alias_batch_is_atomic(self):
        data = base64.b64encode('entityId,alias\nmainboard,总控模块示例\nspeaker,主控板\n'.encode()).decode()
        with self.assertRaises(ValueError):
            self.preview(action='import_aliases', filename='aliases.csv', file=data)
        self.assertEqual(self.registry.snapshot()['schema'], SEED)

    def test_blocked_calls_never_reach_execution_and_trace_pairs(self):
        with patch('ontology_registry.execute_local', wraps=execute_local) as tool:
            result = self.run_case(mode='unrelated_part')
        self.assertEqual(tool.call_count, 2)
        self.assertTrue(all(call.args[1]['arguments']['partId'] != 'speaker' for call in tool.call_args_list))
        self.assertEqual(result['blockedCalls'], 1)
        self.assertGreater(len(result['steps']), 10)
        starts = [step['output']['callId'] for step in result['steps'] if step['status'] == 'started']
        self.assertEqual(len(starts), 2)
        self.assertEqual([step['sequence'] for step in result['steps']], list(range(1, len(result['steps']) + 1)))
        self.assertEqual(self.registry.get_run(result['id']), result)

    def test_frozen_revision_and_request_identity(self):
        body = {'message': 'A-100 主控板黑屏。', 'requestId': uuid.uuid4().hex}
        first = self.registry.run(body)
        self.assertTrue(self.registry.run(body)['replayed'])
        with self.assertRaises(ValueError):
            self.registry.run({**body, 'message': 'other'})
        preview = self.preview()
        self.registry.commit({'token': preview['token'], 'confirmed': True})
        second = self.run_case(sessionId=first['sessionId'], revision=1, message='那能上门修吗？')
        self.assertEqual(second['revision'], 1)
        self.assertEqual(second['sessionRevision'], 2)
        self.assertEqual(self.run_case()['revision'], 2)
        for revision in [1, True]:
            with self.assertRaises(ValueError):
                self.run_case(sessionId=first['sessionId'], revision=revision)

    def test_concurrency_and_tool_failure_are_visible(self):
        first = self.run_case()
        self.registry.active_sessions.add(first['sessionId'])
        with self.assertRaisesRegex(ValueError, '正在执行'):
            self.run_case(sessionId=first['sessionId'], revision=1)
        self.registry.active_sessions.clear()
        with patch('ontology_registry.execute_local', side_effect=RuntimeError('private-error-not-persisted')):
            failed = self.run_case()
        self.assertFalse(failed['outputCheck']['allowed'])
        self.assertEqual(len([step for step in failed['steps'] if step['status'] == 'failed']), 2)
        self.assertNotIn('private-error', json.dumps(failed))
        with patch.object(self.registry.capacity, 'acquire', return_value=False), self.assertRaisesRegex(ValueError, '队列已满'):
            self.run_case()

    def test_unavailable_does_not_execute_and_restart_marks_interrupted(self):
        with patch('ontology_registry.execute_local') as tool:
            result = self.run_case(mode='unavailable')
        tool.assert_not_called()
        self.assertFalse(result['outputCheck']['allowed'])
        with self.registry.connect() as database:
            result['status'] = 'running'
            database.execute('UPDATE runs SET payload=? WHERE id=?', (json.dumps(result), result['id']))
        restored = OntologyRegistry(self.repo).get_run(result['id'])
        self.assertEqual(restored['status'], 'interrupted')
        self.assertFalse(restored['outputCheck']['allowed'])

    def test_stats_dedupe_aliases_and_export_omit_original_message(self):
        first = self.run_case(message='A-100 主控板屏幕黑屏，需要上门修。')
        self.run_case(sessionId=first['sessionId'], revision=1, message='开机屏幕不亮。')
        state = self.registry.state()
        self.assertEqual(state['stats']['todayRuns'], 2)
        self.assertEqual(state['stats']['symptoms'], [{'id': 'black', 'sessions': 1}])
        self.assertIsNotNone(state['stats']['alignmentP95Ms'])
        exported = self.registry.export()
        self.assertEqual(exported['rowCount'], 2)
        self.assertNotIn('主控板屏幕黑屏', exported['content'])
        self.assertNotIn('开机屏幕不亮', exported['content'])


if __name__ == '__main__':
    unittest.main()
