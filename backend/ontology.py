import collections
import hashlib
import json
from pathlib import Path
import re
import threading
import urllib.parse

from dataset_labels import FIELDS, label_values


SCHEMA = json.loads(Path(__file__).with_name('ontology_schema.json').read_text())
VALUE_NAMES = {'info_query': '信息查询', 'feature_inquiry': '功能咨询', 'fault_repair': '故障维修', 'dispatch_request': '派单服务', 'policy_inquiry': '政策咨询', 'other': '其他问题', 'irrelevant': '无关问题', 'complaint': '投诉反馈', 'unclear': '意图待澄清', 'has_answer': '原标注：已有答案', 'gap': '原标注：知识缺口'}
MAX_CASES = 10000


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def edge(source, target, relation, label, provenance, **details):
    return {'id': digest([source, target, relation])[:24], 'source': source, 'target': target, 'type': relation, 'label': label, 'provenance': provenance, **details}


def validate_graph(nodes, edges):
    indexed = {node['id']: node for node in nodes}
    if len(indexed) != len(nodes) or len({item['id'] for item in edges}) != len(edges):
        raise ValueError('图谱包含重复标识')
    domains = {'has_model': ('device', 'model'), 'scoped_to': ('code', 'model'), 'candidate_component': ('code', 'component'), 'presents_as': ('code', 'symptom'), 'has_component': ('device', 'component'), 'next_step': ('symptom', 'action'), 'needs_review': ('component', 'action'), 'records_in': ('action', 'ticket')}
    for item in edges:
        if item['source'] not in indexed or item['target'] not in indexed:
            raise ValueError('图谱包含不存在的关系端点')
        source, target = indexed[item['source']], indexed[item['target']]
        if item['type'] in domains and (source.get('classId'), target.get('classId')) != domains[item['type']]:
            raise ValueError('关系不符合本体定义的概念范围')
        if item['type'] == 'alias_of' and (source['kind'] != 'alias' or target['kind'] != 'entity'):
            raise ValueError('同义关系必须指向规范实体')
        if item['type'] == 'has_label' and (source['kind'] != 'case' or target['kind'] != 'label'):
            raise ValueError('人工标注关系必须连接会话与标签')
        if item['type'] == 'instance_of' and target['kind'] != 'class':
            raise ValueError('实例必须指向一个已定义的类')
    return True


def example_graph(schema=None):
    schema = SCHEMA if schema is None else schema
    nodes, edges = [], []
    for item in schema['classes']:
        nodes.append({**item, 'id': 'class:' + item['id'], 'kind': 'class', 'provenance': 'schema'})
    for item in schema['rules']:
        nodes.append({**item, 'id': 'rule:' + item['id'], 'kind': 'rule', 'provenance': 'schema'})
    for item in schema['entities']:
        nodes.append({**item, 'classId': item['class'], 'kind': 'entity', 'provenance': 'example'})
        edges.append(edge(item['id'], 'class:' + item['class'], 'instance_of', '属于概念', 'schema'))
        for alias in item['aliases']:
            identifier = 'alias:' + digest([item['id'], alias])[:16]
            nodes.append({'id': identifier, 'label': alias, 'kind': 'alias', 'provenance': 'example', 'classId': item['class'], 'description': f'客户说“{alias}”时，本示例词典将其归一为“{item["label"]}”。这是一条明确的术语映射，不代表识别了同一台物理设备，也不构成诊断。'})
            edges.append(edge(identifier, item['id'], 'alias_of', '规范叫法', 'example'))
    for item in schema['relations']:
        edges.append(edge(item['source'], item['target'], item['type'], item['label'], 'example', evidence='人工编写的本体教学示例，非厂商维修依据'))
    validate_graph(nodes, edges)
    return nodes, edges


def term_mentioned(term, text):
    pattern = re.escape(term)
    if re.search(r'[A-Za-z0-9]', term):
        pattern = r'(?<![A-Za-z0-9])' + pattern + r'(?![A-Za-z0-9])'
    for match in re.finditer(pattern, text, re.IGNORECASE):
        prefix = text[max(0, match.start() - 8):match.start()]
        if not re.search(r'(不是|并非|没有|未出现|不报|没有报)\s*$', prefix):
            return True
    return False


def resolve_example(text, proposed_action='clarify', schema=None):
    schema = SCHEMA if schema is None else schema
    if proposed_action not in ('clarify', 'replace'):
        raise ValueError('不支持的教学检查动作')
    mappings, active = [], set()
    for item in schema['entities']:
        if item['class'] == 'code':
            continue
        terms = [term for term in [item['label'], *item['aliases']] if term_mentioned(term, text)]
        if terms:
            mappings.append({'terms': terms, 'canonical': item['label'], 'nodeId': item['id'], 'classId': item['class'], 'basis': '受控示例词典；词语命中不等于完整句意理解'})
            active.add(item['id'])
    models = [item['id'] for item in schema['entities'] if item['class'] == 'model' and item['id'] in active]
    codes = sorted({match.group(0).upper() for match in re.finditer(r'(?<![A-Za-z0-9])E\d{3,6}(?![A-Za-z0-9])', text, re.IGNORECASE) if term_mentioned(match.group(0), text)})
    known = {item['code'] for item in schema['entities'] if item['class'] == 'code'}
    checks = []
    if codes:
        checks.append({'id': 'model-scope', 'status': 'pass' if len(models) == 1 else 'blocked', 'title': '先限定设备型号', 'reason': '已匹配唯一示例型号。' if len(models) == 1 else '型号缺失或不唯一，不能据故障码关联部件；请先确认型号。'})
        checks.append({'id': 'known-code', 'status': 'blocked' if set(codes) - known else 'pass', 'title': '不补造未知代码', 'reason': '存在词典未登记的代码，保留为未知。' if set(codes) - known else '代码在示例词典中，仍需核对适用型号。'})
        if len(models) == 1:
            for code in codes:
                scoped = [item for item in schema['entities'] if item.get('code') == code and item.get('model') == models[0]]
                for item in scoped:
                    mappings.append({'terms': [code], 'canonical': item['label'], 'nodeId': item['id'], 'classId': 'code', 'basis': '以代码和型号共同定位；仅教学映射'})
                    active.add(item['id'])
                    for relation in schema['relations']:
                        if relation['source'] == item['id'] and relation['type'] in ('candidate_component', 'scoped_to'):
                            active.add(relation['target'])
                if not scoped and code in known:
                    checks.append({'id': 'known-code', 'status': 'blocked', 'title': '当前型号没有这条映射', 'reason': '不能把其他型号的记录用于当前设备。'})
    checks.append({'id': 'candidate-only', 'status': 'blocked' if proposed_action == 'replace' else 'pass', 'title': '候选关联不能授权换件', 'reason': '已拦截直接更换部件的建议：尚无专业诊断和维修授权。' if proposed_action == 'replace' else '仅做澄清和专业复核，不生成换件结论。'})
    if active.intersection({'startup', 'black', 'no-power'}):
        checks.append({'id': 'symptom-boundary', 'status': 'pass', 'title': '保留症状与根因的区别', 'reason': '启动异常、黑屏、无法上电保持为不同概念，不互相补造。'})
    active.update('rule:' + item['id'] for item in checks)
    if any(item['id'] == 'model-scope' and item['status'] == 'blocked' for item in checks):
        active.add('ask-model')
    nodes, edges = example_graph(schema)
    for item in edges:
        if item['type'] == 'alias_of' and item['target'] in active and term_mentioned(next(node['label'] for node in nodes if node['id'] == item['source']), text):
            active.add(item['source'])
    return {'mappings': mappings, 'checks': checks, 'activeNodeIds': sorted(active), 'activeEdgeIds': [item['id'] for item in edges if item['source'] in active and item['target'] in active], 'status': 'blocked' if any(item['status'] == 'blocked' for item in checks) else 'checked', 'unknownCodes': sorted(set(codes) - known), 'externalCalls': False, 'boundary': schema['boundary']}


class OntologyService:
    def __init__(self, repository):
        self.repository = repository
        self.commands = None
        self.domain_lock = threading.RLock()

    def workbench(self):
        if self.commands is None:
            if not hasattr(self.repository, 'DATA'):
                raise ValueError('当前运行环境没有配置独立的本体工作区。')
            from ontology_commands import OntologyCommands
            self.commands = OntologyCommands(self.repository.DATA / 'ontology-workbench.sqlite3', self.repository.local_scan)
        return self.commands

    def current_schema(self):
        return self.workbench().snapshot()['schema'] if hasattr(self.repository, 'DATA') else SCHEMA

    def domain(self):
        from ontology_registry import OntologyRegistry
        expected = Path(self.repository.DATA) / 'ontology-domain.sqlite3'
        with self.domain_lock:
            if not hasattr(self, '_domain') or self._domain.path != expected:
                self._domain = OntologyRegistry(self.repository)
            return self._domain

    def corpus_graph(self, project):
        corpus = self.repository.get('corpus', project)
        if not corpus or corpus.get('scanStatus') != 'passed':
            raise ValueError('请先选择已完成脱敏复核的项目')
        self.repository.DIALOGUES.refresh_index()
        with self.repository.LOCK, self.repository.connection() as database:
            total = database.execute('SELECT COUNT(*) FROM dialogue_summaries WHERE dataset_id=?', (project,)).fetchone()[0]
            rows = database.execute("SELECT id,json_extract(payload,'$.labelSummary'),json_extract(payload,'$.messageCount') FROM dialogue_summaries WHERE dataset_id=? ORDER BY id LIMIT ?", (project, MAX_CASES)).fetchall()
        nodes = [{'id': 'project:' + project, 'label': corpus['name'], 'kind': 'project', 'provenance': 'imported', 'description': '已导入的脱敏历史会话项目。图谱关系取自人工标签，不推断诊断或因果。', 'count': total, 'href': '#datasets?' + urllib.parse.urlencode({'project': project})}]
        edges, counts = [], collections.Counter()
        labels = {}
        for field, name in FIELDS.items():
            nodes.append({'id': 'class:' + field, 'label': name, 'kind': 'class', 'provenance': 'schema', 'field': field, 'description': '人工标注中的概念类别；与领域故障实体示例分开。'})
            edges.append(edge('project:' + project, 'class:' + field, 'declares_class', '标注维度', 'schema'))
        for position, (identifier, raw_summary, message_count) in enumerate(rows, 1):
            summary = json.loads(raw_summary) if raw_summary else {}
            node_id = 'case:' + identifier
            links = []
            for field in FIELDS:
                for value in sorted(label_values(summary, field)):
                    label_id = 'label:' + field + ':' + digest(value)[:16]
                    labels[label_id] = {'id': label_id, 'label': VALUE_NAMES.get(value, value), 'kind': 'label', 'field': field, 'value': value, 'provenance': 'human_annotation', 'description': '来自导入会话的有效提交标注；不是模型预测。多值及分歧保持原样。', 'href': '#datasets?' + urllib.parse.urlencode({'project': project, 'labels': json.dumps({field: value}, ensure_ascii=False)})}
                    counts[label_id] += 1
                    links.append(label_id)
                    edges.append(edge(node_id, label_id, 'has_label', FIELDS[field], 'human_annotation', disputed=field in summary.get('conflicts', []), evidence='原始有效提交标注；可打开完整会话核对'))
            return_to = '#ontology?' + urllib.parse.urlencode({'project': project})
            nodes.append({'id': node_id, 'label': f'案例 {position:04d}', 'kind': 'case', 'provenance': 'imported', 'sessionId': identifier, 'messageCount': message_count or 0, 'conflicts': summary.get('conflicts', []), 'cluster': links[0] if links else 'project:' + project, 'description': f'脱敏历史会话，{message_count or 0} 条消息。仅展示标注关系，不把同现当作因果。', 'href': '#knowledge?' + urllib.parse.urlencode({'session': identifier, 'dataset': project, 'project': project, 'returnTo': return_to})})
            edges.append(edge(node_id, 'project:' + project, 'belongs_to_project', '来源项目', 'imported'))
        for identifier, node in labels.items():
            nodes.append({**node, 'count': counts[identifier]})
            edges.append(edge(identifier, 'class:' + node['field'], 'instance_of', '属于概念', 'human_annotation', count=counts[identifier]))
        validate_graph(nodes, edges)
        return nodes, edges, {'totalCases': total, 'loadedCases': len(rows), 'complete': total <= MAX_CASES, 'limit': MAX_CASES, 'conflictCases': sum(bool(node.get('conflicts')) for node in nodes if node['kind'] == 'case')}

    def graph(self, query):
        mode = query.get('mode', ['corpus'])[0]
        if mode not in ('corpus', 'example'):
            raise ValueError('不支持的图谱范围')
        projects = [{'id': corpus['id'], 'name': corpus['name']} for corpus in self.repository.records('corpus') if corpus.get('scanStatus') == 'passed']
        project = query.get('project', [''])[0] or (projects[0]['id'] if projects else '')
        workspace_revision = None
        if mode == 'example':
            snapshot = self.workbench().snapshot() if hasattr(self.repository, 'DATA') else {'schema': SCHEMA}
            schema = snapshot['schema']
            workspace_revision = snapshot.get('revision')
            nodes, edges = example_graph(schema)
            coverage = {'totalCases': 0, 'loadedCases': 0, 'complete': True, 'conflictCases': 0}
        elif not project:
            nodes, edges, coverage = [], [], {'totalCases': 0, 'loadedCases': 0, 'complete': True, 'conflictCases': 0}
        else:
            nodes, edges, coverage = self.corpus_graph(project)
        return {'protocol': 'ontology-graph-v1', 'schemaVersion': SCHEMA['version'], 'mode': mode, 'project': project, 'projects': projects, 'nodes': nodes, 'edges': edges, 'coverage': coverage, 'revision': digest([nodes, edges]), 'workspaceRevision': workspace_revision, 'generatedAt': self.repository.now(), 'externalCalls': False, 'boundary': SCHEMA['boundary'] if mode == 'example' else '关系来源于有效人工标注，不代表诊断因果；缺失标签不推断，不读取或外发原始媒体。'}

    def get(self, path, query):
        if path.startswith('/api/support/ontology/domain/'):
            return self.domain().get(path.removeprefix('/api/support/ontology/domain/'))
        if path == '/api/support/ontology/workbench/state':
            return self.workbench().state()
        if path == '/api/support/ontology/business/catalog':
            from ontology_workflow import catalog
            return catalog(self.current_schema())
        if path == '/api/support/ontology/graph':
            return self.graph(query)
        if path == '/api/support/ontology/health':
            return {'protocol': 'ontology-graph-v1', 'available': True, 'domainProtocol': 'ontology-domain-v1'}
        raise ValueError('本体图谱接口不存在')

    def post(self, path, body):
        if path.startswith('/api/support/ontology/domain/'):
            return self.domain().post(path.removeprefix('/api/support/ontology/domain/'), body)
        if path == '/api/support/ontology/workbench/command':
            return self.workbench().command(body)
        if path == '/api/support/ontology/workbench/commit':
            return self.workbench().commit(body)
        if path == '/api/support/ontology/business/verify':
            from ontology_workflow import verify_acceptance
            if body != {'confirmSynthetic': True}:
                raise ValueError('此入口只运行固定合成验收，不接受外部数据或评分指令')
            return verify_acceptance(self.current_schema())
        if path == '/api/support/ontology/business/run':
            from ontology_workflow import run_workflow
            if set(body) != {'text', 'confirmedModel', 'proposedAction'}:
                raise ValueError('业务演示只接受问题、补充型号与处理建议')
            return run_workflow(self.repository.text(body.get('text'), 500), body['confirmedModel'], body['proposedAction'], self.current_schema())
        if path != '/api/support/ontology/resolve':
            raise ValueError('本体图谱接口不存在')
        text = self.repository.text(body.get('text'), 500)
        return resolve_example(text, body.get('action', 'clarify'), self.current_schema())
