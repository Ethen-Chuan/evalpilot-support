import base64
import collections
from concurrent.futures import ThreadPoolExecutor
import copy
import csv
from datetime import datetime, timezone
import io
import json
import math
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
import xml.etree.ElementTree as XML
import zipfile

from ontology import digest
from ontology_domain import MODES, PROTOCOL, RELATIONS, SEED, TOOLS, align, execute_local, graph_payload, plan_calls, scoped, text, validate_call, validate_output, validate_schema


def now():
    return datetime.now(timezone.utc).isoformat()


def changed_objects(before, after):
    changes = []
    for group in ('classes', 'entities', 'relations', 'rules', 'documents'):
        previous = {item['id']: item for item in before[group]}
        current = {item['id']: item for item in after[group]}
        for identifier in sorted(set(previous) | set(current)):
            if previous.get(identifier) != current.get(identifier):
                changes.append({'group': group, 'id': identifier, 'before': previous.get(identifier), 'after': current.get(identifier)})
    return changes


def alias_rows(filename, encoded, scan):
    if not isinstance(encoded, str) or len(encoded) > 700000:
        raise ValueError('文件不得超过五百 KB')
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        raise ValueError('文件编码不正确') from None
    if len(content) > 500000:
        raise ValueError('文件不得超过五百 KB')
    if filename.lower().endswith('.csv'):
        try:
            raw = content.decode('utf-8-sig')
        except UnicodeError:
            raise ValueError('CSV 请保存为 UTF-8 编码') from None
        scan([raw])
        rows = list(csv.reader(io.StringIO(raw)))
    elif filename.lower().endswith('.xlsx'):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if len(entries) > 40 or len({entry.filename for entry in entries}) != len(entries) or sum(entry.file_size for entry in entries) > 2000000 or any(entry.flag_bits & 1 or '..' in entry.filename or entry.filename.startswith('/') for entry in entries):
                    raise ValueError('工作簿超限、加密或路径不安全')
                if any(re.search(r'vba|externalLink|embedding|media/|comments|drawing', entry.filename, re.I) for entry in entries):
                    raise ValueError('只接受无宏、图片、批注、外链及嵌入对象的别名模板')
                xml_files = {entry.filename: archive.read(entry).decode('utf-8') for entry in entries if entry.filename.endswith(('.xml', '.rels'))}
                if len(xml_files) != len(entries):
                    raise ValueError('模板不能含无法扫描的二进制内容')
                if any('<!DOCTYPE' in value.upper() or '<!ENTITY' in value.upper() for value in xml_files.values()):
                    raise ValueError('不允许 XML 实体或外部引用')
                scan(list(xml_files.values()))
                if any(node.get('TargetMode', '').lower() == 'external' for value in xml_files.values() for node in XML.fromstring(value).iter()):
                    raise ValueError('模板不允许任何外部引用')
                workbook = XML.fromstring(xml_files['xl/workbook.xml'])
                sheets = workbook.findall('.//{*}sheet')
                if len(sheets) != 1 or sheets[0].get('state', 'visible') != 'visible':
                    raise ValueError('模板只接受一个可见工作表，不能含隐藏工作表')
                sheet_paths = [name for name in xml_files if re.fullmatch(r'xl/worksheets/[^/]+\.xml', name)]
                if len(sheet_paths) != 1:
                    raise ValueError('工作表结构不符合模板')
                shared = XML.fromstring(xml_files.get('xl/sharedStrings.xml', '<sst/>'))
                strings = [''.join(node.itertext()) for node in shared.findall('{*}si')]
                worksheet = XML.fromstring(xml_files[sheet_paths[0]])
                if any(node.get('hidden') in ('1', 'true') for node in worksheet.iter()) or worksheet.find('.//{*}f') is not None:
                    raise ValueError('模板不接受隐藏行列或公式，请转换成可见纯文本')
                rows = []
                for row in worksheet.findall('.//{*}sheetData/{*}row'):
                    columns = {}
                    for cell in row.findall('{*}c'):
                        address = re.fullmatch(r'([A-Z]+)\d+', cell.get('r', ''))
                        if not address or address.group(1) not in ('A', 'B'):
                            raise ValueError('模板仅包含 entityId 和 alias 两列')
                        kind = cell.get('t')
                        value = cell.find('{*}v')
                        if kind == 's' and value is not None:
                            content_value = strings[int(value.text)]
                        elif kind == 'inlineStr':
                            content_value = ''.join(node.text or '' for node in cell.findall('.//{*}t'))
                        elif value is None:
                            content_value = ''
                        else:
                            raise ValueError('实体编号与别名必须为文本单元格')
                        if address.group(1) in columns:
                            raise ValueError('模板包含重复单元格')
                        columns[address.group(1)] = content_value
                    if any(columns.values()):
                        rows.append([columns.get('A', ''), columns.get('B', '')])
        except (zipfile.BadZipFile, UnicodeError, KeyError, XML.ParseError, IndexError, TypeError, RuntimeError, NotImplementedError):
            raise ValueError('工作簿损坏或不支持，请使用单表两列纯文本模板') from None
    else:
        raise ValueError('仅支持 UTF-8 CSV 或单工作表 XLSX')
    if not rows or rows[0] != ['entityId', 'alias'] or not 2 <= len(rows) <= 201 or any(len(row) != 2 for row in rows):
        raise ValueError('首行必须是 entityId,alias；一次导入一到二百行')
    if any(value.lstrip().startswith(('=', '+', '-', '@')) for row in rows[1:] for value in row):
        raise ValueError('别名模板不接受公式前缀，请改成纯文本名称')
    return [{'entityId': text(row[0], 64), 'alias': text(row[1], 60)} for row in rows[1:]]


class OntologyRegistry:
    def __init__(self, repository):
        self.repo = repository
        self.path = Path(repository.DATA) / 'ontology-domain.sqlite3'
        self.lock = threading.RLock()
        self.capacity = threading.BoundedSemaphore(8)
        self.tools = threading.BoundedSemaphore(2)
        self.active_sessions = set()
        self.active_requests = set()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as database:
            database.executescript('''
                CREATE TABLE IF NOT EXISTS versions(revision INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,changes TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS previews(token TEXT PRIMARY KEY,base INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,expires REAL NOT NULL,committed INTEGER);
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            ''')
            if not database.execute('SELECT 1 FROM versions LIMIT 1').fetchone():
                validate_schema(SEED)
                database.execute('INSERT INTO versions(payload,actor,reason,created_at,changes) VALUES (?,?,?,?,?)', (json.dumps(SEED, ensure_ascii=False), '系统示例', '初始化虚构本体，不含厂商数据', now(), '[]'))
        self.path.chmod(0o600)
        with self.connect() as database:
            for row in database.execute('SELECT id,payload FROM runs').fetchall():
                run = json.loads(row['payload'])
                if run['status'] == 'running':
                    run.update(status='interrupted', answer='服务重启中断，未发布部分结果。请新建调试请求。', outputCheck={'allowed': False, 'reasons': ['execution_interrupted']})
                    run['steps'].append({'sequence': len(run['steps']) + 1, 'name': '服务恢复检查', 'status': 'failed', 'input': {}, 'output': {'published': False, 'recoveredAt': now()}, 'durationMs': 0, 'offsetMs': run['steps'][-1]['offsetMs'] if run['steps'] else 0})
                    database.execute('UPDATE runs SET payload=? WHERE id=?', (json.dumps(run, ensure_ascii=False), run['id']))

    def connect(self):
        database = sqlite3.connect(self.path, timeout=10)
        database.row_factory = sqlite3.Row
        return database

    def snapshot(self, revision=None):
        with self.connect() as database:
            row = database.execute('SELECT * FROM versions WHERE revision=?', (revision,)).fetchone() if revision else database.execute('SELECT * FROM versions ORDER BY revision DESC LIMIT 1').fetchone()
        if not row:
            raise ValueError('本体版本不存在')
        schema = json.loads(row['payload'])
        return {'revision': row['revision'], 'schema': schema, 'hash': digest(schema), 'actor': row['actor'], 'reason': row['reason'], 'createdAt': row['created_at']}

    def preview(self, body):
        if body.get('expertConfirmed') is not True:
            raise ValueError('请确认以本机维护者身份修改；这不是多用户鉴权')
        current = self.snapshot()
        if type(body.get('revision')) is not int or body['revision'] != current['revision']:
            raise ValueError('版本已变化，请刷新后重新预览')
        actor, reason = text(body.get('actor'), 60), text(body.get('reason'), 300)
        self.repo.local_scan([actor, reason, json.dumps({key: value for key, value in body.items() if key != 'file'}, ensure_ascii=False)])
        updated = copy.deepcopy(current['schema'])
        action = body.get('action')
        if action == 'rollback':
            revision = body.get('targetRevision')
            if type(revision) is not int or revision >= current['revision'] or revision < 1:
                raise ValueError('请选择早于当前的版本')
            updated = self.snapshot(revision)['schema']
        elif action == 'import_aliases':
            rows = alias_rows(text(body.get('filename'), 150), body.get('file'), self.repo.local_scan)
            for row in rows:
                entity = next((item for item in updated['entities'] if item['id'] == row['entityId']), None)
                if not entity:
                    raise ValueError('导入引用了不存在的实体；整批未写入')
                entity['aliases'].append(row['alias'])
        elif action in ('upsert', 'delete'):
            group = body.get('group')
            if group not in ('classes', 'entities', 'relations', 'rules'):
                raise ValueError('不支持的维护对象')
            identifier = text(body.get('id'), 64)
            previous = next((item for item in updated[group] if item['id'] == identifier), None)
            if action == 'delete' and not previous:
                raise ValueError('对象不存在')
            updated[group] = [item for item in updated[group] if item['id'] != identifier]
            if action == 'upsert':
                item = body.get('item')
                if not isinstance(item, dict) or item.get('id') != identifier:
                    raise ValueError('对象编号不一致')
                updated[group].append(copy.deepcopy(item))
        else:
            raise ValueError('未知维护动作')
        validate_schema(updated)
        self.repo.local_scan([json.dumps(updated, ensure_ascii=False)])
        changes = changed_objects(current['schema'], updated)
        if not changes:
            raise ValueError('内容未变化，无需创建版本')
        token = uuid.uuid4().hex
        with self.connect() as database:
            database.execute('DELETE FROM previews WHERE expires<? AND committed IS NULL', (time.time(),))
            database.execute('INSERT INTO previews VALUES (?,?,?,?,?,?,NULL)', (token, current['revision'], json.dumps(updated, ensure_ascii=False), actor, reason, time.time() + 600))
        return {'token': token, 'baseRevision': current['revision'], 'changes': changes, 'expiresInSeconds': 600, 'hash': digest(updated), 'requiresConfirmation': True, 'warnings': ['变更只影响后续任务；既有会话固定原版本。', '此处是本机维护确认，不具备生产角色权限管理。']}

    def commit(self, body):
        if body.get('confirmed') is not True:
            raise ValueError('请明确确认本次差异后保存')
        token = text(body.get('token'), 64)
        with self.lock, self.connect() as database:
            database.execute('BEGIN IMMEDIATE')
            preview = database.execute('SELECT * FROM previews WHERE token=?', (token,)).fetchone()
            if not preview:
                raise ValueError('预览凭据不存在')
            if preview['committed']:
                return {'revision': preview['committed'], 'replayed': True}
            if preview['expires'] < time.time():
                raise ValueError('预览已过期，请重新预览')
            current = database.execute('SELECT * FROM versions ORDER BY revision DESC LIMIT 1').fetchone()
            if current['revision'] != preview['base']:
                raise ValueError('他处已修改本体，请重新核对差异')
            updated = json.loads(preview['payload'])
            validate_schema(updated)
            changes = changed_objects(json.loads(current['payload']), updated)
            cursor = database.execute('INSERT INTO versions(payload,actor,reason,created_at,changes) VALUES (?,?,?,?,?)', (preview['payload'], preview['actor'], preview['reason'], now(), json.dumps(changes, ensure_ascii=False)))
            revision = cursor.lastrowid
            database.execute('UPDATE previews SET committed=? WHERE token=?', (revision, token))
        return {'revision': revision, 'hash': digest(updated), 'replayed': False}

    def state(self):
        current = self.snapshot()
        with self.connect() as database:
            versions = [{'revision': row['revision'], 'actor': row['actor'], 'reason': row['reason'], 'createdAt': row['created_at'], 'changes': json.loads(row['changes'])} for row in database.execute('SELECT * FROM versions ORDER BY revision DESC LIMIT 50')]
            runs = [json.loads(row[0]) for row in database.execute('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 500')]
        completed = [run for run in runs if run['status'] == 'completed']
        today = datetime.now().astimezone().date()
        daily = [run for run in completed if datetime.fromisoformat(run['createdAt']).astimezone().date() == today]
        aligned = [run for run in completed if run.get('alignment', {}).get('status') == 'aligned']
        sessions = {run['sessionId'] for run in completed}
        blocked = {run['sessionId'] for run in completed if run.get('blockedCalls', 0) or not run.get('outputCheck', {}).get('allowed', True)}
        symptom_sessions = collections.defaultdict(set)
        model_symptoms = collections.defaultdict(set)
        for run in aligned:
            for symptom in run['alignment']['slots'].get('symptom', []):
                symptom_sessions[symptom].add(run['sessionId'])
                model_symptoms[(run['alignment']['modelId'], symptom)].add(run['sessionId'])
        durations = sorted(run['alignmentDurationMs'] for run in completed if 'alignmentDurationMs' in run)
        return {'protocol': PROTOCOL, **current, 'graph': graph_payload(current['schema']), 'versions': versions, 'runs': [{key: run.get(key) for key in ('id', 'sessionId', 'status', 'createdAt', 'revision', 'mode', 'source', 'blockedCalls', 'durationMs', 'traceId')} for run in runs[:30]], 'stats': {'todayRuns': len(daily), 'todayBlockedCalls': sum(run.get('blockedCalls', 0) for run in daily), 'today': today.isoformat(), 'timezone': str(datetime.now().astimezone().tzinfo), 'sessions': len(sessions), 'blockedSessions': len(blocked), 'blockedRate': len(blocked) / len(sessions) if sessions else None, 'symptoms': [{'id': identifier, 'sessions': len(identifiers)} for identifier, identifiers in sorted(symptom_sessions.items(), key=lambda item: -len(item[1]))], 'modelSymptoms': [{'modelId': model, 'symptomId': symptom, 'sessions': len(identifiers)} for (model, symptom), identifiers in model_symptoms.items()], 'alignmentP95Ms': durations[math.ceil(len(durations) * .95) - 1] if durations else None, 'alignmentSamples': len(durations), 'windowRuns': len(runs), 'productionReplacements': None, 'productionAccuracy': None}, 'limits': {'windowUserTurns': 6, 'parallelTools': 2, 'maxPlannedCalls': 3, 'admittedRuns': 8, 'historyMetricsLimit': 500}, 'tools': TOOLS, 'relations': {key: {'label': value[0], 'sourceClass': value[1], 'targetClass': value[2]} for key, value in RELATIONS.items()}, 'modes': MODES, 'boundary': SEED['boundary']}

    def get_run(self, identifier):
        with self.connect() as database:
            row = database.execute('SELECT payload FROM runs WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise ValueError('运行记录不存在')
        return json.loads(row[0])

    def run(self, body, source='debug'):
        if set(body) - {'message', 'sessionId', 'revision', 'requestId', 'mode'}:
            raise ValueError('调试请求包含不支持的字段')
        message = text(body.get('message'), 1000)
        mode = body.get('mode', 'normal')
        request_key = text(body.get('requestId'), 80)
        if mode not in MODES or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}', request_key):
            raise ValueError('调试模式或幂等编号不正确')
        self.repo.local_scan([message])
        request_hash = digest(body)
        identifier = 'DOM-' + uuid.uuid4().hex[:16]
        session_id = body.get('sessionId') or 'DOS-' + uuid.uuid4().hex[:16]
        if not isinstance(session_id, str) or not re.fullmatch(r'DOS-[a-f0-9]{16}', session_id):
            raise ValueError('会话编号格式不正确')
        if not self.capacity.acquire(blocking=False):
            raise ValueError('本体本机队列已满，请稍后重试；未丢弃为成功结果')
        registered = False
        try:
            with self.lock, self.connect() as database:
                previous = database.execute('SELECT request_hash,payload FROM runs WHERE request_key=?', (request_key,)).fetchone()
                if previous:
                    if previous['request_hash'] != request_hash:
                        raise ValueError('同一幂等编号不能对应不同输入')
                    value = json.loads(previous['payload'])
                    if value['status'] == 'running':
                        raise ValueError('该请求已接收，请查看原运行记录；不会重复执行')
                    return {**value, 'replayed': True}
                if session_id in self.active_sessions or request_key in self.active_requests:
                    raise ValueError('同一会话正在执行，请等待当前轮次完成')
                row = database.execute('SELECT payload FROM sessions WHERE id=?', (session_id,)).fetchone()
                if body.get('sessionId') and not row:
                    raise ValueError('会话不存在')
                session = json.loads(row[0]) if row else {'id': session_id, 'revision': 0, 'history': [], 'schemaRevision': self.snapshot()['revision']}
                if body.get('sessionId') and (type(body.get('revision')) is not int or body['revision'] != session['revision']):
                    raise ValueError('会话轮次已经改变，请刷新后继续')
                self.active_sessions.add(session_id)
                self.active_requests.add(request_key)
                registered = True
            snapshot = self.snapshot(session['schemaRevision'])
            result = {'protocol': PROTOCOL, 'id': identifier, 'sessionId': session_id, 'sessionRevision': session['revision'], 'revision': snapshot['revision'], 'schemaHash': snapshot['hash'], 'status': 'running', 'createdAt': now(), 'source': source, 'mode': mode, 'steps': [], 'externalCalls': False, 'boundary': SEED['boundary']}

            def persist():
                with self.connect() as database:
                    database.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?,?)', (identifier, request_key, request_hash, json.dumps(result, ensure_ascii=False)))

            event_lock = threading.RLock()
            started = time.perf_counter()

            def record(name, status, inputs, outputs, duration=0, save=True):
                with event_lock:
                    result['steps'].append({'sequence': len(result['steps']) + 1, 'name': name, 'status': status, 'input': inputs, 'output': outputs, 'offsetMs': round((time.perf_counter() - started) * 1000, 3), 'durationMs': duration})
                    if save:
                        persist()

            persist()
            try:
                record('输入与版本冻结', 'succeeded', {'source': source, 'requestId': request_key}, {'schemaRevision': snapshot['revision'], 'sessionId': session_id, 'privacyChecked': True})
                if mode == 'unavailable':
                    result.update(alignment={'status': 'unavailable', 'slots': {}, 'modelId': None, 'score': 0, 'mappings': [], 'issues': ['本体不可用，停止业务工具。'], 'window': {'limit': 6, 'retainedUserTurns': 0, 'droppedUserTurns': 0}}, planned=[], executions=[], blockedCalls=0, outputCheck={'allowed': False, 'reasons': ['ontology_unavailable']}, answer='本体校验暂不可用，已停止备件、维修和派单工具。请通过正式售后渠道人工核实；本演示没有接入降级 RAG。')
                    record('本体可用性检查', 'blocked', {'injectedFailure': True}, {'businessToolsExecuted': False, 'ragFallbackConnected': False})
                else:
                    alignment_started = time.perf_counter()
                    alignment = align(snapshot['schema'], message, session['history'])
                    result['alignmentDurationMs'] = round((time.perf_counter() - alignment_started) * 1000, 3)
                    result['alignment'] = alignment
                    record('滑动窗口与标准实体对齐', 'succeeded', {'currentMessage': message, 'historyUserTurns': len(session['history'])}, alignment, result['alignmentDurationMs'])
                    documents = [item for item in snapshot['schema']['documents'] if alignment['status'] == 'aligned' and scoped(item, alignment['modelId']) and set(item['entityIds']).intersection(alignment['slots'].get('symptom', []))]
                    result['documents'] = documents
                    record('按标准实体及机型过滤知识', 'succeeded', {'modelId': alignment['modelId'], 'symptomIds': alignment['slots'].get('symptom', [])}, {'documentIds': [item['id'] for item in documents], 'method': '本机结构化示例知识，不是向量检索'})
                    calls = plan_calls(snapshot['schema'], alignment, mode)
                    result['planned'] = calls
                    record('生成候选工具计划', 'succeeded', {'planner': '确定性沙箱计划，非大模型规划', 'mode': mode}, calls)
                    checked = [{**call, 'check': validate_call(snapshot['schema'], alignment, call)} for call in calls]
                    if len(checked) > 3:
                        raise ValueError('超出本轮工具预算')
                    record('执行前本体硬校验', 'succeeded', calls, checked)
                    executions = []

                    def perform(call):
                        if not call['check']['allowed']:
                            record(TOOLS.get(call['tool'], call['tool']), 'blocked', call['arguments'], {'executed': False, **call['check']})
                            return {'call': call, 'status': 'blocked', 'output': {'executed': False}, 'check': call['check']}
                        record('工具排队', 'queued', {'callId': call['id']}, {'parallelLimit': 2})
                        if not self.tools.acquire(timeout=2):
                            record(TOOLS[call['tool']], 'failed', call['arguments'], {'executed': False, 'reason': 'queue_timeout'})
                            return {'call': call, 'status': 'failed', 'output': {'executed': False}, 'check': call['check']}
                        try:
                            beginning = time.perf_counter()
                            record(TOOLS[call['tool']], 'started', call['arguments'], {'callId': call['id']})
                            output = execute_local(snapshot['schema'], call)
                            record(TOOLS[call['tool']], 'succeeded', call['arguments'], output, round((time.perf_counter() - beginning) * 1000, 3))
                            return {'call': call, 'status': 'succeeded', 'output': output, 'check': call['check']}
                        except Exception:
                            record(TOOLS[call['tool']], 'failed', call['arguments'], {'callId': call['id'], 'reason': 'local_tool_failed', 'published': False})
                            return {'call': call, 'status': 'failed', 'output': {'executed': False}, 'check': call['check']}
                        finally:
                            self.tools.release()

                    with ThreadPoolExecutor(max_workers=2) as executor:
                        executions = list(executor.map(perform, checked))
                    result['executions'] = executions
                    result['blockedCalls'] = sum(item['status'] == 'blocked' for item in executions)
                    proposal = {'partIds': sorted({item['call']['arguments']['partId'] for item in executions if item['status'] == 'succeeded' and item['call']['tool'] == 'query_spare'}), 'spareIds': sorted({identifier for item in executions if item['status'] == 'succeeded' for identifier in item['output'].get('spareIds', [])}), 'actionIds': sorted({item['output']['actionId'] for item in executions if item['status'] == 'succeeded' and item['output'].get('actionId')}), 'confirmedDiagnosis': False, 'productionExecuted': False}
                    if mode == 'unsafe_output':
                        proposal.update(partIds=['speaker'], confirmedDiagnosis=True)
                    gate = validate_output(snapshot['schema'], alignment, proposal, executions)
                    if any(item['status'] == 'failed' for item in executions):
                        gate['allowed'] = False
                        gate['reasons'].append('tool_execution_failed')
                    result.update(proposal=proposal, outputCheck=gate)
                    record('发布前结论二次校验', 'succeeded' if gate['allowed'] else 'blocked', proposal, gate)
                    entities = {item['id']: item for item in snapshot['schema']['entities']}
                    if alignment['status'] != 'aligned':
                        answer = ' '.join(alignment['issues'])
                    elif not gate['allowed']:
                        answer = '候选结论未通过本体与工具证据校验，已拦截，需专业人员核实。'
                    else:
                        parts = '、'.join(entities[identifier]['label'] for identifier in proposal['partIds']) or '无已核对的候选部件'
                        actions = '、'.join(entities[identifier]['label'] for identifier in proposal['actionIds']) or '暂无获准处理方式，需人工核实'
                        answer = f'本地已核对的候选：{parts}；下一步：{actions}。仅表示示例关系和预校验条件满足，不代表故障确诊、承诺上门或允许自行换件。'
                    result['answer'] = answer + ' 本次没有创建真实工单、执行换件或接通真人。'
                result['status'] = 'completed'
                session['history'] = (session['history'] + [{'role': 'user', 'content': message}])[-24:]
                session['revision'] += 1
                result['sessionRevision'] = session['revision']
                result['durationMs'] = round((time.perf_counter() - started) * 1000, 3)
                record('标准实体埋点与结果保存', 'succeeded', {'source': source}, {'persisted': True, 'modelId': result['alignment'].get('modelId'), 'slots': result['alignment']['slots'], 'blockedCalls': result['blockedCalls'], 'sessionRevision': session['revision']}, save=False)
                with self.connect() as database:
                    database.execute('BEGIN IMMEDIATE')
                    database.execute('INSERT OR REPLACE INTO sessions VALUES (?,?)', (session_id, json.dumps(session, ensure_ascii=False)))
                    database.execute('UPDATE runs SET payload=? WHERE id=?', (json.dumps(result, ensure_ascii=False), identifier))
                return result
            except Exception:
                result['status'] = 'failed'
                record('本轮执行未完成', 'failed', {}, {'published': False, 'reason': '运行失败，安全事件已保留，不展示未复核结果'})
                raise
        finally:
            if registered:
                with self.lock:
                    self.active_sessions.discard(session_id)
                    self.active_requests.discard(request_key)
            self.capacity.release()

    def export(self):
        state = self.state()
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(['run_id', 'session_id', 'created_at', 'schema_revision', 'source', 'status', 'model_id', 'symptom_ids', 'cause_ids', 'action_ids', 'matching_score_not_probability', 'blocked_tool_calls', 'output_allowed'])
        for item in state['runs']:
            run = self.get_run(item['id'])
            alignment = run.get('alignment', {})
            row = [run['id'], run['sessionId'], run['createdAt'], run['revision'], run['source'], run['status'], alignment.get('modelId') or '', '|'.join(alignment.get('slots', {}).get('symptom', [])), '|'.join(alignment.get('slots', {}).get('cause', [])), '|'.join(run.get('proposal', {}).get('actionIds', [])) if run.get('outputCheck', {}).get('allowed') else '', alignment.get('score', ''), run.get('blockedCalls', ''), run.get('outputCheck', {}).get('allowed', '')]
            writer.writerow(["'" + str(value) if str(value).lstrip().startswith(('=', '+', '-', '@')) else value for value in row])
        self.repo.local_scan([stream.getvalue()])
        return {'filename': 'ontology-local-events.csv', 'content': '\ufeff' + stream.getvalue(), 'rowCount': len(state['runs']), 'boundary': '最多最近三十次本地调试运行；不含用户原话、姓名或凭证，不是生产故障与备件消耗统计。'}

    def get(self, route):
        if route == 'state':
            return self.state()
        if route.startswith('runs/'):
            return self.get_run(route[5:])
        if route == 'export':
            return self.export()
        raise ValueError('本体管理接口不存在')

    def post(self, route, body):
        if not isinstance(body, dict):
            raise ValueError('请求必须是结构化对象')
        if route == 'preview':
            return self.preview(body)
        if route == 'commit':
            return self.commit(body)
        if route == 'run':
            return self.run(body)
        if route == 'verify':
            from ontology_domain_acceptance import verify
            return verify(self.snapshot()['schema'])
        raise ValueError('本体管理接口不存在')
