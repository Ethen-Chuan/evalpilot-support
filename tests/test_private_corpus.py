import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
import private_corpus
import support_api
from corpus_import import checked_records
from redact_labeled_dataset import Redactor, convert_record
from test_corpus import source_row


class PrivateAccessTests(unittest.TestCase):
    def replies(self):
        return [
            {'login': 'sample-owner'},
            {'full_name': 'sample-owner/private-data', 'private': True, 'visibility': 'private', 'owner': {'type': 'User', 'login': 'sample-owner'}, 'permissions': {'admin': True}, 'fork': False, 'has_pages': False},
            [{'login': 'sample-owner'}], [], [], {'enabled': False},
        ]

    def test_owner_only_private_repository_accepted(self):
        with patch.object(private_corpus, 'github_json', side_effect=self.replies()):
            result = private_corpus.verify_access('sample-owner/private-data')
        self.assertEqual(result['otherCollaborators'], 0)

    def test_public_shared_invited_keys_actions_pages_and_wrong_owner_rejected(self):
        scenarios = []
        for field, value in [('private', False), ('visibility', 'public'), ('fork', True), ('has_pages', True), ('owner', {'type': 'Organization', 'login': 'sample-owner'}), ('full_name', 'another-owner/private-data')]:
            replies = self.replies()
            replies[1][field] = value
            scenarios.append(replies)
        for position, value in [(0, {'login': 'another-owner'}), (2, [{'login': 'another-person'}]), (3, [{'id': 1}]), (4, [{'id': 1}]), (5, {'enabled': True})]:
            replies = self.replies()
            replies[position] = value
            scenarios.append(replies)
        for replies in scenarios:
            with self.subTest(replies=replies), patch.object(private_corpus, 'github_json', side_effect=replies), self.assertRaises(ValueError):
                private_corpus.verify_access('sample-owner/private-data')

    def test_request_never_prints_remote_error_and_disables_debug(self):
        with patch.dict(os.environ, {'GH_DEBUG': 'api'}), patch.object(private_corpus.subprocess, 'run') as command:
            command.return_value.returncode = 1
            command.return_value.stdout = b'server error'
            with self.assertRaisesRegex(ValueError, '无法读取私有仓库'):
                private_corpus.github_bytes('user')
            self.assertNotIn('GH_DEBUG', command.call_args.kwargs['env'])
            self.assertIn('github.com', command.call_args.args[0])


class PrivateCorpusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.package = self.home / 'package'
        self.package.mkdir()
        self.database = self.home / 'database'
        self.database.mkdir()
        self.record = convert_record(source_row(), 'source-test', 1, Redactor(b'local-test-key'), dataset_id='sample-private-v1')
        self.source = self.package / 'source-test_redacted.jsonl'
        self.source.write_text(json.dumps(self.record, ensure_ascii=False) + '\n')
        self.manifest = {'schemaVersion': 1, 'id': self.record['datasetId'], 'scanStatus': 'passed', 'quarantined': [], 'totals': {'sessions': 1, 'messages': 2}, 'files': [{'name': self.source.name, 'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest(), 'sessions': 1}]}
        self.manifest_path = self.package / 'manifest.json'
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.entry = {'repository': 'sample-owner/private-data', 'datasetId': self.record['datasetId'], 'commit': 'a' * 40, 'manifestSha256': hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()}
        self.config = self.home / 'registry.json'
        self.config.write_text(json.dumps({'schemaVersion': 1, 'datasets': [self.entry]}))
        self.patchers = [patch.object(support_api, 'DATA', self.database), patch.object(support_api, 'DATABASE', self.database / 'support.sqlite3')]
        for patcher in self.patchers:
            patcher.start()
        with support_api.connection() as database:
            database.execute('CREATE TABLE documents(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))')
        support_api.DIALOGUES.initialize_index()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def restore(self):
        with patch.object(private_corpus, 'cached_package', return_value=self.package):
            return private_corpus.restore_registered(support_api, self.config)

    def test_real_scanner_import_and_repeat_without_network_or_duplicate(self):
        result = self.restore()
        self.assertEqual(result[0]['inserted'], 1)
        with patch.object(private_corpus, 'github_bytes', side_effect=AssertionError('must stay offline')), patch.object(private_corpus, 'cached_package', side_effect=AssertionError('must keep existing data')):
            repeated = private_corpus.restore_registered(support_api, self.config)
        self.assertEqual(repeated[0]['status'], 'already_present')
        self.assertEqual(len(support_api.records('imported_dialogue')), 1)
        self.assertEqual(len(list((self.home / 'backups').glob('*.sqlite3'))), 1)

    def test_deleted_data_restored_and_unrelated_document_preserved(self):
        self.restore()
        support_api.save('test_marker', 'keep', {'id': 'keep'})
        with support_api.connection() as database:
            database.execute("DELETE FROM documents WHERE kind IN ('imported_dialogue','dialogue_archive')")
        restored = self.restore()
        self.assertEqual(restored[0]['inserted'], 1)
        self.assertEqual(support_api.get('test_marker', 'keep'), {'id': 'keep'})

    def test_real_scanner_rejects_manifest_content_tamper(self):
        self.manifest_path.write_text('{}')
        with self.assertRaisesRegex(ValueError, '指纹不一致'):
            private_corpus.check_package(self.package, self.entry)

    def test_real_scanner_rejects_file_tamper_before_database_write(self):
        self.source.write_text(self.source.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, '指纹不一致'):
            private_corpus.check_package(self.package, self.entry)
        self.assertEqual(support_api.records('imported_dialogue'), [])

    def test_extra_files_missing_files_and_symlinks_rejected(self):
        extra = self.package / 'unexpected.txt'
        extra.write_text('not part of package')
        with self.assertRaises(ValueError):
            private_corpus.check_package(self.package, self.entry)
        extra.unlink()
        self.source.unlink()
        with self.assertRaises(ValueError):
            private_corpus.check_package(self.package, self.entry)
        self.source.symlink_to(self.manifest_path)
        with self.assertRaises(ValueError):
            private_corpus.check_package(self.package, self.entry)
        with self.assertRaises(ValueError):
            checked_records(self.package)

    def test_download_uses_only_pinned_allowlisted_files(self):
        payloads = {'manifest.json': self.manifest_path.read_bytes(), self.source.name: self.source.read_bytes()}
        calls = []
        def download(endpoint, **options):
            calls.append(endpoint)
            self.assertTrue(endpoint.endswith('?ref=' + self.entry['commit']))
            self.assertTrue(options['raw'])
            return payloads[endpoint.split('/')[-1].split('?')[0]]
        with patch.object(private_corpus, 'verify_access'), patch.object(private_corpus, 'github_bytes', side_effect=download):
            cached = private_corpus.cached_package(self.entry, self.home)
        self.assertEqual(len(calls), 2)
        self.assertEqual(private_corpus.check_package(cached, self.entry)['id'], self.entry['datasetId'])
        self.assertEqual((cached / 'manifest.json').stat().st_mode & 0o777, 0o600)

    def test_unsafe_remote_manifest_never_downloads_data(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['files'][0]['name'] = '../source-test_redacted.jsonl'
        payload = json.dumps(manifest).encode()
        self.entry['manifestSha256'] = hashlib.sha256(payload).hexdigest()
        with patch.object(private_corpus, 'verify_access'), patch.object(private_corpus, 'github_bytes', return_value=payload) as download, self.assertRaises(ValueError):
            private_corpus.cached_package(self.entry, self.home)
        self.assertEqual(download.call_count, 1)

    def test_registered_commit_cannot_be_silently_changed(self):
        changed = {**self.entry, 'commit': 'b' * 40}
        with self.assertRaisesRegex(ValueError, '另一版本'):
            private_corpus.register(changed, self.config)
        self.restore()
        self.config.write_text(json.dumps({'schemaVersion': 1, 'datasets': [changed]}))
        with self.assertRaisesRegex(ValueError, '版本不同'):
            private_corpus.restore_registered(support_api, self.config)

    def test_offline_failure_is_reported_and_existing_data_preserved(self):
        support_api.save('test_marker', 'keep', {'id': 'keep'})
        with patch.object(private_corpus, 'config_path', return_value=self.config), patch.object(private_corpus, 'cached_package', side_effect=OSError('offline')), patch('sys.stdout', new_callable=io.StringIO) as output:
            result = private_corpus.restore_at_startup(support_api)
        self.assertEqual(result, [{'status': 'attention_required'}])
        self.assertIn('恢复未完成', output.getvalue())
        self.assertEqual(support_api.get('test_marker', 'keep'), {'id': 'keep'})

    def test_absent_registry_does_not_download_or_create_demo_data(self):
        with patch.object(private_corpus, 'github_bytes', side_effect=AssertionError('must stay offline')):
            self.assertEqual(private_corpus.restore_registered(support_api, self.home / 'absent.json'), [])
        self.assertEqual(support_api.records('imported_dialogue'), [])

    def test_mutable_revision_paths_and_extra_fields_rejected(self):
        for changed in [{**self.entry, 'commit': 'main'}, {**self.entry, 'datasetId': '../elsewhere'}, {**self.entry, 'repository': 'https://example.invalid/repo'}, {**self.entry, 'unknown': 'value'}]:
            with self.subTest(entry=changed), self.assertRaises(ValueError):
                private_corpus.validate_entry(changed)


if __name__ == '__main__':
    unittest.main()
