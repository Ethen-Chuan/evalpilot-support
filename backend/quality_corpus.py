import hashlib
import json
from pathlib import Path
import re
import sqlite3

from corpus_import import scan_file


DIMENSIONS = [('dim_observe', '流程规范'), ('dim_solution', '问题解决'), ('dim_risk', '风险提醒'), ('dim_attitude', '服务态度'), ('dim_closure', '服务闭环'), ('dim_wording', '礼貌用语'), ('dim_proactive', '主动服务')]
KIND = 'quality_inspection'


def fingerprint(records):
    return hashlib.sha256(json.dumps(sorted(records, key=lambda record: record['id']), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def statistics(records):
    return {'records': len(records), 'scoredRecords': sum(record['labels']['goldScore'] is not None for record in records), 'transcriptRecords': sum(bool(record['transcript']) for record in records), 'qualified': sum(record['labels']['qualified'] is True for record in records), 'unqualified': sum(record['labels']['qualified'] is False for record in records), 'qualificationMissing': sum(record['labels']['qualified'] is None for record in records), 'withheldLines': sum(record['privacy']['withheldLines'] for record in records)}


def validate_record(record, dataset_id, channel):
    expected = {'schemaVersion', 'id', 'datasetId', 'channel', 'labels', 'transcript', 'metadata', 'provenance', 'privacy'}
    if not isinstance(record, dict) or set(record) != expected or record['schemaVersion'] != 1 or record['datasetId'] != dataset_id or record['channel'] != channel or not re.fullmatch(r'QC-[A-Z]{16}', record['id']):
        raise ValueError('质检记录结构或来源不正确')
    labels = record['labels']
    if not isinstance(labels, dict) or set(labels) != {'goldScore', 'qualified', 'dimensions', 'reason'}:
        raise ValueError('质检标注字段不正确')
    score = labels['goldScore']
    if score is not None and (type(score) not in (int, float) or not 0 <= score <= 100):
        raise ValueError('源表总分必须为空或在 0–100 范围内')
    if labels['qualified'] is not None and type(labels['qualified']) is not bool:
        raise ValueError('合格标注必须为是、否或未填写')
    if not isinstance(labels['dimensions'], dict) or set(labels['dimensions']) != {field for field, name in DIMENSIONS}:
        raise ValueError('缺少原始七项质检字段')
    for values in labels['dimensions'].values():
        if not isinstance(values, list) or len(values) > 50 or any(not isinstance(value, str) or not value.strip() or len(value) > 2000 for value in values):
            raise ValueError('质检问题标签不合法')
    if labels['reason'] is not None and (not isinstance(labels['reason'], str) or len(labels['reason']) > 20000):
        raise ValueError('质检意见不合法')
    if record['transcript'] is not None and (not isinstance(record['transcript'], str) or not record['transcript'].strip() or len(record['transcript']) > 100000):
        raise ValueError('质检原文不合法')
    if channel == 'hotline' and record['transcript'] is not None:
        raise ValueError('当前热线模板不含对话，不能补造原文')
    source = record['provenance']
    if set(source) != {'file', 'sheet', 'row'} or source['file'] != channel + '_label_template.xlsx' or source['sheet'] != ('热线标注' if channel == 'hotline' else '在线标注') or type(source['row']) is not int or source['row'] < 2:
        raise ValueError('质检来源定位不正确')
    if set(record['metadata']) - {'productCategory', 'organization', 'brand', 'agent'} or any(not isinstance(value, str) or not re.fullmatch(r'[A-Z]{16}', value) for value in record['metadata'].values()):
        raise ValueError('质检身份字段必须使用匿名标识')
    privacy = record['privacy']
    if set(privacy) != {'redacted', 'withheldLines', 'originalLines'} or privacy['redacted'] is not True or any(type(privacy[key]) is not int or privacy[key] < 0 for key in ('withheldLines', 'originalLines')) or privacy['withheldLines'] > privacy['originalLines']:
        raise ValueError('质检脱敏说明不完整')


def checked_quality_records(directory):
    manifest_path = directory / 'manifest.json'
    scan_file(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('kind') != KIND or manifest.get('schemaVersion') != 1 or manifest.get('scanStatus') != 'passed' or manifest.get('channel') not in ('hotline', 'online') or manifest.get('quarantined') != [] or not re.fullmatch(r'quality-[a-z-]+-v\d+', manifest.get('id', '')):
        raise ValueError('质检数据清单不合法或尚未复扫')
    entries = manifest.get('files')
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise ValueError('质检数据文件数量不合法')
    names = [entry.get('name', '') for entry in entries]
    if len(set(names)) != len(names) or any(not re.fullmatch(r'[a-zA-Z0-9_-]+_redacted\.jsonl', name) for name in names) or {file.name for file in directory.iterdir()} != set(names) | {'manifest.json'}:
        raise ValueError('质检数据包含未知文件或非法路径')
    records = []
    for entry in entries:
        source = directory / entry['name']
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 20 * 1024 * 1024:
            raise ValueError('质检数据文件不合法或超限')
        content = source.read_bytes()
        if hashlib.sha256(content).hexdigest() != entry['sha256']:
            raise ValueError('质检数据文件指纹不匹配')
        scan_file(source)
        rows = [json.loads(line) for line in content.decode().splitlines() if line.strip()]
        if len(rows) != entry['records']:
            raise ValueError('质检记录数量不匹配')
        for record in rows:
            validate_record(record, manifest['id'], manifest['channel'])
        records.extend(rows)
    if not records or len({record['id'] for record in records}) != len(records) or statistics(records) != manifest['totals'] or fingerprint(records) != manifest['recordsSha256']:
        raise ValueError('质检记录完整性校验失败')
    return manifest, records


def already_imported(repository, entry):
    corpus = repository.get('quality_corpus', entry['datasetId'])
    if not corpus:
        return False
    if corpus.get('privateSource') != entry:
        raise ValueError('质检项目版本不一致，未覆盖已有标注')
    with repository.connection() as database:
        records = [json.loads(row[0]) for row in database.execute("SELECT payload FROM documents WHERE kind='quality_record' AND json_extract(payload,'$.datasetId')=?", (entry['datasetId'],))]
    return fingerprint(records) == corpus['recordsSha256'] and statistics(records) == corpus['totals']


def import_quality_corpus(directory, repository, backup, entry):
    manifest, records = checked_quality_records(directory)
    backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup.exists():
        raise ValueError('不会覆盖已有备份')
    inserted = 0
    with repository.LOCK, repository.connection() as database:
        with sqlite3.connect(backup) as snapshot:
            database.backup(snapshot)
        backup.chmod(0o600)
        database.execute('BEGIN IMMEDIATE')
        for record in records:
            previous = database.execute("SELECT payload FROM documents WHERE kind='quality_record' AND id=?", (record['id'],)).fetchone()
            if previous:
                if json.loads(previous[0]) != record:
                    raise ValueError('同一质检案例已存在不同内容，未覆盖已有标注')
                continue
            database.execute("INSERT INTO documents(kind,id,payload) VALUES ('quality_record',?,?)", (record['id'], json.dumps(record, ensure_ascii=False)))
            inserted += 1
        previous = repository.get('quality_corpus', manifest['id'])
        corpus = {**manifest, 'importedAt': previous['importedAt'] if previous else repository.now(), 'privateSource': entry}
        database.execute("INSERT OR REPLACE INTO documents(kind,id,payload) VALUES ('quality_corpus',?,?)", (manifest['id'], json.dumps(corpus, ensure_ascii=False)))
    return {'datasetId': manifest['id'], 'inserted': inserted, 'duplicates': len(records) - inserted, 'records': len(records), 'modelTrained': False}


def listing(repository, query):
    identifier = query.get('project', [''])[0]
    corpus = repository.get('quality_corpus', identifier)
    if not corpus:
        raise ValueError('质检项目不存在')
    page = int(query.get('page', ['1'])[0])
    if not 1 <= page <= 100000:
        raise ValueError('质检页码不正确')
    with repository.connection() as database:
        rows = [json.loads(row[0]) for row in database.execute("SELECT payload FROM documents WHERE kind='quality_record' AND json_extract(payload,'$.datasetId')=? ORDER BY json_extract(payload,'$.provenance.row') LIMIT 20 OFFSET ?", (identifier, (page - 1) * 20))]
    return {'records': [{'id': row['id'], 'row': row['provenance']['row'], 'goldScore': row['labels']['goldScore'], 'qualified': row['labels']['qualified'], 'hasTranscript': bool(row['transcript'])} for row in rows], 'total': corpus['totals']['records'], 'page': page, 'pageSize': 20}
