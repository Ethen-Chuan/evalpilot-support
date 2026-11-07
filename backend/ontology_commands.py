import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

from ontology import SCHEMA, digest, example_graph
from ontology_workflow import knowledge_records, run_workflow, verify_acceptance


PROTOCOL = 'ontology-commands-v1'
RELATIONS = {'has_model': '示例可选型号', 'candidate_component': '候选部件', 'presents_as': '示例关联现象', 'has_component': '示例组成部件', 'next_step': '需要核实', 'needs_review': '需专业复核'}
EXAMPLES = ['查看关联元素', '给“启动异常”添加别名“启动没反应”', '运行客服任务“我的主机启动没反应。”', '说明改为“仅用于匿名演示，需核实适用范围。”', '新增部件“散热模组”', '关联“散热模组”，关系“示例组成部件”', '运行固定验收', '撤销上次修改']


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def resolve_node(schema, reference):
    nodes, edges = example_graph(schema)
    matches = [node for node in nodes if node['id'] == reference] or [node for node in nodes if node['label'] == reference]
    if len(matches) != 1:
        raise ValueError('没有唯一匹配的元素，请先在图谱中选中目标，再发送指令。')
    return matches[0]


def entity(schema, identifier):
    selected = next((item for item in schema['entities'] if item['id'] == identifier), None)
    if selected is None:
        raise ValueError('写操作只允许规范实体；不能改写规则、原始案例或派生别名节点。')
    return selected


def add_alias(schema, arguments):
    target = entity(schema, arguments['nodeId'])
    if target['class'] in ('code', 'ticket'):
        raise ValueError('故障码和工单不能通过普通别名函数改写。')
    alias = arguments['alias']
    if len(target['aliases']) >= 30:
        raise ValueError('单个实体最多登记 30 个别名，请先清理重复或无效叫法。')
    if len(alias) > 30 or any(alias.casefold() in [item['label'].casefold(), *(word.casefold() for word in item['aliases'])] for item in schema['entities']):
        raise ValueError('该叫法已存在或与其他实体冲突；不能创建歧义映射。')
    target['aliases'].append(alias)


def remove_alias(schema, arguments):
    target = entity(schema, arguments['nodeId'])
    if arguments['alias'] not in target['aliases']:
        raise ValueError('该实体没有这条别名。')
    target['aliases'].remove(arguments['alias'])


def update_description(schema, arguments):
    target = entity(schema, arguments['nodeId'])
    if target['description'] == arguments['description']:
        raise ValueError('说明没有变化，无需执行写操作。')
    target['description'] = arguments['description']


def create_entity(schema, arguments):
    if arguments['classId'] not in ('component', 'symptom') or len(arguments['label']) > 30:
        raise ValueError('本机工作区只允许新增短名称的部件或症状。')
    if any(arguments['label'].casefold() in [item['label'].casefold(), *(alias.casefold() for alias in item['aliases'])] for item in schema['entities']):
        raise ValueError('该名称与已有实体或别名重复。')
    schema['entities'].append({'id': arguments['nodeId'], 'label': arguments['label'], 'class': arguments['classId'], 'aliases': [], 'description': arguments['description'], 'origin': 'local-command'})


def add_relation(schema, arguments):
    entity(schema, arguments['sourceId'])
    entity(schema, arguments['targetId'])
    if arguments['relation'] not in RELATIONS or arguments['sourceId'] == arguments['targetId']:
        raise ValueError('不允许该关系类型或自关联；规则、型号范围等保护关系不可改写。')
    proposed = {'source': arguments['sourceId'], 'target': arguments['targetId'], 'type': arguments['relation'], 'label': RELATIONS[arguments['relation']]}
    if any(all(item[field] == proposed[field] for field in ('source', 'target', 'type')) for item in schema['relations']):
        raise ValueError('这条关系已经存在。')
    schema['relations'].append(proposed)


def remove_relation(schema, arguments):
    if arguments['relation'] not in RELATIONS:
        raise ValueError('受保护关系不能删除。')
    matches = [item for item in schema['relations'] if item['source'] == arguments['sourceId'] and item['target'] == arguments['targetId'] and item['type'] == arguments['relation']]
    if not matches:
        raise ValueError('没有找到指定关系。')
    schema['relations'].remove(matches[0])


MUTATIONS = {'add_alias': add_alias, 'remove_alias': remove_alias, 'update_description': update_description, 'create_entity': create_entity, 'add_relation': add_relation, 'remove_relation': remove_relation}


def parse_command(command, selected, schema):
    command = command.strip().replace('"', '“').replace('”', '“').replace('，', ',').rstrip('。')
    target = lambda reference: resolve_node(schema, reference)['id']
    if command == '查看关联元素':
        return 'inspect_node', {'nodeId': target(selected)}
    if command == '运行固定验收':
        return 'verify_workspace', {}
    if command == '撤销上次修改':
        return 'undo_change', {}
    matched = re.fullmatch(r'运行客服任务“(.+)“', command)
    if matched:
        return 'run_customer_task', {'text': matched[1]}
    matched = re.fullmatch(r'(?:给|为)“([^“]+)“(?:添加|增加)别名“([^“]+)“', command)
    if matched:
        return 'add_alias', {'nodeId': target(matched[1]), 'alias': matched[2]}
    matched = re.fullmatch(r'(添加|增加|移除|删除)别名“([^“]+)“', command)
    if matched:
        return 'add_alias' if matched[1] in ('添加', '增加') else 'remove_alias', {'nodeId': target(selected), 'alias': matched[2]}
    matched = re.fullmatch(r'(?:把|将)?“([^“]+)“的说明改为“([^“]+)“', command)
    if matched:
        return 'update_description', {'nodeId': target(matched[1]), 'description': matched[2]}
    matched = re.fullmatch(r'说明(?:改为|改成)“([^“]+)“', command)
    if matched:
        return 'update_description', {'nodeId': target(selected), 'description': matched[1]}
    matched = re.fullmatch(r'新增(部件|症状)“([^“]+)“', command)
    if matched:
        return 'create_entity', {'nodeId': 'custom:' + uuid.uuid4().hex[:16], 'classId': 'component' if matched[1] == '部件' else 'symptom', 'label': matched[2], 'description': '用户在本机新增的匿名演示实体；尚未登记知识内容，不代表真实诊断依据。'}
    matched = re.fullmatch(r'(关联|移除关联)“([^“]+)“,\s*关系“([^“]+)“', command)
    if matched:
        relation = next((identifier for identifier, label in RELATIONS.items() if matched[3] in (identifier, label)), None)
        if not relation:
            raise ValueError('关系必须来自登记列表，不能任意创建或关闭业务约束。')
        return 'add_relation' if matched[1] == '关联' else 'remove_relation', {'sourceId': target(selected), 'targetId': target(matched[2]), 'relation': relation}
    raise ValueError('没有执行：目前支持面板中的明确指令格式，不是任意自然语言或系统终端。请从示例带入后修改。')


def graph_changes(before, after):
    old_nodes, old_edges = example_graph(before)
    new_nodes, new_edges = example_graph(after)
    changes = []
    for kind, old, new in [('元素', old_nodes, new_nodes), ('关系', old_edges, new_edges)]:
        old_index = {item['id']: item for item in old}
        new_index = {item['id']: item for item in new}
        for identifier in sorted(set(old_index) | set(new_index)):
            previous, current = old_index.get(identifier), new_index.get(identifier)
            if previous != current:
                changes.append({'kind': kind, 'action': '新增' if previous is None else '删除' if current is None else '修改', 'id': identifier, 'label': (current or previous)['label'], 'before': previous, 'after': current})
    return changes


class OntologyCommands:
    def __init__(self, path, scanner):
        self.path = Path(path)
        self.scanner = scanner
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as database:
            database.executescript('CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,generation INTEGER,payload TEXT); CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,payload TEXT,used INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,payload TEXT);')
            database.execute('INSERT OR IGNORE INTO state VALUES (1,0,?)', (json.dumps({'schema': SCHEMA, 'baseHash': digest(SCHEMA), 'undo': []}, ensure_ascii=False),))

    def connection(self):
        database = sqlite3.connect(str(self.path), timeout=20)
        database.execute('PRAGMA journal_mode=WAL')
        return database

    def snapshot(self, database=None):
        if database is None:
            with self.connection() as current:
                return self.snapshot(current)
        generation, payload = database.execute('SELECT generation,payload FROM state WHERE id=1').fetchone()
        value = json.loads(payload)
        if value['baseHash'] != digest(SCHEMA):
            raise ValueError('基础本体版本已变化；已保留本机修改并停止写入，需要先迁移工作区，不能静默覆盖。')
        return {**value, 'generation': generation, 'revision': str(generation) + ':' + digest(value['schema'])[:16]}

    def state(self):
        value = self.snapshot()
        with self.connection() as database:
            rows = database.execute('SELECT sequence,payload FROM events ORDER BY sequence DESC LIMIT 20').fetchall()
        return {'protocol': PROTOCOL, 'revision': value['revision'], 'schemaHash': digest(value['schema']), 'undoAvailable': bool(value['undo']), 'history': [{'sequence': sequence, **json.loads(payload)} for sequence, payload in reversed(rows)], 'historyLimit': 20, 'examples': EXAMPLES, 'functions': list(MUTATIONS) + ['inspect_node', 'run_customer_task', 'verify_workspace', 'undo_change'], 'relations': RELATIONS, 'boundary': '只修改本机教学工作区，保留源 Schema 和真实数据。指令由有限语法解析，不调用模型，不是系统终端；最近 20 条记录在面板显示，历史保存在独立本机数据库。'}

    def event(self, database, value):
        database.execute('INSERT INTO events(id,payload) VALUES (?,?)', (value['id'], json.dumps(value, ensure_ascii=False)))

    def command(self, body):
        if set(body) != {'command', 'selectedNodeId', 'expectedRevision'} or not all(isinstance(body[key], str) for key in body):
            raise ValueError('指令需要文本、当前选中元素和工作区版本。')
        if not body['command'].strip() or len(body['command']) > 500 or len(body['selectedNodeId']) > 100:
            raise ValueError('请输入 1–500 字的匿名业务指令。')
        self.scanner([body['command']])
        try:
            return self.execute_checked(body)
        except ValueError as error:
            state = self.snapshot()
            rejection = {'protocol': PROTOCOL, 'id': 'REJECT-' + uuid.uuid4().hex[:16], 'createdAt': timestamp(), 'status': 'blocked', 'function': 'validate_command', 'arguments': {}, 'command': body['command'], 'revision': state['revision'], 'error': str(error), 'writesApplied': False, 'trace': [{'function': 'privacy_check', 'status': 'completed'}, {'function': 'validate_command', 'status': 'blocked'}]}
            with self.connection() as database:
                self.event(database, rejection)
            raise

    def execute_checked(self, body):
        state = self.snapshot()
        if body['expectedRevision'] != state['revision']:
            raise ValueError('工作区已被另一窗口修改，请刷新版本后重新预览。')
        action, arguments = parse_command(body['command'], body['selectedNodeId'], state['schema'])
        start = time.perf_counter()
        result = {'protocol': PROTOCOL, 'id': 'CMD-' + uuid.uuid4().hex[:16], 'createdAt': timestamp(), 'command': body['command'], 'function': action, 'arguments': arguments, 'revision': state['revision'], 'externalCalls': False, 'businessActionExecuted': False}
        if action in MUTATIONS or action == 'undo_change':
            changed = copy.deepcopy(state['schema'])
            if action == 'undo_change':
                if not state['undo']:
                    raise ValueError('没有可撤销的修改。')
                changed = state['undo'][-1]['before']
                arguments['operationId'] = state['undo'][-1]['id']
            else:
                MUTATIONS[action](changed, arguments)
            if len(changed['entities']) > 100 or len(changed['relations']) > 300:
                raise ValueError('教学工作区容量上限为 100 个实体、300 条显式关系。')
            example_graph(changed)
            knowledge_records(changed)
            suite = verify_acceptance(changed)
            result.update(status='preview' if suite['passed'] == suite['total'] else 'blocked', previewId='PRE-' + uuid.uuid4().hex, expiresAt=time.time() + 600, changes=graph_changes(state['schema'], changed), checks={'schema': True, 'privacy': True, 'passed': suite['passed'], 'total': suite['total'], 'failedCases': [row['name'] for row in suite['rows'] if not row['passed']]}, canCommit=suite['passed'] == suite['total'], writesApplied=False)
            result['trace'] = [{'function': 'parse_command', 'status': 'completed'}, {'function': action, 'status': 'dry_run'}, {'function': 'validate_graph', 'status': 'completed'}, {'function': 'verify_acceptance', 'status': 'completed' if result['canCommit'] else 'blocked'}, {'function': 'commit_workspace', 'status': 'awaiting_confirmation' if result['canCommit'] else 'blocked'}]
            result['durationMs'] = round((time.perf_counter() - start) * 1000, 3)
            with self.connection() as database:
                database.execute('DELETE FROM previews WHERE json_extract(payload,\'$.expiresAt\') < ?', (time.time(),))
                database.execute('INSERT INTO previews(id,payload) VALUES (?,?)', (result['previewId'], json.dumps(result, ensure_ascii=False)))
                self.event(database, result)
            return result
        if action == 'inspect_node':
            nodes, edges = example_graph(state['schema'])
            result['output'] = {'node': next(node for node in nodes if node['id'] == arguments['nodeId']), 'relations': [edge for edge in edges if arguments['nodeId'] in (edge['source'], edge['target'])]}
        elif action == 'run_customer_task':
            result['output'] = run_workflow(arguments['text'], schema=state['schema'])
        elif action == 'verify_workspace':
            result['output'] = verify_acceptance(state['schema'])
        else:
            raise ValueError('未登记的业务函数。')
        result.update(status='executed', writesApplied=False, durationMs=round((time.perf_counter() - start) * 1000, 3), trace=[{'function': 'parse_command', 'status': 'completed'}, {'function': action, 'status': 'completed'}, {'function': 'append_audit_record', 'status': 'completed'}])
        with self.connection() as database:
            self.event(database, result)
        return result

    def commit(self, body):
        if set(body) != {'previewId', 'expectedRevision', 'confirm'} or body['confirm'] is not True or not isinstance(body['previewId'], str) or not isinstance(body['expectedRevision'], str):
            raise ValueError('必须明确确认已预览的修改。')
        with self.connection() as database:
            database.execute('BEGIN IMMEDIATE')
            found = database.execute('SELECT payload,used FROM previews WHERE id=?', (body['previewId'],)).fetchone()
            if not found:
                raise ValueError('没有找到变更预览，请重新提交指令。')
            preview, used = json.loads(found[0]), found[1]
            state = self.snapshot(database)
            if used or preview['expiresAt'] < time.time() or state['revision'] != preview['revision'] or body['expectedRevision'] != state['revision']:
                raise ValueError('预览已使用、过期或版本已变化；没有重复执行，请重新预览。')
            if not preview['canCommit']:
                raise ValueError('固定验收未通过，不能应用此修改。')
            self.scanner([preview['command']])
            changed = copy.deepcopy(state['schema'])
            undo = state['undo']
            if preview['function'] == 'undo_change':
                if not undo or undo[-1]['id'] != preview['arguments']['operationId']:
                    raise ValueError('可撤销版本已变化。')
                changed = undo.pop()['before']
            else:
                MUTATIONS[preview['function']](changed, preview['arguments'])
            example_graph(changed)
            knowledge_records(changed)
            suite = verify_acceptance(changed)
            if suite['passed'] != suite['total']:
                raise ValueError('当前校验未通过；没有保存任何图谱修改。')
            operation_id = 'APPLY-' + uuid.uuid4().hex[:16]
            if preview['function'] != 'undo_change':
                undo = (undo + [{'id': operation_id, 'before': state['schema']}])[-50:]
            generation = state['generation'] + 1
            revision = str(generation) + ':' + digest(changed)[:16]
            result = {'protocol': PROTOCOL, 'id': operation_id, 'createdAt': timestamp(), 'status': 'committed', 'function': preview['function'], 'arguments': preview['arguments'], 'command': preview['command'], 'previewId': preview['previewId'], 'revision': revision, 'previousRevision': state['revision'], 'changes': graph_changes(state['schema'], changed), 'checks': {'passed': suite['passed'], 'total': suite['total']}, 'writesApplied': True, 'externalCalls': False, 'businessActionExecuted': False, 'trace': [{'function': 'check_confirmation_and_revision', 'status': 'completed'}, {'function': preview['function'], 'status': 'completed'}, {'function': 'verify_acceptance', 'status': 'completed'}, {'function': 'commit_workspace_and_audit', 'status': 'completed'}]}
            database.execute('UPDATE state SET generation=?,payload=? WHERE id=1', (generation, json.dumps({'schema': changed, 'baseHash': state['baseHash'], 'undo': undo}, ensure_ascii=False)))
            database.execute('UPDATE previews SET used=1 WHERE id=?', (preview['previewId'],))
            self.event(database, result)
            return result
