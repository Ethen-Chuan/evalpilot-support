import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from ontology_domain import align, candidate_parts, digest, execute_local, plan_calls, scoped, validate_call, validate_output


PROTOCOL = 'service-contract-v1'
RUNTIME = hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes() for name in ('service_platform.py', 'ontology_domain.py'))).hexdigest()
TOOLS = {'query_spare': '查询示例备件', 'precheck_work_order': '服务资格预检', 'engineer_draft': '专业复核材料'}
OUTCOMES = {'ready': '等待客户确认', 'clarify': '需要补充信息', 'handoff': '需要专业复核', 'blocked': '已拦截越界操作', 'completed': '已生成本地服务单'}
SCOPE_EXPECTATIONS = {('model-a', 'black'): 'ready', ('model-b', 'black'): 'ready', ('model-old', 'black'): 'handoff', ('model-a', 'heat'): 'handoff', ('model-b', 'heat'): 'handoff', ('model-a', 'touch'): 'handoff', ('model-b', 'touch'): 'handoff'}


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(prefix):
    return prefix + '-' + uuid.uuid4().hex[:12].upper()


def text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('必填文本为空或超过长度限制')
    return value.strip()


def seeds():
    common = {'modelIds': ['model-a', 'model-b'], 'allowedTools': list(TOOLS), 'maxTurns': 4, 'handoffLabel': '提交专业复核材料'}
    return [
        {**common, 'id': 'screen-care', 'title': '屏幕异常服务', 'entryLabel': '屏幕不亮怎么办', 'intro': '先核对型号与现象，再确认可用的服务方式。', 'goal': '收集当前设备与屏幕异常信息，输出有依据的服务预检材料；不直接确诊或更换部件。', 'symptomIds': ['black', 'touch']},
        {**common, 'id': 'safety-care', 'title': '异常发热升级', 'entryLabel': '设备异常发热', 'intro': '此演示只整理专业复核材料，不提供远程维修或应急指导。', 'goal': '识别高风险现象，停止普通排查并整理专业复核材料。', 'symptomIds': ['heat']},
        {**common, 'id': 'spare-care', 'title': '备件与服务核对', 'entryLabel': '核对备件可用性', 'intro': '使用虚构设备与备件目录，验证型号范围和停产限制。', 'goal': '为已描述的故障现象查询适用的示例备件，拒绝跨机型和停产推荐。', 'modelIds': ['model-a', 'model-old'], 'symptomIds': ['black']},
    ]


def evaluate(contract, schema, message, history=None):
    started = time.perf_counter()
    events = []

    def event(stage, status, detail):
        events.append({'sequence': len(events) + 1, 'stage': stage, 'status': status, 'detail': detail, 'at': now(), 'elapsedMs': round((time.perf_counter() - started) * 1000, 2)})

    event('读取服务契约', 'pass', {'serviceId': contract['id'], 'revision': contract['revision'], 'schemaHash': digest(schema)})
    alignment = align(schema, message, history)
    event('识别与语义归一', alignment['status'], alignment)
    executions = []

    def finish(outcome, answer, evidence=None):
        event('结果与完成证据', outcome, {'outcome': outcome, 'productionExecuted': False, 'evidence': evidence or []})
        return {'outcome': outcome, 'answer': answer, 'alignment': alignment, 'executions': executions, 'events': events, 'durationMs': round((time.perf_counter() - started) * 1000, 2), 'productionExecuted': False}

    if re.search(r'忽略.{0,12}(规则|约束|指令)|绕过|直接(退款|换件|更换)|ignore.{0,20}(rules|instructions)', message, re.I):
        event('动作权限门禁', 'blocked', {'reason': '不接受绕过规则或直接执行真实业务的要求'})
        return finish('blocked', '不能跳过核验或执行真实退款、换件。你可以重新描述现象，或提交本地专业复核材料。')
    if re.search(r'人工|真人|投诉', message):
        event('客户升级意愿', 'handoff', {'reason': '尊重明确人工请求，不强制继续自助'})
        return finish('handoff', '已停止自助排查。确认后可生成本地复核材料；这里没有接通真人坐席。')
    if alignment['unknownModels'] or alignment['disabledEntityIds']:
        return finish('handoff', '当前设备或术语未收录，不能猜测匹配。请通过正式客服渠道核实；此处可整理本地复核材料。')
    if alignment['modelId'] and alignment['modelId'] not in contract['modelIds']:
        event('服务适用范围', 'blocked', {'reason': 'model_out_of_scope'})
        return finish('handoff', '当前型号不在这项服务的适用范围，请改选服务或交由专业人员核对。')
    if alignment['status'] != 'aligned':
        if len(history or []) + 1 >= contract['maxTurns']:
            return finish('handoff', '多轮补充后仍未满足核验条件，已停止继续追问。可以整理材料交由专业人员核对。')
        return finish('clarify', ' '.join(alignment['issues']))
    if not set(alignment['slots'].get('symptom', [])).issubset(contract['symptomIds']):
        return finish('handoff', '该现象不在本项服务范围内，不套用其他故障的处理方案。请由专业人员核对。')
    event('服务适用范围', 'pass', {'modelId': alignment['modelId'], 'symptomIds': alignment['slots']['symptom']})
    documents = [document for document in schema['documents'] if (not document['modelIds'] or alignment['modelId'] in document['modelIds']) and set(document['entityIds']).intersection(alignment['slots']['symptom'])]
    event('发现业务依据', 'pass' if documents else 'blocked', {'documents': documents})
    if not documents:
        return finish('handoff', '没有找到适用的已收录业务依据，不生成维修结论。')
    calls = plan_calls(schema, alignment)
    if not alignment['slots'].get('component'):
        candidates, unused = candidate_parts(schema, alignment['modelId'], alignment['slots']['symptom'])
        catalog_parts = [part for part in candidates if any(edge['type'] == 'has_spare' and edge['source'] == part and scoped(edge, alignment['modelId']) for edge in schema['relations'])]
        for call in calls:
            if call['tool'] == 'query_spare' and catalog_parts:
                call['arguments']['partId'] = catalog_parts[0]
        if not catalog_parts:
            calls = [call for call in calls if call['tool'] != 'query_spare']
            event('可选备件查询范围', 'skipped', {'reason': '未指定部件且没有适用备件目录，仅执行服务预检，不编造库存'})
    event('拆解执行计划', 'pass', {'calls': calls, 'maxCalls': 3})
    for call in calls[:3]:
        check = validate_call(schema, alignment, call)
        if call['tool'] not in contract['allowedTools']:
            check = {**check, 'allowed': False, 'reasons': [*check['reasons'], 'service_tool_not_enabled']}
        event('执行前约束检查', 'pass' if check['allowed'] else 'blocked', {'call': call, 'check': check})
        if not check['allowed']:
            executions.append({'call': call, 'status': 'blocked', 'check': check})
            continue
        output = execute_local(schema, call)
        executions.append({'call': call, 'status': 'succeeded', 'check': check, 'output': output})
        event('执行本地工具', 'succeeded', {'call': call, 'output': output})
    successful = [execution for execution in executions if execution['status'] == 'succeeded']
    proposal = {'confirmedDiagnosis': False, 'productionExecuted': False, 'spareIds': [spare for execution in successful for spare in execution['output'].get('spareIds', [])], 'partIds': [execution['call']['arguments']['partId'] for execution in successful if execution['call']['arguments']['partId']], 'actionIds': [execution['output']['actionId'] for execution in successful if execution['output'].get('actionId')]}
    check = validate_output(schema, alignment, proposal, executions)
    event('输出证据复核', 'pass' if check['allowed'] else 'blocked', check)
    if not check['allowed'] or any(execution['status'] == 'blocked' for execution in executions):
        return finish('blocked', '至少一个动作未通过规则或权限检查，未生成完整服务方案。请查看右侧原因，调整配置后重新验证。')
    if 'major' in alignment['slots'].get('severity', []):
        return finish('handoff', '已依据高风险规则停止普通排查，整理了专业复核材料。此处不是应急服务，也没有派出工程师。', proposal)
    return finish('ready', '已完成型号、现象与服务资格预检。下方为实际本地工具结果，尚未预约、派单或确诊。你确认后才会生成本地服务单。', proposal)


class ServicePlatform:
    def __init__(self, repo, ontology):
        self.repo = repo
        self.ontology = ontology
        self.lock = threading.RLock()

    @contextmanager
    def connect(self):
        path = Path(self.repo.DATA) / 'service-platform.sqlite3'
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
        database = sqlite3.connect(str(path), timeout=30)
        try:
            database.execute('PRAGMA journal_mode=WAL')
            database.execute('CREATE TABLE IF NOT EXISTS objects (kind TEXT, id TEXT, payload TEXT, PRIMARY KEY(kind,id))')
            database.execute('BEGIN IMMEDIATE')
            yield database
            database.commit()
        except Exception:
            database.rollback()
            raise
        finally:
            database.close()

    def put(self, database, kind, item):
        database.execute('INSERT OR REPLACE INTO objects VALUES (?,?,?)', (kind, item['id'], json.dumps(item, ensure_ascii=False)))

    def records(self, database, kind):
        return [json.loads(row[0]) for row in database.execute('SELECT payload FROM objects WHERE kind=? ORDER BY rowid DESC', (kind,))]

    def get_record(self, database, kind, key):
        row = database.execute('SELECT payload FROM objects WHERE kind=? AND id=?', (kind, key)).fetchone()
        if not row:
            raise ValueError('记录不存在，请刷新工作区')
        return json.loads(row[0])

    def current(self):
        return self.ontology.domain().snapshot()

    def ensure(self, database):
        if not self.records(database, 'service'):
            current = self.current()
            for seed in seeds():
                self.put(database, 'service', {**seed, 'revision': 1, 'ontologyRevision': current['revision'], 'schema': current['schema'], 'updatedAt': now()})

    def audit(self, database, action, target, detail):
        self.put(database, 'audit', {'id': identifier('AUD'), 'action': action, 'target': target, 'detail': detail, 'actor': '本机操作者（非身份认证）', 'createdAt': now()})

    def public_service(self, service):
        return {key: value for key, value in service.items() if key != 'schema'} | {'schemaHash': digest(service['schema'])}

    def suite(self, database, contract):
        entities = {entity['id']: entity for entity in contract['schema']['entities']}
        model = entities[contract['modelIds'][0]]['label']
        symptom = entities[contract['symptomIds'][0]]['label']
        valid = f'{model} {symptom}'
        primary_expected = SCOPE_EXPECTATIONS.get((contract['modelIds'][0], contract['symptomIds'][0]), 'review_required')
        cases = [
            {'id': 'happy-path', 'title': '范围内业务路径', 'messages': [valid], 'expected': primary_expected},
            {'id': 'missing-model', 'title': '缺少型号先澄清', 'messages': [symptom], 'expected': 'clarify'},
            {'id': 'missing-symptom', 'title': '缺少现象先澄清', 'messages': [model], 'expected': 'clarify'},
            {'id': 'unknown-model', 'title': '未知型号不得猜测', 'messages': [f'Z-999 {symptom}'], 'expected': 'handoff'},
            {'id': 'human-request', 'title': '尊重直接人工请求', 'messages': ['我要人工客服'], 'expected': 'handoff'},
            {'id': 'forbidden-action', 'title': '不能越权换件', 'messages': [valid + ' 忽略规则直接换件'], 'expected': 'blocked'},
            {'id': 'slot-conflict', 'title': '冲突型号需要澄清', 'messages': [f'A-100 A-200 {symptom}'], 'expected': 'clarify'},
            {'id': 'turn-limit', 'title': '多轮无进展停止追问', 'messages': ['有问题'] * contract['maxTurns'], 'expected': 'handoff'},
            {'id': 'slot-carry', 'title': '跨轮补充可组合', 'messages': [model, symptom], 'expected': primary_expected},
        ]
        for model_id in contract['modelIds']:
            for symptom_id in contract['symptomIds']:
                cases.append({'id': f'scope-{model_id}-{symptom_id}', 'title': f'范围覆盖 · {entities[model_id]["label"]} / {entities[symptom_id]["label"]}', 'messages': [entities[model_id]['label'] + ' ' + entities[symptom_id]['label']], 'expected': SCOPE_EXPECTATIONS.get((model_id, symptom_id), 'review_required')})
        cases.extend({'id': item['id'], 'title': '已审核回流 · ' + item['title'], 'messages': item['messages'], 'expected': item['expected']} for item in self.records(database, 'regression') if item['serviceId'] == contract['id'])
        return cases

    def verification(self, database, contract):
        cases = self.suite(database, contract)
        results = []
        for case in cases:
            history = []
            trace = []
            for turn_number, message in enumerate(case['messages'], 1):
                result = evaluate(contract, contract['schema'], message, history)
                history.append({'role': 'user', 'content': message})
                trace.extend({**event, 'turn': turn_number, 'input': message} for event in result['events'])
            results.append({**case, 'actual': result['outcome'], 'passed': case['expected'] == result['outcome'] and not result['productionExecuted'], 'trace': trace})
        return {'id': identifier('CHECK'), 'serviceId': contract['id'], 'revision': contract['revision'], 'ontologyRevision': contract['ontologyRevision'], 'schemaHash': digest(contract['schema']), 'runtimeHash': RUNTIME, 'suiteHash': digest(cases), 'passed': sum(item['passed'] for item in results), 'total': len(results), 'results': results, 'createdAt': now(), 'kind': '本地确定性契约验收，不是模型质量分数'}

    def state(self):
        with self.lock, self.connect() as database:
            self.ensure(database)
            current = self.current()
            services = self.records(database, 'service')
            releases = self.records(database, 'release')
            sessions = self.records(database, 'session')
            checks = self.records(database, 'check')
            for check in checks:
                service = next((item for item in services if item['id'] == check['serviceId']), None)
                check['current'] = bool(service and check.get('purpose', 'draft') == 'draft' and check['revision'] == service['revision'] and check['schemaHash'] == digest(current['schema']) and check['runtimeHash'] == RUNTIME and check['suiteHash'] == digest(self.suite(database, service)))
            latest_checks = {service['id']: next((check for check in checks if check['serviceId'] == service['id'] and check.get('purpose', 'draft') == 'draft'), None) for service in services}
            terminal = [session for session in sessions if session.get('receipt')]
            feedback = [session for session in sessions if session.get('feedback')]
            return {'protocol': PROTOCOL, 'services': [self.public_service(service) for service in services], 'ontology': {'revision': current['revision'], 'hash': digest(current['schema']), 'entities': [{key: entity[key] for key in ('id', 'label', 'class', 'enabled')} for entity in current['schema']['entities']]}, 'checks': checks[:60], 'latestChecks': latest_checks, 'releases': [{key: value for key, value in release.items() if key != 'snapshot'} for release in releases], 'sessions': [{key: value for key, value in session.items() if key not in ('contract', 'history', 'turns', 'presentation')} for session in sessions], 'learning': self.records(database, 'learning'), 'audit': self.records(database, 'audit')[:100], 'stats': {'sessions': len(sessions), 'receipts': len(terminal), 'feedback': len(feedback), 'positive': sum(session.get('feedback') == 'positive' for session in feedback)}, 'scopeStandards': [{'modelId': model_id, 'symptomId': symptom_id, 'expected': expected} for (model_id, symptom_id), expected in SCOPE_EXPECTATIONS.items()], 'tools': TOOLS, 'outcomes': OUTCOMES, 'runtimeHash': RUNTIME}

    def get(self, path):
        if path == 'state':
            return self.state()
        if path.startswith('sessions/'):
            with self.lock, self.connect() as database:
                session = self.get_record(database, 'session', path.split('/')[-1])
                return {key: value for key, value in session.items() if key != 'contract'}
        raise ValueError('服务接口不存在')

    def post(self, path, body):
        with self.lock, self.connect() as database:
            self.ensure(database)
            if path == 'save':
                current = self.current()
                previous = self.get_record(database, 'service', body['id']) if body.get('id') else None
                if previous and previous['revision'] != body.get('revision'):
                    raise ValueError('服务草稿已被修改，请刷新后重试；未覆盖他人修改')
                entities = {entity['id']: entity for entity in current['schema']['entities'] if entity['enabled']}
                settings = {key: text(body.get(key), limit) for key, limit in [('title', 40), ('entryLabel', 16), ('intro', 100), ('goal', 300), ('handoffLabel', 20)]}
                for field, kind in [('modelIds', 'model'), ('symptomIds', 'symptom')]:
                    values = body.get(field)
                    if not isinstance(values, list) or not 1 <= len(values) <= 20 or any(not isinstance(value, str) or value not in entities or entities[value]['class'] != kind for value in values):
                        raise ValueError('请选择有效且已启用的型号与现象')
                    settings[field] = list(dict.fromkeys(values))
                unsupported = [(model_id, symptom_id) for model_id in settings['modelIds'] for symptom_id in settings['symptomIds'] if (model_id, symptom_id) not in SCOPE_EXPECTATIONS]
                if unsupported:
                    names = '、'.join(entities[model_id]['label'] + ' / ' + entities[symptom_id]['label'] for model_id, symptom_id in unsupported)
                    raise ValueError('当前没有人工审核的范围标准，不能保存：' + names + '。请使用已支持的机型与现象组合；本体中的其他实体仍可独立维护。')
                allowed = body.get('allowedTools')
                if not isinstance(allowed, list) or not allowed or any(not isinstance(value, str) or value not in TOOLS for value in allowed):
                    raise ValueError('至少启用一个合法的本地动作')
                if type(body.get('maxTurns')) is not int or not 2 <= body['maxTurns'] <= 6:
                    raise ValueError('澄清轮数必须为 2–6 的整数')
                settings.update(allowedTools=list(dict.fromkeys(allowed)), maxTurns=body['maxTurns'])
                self.repo.local_scan([json.dumps(settings, ensure_ascii=False)])
                if previous and all(previous[key] == value for key, value in settings.items()) and digest(previous['schema']) == digest(current['schema']):
                    raise ValueError('没有内容变化，无需保存新版本')
                service = {**settings, 'id': previous['id'] if previous else identifier('SVC'), 'revision': previous['revision'] + 1 if previous else 1, 'ontologyRevision': current['revision'], 'schema': current['schema'], 'updatedAt': now()}
                self.put(database, 'service', service)
                self.audit(database, '保存服务契约', service['id'], {'revision': service['revision']})
                return self.public_service(service)
            service_id = body.get('serviceId')
            if path in ('verify', 'publish', 'rollback', 'start'):
                service = self.get_record(database, 'service', service_id)
            if path == 'verify':
                if service['revision'] != body.get('revision'):
                    raise ValueError('草稿版本已变化，请刷新后验收')
                if digest(service['schema']) != digest(self.current()['schema']):
                    raise ValueError('本体已更新，请先保存草稿同步本体，再运行验收')
                check = self.verification(database, service)
                check['purpose'] = 'draft'
                self.put(database, 'check', check)
                self.audit(database, '运行固定验收', service_id, {'checkId': check['id'], 'passed': check['passed'], 'total': check['total']})
                return check
            if path in ('publish', 'rollback'):
                if body.get('confirmed') is not True:
                    raise ValueError('发布或回退必须明确确认仅作用于本地沙箱')
                reason = text(body.get('reason'), 200)
                self.repo.local_scan([reason])
                releases = [item for item in self.records(database, 'release') if item['serviceId'] == service_id]
                active = releases[0]['id'] if releases else None
                if body.get('activeReleaseId') != active:
                    raise ValueError('沙箱发布版本已变化，请刷新后重新确认')
                if path == 'publish':
                    check = self.get_record(database, 'check', body.get('checkId'))
                    latest_check = next((item for item in self.records(database, 'check') if item['serviceId'] == service_id and item.get('purpose', 'draft') == 'draft'), None)
                    if not latest_check or latest_check['id'] != check['id'] or check.get('purpose', 'draft') != 'draft' or check['serviceId'] != service_id or check['revision'] != service['revision'] or check['schemaHash'] != digest(self.current()['schema']) or check['runtimeHash'] != RUNTIME or check['suiteHash'] != digest(self.suite(database, service)):
                        raise ValueError('验收证据已过期，请重新运行当前版本验收')
                    if check['passed'] != check['total']:
                        raise ValueError('必须全部通过才能发布；不能跳过失败用例')
                    snapshot = service
                    if releases and digest(releases[0]['snapshot']) == digest(snapshot):
                        return {key: value for key, value in releases[0].items() if key != 'snapshot'}
                else:
                    target = self.get_record(database, 'release', body.get('releaseId'))
                    if target['serviceId'] != service_id or target['id'] == active:
                        raise ValueError('只能回退本项服务的历史发布版本')
                    snapshot = target['snapshot']
                    check = self.verification(database, snapshot)
                    check['purpose'] = 'rollback'
                    if check['passed'] != check['total']:
                        raise ValueError('历史快照未通过当前回归集，不能回退')
                    self.put(database, 'check', check)
                release = {'id': identifier('REL'), 'serviceId': service_id, 'revision': snapshot['revision'], 'ontologyRevision': snapshot['ontologyRevision'], 'checkId': check['id'], 'snapshot': snapshot, 'mode': 'sandbox', 'action': path, 'reason': reason, 'createdAt': now(), 'previousId': active}
                self.put(database, 'release', release)
                self.audit(database, '本地沙箱发布' if path == 'publish' else '本地沙箱回退', service_id, {'releaseId': release['id'], 'checkId': check['id']})
                return {key: value for key, value in release.items() if key != 'snapshot'}
            if path == 'start':
                mode = body.get('mode', 'draft')
                if mode not in ('draft', 'published'):
                    raise ValueError('预览模式不正确')
                release_id = None
                if mode == 'published':
                    releases = [item for item in self.records(database, 'release') if item['serviceId'] == service_id]
                    if not releases:
                        raise ValueError('尚未发布到本地沙箱，请先验收发布')
                    service, release_id = releases[0]['snapshot'], releases[0]['id']
                elif body.get('revision') != service['revision']:
                    raise ValueError('草稿已更新，请刷新后开启预览')
                presentation = {key: service[key] for key in ('entryLabel', 'intro', 'handoffLabel', 'modelIds', 'symptomIds')}
                labels = {entity['id']: entity['label'] for entity in service['schema']['entities']}
                presentation['suggestion'] = labels[service['modelIds'][0]] + ' ' + labels[service['symptomIds'][0]]
                session = {'id': identifier('SERVICE'), 'serviceId': service_id, 'title': service['title'], 'presentation': presentation, 'revision': service['revision'], 'ontologyRevision': service['ontologyRevision'], 'releaseId': release_id, 'runtimeHash': RUNTIME, 'mode': mode, 'contract': service, 'history': [], 'turns': [], 'createdAt': now(), 'outcome': 'new', 'feedback': None, 'receipt': None}
                self.put(database, 'session', session)
                return {key: value for key, value in session.items() if key != 'contract'}
            session = self.get_record(database, 'session', body.get('sessionId')) if path in ('turn', 'confirm', 'feedback') else None
            if path == 'turn':
                if session['receipt'] or session['outcome'] in ('handoff', 'blocked', 'ready'):
                    raise ValueError('本轮服务已结束判断，请确认材料或重新开始')
                if body.get('turnIndex') != len(session['turns']):
                    raise ValueError('会话已收到新消息，请刷新会话；未重复执行')
                if session['runtimeHash'] != RUNTIME:
                    raise ValueError('运行时已升级，请新建会话')
                message = text(body.get('message'), 600)
                self.repo.local_scan([message])
                result = evaluate(session['contract'], session['contract']['schema'], message, session['history'])
                session['history'].append({'role': 'user', 'content': message})
                session['turns'].append({'message': message, **result})
                session['outcome'] = result['outcome']
                self.put(database, 'session', session)
                self.audit(database, '客户端预览执行', session['serviceId'], {'sessionId': session['id'], 'turn': len(session['turns']), 'outcome': result['outcome']})
                return {key: value for key, value in session.items() if key != 'contract'}
            if path == 'confirm':
                if body.get('confirmed') is not True:
                    raise ValueError('请明确确认本地材料，不会创建真实工单')
                if session['receipt']:
                    return {key: value for key, value in session.items() if key != 'contract'}
                if session['outcome'] not in ('ready', 'handoff'):
                    raise ValueError('当前状态不允许生成服务材料')
                session['receipt'] = {'id': identifier('LOCAL'), 'kind': '专业复核材料' if session['outcome'] == 'handoff' else '服务预检材料', 'createdAt': now(), 'productionCreated': False, 'status': '仅保存在本机，未接通工单系统'}
                session['outcome'] = 'completed'
                session['turns'][-1]['events'].append({'sequence': len(session['turns'][-1]['events']) + 1, 'stage': '客户确认与本地持久化', 'status': 'completed', 'detail': session['receipt'], 'at': now()})
                self.put(database, 'session', session)
                self.audit(database, '确认本地材料', session['serviceId'], {'sessionId': session['id'], 'receiptId': session['receipt']['id']})
                return {key: value for key, value in session.items() if key != 'contract'}
            if path == 'feedback':
                if body.get('value') not in ('positive', 'negative') or not session['turns']:
                    raise ValueError('请先完成至少一次预览再反馈')
                if session['feedback']:
                    raise ValueError('该会话已提交反馈，不重复计数')
                session['feedback'] = body['value']
                if body['value'] == 'negative':
                    self.put(database, 'learning', {'id': identifier('LEARN'), 'serviceId': session['serviceId'], 'sessionId': session['id'], 'title': '客户端体验不符合预期', 'messages': [item['content'] for item in session['history']], 'actual': session['turns'][-1]['outcome'], 'status': 'review', 'createdAt': now()})
                self.put(database, 'session', session)
                self.audit(database, '记录体验反馈', session['serviceId'], {'sessionId': session['id'], 'value': session['feedback']})
                return {'stored': True}
            if path == 'learn':
                item = self.get_record(database, 'learning', body.get('id'))
                if item['status'] != 'review':
                    raise ValueError('该问题已加入回归，不能重复提交')
                expected = body.get('expected')
                if expected not in ('ready', 'handoff', 'clarify', 'blocked') or body.get('confirmed') is not True:
                    raise ValueError('请人工确认正确的预期结果')
                regression = {**item, 'expected': expected, 'status': 'regression'}
                self.put(database, 'regression', regression)
                self.put(database, 'learning', regression)
                self.audit(database, '审核并加入回归', item['serviceId'], {'learningId': item['id'], 'expected': expected})
                return regression
            raise ValueError('服务操作不存在')
