import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
import private_corpus
import quality_corpus
import support_api
from prepare_quality_datasets import convert_row, qualification
from redact_labeled_dataset import Redactor
import publish_quality_datasets


class QualityDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.directory = self.home / 'package'
        self.directory.mkdir()
        self.record = convert_row({'SESSION_SEQ': 'synthetic-session', 'gold_score': '0', 'is_qualified': False, 'transcript_text': '客户：设备无法启动。\n坐席：请先核实设备型号。', 'dim_observe': '未邀评,结束语不规范'}, 2, 'online', 'quality-online-test-v1', Redactor(b'synthetic-quality-test'))
        self.manifest = {'schemaVersion': 1, 'kind': quality_corpus.KIND, 'id': self.record['datasetId'], 'channel': 'online', 'name': '合成质检测试', 'scanStatus': 'passed', 'quarantined': [], 'files': [], 'totals': {}, 'recordsSha256': ''}
        self.write_package()
        self.patchers = [patch.object(support_api, 'DATABASE', self.home / 'support.sqlite3')]
        for patcher in self.patchers:
            patcher.start()
        with support_api.connection() as database:
            database.execute('CREATE TABLE documents(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))')
        self.config = self.home / 'registry.json'
        self.config.write_text(json.dumps({'schemaVersion': 1, 'datasets': [self.entry]}))

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def write_package(self):
        source = self.directory / 'online_redacted.jsonl'
        source.write_text(json.dumps(self.record, ensure_ascii=False) + '\n')
        self.manifest.update(files=[{'name': source.name, 'records': 1, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}], totals=quality_corpus.statistics([self.record]), recordsSha256=quality_corpus.fingerprint([self.record]))
        manifest = self.directory / 'manifest.json'
        manifest.write_text(json.dumps(self.manifest, ensure_ascii=False))
        self.entry = {'repository': 'sample-owner/private-data', 'datasetId': self.manifest['id'], 'commit': 'a' * 40, 'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest()}

    def restore(self):
        with patch.object(private_corpus, 'cached_package', return_value=self.directory):
            return private_corpus.restore_registered(support_api, self.config)

    def test_zero_false_and_missing_remain_distinct(self):
        self.assertEqual(self.record['labels']['goldScore'], 0)
        self.assertIs(self.record['labels']['qualified'], False)
        self.assertEqual(self.record['labels']['dimensions']['dim_observe'], ['未邀评', '结束语不规范'])
        self.assertEqual(self.record['labels']['dimensions']['dim_risk'], [])
        self.assertIsNone(self.record['labels']['reason'])
        self.assertIsNone(qualification(None))
        self.assertIs(qualification('false'), False)
        with self.assertRaises(ValueError):
            qualification('unknown')

    def test_hotline_never_invents_transcript(self):
        record = convert_row({'serial_id': 'synthetic-call', 'gold_score': '80', 'is_qualified': None}, 3, 'hotline', 'quality-hotline-test-v1', Redactor(b'synthetic-quality-test'))
        self.assertIsNone(record['transcript'])
        self.assertEqual(quality_corpus.statistics([record])['transcriptRecords'], 0)

    def test_scores_cannot_imply_qualification_or_dimension_points(self):
        record = copy.deepcopy(self.record)
        record['labels'].update(goldScore=100, qualified=None)
        quality_corpus.validate_record(record, record['datasetId'], 'online')
        self.assertEqual(quality_corpus.statistics([record])['qualificationMissing'], 1)
        for score in (True, float('nan'), -1, 101):
            record['labels']['goldScore'] = score
            with self.assertRaises(ValueError):
                quality_corpus.validate_record(record, record['datasetId'], 'online')

    def test_identity_fields_are_removed_and_text_is_scanned(self):
        private_value = 'synthetic-agent-identity'
        record = convert_row({'serial_id': private_value, 'agent_name': private_value, 'ent_name': '合成示例单位'}, 2, 'hotline', 'quality-hotline-test-v1', Redactor(b'synthetic-quality-test'))
        self.assertNotIn(private_value, json.dumps(record))
        self.assertNotIn('合成示例单位', json.dumps(record, ensure_ascii=False))
        self.assertEqual(quality_corpus.checked_quality_records(self.directory)[1], [self.record])

    def test_private_restore_is_idempotent_and_offline(self):
        self.assertEqual(self.restore()[0]['inserted'], 1)
        with patch.object(private_corpus, 'cached_package', side_effect=AssertionError('no network')):
            self.assertEqual(private_corpus.restore_registered(support_api, self.config)[0]['status'], 'already_present')
        self.assertEqual(len(support_api.records('quality_record')), 1)
        self.assertEqual(support_api.records('imported_dialogue'), [])
        self.assertEqual(support_api.records('corpus'), [])

    def test_missing_record_restored_without_changing_others(self):
        self.restore()
        with support_api.connection() as database:
            database.execute("DELETE FROM documents WHERE kind='quality_record'")
        self.assertEqual(self.restore()[0]['inserted'], 1)
        self.assertEqual(support_api.get('quality_record', self.record['id']), self.record)

    def test_conflicting_label_refuses_overwrite_and_keeps_backup(self):
        self.restore()
        modified = copy.deepcopy(self.record)
        modified['labels']['goldScore'] = 55
        support_api.save('quality_record', self.record['id'], modified)
        with self.assertRaisesRegex(ValueError, '未覆盖'):
            self.restore()
        self.assertEqual(support_api.get('quality_record', self.record['id'])['labels']['goldScore'], 55)
        self.assertEqual(len(list((self.home / 'backups').glob('*.sqlite3'))), 2)

    def test_hash_tamper_extra_files_and_invalid_schema_rejected(self):
        (self.directory / 'extra.txt').write_text('unexpected')
        with self.assertRaises(ValueError):
            quality_corpus.checked_quality_records(self.directory)
        (self.directory / 'extra.txt').unlink()
        (self.directory / 'online_redacted.jsonl').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, '指纹'):
            quality_corpus.checked_quality_records(self.directory)
        self.record['labels']['dimensions'].pop('dim_risk')
        self.write_package()
        with self.assertRaisesRegex(ValueError, '七项'):
            quality_corpus.checked_quality_records(self.directory)

    def test_api_lists_without_transcript_and_requires_correct_project(self):
        self.restore()
        query = {'project': [self.entry['datasetId']]}
        response = support_api.dispatch_get('/api/support/quality/records', query)[0]
        self.assertEqual(response['total'], 1)
        self.assertNotIn('transcript', response['records'][0])
        self.assertEqual(support_api.dispatch_get('/api/support/quality/records/' + self.record['id'], query)[0], self.record)
        with self.assertRaises(ValueError):
            support_api.dispatch_get('/api/support/quality/records/' + self.record['id'], {'project': ['other']})

    def test_publishing_rejects_unsafe_repository_before_any_write(self):
        with patch.object(publish_quality_datasets, 'verify_access', side_effect=ValueError('private access required')), patch.object(publish_quality_datasets, 'write_github') as write:
            with self.assertRaises(ValueError):
                publish_quality_datasets.publish('sample-owner/private-data', [self.directory])
            write.assert_not_called()

    def test_publishing_is_atomic_non_forced_and_download_verified(self):
        replies = [{'default_branch': 'main'}, {'object': {'sha': 'a' * 40}}, {'tree': {'sha': 'b' * 40}}, {'tree': [], 'truncated': False}]
        writes = [{'sha': 'c' * 40}, {'sha': 'd' * 40}, {'sha': 'e' * 40}, {'sha': 'f' * 40}, {'object': {'sha': 'f' * 40}}]
        with patch.object(publish_quality_datasets, 'verify_access') as access, patch.object(publish_quality_datasets, 'github_json', side_effect=replies), patch.object(publish_quality_datasets, 'write_github', side_effect=writes) as write, patch.object(publish_quality_datasets, 'github_bytes', side_effect=[(self.directory / 'manifest.json').read_bytes(), (self.directory / 'online_redacted.jsonl').read_bytes()]):
            result = publish_quality_datasets.publish('sample-owner/private-data', [self.directory])
        self.assertEqual(access.call_count, 2)
        self.assertEqual(write.call_args.args[1], {'sha': 'f' * 40, 'force': False})
        self.assertEqual(write.call_args.kwargs['method'], 'PATCH')
        self.assertEqual(result[0]['commit'], 'f' * 40)

    def test_publishing_refuses_different_existing_version(self):
        replies = [{'default_branch': 'main'}, {'object': {'sha': 'a' * 40}}, {'tree': {'sha': 'b' * 40}}, {'tree': [{'type': 'blob', 'path': 'packages/' + self.entry['datasetId'] + '/manifest.json', 'sha': 'c' * 40}], 'truncated': False}]
        with patch.object(publish_quality_datasets, 'verify_access'), patch.object(publish_quality_datasets, 'github_json', side_effect=replies), patch.object(publish_quality_datasets, 'write_github') as write:
            with self.assertRaisesRegex(ValueError, '不同内容'):
                publish_quality_datasets.publish('sample-owner/private-data', [self.directory])
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()
