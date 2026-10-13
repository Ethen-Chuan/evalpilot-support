import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
import support_api
from corpus_import import import_corpus, checked_records
from redact_labeled_dataset import Redactor, extract_messages, convert_record, annotation_sets, summarize_labels
from tracing import TraceStore


def markup():
    return '<div><div><div><div>用户<span>23:59:55</span></div><div>屏幕无法点亮<br>请帮忙检查<img src="https://example.invalid/image"></div></div></div><div><div><div>人工客服<span>00:00:05</span></div><div>请检查电源连接。</div></div></div></div>'


def source_row():
    return {'data': {'task_id': 'synthetic-task', 'user_id': 'synthetic-user', 'conversation': markup(), 'n_turns': 2, 'n_user_turns': 1, 'n_images': 1, 'n_videos': 0}, 'annotations': [{'result': [{'type': 'choices', 'from_name': 'intent', 'value': {'choices': ['feature_inquiry']}}]}], 'drafts': []}


class RedactionTests(unittest.TestCase):
    def setUp(self):
        self.redactor = Redactor(b'local-test-key')

    def test_parser_preserves_roles_newlines_and_midnight_offset(self):
        messages = extract_messages(markup())
        self.assertEqual([message['role'] for message in messages], ['user', 'human'])
        self.assertEqual([message['elapsedSeconds'] for message in messages], [0, 10])
        self.assertIn('屏幕无法点亮\n请帮忙检查', messages[0]['rawContent'])
        self.assertNotIn('https', messages[0]['rawContent'])
        self.assertEqual(messages[0]['attachments'], {'img': 1})

    def test_categorical_enums_not_mistaken_for_long_identifiers(self):
        record = convert_record(source_row(), 'source-test', 1, self.redactor)
        self.assertEqual(record['labelSummary']['values']['intent'], ['feature_inquiry'])
        self.assertIsNone(record['messages'][0]['traceId'])
        self.assertNotIn('synthetic-user', json.dumps(record))
        self.assertEqual(record['privacy']['originalMediaImported'], False)

    def test_count_mismatch_rejected_not_truncated(self):
        row = source_row()
        row['data']['n_turns'] = 3
        with self.assertRaises(ValueError):
            convert_record(row, 'source-test', 1, self.redactor)

    def test_conflicting_final_and_draft_labels_retained(self):
        row = source_row()
        other = copy.deepcopy(row['annotations'][0])
        other['result'][0]['value']['choices'] = ['fault_repair']
        row['annotations'].append(other)
        row['drafts'].append(copy.deepcopy(other))
        sets = annotation_sets(row, self.redactor)
        self.assertEqual(len(sets), 3)
        self.assertEqual(summarize_labels(sets)['conflicts'], ['intent'])
        sets[1]['cancelled'] = True
        self.assertEqual(summarize_labels(sets)['conflicts'], [])

    def test_identifiers_entities_and_business_segments_redacted(self):
        redactor = Redactor(b'local-test-key', identifiers=['DEVICE-DEMO'])
        self.assertNotIn('DEVICE-DEMO', redactor.text('设备 DEVICE-DEMO 无法点亮'))
        self.assertIn('隔离', redactor.text('维修成本待核实'))
        self.assertIn('隔离', redactor.text('维修需要 500 元'))
        self.assertNotIn('示例市', redactor.text('我在示例市'))
        self.assertNotIn('张老师', redactor.text('张老师您好'))
        self.assertEqual(redactor.alias('person', 'demo'), redactor.alias('person', 'demo'))
        self.assertNotEqual(redactor.alias('person', 'demo'), redactor.alias('session', 'demo'))


class CorpusImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)
        self.patchers = [patch.object(support_api, 'DATA', self.folder), patch.object(support_api, 'DATABASE', self.folder / 'support.sqlite3'), patch.object(support_api, 'TRACE_STORE', TraceStore(self.folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='test scanner stub')]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.record = convert_record(source_row(), 'source-test', 1, Redactor(b'local-test-key'))
        self.record['labelSummary']['values']['is_invalid'] = ['是']
        self.record['labelSummary']['values']['kb_expectation'] = ['gap']
        self.manifest = {'id': self.record['datasetId'], 'totals': {'sessions': 1, 'messages': 2}, 'scanStatus': 'passed'}

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.directory.cleanup()

    def import_fixture(self, suffix='initial'):
        with patch('corpus_import.checked_records', return_value=(self.manifest, [self.record], [])):
            return import_corpus(self.folder, support_api, self.folder / (suffix + '.sqlite3'))

    def test_transactional_import_archive_and_idempotence(self):
        first = self.import_fixture()
        self.assertEqual(first['inserted'], 1)
        self.assertEqual(self.import_fixture('again')['duplicates'], 1)
        session = support_api.DIALOGUES.assemble(self.record['id'])
        self.assertEqual(session['messages'], self.record['messages'])
        self.assertEqual(session['annotationSets'], self.record['annotationSets'])
        self.assertEqual(session['analysis']['traceCount'], 0)
        self.assertEqual(len(session['archives']), 1)
        self.assertEqual(len(support_api.records('knowledge')), 8)
        self.assertEqual(support_api.records('corpus')[0]['trainingStatus'], 'not_trained')

    def test_index_filters_and_no_full_archive_scans(self):
        self.import_fixture()
        listing = support_api.DIALOGUES.sessions({'dataset': [self.record['datasetId']], 'status': ['invalid']})
        self.assertEqual(listing['total'], 1)
        self.assertEqual(support_api.DIALOGUES.sessions({'status': ['gap']})['total'], 1)
        self.assertEqual(support_api.DIALOGUES.sessions({'q': ['电源连接']})['total'], 1)
        self.assertEqual(support_api.DIALOGUES.sessions({'intent': ['fault_repair']})['total'], 0)
        with patch.object(support_api.DIALOGUES, 'assemble', side_effect=AssertionError('list must use summaries')):
            self.assertEqual(support_api.DIALOGUES.sessions({})['total'], 1)

    def test_changed_duplicate_rolls_back_without_overwrite(self):
        self.import_fixture()
        self.record['messages'][0]['content'] = '不同内容'
        with self.assertRaises(ValueError):
            self.import_fixture('conflict')
        self.assertNotEqual(support_api.DIALOGUES.assemble(self.record['id'])['messages'][0]['content'], '不同内容')

    def test_unreviewed_package_rejected(self):
        (self.folder / 'manifest.json').write_text(json.dumps({'schemaVersion': 1, 'scanStatus': 'pending'}))
        with self.assertRaises(ValueError):
            checked_records(self.folder)

    def test_manifest_scan_failure_rejected_before_import(self):
        (self.folder / 'manifest.json').write_text(json.dumps({'schemaVersion': 1, 'scanStatus': 'passed'}))
        completed = SimpleNamespace(returncode=0, stdout=json.dumps({'max_severity': 3, 'findings': [{'severity': 3}]}))
        with patch('corpus_import.subprocess.run', return_value=completed), self.assertRaises(ValueError):
            checked_records(self.folder)
        self.assertEqual(support_api.records('imported_dialogue'), [])

    def test_file_fingerprint_mismatch_rejected(self):
        source = self.folder / 'source-test_redacted.jsonl'
        source.write_text(json.dumps(self.record, ensure_ascii=False) + '\n')
        manifest = {'id': self.record['datasetId'], 'schemaVersion': 1, 'scanStatus': 'passed', 'files': [{'name': source.name, 'sha256': hashlib.sha256(b'different-content').hexdigest(), 'sessions': 1}]}
        (self.folder / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            checked_records(self.folder)

    def test_export_contains_labels_and_provenance(self):
        self.import_fixture()
        session = support_api.DIALOGUES.assemble(self.record['id'])
        exported = support_api.DIALOGUES.markdown(session)
        self.assertIn('feature_inquiry', exported)
        self.assertIn('source-test', exported)
        self.assertIn('请检查电源连接', exported)


if __name__ == '__main__':
    unittest.main()
