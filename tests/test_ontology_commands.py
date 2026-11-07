import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from ontology import SCHEMA, OntologyService, digest, example_graph
from ontology_commands import OntologyCommands
from ontology_workflow import run_workflow


class OntologyCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / 'ontology.sqlite3'
        self.scanner = Mock()
        self.workspace = OntologyCommands(self.path, self.scanner)

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, text, selected='startup', revision=None):
        return self.workspace.command({'command': text, 'selectedNodeId': selected, 'expectedRevision': revision or self.workspace.state()['revision']})

    def commit(self, preview):
        return self.workspace.commit({'previewId': preview['previewId'], 'expectedRevision': preview['revision'], 'confirm': True})

    def test_preview_is_not_a_write_and_confirm_really_changes_retrieval(self):
        original_hash = digest(SCHEMA)
        original = run_workflow('我的主机启动没反应。', schema=self.workspace.snapshot()['schema'])
        self.assertEqual(original['comparison']['selected'], [])
        preview = self.command('添加别名“启动没反应”')
        self.assertEqual(preview['function'], 'add_alias')
        self.assertEqual(preview['status'], 'preview')
        self.assertFalse(preview['writesApplied'])
        self.assertEqual(digest(self.workspace.snapshot()['schema']), original_hash)
        result = self.commit(preview)
        self.assertTrue(result['writesApplied'])
        updated = self.command('运行客服任务“我的主机启动没反应。”')
        self.assertEqual(updated['output']['comparison']['selected'][0]['id'], 'DEMO-STARTUP')
        self.assertEqual(digest(SCHEMA), original_hash)

    def test_persistence_and_auditable_undo_restore_behavior(self):
        self.commit(self.command('添加别名“启动没反应”'))
        restored = OntologyCommands(self.path, self.scanner)
        self.assertTrue(restored.state()['undoAvailable'])
        self.assertIn('启动没反应', next(item['aliases'] for item in restored.snapshot()['schema']['entities'] if item['id'] == 'startup'))
        undo = self.command('撤销上次修改')
        self.assertEqual(undo['status'], 'preview')
        self.commit(undo)
        self.assertEqual(self.command('运行客服任务“我的主机启动没反应。”')['output']['comparison']['selected'], [])
        self.assertFalse(self.workspace.state()['undoAvailable'])
        self.assertTrue(any(row['status'] == 'committed' and row['function'] == 'undo_change' for row in self.workspace.state()['history']))

    def test_description_entity_and_typed_relation_are_real_functions(self):
        self.commit(self.command('说明改为“匿名修改后的定义。”'))
        self.assertEqual(self.command('查看关联元素')['output']['node']['description'], '匿名修改后的定义。')
        created = self.commit(self.command('新增部件“散热模组”'))
        identifier = created['arguments']['nodeId']
        self.commit(self.command('关联“散热模组”，关系“示例组成部件”', 'equipment'))
        inspected = self.command('查看关联元素', identifier)
        self.assertTrue(any(edge['source'] == 'equipment' and edge['target'] == identifier for edge in inspected['output']['relations']))
        self.commit(self.command('移除关联“散热模组”，关系“示例组成部件”', 'equipment'))
        self.assertFalse(any(edge['type'] == 'has_component' for edge in self.command('查看关联元素', identifier)['output']['relations']))

    def test_alias_removal_and_multi_undo_are_lifo(self):
        self.commit(self.command('添加别名“启动没反应”'))
        self.commit(self.command('移除别名“启动没反应”'))
        self.commit(self.command('撤销上次修改'))
        self.assertEqual(self.command('运行客服任务“启动没反应。”')['output']['comparison']['selected'][0]['id'], 'DEMO-STARTUP')
        self.commit(self.command('撤销上次修改'))
        self.assertEqual(self.command('运行客服任务“启动没反应。”')['output']['comparison']['selected'], [])

    def test_cross_class_relationships_and_protected_nodes_are_rejected(self):
        for text, node in [('关联“主控板”，关系“候选部件”', 'startup'), ('说明改为“关闭安全限制”', 'rule:candidate-only'), ('关联“主控板”，关系“受约束”', 'equipment'), ('新增型号“A-300”', 'equipment')]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.command(text, node)
        self.assertEqual(self.workspace.snapshot()['generation'], 0)

    def test_regression_failure_blocks_candidate_changes(self):
        preview = self.command('关联“供电模块”，关系“候选部件”', 'code-a')
        self.assertEqual(preview['status'], 'blocked')
        self.assertFalse(preview['canCommit'])
        self.assertLess(preview['checks']['passed'], preview['checks']['total'])
        with self.assertRaises(ValueError):
            self.commit(preview)
        self.assertEqual(self.workspace.snapshot()['generation'], 0)

    def test_alias_conflicts_unsupported_and_compound_commands_do_not_run(self):
        for text in ['添加别名“黑屏”', '添加别名“开不了机”', '删除所有节点', '添加别名“新词”；删除数据库', '执行 rm -rf /', 'python print(1)']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.command(text)
        self.assertEqual(self.workspace.snapshot()['generation'], 0)
        self.assertTrue(all(item['status'] == 'blocked' for item in self.workspace.state()['history']))

    def test_sensitive_input_never_reaches_parser_or_storage(self):
        self.scanner.side_effect = ValueError('synthetic privacy gate')
        with patch('ontology_commands.parse_command') as parser, self.assertRaises(ValueError):
            self.command('合成的拦截输入')
        parser.assert_not_called()
        self.assertEqual(self.workspace.state()['history'], [])

    def test_confirmation_tampering_expiry_and_duplicates_fail_closed(self):
        preview = self.command('添加别名“启动没反应”')
        for body in [{'previewId': preview['previewId'], 'expectedRevision': preview['revision'], 'confirm': False}, {'previewId': preview['previewId'], 'expectedRevision': preview['revision'], 'confirm': True, 'arguments': {'alias': 'tampered'}}]:
            with self.assertRaises(ValueError):
                self.workspace.commit(body)
        with patch('ontology_commands.time.time', return_value=preview['expiresAt'] + 1), self.assertRaises(ValueError):
            self.commit(preview)
        self.commit(preview)
        with self.assertRaises(ValueError):
            self.commit(preview)

    def test_stale_revision_and_aba_after_undo_do_not_reuse_preview(self):
        stale = self.command('添加别名“另一叫法”')
        self.commit(self.command('添加别名“启动没反应”'))
        self.commit(self.command('撤销上次修改'))
        self.assertEqual(digest(self.workspace.snapshot()['schema']), digest(SCHEMA))
        with self.assertRaises(ValueError):
            self.commit(stale)
        with self.assertRaises(ValueError):
            self.command('查看关联元素', revision=stale['revision'])

    def test_concurrent_confirms_allow_only_one_atomic_write(self):
        previews = [self.command('添加别名“新叫法甲”'), self.command('添加别名“新叫法乙”')]
        def attempt(preview):
            try:
                return self.commit(preview)['writesApplied']
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, previews))
        self.assertEqual(results.count(True), 1)
        self.assertEqual(self.workspace.snapshot()['generation'], 1)

    def test_transaction_failure_does_not_save_partial_graph_or_consume_preview(self):
        preview = self.command('添加别名“启动没反应”')
        with patch.object(self.workspace, 'event', side_effect=RuntimeError('synthetic disk failure')), self.assertRaises(RuntimeError):
            self.commit(preview)
        self.assertEqual(self.workspace.snapshot()['generation'], 0)
        self.assertTrue(self.commit(preview)['writesApplied'])

    def test_preview_and_confirm_both_use_privacy_gate(self):
        preview = self.command('添加别名“启动没反应”')
        self.commit(preview)
        self.assertEqual(self.scanner.call_count, 2)

    def test_base_schema_upgrade_is_detected_without_overwriting_workspace(self):
        changed = copy.deepcopy(SCHEMA)
        changed['version'] = 'new-fixture'
        with patch('ontology_commands.SCHEMA', changed), self.assertRaises(ValueError):
            self.workspace.snapshot()
        self.assertEqual(digest(self.workspace.snapshot()['schema']), digest(SCHEMA))

    def test_ontology_endpoints_use_saved_schema_not_global_demo(self):
        repository = SimpleNamespace(DATA=Path(self.temporary.name), local_scan=self.scanner, records=lambda kind: [], now=lambda: 'fixture', text=lambda value, maximum: value)
        service = OntologyService(repository)
        state = service.get('/api/support/ontology/workbench/state', {})
        preview = service.post('/api/support/ontology/workbench/command', {'command': '给“启动异常”添加别名“启动没反应”', 'selectedNodeId': '', 'expectedRevision': state['revision']})
        service.post('/api/support/ontology/workbench/commit', {'previewId': preview['previewId'], 'expectedRevision': state['revision'], 'confirm': True})
        graph = service.graph({'mode': ['example']})
        self.assertTrue(any(node['label'] == '启动没反应' for node in graph['nodes']))
        response = service.post('/api/support/ontology/business/run', {'text': '我的主机启动没反应。', 'confirmedModel': '', 'proposedAction': 'review'})
        self.assertEqual(response['comparison']['selected'][0]['id'], 'DEMO-STARTUP')
        self.assertEqual(service.post('/api/support/ontology/business/verify', {'confirmSynthetic': True})['passed'], 12)


if __name__ == '__main__':
    unittest.main()
