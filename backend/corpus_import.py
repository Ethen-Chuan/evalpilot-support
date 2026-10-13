import argparse
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess

from dialogues import DialogueService, analyze, fingerprint


def checked_records(directory):
    scanner = Path.home() / '.config/ept/codex/dlp/dlp'
    manifest_path = directory / 'manifest.json'
    scanned_manifest = subprocess.run([str(scanner), 'scan', str(manifest_path)], capture_output=True, text=True, timeout=60)
    manifest_report = json.loads(scanned_manifest.stdout) if scanned_manifest.returncode == 0 else None
    if not manifest_report or manifest_report['max_severity'] != 0 or manifest_report.get('findings'):
        raise ValueError('数据清单未通过扫描，未导入')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('schemaVersion') != 1 or manifest.get('scanStatus') != 'passed':
        raise ValueError('数据包尚未完成全量复扫')
    records = []
    receipts = []
    for entry in manifest['files']:
        name = entry['name']
        if Path(name).name != name or not name.endswith('_redacted.jsonl'):
            raise ValueError('数据包路径不合法')
        source = directory / name
        content = source.read_bytes()
        if hashlib.sha256(content).hexdigest() != entry['sha256']:
            raise ValueError('文件内容与复核指纹不一致')
        scanned = subprocess.run([str(scanner), 'scan', str(source)], capture_output=True, text=True, timeout=240)
        if scanned.returncode:
            raise ValueError('文件扫描失败，未导入')
        report = json.loads(scanned.stdout)
        if report['max_severity'] != 0 or report.get('findings'):
            raise ValueError('文件复扫仍有风险，未导入')
        rows = [json.loads(line) for line in content.decode().splitlines() if line.strip()]
        if len(rows) != entry['sessions']:
            raise ValueError('文件记录数不一致')
        records.extend(rows)
        receipts.append({'file': name, 'sha256': entry['sha256'], 'maxSeverity': 0})
    identifiers = set()
    message_count = 0
    for record in records:
        if record.get('datasetId') != manifest['id'] or record.get('schemaVersion') != 1 or record['id'] in identifiers:
            raise ValueError('数据版本、来源或唯一标识不一致')
        identifiers.add(record['id'])
        messages = record['messages']
        if len(messages) != record['provenance']['declaredMessages']:
            raise ValueError('会话轮次数不完整')
        for sequence, message in enumerate(messages, 1):
            if message['sequence'] != sequence or message['role'] not in ('user', 'assistant', 'human') or message.get('traceId') is not None or not isinstance(message['content'], str):
                raise ValueError('消息顺序、角色或来源不合法')
        message_count += len(messages)
    if len(records) != manifest['totals']['sessions'] or message_count != manifest['totals']['messages']:
        raise ValueError('会话或消息总量不一致')
    return manifest, records, receipts


def import_corpus(directory, repository, backup):
    manifest, records, receipts = checked_records(directory)
    backup.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        raise ValueError('备份文件已存在，不覆盖原备份')
    with repository.LOCK, repository.connection() as database:
        with sqlite3.connect(backup) as snapshot:
            database.backup(snapshot)
        backup.chmod(0o600)
        database.execute('BEGIN IMMEDIATE')
        imported_at = repository.now()
        inserted = 0
        duplicate = 0
        for record in records:
            session = copy.deepcopy(record)
            session.update(createdAt=imported_at, updatedAt=imported_at, importedAt=imported_at)
            session['hash'] = fingerprint(session['messages'])
            existing = database.execute("SELECT payload FROM documents WHERE kind='imported_dialogue' AND id=?", (session['id'],)).fetchone()
            if existing:
                previous = json.loads(existing[0])
                if fingerprint(previous['messages']) != session['hash'] or previous.get('annotationSets') != session['annotationSets']:
                    raise ValueError('同一来源已存在不同版本，未覆盖历史资料')
                duplicate += 1
                continue
            session['analysis'] = analyze(session['messages'], repository.INTENTS)
            archive_id = 'DOC-' + session['id']
            archive = {'id': archive_id, 'sessionId': session['id'], 'title': session['title'], 'version': 1, 'createdAt': imported_at, 'hash': session['hash'], 'messageCount': len(session['messages']), 'kind': 'conversation_evidence', 'usableForAnswers': False, 'snapshot': copy.deepcopy(session)}
            session['archives'] = [{key: archive[key] for key in ('id', 'title', 'version', 'createdAt', 'hash', 'messageCount')}]
            for kind, identifier, payload in [('imported_dialogue', session['id'], session), ('dialogue_archive', archive_id, archive)]:
                database.execute('INSERT INTO documents(kind,id,payload) VALUES (?,?,?)', (kind, identifier, json.dumps(payload, ensure_ascii=False)))
            DialogueService.index_session(database, session)
            inserted += 1
        previous_corpus = database.execute("SELECT payload FROM documents WHERE kind='corpus' AND id=?", (manifest['id'],)).fetchone()
        registered = {**manifest, 'importedAt': json.loads(previous_corpus[0])['importedAt'] if previous_corpus else imported_at, 'scanReceipts': receipts, 'trainingStatus': 'not_trained', 'automaticKnowledgePublication': False}
        database.execute("INSERT OR REPLACE INTO documents(kind,id,payload) VALUES ('corpus',?,?)", (manifest['id'], json.dumps(registered, ensure_ascii=False)))
    return {'datasetId': manifest['id'], 'inserted': inserted, 'duplicates': duplicate, 'messages': manifest['totals']['messages'], 'archived': inserted, 'modelTrained': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    options = parser.parse_args()
    import support_api
    support_api.initialize()
    print(json.dumps(import_corpus(options.directory, support_api, options.backup), ensure_ascii=False))
