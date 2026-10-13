import argparse
import collections
import hashlib
import hmac
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import secrets
import importlib.util
import sys

DATASET_ID = 'aftersales-corpus-redacted'
INTENT_NAMES = {'info_query': '信息查询', 'feature_inquiry': '功能咨询', 'fault_repair': '故障维修', 'dispatch_request': '派单服务', 'policy_inquiry': '政策咨询', 'other': '其他问题', 'irrelevant': '无关问题', 'complaint': '投诉反馈', 'unclear': '意图待澄清'}


def native_scanner():
    source = Path.home() / '.config/ept/codex/dlp/codex_dlp.py'
    specification = importlib.util.spec_from_file_location('dataset_native_dlp', source)
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module, module.load_policy(Path.cwd())


class Redactor:
    def __init__(self, key, identifiers=(), organizations=()):
        self.key = key
        self.counts = collections.Counter()
        self.scanner, self.policy = native_scanner()
        self.identifiers = set(str(value) for value in identifiers if value and len(str(value)) >= 3)
        self.organizations = sorted({str(value) for value in organizations if value and len(str(value)) >= 2}, key=len, reverse=True)
        self.identifier_pattern = re.compile('|'.join(re.escape(value) for value in sorted(self.identifiers, key=len, reverse=True))) if self.identifiers else None

    def alias(self, namespace, value):
        digest = hmac.new(self.key, (namespace + ':' + str(value)).encode(), hashlib.sha256).digest()
        return ''.join(chr(65 + byte % 26) for byte in digest[:16])

    def substitute(self, pattern, replacement, text, category):
        output, count = re.subn(pattern, replacement, text)
        self.counts[category] += count
        return output

    def text(self, raw, categorical=False):
        text = str(raw)
        if not categorical and any(term.casefold() in text.casefold() for term in self.policy.get('financial_keywords', [])):
            self.counts['business_context_segment'] += 1
            return '[涉及业务经营信息的正文已隔离，保留本轮位置]'
        findings = self.scanner.scan_text(text, 'memory-segment', self.policy)
        restricted = [item for item in findings if item.severity >= 3]
        if restricted:
            for item in restricted:
                self.counts[item.category + '_segment'] += 1
            return '[受限正文整段已隔离，保留轮次等待复核]'
        masked = self.scanner.redact_text(text)
        if masked != text:
            self.counts['native_masked_segment'] += 1
        text = self.mask_more(masked, categorical)
        if self.scanner.scan_text(text, 'redacted-segment', self.policy):
            self.counts['residual_segment'] += 1
            return '[正文复扫仍需复核，已隔离并保留本轮位置]'
        return text

    def mask_more(self, text, categorical=False):
        text = self.substitute(r'(?i)(?:https?://|www\.)[^\s<>「」“”]+', '[链接已移除]', text, 'url')
        text = self.substitute(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[邮箱已移除]', text, 'email')
        text = self.substitute(r'(?i)\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|local|edu|gov)\b[^\s<>]*', '[域名已移除]', text, 'domain')
        text = self.substitute(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '[网络地址已移除]', text, 'ip')
        text = self.substitute(r'(?:[A-Za-z]:[\\/]|\b(?:Users|home|mnt|private)[\\/])[^\s<>]+', '[本地路径已移除]', text, 'path')
        text = self.substitute(r'(?:工号|工单号|订单号|设备号|序列号|机器码|SN|sn|微信号|QQ号|账号)\s*[:：=是]?\s*[A-Za-z0-9_-]{4,}', '[业务编号已移除]', text, 'business_id')
        text = self.substitute(r'(?:专属客服|客服编号|客服|工号)\s*[:：是]?\s*\d{3,6}', '[客服人员已匿名化]', text, 'operator_id')
        if re.search(r'(?:姓名|联系人|收货人|收件人|签收人|收货地址|寄件地址|详细地址|联系地址|安装地址|邮寄地址|收件地址|发货地址|所在单位|学校名称|公司名称|客户名称|项目名称|纳税人|统一社会信用)\s*[:：=]|(?:联系电话|联系手机|手机号|手机号码|电话号码)\s*[:：=]|(?:我叫|姓名是|名字是|我姓)[\u4e00-\u9fff]{1,6}', text):
            self.counts['identity_segment'] += 1
            return '[含身份或联系资料的正文已隔离，保留本轮位置]'
        if re.search(r'([\u4e00-\u9fff]{2,12}(?:省|自治区|自治州|市|区|县|镇|街道|路|街|巷|村)){2,}|[\u4e00-\u9fff]{2,15}(?:路|街|巷|栋|幢|楼)\s*\d+\s*(?:号|室|层|单元)|[\u4e00-\u9fff]{2,25}(?:有限责任公司|有限公司|中心小学|实验小学|实验中学|职业学院|幼儿园|职业学校)', text):
            self.counts['address_organization_segment'] += 1
            return '[含地址或单位身份线索的正文已隔离，保留本轮位置]'
        if re.search(r'(?:密码|口令|验证码|提取码|访问码|解压码)\s*(?:[:：=是为])?\s*[A-Za-z0-9]{3,}', text):
            self.counts['access_code_segment'] += 1
            return '[含访问代码的正文已隔离]'
        if re.search(r'\d[\d,.]*\s*(?:万元|亿元|元|块钱)|[￥¥$]\s*\d|[一二三四五六七八九十百千万]{2,}\s*(?:元|块钱)', text):
            self.counts['financial_segment'] += 1
            return '[含经营数值的正文已隔离，保留本轮位置]'
        if self.identifier_pattern:
            text = self.substitute(self.identifier_pattern, '[身份编号已脱敏]', text, 'structured_identity')
        for organization in self.organizations:
            if organization in text:
                self.counts['organization'] += text.count(organization)
                text = text.replace(organization, '[业务实体已匿名化]')
        text = self.substitute(r'(?<![A-Za-z0-9])\+?\d[\d\s()（）.-]{6,}\d[Xx]?(?![A-Za-z0-9])', '[长编号已脱敏]', text, 'long_number')
        if not categorical:
            text = self.substitute(r'(?i)(?<![A-Za-z0-9])[A-Za-z0-9_-]{13,}(?![A-Za-z0-9])', '[长标识已脱敏]', text, 'long_identifier')
        text = self.substitute(r'[赵钱孙李周吴郑王陈蒋沈韩杨朱许何吕张曹金魏姜谢邹苏潘范彭鲁韦马方俞任袁柳史唐费薛雷贺倪汤罗郝安常于傅齐康伍余顾孟黄萧尹姚邵汪毛戴宋熊董梁杜阮贾江郭梅林钟徐邱高夏蔡田胡万柯管卢莫丁邓洪包左石崔龚程陆曾廖谭叶温庄闫易付][\u4e00-\u9fff]{0,2}(?:老师|先生|女士|师傅|师父|主任|校长|经理|同学|主管|工程师)', '[人员已匿名化]', text, 'named_person')
        text = self.substitute(r'[\u4e00-\u9fff]{2,8}(?:省|自治区|自治州|市|县|街道|小学|中学|大学|学院|医院)(?!场|值)', '[地区或单位已匿名化]', text, 'location_entity')
        text = self.substitute(r'(?i)(?:CSM|CVTE|MAXHUB|SEEWO)|简道云(?:表单)?|数策平台|希沃|希科|视源|小希', '[业务实体已匿名化]', text, 'internal_entity')
        text = self.substitute(r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\b', '[人员名称已匿名化]', text, 'latin_name')
        text = self.substitute(r'\d+(?:\.\d+)?\s*%', '[比例已概化]', text, 'business_ratio')
        return text


class Node:
    def __init__(self, tag='root', attributes=None):
        self.tag = tag
        self.attributes = dict(attributes or [])
        self.children = []

    def text(self):
        return ''.join(child.text() if isinstance(child, Node) else child for child in self.children)

    def nodes(self):
        return [child for child in self.children if isinstance(child, Node)]


class ConversationParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attributes):
        node = Node(tag, attributes)
        self.stack[-1].children.append(node)
        if tag not in ('img', 'br', 'hr', 'input', 'source', 'meta', 'link', 'wbr'):
            self.stack.append(node)

    def handle_startendtag(self, tag, attributes):
        self.stack[-1].children.append(Node(tag, attributes))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def body_text(node, attachment_counts):
    if node.tag in ('script', 'style', 'iframe', 'object', 'embed'):
        return '[嵌入内容已隔离]'
    if node.tag in ('img', 'video', 'audio'):
        attachment_counts[node.tag] += 1
        return '\n[' + {'img': '图片', 'video': '视频', 'audio': '音频'}[node.tag] + '附件未导入：内容尚未脱敏复核]\n'
    if node.tag == 'br':
        return '\n'
    pieces = []
    for child in node.children:
        if isinstance(child, Node):
            pieces.append(body_text(child, attachment_counts))
            if child.tag in ('p', 'div', 'li', 'tr'):
                pieces.append('\n')
        else:
            pieces.append(child)
    return ''.join(pieces)


def extract_messages(markup):
    parser = ConversationParser()
    parser.feed(markup)
    outer = parser.root.nodes()
    if len(outer) != 1:
        raise ValueError('html_root_mismatch')
    messages = []
    elapsed = 0
    previous_clock = None
    for card in outer[0].nodes():
        children = card.nodes()
        if len(children) != 1 or len(children[0].nodes()) != 2:
            raise ValueError('message_structure_mismatch')
        header, body = children[0].nodes()
        header_text = header.text().strip()
        clock = re.search(r'(\d\d):(\d\d):(\d\d)\s*$', header_text)
        if not clock:
            raise ValueError('missing_clock')
        role_text = header_text[:clock.start()].strip()
        role = 'user' if role_text == '用户' else 'human' if role_text == '人工客服' else 'assistant' if '机器人' in role_text else None
        if role is None:
            raise ValueError('unknown_role')
        seconds = int(clock[1]) * 3600 + int(clock[2]) * 60 + int(clock[3])
        if previous_clock is not None:
            elapsed += (seconds - previous_clock) % 86400
        previous_clock = seconds
        attachments = collections.Counter()
        content = body_text(body, attachments).strip()
        messages.append({'role': role, 'rawContent': content, 'elapsedSeconds': elapsed, 'attachments': dict(attachments)})
    return messages


def annotation_sets(row, redactor):
    converted = []
    for source_key, state in [('annotations', 'final'), ('drafts', 'draft')]:
        for position, annotation in enumerate(row.get(source_key, []), 1):
            results = []
            for result in annotation.get('result', []):
                kind = result.get('type')
                field = result.get('from_name', '')
                if kind not in ('choices', 'taxonomy', 'textarea') or not re.fullmatch(r'[a-z][a-z0-9_]*', field):
                    raise ValueError('unsupported_annotation_schema')
                value_key = {'choices': 'choices', 'taxonomy': 'taxonomy', 'textarea': 'text'}[kind]
                raw_values = result.get('value', {}).get(value_key)
                if not isinstance(raw_values, list):
                    raise ValueError('annotation_value_not_list')
                def clean(value):
                    if isinstance(value, list):
                        return [clean(child) for child in value]
                    if not isinstance(value, str):
                        raise ValueError('annotation_value_not_text')
                    if field == 'sn_code':
                        return '[设备编号已移除]' if value else ''
                    if field in ('expected_system', 'product_line') and value:
                        return '类别-' + redactor.alias(field, value)
                    return redactor.text(value, categorical=kind in ('choices', 'taxonomy'))
                results.append({'field': field, 'type': kind, 'values': clean(raw_values)})
            converted.append({'id': f'{state}-{position}', 'state': state, 'cancelled': bool(annotation.get('was_cancelled')), 'groundTruth': bool(annotation.get('ground_truth')), 'results': results})
    return converted


def summarize_labels(sets):
    values = collections.defaultdict(set)
    versions = collections.defaultdict(set)
    for annotation in sets:
        if annotation['state'] != 'final' or annotation['cancelled']:
            continue
        per_set = collections.defaultdict(set)
        for result in annotation['results']:
            for value in result['values']:
                flattened = ' / '.join(str(part) for part in value) if isinstance(value, list) else value
                if flattened:
                    values[result['field']].add(flattened)
                    per_set[result['field']].add(flattened)
        for field, entries in per_set.items():
            versions[field].add(tuple(sorted(entries)))
    return {'values': {field: sorted(entries) for field, entries in values.items()}, 'conflicts': sorted(field for field, entries in versions.items() if len(entries) > 1)}


def convert_record(row, source_file, position, redactor):
    data = row['data']
    identifier = 'CORP-' + redactor.alias('session', data['task_id'])
    parsed = extract_messages(data['conversation'])
    if len(parsed) != data['n_turns'] or sum(message['role'] == 'user' for message in parsed) != data['n_user_turns']:
        raise ValueError('message_count_mismatch')
    messages = []
    for sequence, message in enumerate(parsed, 1):
        content = redactor.text(message['rawContent']) or '[此轮无文本正文]'
        messages.append({'id': 'CM-' + redactor.alias(identifier, sequence), 'sequence': sequence, 'role': message['role'], 'content': content, 'at': None, 'elapsedSeconds': message['elapsedSeconds'], 'traceId': None, 'turnId': None, 'metadata': {'observedLocally': False, 'attachments': message['attachments'], 'redacted': content != message['rawContent']}})
    sets = annotation_sets(row, redactor)
    summary = summarize_labels(sets)
    intent = next(iter(summary['values'].get('intent', [])), 'unclear')
    return {'schemaVersion': 1, 'id': identifier, 'datasetId': DATASET_ID, 'title': f"设备售后 · {INTENT_NAMES.get(intent, '标注会话')} · {identifier[-6:]}", 'origin': 'user_imported', 'sourceLabel': '用户提供真实售后语料 · 脱敏文本', 'messages': messages, 'annotationSets': sets, 'labelSummary': summary, 'provenance': {'file': source_file, 'row': position, 'participant': 'PERSON-' + redactor.alias('participant', data.get('user_id', data['task_id'])), 'imagesWithheld': data.get('n_images', 0), 'videosWithheld': data.get('n_videos', 0), 'declaredMessages': data['n_turns'], 'runtimeTraceAvailable': False}, 'completeness': '保留上游提供的全部消息轮次与角色。身份、链接及高风险正文已脱敏或隔离；图片视频未导入。只保留按时钟推算的相对时差，不代表已验证的持续时长。上游没有运行 Trace，不补造。', 'privacy': {'status': 'automated_rules_checked', 'reviewRequiredBeforeSharing': True, 'originalMediaImported': False}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    options = parser.parse_args()
    os.umask(0o077)
    options.output.mkdir(parents=True, exist_ok=True)
    options.key.parent.mkdir(parents=True, exist_ok=True)
    if not options.key.exists():
        options.key.write_bytes(secrets.token_bytes(32))
    raw_files = []
    identifiers = set()
    metadata_files = 0
    for file in sorted(options.source.glob('source-*.json')):
        if file.read_bytes()[:4] == bytes.fromhex('00051607'):
            metadata_files += 1
            continue
        raw_files.append(file)
        for row in json.loads(file.read_text()):
            data = row['data']
            identifiers.update(str(value) for value in (data.get('user_id'), data.get('task_id')) if value)
            identifiers.update(re.findall(r'(?:专属客服|客服工号|客服编号|客服|工号)\s*[:：是]?\s*(\d{3,6})', data['conversation']))
            for annotation in row.get('annotations', []) + row.get('drafts', []):
                for result in annotation.get('result', []):
                    if result.get('from_name') == 'sn_code':
                        for value in result.get('value', {}).get('text', []):
                            identifiers.update(re.findall(r'[A-Za-z0-9-]{6,}', value))
    redactor = Redactor(options.key.read_bytes(), identifiers)
    totals = collections.Counter()
    roles = collections.Counter()
    distribution = collections.Counter()
    quarantined = []
    file_manifest = []
    seen = set()
    for file in raw_files:
        output = options.output / (file.stem + '_redacted.jsonl')
        count = 0
        with output.open('w') as stream:
            for position, row in enumerate(json.loads(file.read_text()), 1):
                totals['sourceSessions'] += 1
                try:
                    record = convert_record(row, file.stem, position, redactor)
                except (ValueError, KeyError, TypeError) as problem:
                    quarantined.append({'file': file.stem, 'row': position, 'reason': type(problem).__name__})
                    continue
                if record['id'] in seen:
                    raise ValueError('duplicate_source_session')
                seen.add(record['id'])
                stream.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
                count += 1
                totals['sessions'] += 1
                totals['messages'] += len(record['messages'])
                totals['imagesWithheld'] += record['provenance']['imagesWithheld']
                totals['videosWithheld'] += record['provenance']['videosWithheld']
                totals['humanSessions'] += any(message['role'] == 'human' for message in record['messages'])
                totals['finalAnnotations'] += sum(annotation['state'] == 'final' for annotation in record['annotationSets'])
                totals['draftAnnotations'] += sum(annotation['state'] == 'draft' for annotation in record['annotationSets'])
                totals['conflictSessions'] += bool(record['labelSummary']['conflicts'])
                totals['gapSessions'] += 'gap' in record['labelSummary']['values'].get('kb_expectation', [])
                totals['invalidSessions'] += any(value in ('yes', '是') for value in record['labelSummary']['values'].get('is_invalid', []))
                for message in record['messages']:
                    roles[message['role']] += 1
                    totals['changedMessages'] += message['metadata']['redacted']
                    totals['isolatedMessages'] += '隔离' in message['content'] and message['content'].startswith('[')
                distribution.update(record['labelSummary']['values'].get('intent', []))
        file_manifest.append({'name': output.name, 'sessions': count, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
        print(json.dumps({'processedFile': file.stem, 'sessions': count}, ensure_ascii=False), flush=True)
    (options.key.parent / 'redaction-counters.json').write_text(json.dumps(dict(redactor.counts), ensure_ascii=False, indent=2))
    manifest = {'id': DATASET_ID, 'name': '售后完整对话 · 脱敏版', 'schemaVersion': 1, 'nature': '用户提供的真实历史标注语料；非平台实时采集', 'usage': '仅本机授权分析，未经业务复核不公开、不训练、不自动发布答复知识', 'totals': dict(totals), 'roles': dict(roles), 'intentDistribution': dict(distribution), 'metadataFilesExcluded': metadata_files, 'quarantined': quarantined, 'files': file_manifest, 'scanStatus': 'pending_full_file_rescan'}
    (options.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'totals': totals, 'quarantined': len(quarantined)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
