import copy
import hashlib
import json
import re

from tracing import Trace


STATES = ('triage', 'confirmed', 'fixing', 'verified')


def ratio(numerator, denominator):
    return {'value': round(numerator * 100 / denominator, 2) if denominator else None, 'numerator': numerator, 'denominator': denominator}


class RcaWorkbench:
    def __init__(self, repository, clean, causes):
        self.repo = repository
        self.clean = clean
        self.causes = causes

    def project(self, project_id):
        if not isinstance(project_id, str) or not self.repo.get('corpus', project_id):
            raise ValueError('归因项目不存在')

    def items(self, project_id):
        if not project_id:
            return []
        self.project(project_id)
        stored = [record for record in self.repo.records('cx_rca') if record['projectId'] == project_id]
        sources = {(record['sourceType'], record['sourceId']) for record in stored}
        with self.repo.connection() as database:
            sessions = [json.loads(row[0]) for row in database.execute("SELECT payload FROM documents WHERE kind='imported_dialogue' AND json_extract(payload,'$.datasetId')=? AND EXISTS(SELECT 1 FROM json_each(payload,'$.labelSummary.values.intent') WHERE value='complaint') ORDER BY id", (project_id,))]
        for session in sessions:
            if ('conversation_signal', session['id']) in sources:
                continue
            users = [message for message in session.get('messages', []) if message.get('role') == 'user']
            excerpt = next((message for message in users if re.search('投诉|不满意|差评|没解决|未解决', message.get('content', ''))), users[0] if users else {})
            identifier = 'RCA-CHAT-' + hashlib.sha256(f"{project_id}:{session['id']}".encode()).hexdigest()[:16].upper()
            stored.append({'id': identifier, 'projectId': project_id, 'title': session.get('title') or '投诉标注对话', 'sourceType': 'conversation_signal', 'sourceId': session['id'], 'sourceEvidence': excerpt.get('content', '')[:800], 'traceId': None, 'status': 'triage', 'primary': None, 'contributors': [], 'revision': 1, 'history': [], 'updatedAt': session.get('importedAt', ''), 'sourceSequence': excerpt.get('sequence'), 'sourceHash': session.get('hash')})
        outcomes = {record['id']: record for record in self.repo.records('cx_outcome') if record['projectId'] == project_id and record['environment'] == 'production' and type(record.get('rating')) is int and 1 <= record['rating'] <= 2}
        indexed = {session['id']: session for session in sessions}
        reviews = {record['id']: record for record in self.repo.records('qc_case') if record['projectId'] == project_id}
        result = []
        for record in stored:
            session = indexed.get(record['sourceId']) if record['sourceType'] == 'conversation_signal' else None
            outcome = outcomes.get(record['sourceId']) if record['sourceType'] == 'reported_dsat' else None
            review = reviews.get(record['sourceId']) if record['sourceType'] == 'review_signal' else None
            trace_available = bool(record.get('traceId') and self.repo.TRACE_STORE.get(record['traceId']))
            result.append({**record, 'scope': 'dsat' if outcome else 'signals', 'rating': outcome.get('rating') if outcome else None, 'sourceAvailable': bool(session or outcome or review), 'coverage': {'conversation': bool(session and session.get('messages')), 'rating': bool(outcome), 'trace': trace_available}, 'messageCount': len(session.get('messages', [])) if session else 0, 'sourceRow': review.get('sourceRow') if review else None, 'sourceWarning': '投诉标注不等于低分评价；对话中的图片、受限正文和运行日志可能缺失。' if session else '机审摘要可能错判，不能替代原始评价、会话或运行日志。' if review else '来源声明的生产低分评价，尚未经平台独立核验。' if outcome else '来源记录缺失，暂不计入真实DSAT；请先核对关联。'})
        return sorted(result, key=lambda record: (STATES.index(record['status']) if record['status'] in STATES else 0, record['sourceType'] != 'review_signal', record['id']))

    def analytics(self, items):
        result = {}
        for scope in ('dsat', 'signals'):
            rows = [record for record in items if record['scope'] == scope]
            confirmed = [record for record in rows if record['status'] in STATES[1:] and record.get('primary') in {cause['id'] for cause in self.causes}]
            verified = sum(record['status'] == 'verified' for record in confirmed)
            result[scope] = {'total': len(rows), 'confirmed': len(confirmed), 'verified': verified, 'confirmationRate': ratio(len(confirmed), len(rows)), 'verificationRate': ratio(verified, len(confirmed)), 'statuses': [{'id': status, 'count': sum(record['status'] == status for record in rows)} for status in STATES], 'causes': [{'id': cause['id'], 'name': cause['name'], 'count': sum(record['primary'] == cause['id'] for record in confirmed), **ratio(sum(record['primary'] == cause['id'] for record in confirmed), len(confirmed))} for cause in self.causes], 'coverage': {key: ratio(sum(record['coverage'][key] for record in rows), len(rows)) for key in ('conversation', 'rating', 'trace')}}
        return result

    def find(self, project_id, identifier):
        if not isinstance(identifier, str):
            raise ValueError('归因编号不正确')
        item = next((record for record in self.items(project_id) if record['id'] == identifier), None)
        if not item:
            raise ValueError('归因记录不存在或不属于当前项目')
        return item

    def detail(self, project_id, identifier):
        item = self.find(project_id, identifier)
        evidence = []
        messages = []
        warnings = [item['sourceWarning']]
        if item['sourceType'] == 'conversation_signal':
            source = self.repo.get('imported_dialogue', item['sourceId'])
            if source and source.get('datasetId') == project_id:
                messages = [{key: message.get(key) for key in ('id', 'sequence', 'role', 'content', 'at')} for message in source.get('messages', [])]
                evidence.append({'id': 'source_labels', 'label': '来源意图标注', 'text': '、'.join(source.get('labelSummary', {}).get('values', {}).get('intent', []))})
                if any(value in ('是', 'yes') for value in source.get('labelSummary', {}).get('values', {}).get('is_invalid', [])):
                    warnings.append('来源同时标为无效对话，请先复核标注；不自动丢弃或认定责任。')
        elif item['sourceType'] == 'review_signal':
            source = self.repo.get('qc_case', item['sourceId'])
            if source and source.get('projectId') == project_id:
                for field, label in [('appeal', '申诉说明'), ('opinion', '来源复核意见'), ('machineExcerpt', '原机审摘录（可能错判）'), ('warning', '规则适用与待核实条件')]:
                    if source.get(field):
                        evidence.append({'id': field, 'label': label, 'text': source[field]})
                warnings.append('没有可靠关联键，未将这条质检摘要与其他历史对话拼接。')
        elif item['scope'] == 'dsat':
            source = next((record for record in self.repo.records('cx_outcome') if record['projectId'] == project_id and record['id'] == item['sourceId']), {})
            evidence = [{'id': 'rating', 'label': '来源低分评价', 'text': f"{item['rating']}/5分 · 会话结束 {source.get('closedAt', '')}"}, {'id': 'source_result', 'label': '来源结果依据', 'text': source.get('evidence', '')}]
        return {'record': item, 'evidence': evidence, 'messages': messages, 'warnings': warnings, 'method': '本机整理已有来源，不调用大模型；六类排查初始均为待核实，不自动定责。'}

    def save(self, body):
        status = body.get('status')
        if status not in STATES:
            raise ValueError('无效归因状态')
        allowed = {cause['id'] for cause in self.causes}
        primary = body.get('primary')
        if primary == '':
            primary = None
        contributors = body.get('contributors', [])
        if (primary is not None and (not isinstance(primary, str) or primary not in allowed)) or not isinstance(contributors, list) or any(not isinstance(value, str) or value not in allowed or value == primary for value in contributors) or len(set(contributors)) != len(contributors):
            raise ValueError('请选择一个主因及不重复的其他促成因素')
        update = {'primary': primary, 'contributors': contributors, 'status': status}
        for field, maximum in [('evidence', 2000), ('counterfactual', 1000), ('action', 1000), ('owner', 60), ('reviewer', 60), ('verification', 1200)]:
            value = body.get(field, '')
            update[field] = '' if value in ('', None) else self.clean(value, maximum)
        checks = body.get('checks', {})
        if not isinstance(checks, dict) or any(key not in allowed for key in checks):
            raise ValueError('排查项必须来自六类原因')
        normalized = {}
        for cause in self.causes:
            check = checks.get(cause['id'], {})
            if not isinstance(check, dict) or check.get('verdict', 'unknown') not in ('unknown', 'supported', 'excluded'):
                raise ValueError('排查结论需为待核实、有证据支持或已排除')
            note = check.get('note', '')
            normalized[cause['id']] = {'verdict': check.get('verdict', 'unknown'), 'note': '' if note in ('', None) else self.clean(note, 1000)}
            if normalized[cause['id']]['verdict'] != 'unknown' and not normalized[cause['id']]['note']:
                raise ValueError('支持或排除一个原因时，必须填写可核查依据')
        update['checks'] = normalized
        if status != 'triage':
            if not primary or any(not update[field] for field in ('evidence', 'counterfactual', 'action', 'owner', 'reviewer')) or body.get('confirmed') is not True:
                raise ValueError('确认归因需主因、定位证据、反事实、改进动作、负责人、复核人及人工核实确认')
            if any(normalized[key]['verdict'] != 'supported' for key in [primary] + contributors):
                raise ValueError('主因和促成因素必须有逐项支持证据，不能把待核实当作结论')
        if status == 'verified' and not update['verification']:
            raise ValueError('验收需填写实际回归编号、范围及结果')
        identifier = body.get('id')
        if not isinstance(identifier, str):
            raise ValueError('归因编号不正确')
        with self.repo.LOCK:
            stored = self.repo.get('cx_rca', identifier)
            project_id = body.get('projectId') or (stored or {}).get('projectId')
            item = self.find(project_id, identifier)
            if type(body.get('revision')) is not int or body['revision'] != item['revision']:
                raise ValueError('归因记录版本已变化，请刷新后再提交')
            if status != 'triage' and not item['sourceAvailable']:
                raise ValueError('来源缺失，请先补齐来源记录再确认归因')
            if status == 'verified' and item['status'] not in ('fixing', 'verified'):
                raise ValueError('必须先进入修复中，再填写回归证据验收')
            update['updatedAt'] = self.repo.now()
            with Trace(self.repo.TRACE_STORE, 'DSAT线索人工归因', 'experience.rca.review', {'id': item['id'], 'revision': item['revision'], 'sourceType': item['sourceType']}, {'projectId': project_id}) as trace:
                trace.output({**update, 'scope': item['scope'], 'verificationMode': '人工登记，非系统自动验证'})
                update['reviewTraceId'] = trace.id
            base = stored or {key: item[key] for key in ('id', 'projectId', 'title', 'sourceType', 'sourceId', 'sourceEvidence', 'traceId', 'status', 'primary', 'contributors', 'revision', 'history', 'updatedAt')}
            record = copy.deepcopy(base)
            record.setdefault('history', []).append(copy.deepcopy(update))
            record.update(**update, revision=item['revision'] + 1)
            self.repo.save('cx_rca', identifier, record)
            return record
