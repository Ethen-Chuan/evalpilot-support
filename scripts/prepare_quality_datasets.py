import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import xml.etree.ElementTree as XML
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from quality_corpus import DIMENSIONS, KIND, checked_quality_records, fingerprint, statistics, validate_record
from corpus_import import scan_file
from redact_labeled_dataset import Redactor


NAMESPACE = {'sheet': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
COMMON = ['gold_score', 'is_qualified'] + [field for field, name in DIMENSIONS] + ['reason']
HEADERS = {'hotline': ['serial_id', '主叫', '被叫', '日期', '开始时间', '结束时间', 'ent_name', 'channel', 'brand', 'agent_name'] + COMMON, 'online': ['SESSION_SEQ', 'product_category', 'channel', 'transcript_text'] + COMMON}


def workbook_rows(source, channel):
    with zipfile.ZipFile(source) as archive:
        if sum(item.file_size for item in archive.infolist()) > 50 * 1024 * 1024 or any(item.flag_bits & 1 for item in archive.infolist()):
            raise ValueError('表格超限或加密，停止处理')
        def tree(name):
            content = archive.read(name)
            if b'<!DOCTYPE' in content or b'<!ENTITY' in content:
                raise ValueError('表格含不支持的 XML 声明')
            return XML.fromstring(content)
        sheets = tree('xl/workbook.xml').findall('sheet:sheets/sheet:sheet', NAMESPACE)
        if len(sheets) != 1 or sheets[0].get('name') != ('热线标注' if channel == 'hotline' else '在线标注'):
            raise ValueError('工作表名称或数量与已审查模板不一致')
        shared = [''.join(item.itertext()) for item in tree('xl/sharedStrings.xml').findall('sheet:si', NAMESPACE)] if 'xl/sharedStrings.xml' in archive.namelist() else []
        rows = []
        for row in tree('xl/worksheets/sheet1.xml').findall('sheet:sheetData/sheet:row', NAMESPACE):
            values = {}
            for cell in row.findall('sheet:c', NAMESPACE):
                if cell.find('sheet:f', NAMESPACE) is not None:
                    raise ValueError('质检模板含公式，需单独审查，不执行公式')
                column = re.sub(r'\d+', '', cell.get('r', ''))
                index = 0
                for character in column:
                    index = index * 26 + ord(character) - 64
                value = cell.findtext('sheet:v', None, NAMESPACE)
                if cell.get('t') == 's' and value is not None:
                    value = shared[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(cell.find('sheet:is', NAMESPACE).itertext())
                elif cell.get('t') == 'b' and value is not None:
                    value = value == '1'
                if value is not None and value != '':
                    values[index] = value
            if values:
                rows.append((int(row.get('r')), values))
    headers = HEADERS[channel]
    if not rows or rows[0][1] != {index: name for index, name in enumerate(headers, 1)}:
        raise ValueError('质检表头与已审查模板不一致')
    output = []
    for position, values in rows[1:]:
        if any(index > len(headers) for index in values) or not values.get(1):
            raise ValueError('质检记录含未定义字段或缺少来源编号')
        output.append((position, {name: values.get(index) for index, name in enumerate(headers, 1)}))
    return output


def qualification(value):
    if value is None or value == '':
        return None
    if type(value) is bool:
        return value
    if str(value).strip().lower() in ('true', '是', '合格', '1'):
        return True
    if str(value).strip().lower() in ('false', '否', '不合格', '0'):
        return False
    raise ValueError('源表合格标注无法识别，未推测结果')


def convert_row(row, position, channel, dataset_id, redactor):
    source_id = row['serial_id' if channel == 'hotline' else 'SESSION_SEQ']
    transcript = row.get('transcript_text')
    original_lines = str(transcript).splitlines() if transcript else []
    cleaned = [redactor.text(re.sub(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?', '[时间已移除]', line)) for line in original_lines]
    metadata = {}
    for original, output in [('product_category', 'productCategory'), ('ent_name', 'organization'), ('brand', 'brand'), ('agent_name', 'agent')]:
        if row.get(original):
            metadata[output] = redactor.alias(original, row[original])
    raw_score = row.get('gold_score')
    score = None if raw_score is None or raw_score == '' else float(raw_score)
    reason = row.get('reason')
    record = {'schemaVersion': 1, 'id': 'QC-' + redactor.alias(channel, source_id), 'datasetId': dataset_id, 'channel': channel, 'labels': {'goldScore': score, 'qualified': qualification(row.get('is_qualified')), 'dimensions': {field: [redactor.text(value.strip(), categorical=True) for value in re.split(r'[,，、;；]', str(row[field])) if value.strip()] if row.get(field) else [] for field, name in DIMENSIONS}, 'reason': '\n'.join(redactor.text(line) for line in str(reason).splitlines()) if reason else None}, 'transcript': '\n'.join(cleaned) if cleaned else None, 'metadata': metadata, 'provenance': {'file': channel + '_label_template.xlsx', 'sheet': '热线标注' if channel == 'hotline' else '在线标注', 'row': position}, 'privacy': {'redacted': True, 'originalLines': len(original_lines), 'withheldLines': sum(line.startswith('[') and '隔离' in line for line in cleaned)}}
    validate_record(record, dataset_id, channel)
    return record


def prepare(sources, output, key_path):
    if output.exists() and any(output.iterdir()):
        raise ValueError('输出目录非空，不覆盖已复核数据包')
    raw = {channel: workbook_rows(source, channel) for channel, source in sources.items()}
    identifiers = {str(value) for rows in raw.values() for position, row in rows for field, value in row.items() if field in ('serial_id', 'SESSION_SEQ', '主叫', '被叫', 'agent_name') and value is not None}
    organizations = {str(value) for rows in raw.values() for position, row in rows for field, value in row.items() if field in ('ent_name', 'brand', 'product_category') and value}
    key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not key_path.exists():
        key_path.write_bytes(secrets.token_bytes(32))
        key_path.chmod(0o600)
    if key_path.is_symlink() or len(key_path.read_bytes()) != 32:
        raise ValueError('脱敏密钥文件不正确')
    redactor = Redactor(key_path.read_bytes(), identifiers, organizations)
    results = []
    for channel, rows in raw.items():
        identifier = 'quality-' + channel + '-redacted-v1'
        directory = output / identifier
        directory.mkdir(parents=True, mode=0o700)
        records = [convert_row(row, position, channel, identifier, redactor) for position, row in rows]
        if len({record['id'] for record in records}) != len(records):
            raise ValueError('发现重复来源编号，停止导入而非静默去重')
        source = directory / (channel + '_redacted.jsonl')
        source.write_text(''.join(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n' for record in records))
        scan_file(source)
        manifest = {'schemaVersion': 1, 'kind': KIND, 'id': identifier, 'channel': channel, 'name': ('热线' if channel == 'hotline' else '在线') + '质检 · 脱敏版', 'nature': '用户提供的质检源表与人工标注，非模型测评结果', 'boundary': '保留源表总分、合格标注和七项问题标签；未填写不推断为通过。热线无录音与对话正文，在线文本有脱敏或隔离，不冒充完整原始证据。', 'totals': statistics(records), 'recordsSha256': fingerprint(records), 'files': [{'name': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'records': len(records)}], 'quarantined': [], 'scanStatus': 'passed', 'excluded': ['直接身份与联系方式', '绝对日期时间', '外链与嵌入图片', '作者与文件元数据'], 'automaticEvaluation': False}
        (directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        checked_quality_records(directory)
        results.append({'datasetId': identifier, 'totals': manifest['totals'], 'manifestSha256': hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest()})
    return results


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='将两种已审查质检模板转换为私有脱敏数据包；不上传原表，不运行模型')
    parser.add_argument('--hotline', type=Path, required=True)
    parser.add_argument('--online', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    options = parser.parse_args()
    try:
        print(json.dumps(prepare({'hotline': options.hotline, 'online': options.online}, options.output, options.key), ensure_ascii=False))
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else '质检数据转换未完成，原件未修改，未上传。', file=sys.stderr)
        sys.exit(1)
