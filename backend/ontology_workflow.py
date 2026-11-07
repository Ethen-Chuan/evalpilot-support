from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
import uuid

from ontology import SCHEMA, digest, example_graph, term_mentioned


ENGINE_VERSION = 'ontology-business-v1'
KNOWLEDGE = json.loads(Path(__file__).with_name('ontology_business_knowledge.json').read_text())
ACCEPTANCE = json.loads(Path(__file__).with_name('ontology_business_cases.json').read_text())
BOUNDARY = '本机确定性词典、结构化查询与规则演示；未调用大模型，未连接工单系统，未执行维修。不证明真实 Agent 的准确率或经营收益。'
ACTION_NAMES = {'clarify_model': '先核实当前设备型号', 'clarify_code': '先核实当前故障码', 'clarify_context': '补充可识别的现象或代码', 'check_external_state': '核实外部状态', 'professional_review': '准备专业复核交接', 'manual_review': '交由专业人员核实未覆盖问题'}


def knowledge_records(schema=None):
    schema = SCHEMA if schema is None else schema
    nodes, edges = example_graph(schema)
    indexed = {node['id']: node for node in nodes}
    documents = []
    for source in KNOWLEDGE['documents']:
        node = indexed.get(source['nodeId'])
        if not node or node['kind'] != 'entity' or source['kind'] not in ('fault', 'symptom'):
            raise ValueError('教学知识引用了无效的本体实体')
        if source['kind'] == 'fault':
            scoped = [edge for edge in edges if edge['source'] == node['id'] and edge['type'] == 'scoped_to']
            candidates = [edge for edge in edges if edge['source'] == node['id'] and edge['type'] == 'candidate_component']
            if node.get('classId') != 'code' or len(scoped) != 1 or not candidates:
                raise ValueError('故障知识缺少明确型号范围或候选来源')
            terms = [node['code'], indexed[scoped[0]['target']]['label']]
            model = scoped[0]['target']
        else:
            if node.get('classId') != 'symptom':
                raise ValueError('症状知识不能引用其他概念')
            terms, model = [node['label']], None
        documents.append({**source, 'terms': terms, 'modelId': model, 'source': KNOWLEDGE['source']})
    if len({document['id'] for document in documents}) != len(documents):
        raise ValueError('教学知识编号重复')
    return documents


def catalog(schema=None):
    schema = SCHEMA if schema is None else schema
    return {'protocol': ENGINE_VERSION, 'boundary': BOUNDARY, 'knowledgeVersion': KNOWLEDGE['version'], 'knowledgeHash': digest(KNOWLEDGE), 'schemaVersion': schema['version'], 'casesVersion': ACCEPTANCE['version'], 'cases': ACCEPTANCE['cases'], 'models': [{'id': entity['id'], 'label': entity['label']} for entity in schema['entities'] if entity['class'] == 'model'], 'entityLabels': {entity['id']: entity['label'] for entity in schema['entities']}, 'documents': knowledge_records(schema), 'comparisonMethod': '同一份知识、同一输入：左侧仅按标准词与代码字面命中；中间增加受控别名归一；右侧执行型号范围与信息完整性约束。前两列只是检索候选池，不是客服答复，也不代表 RAG 或大模型的能力。'}


def extract_context(text, confirmed_model, schema=None):
    schema = SCHEMA if schema is None else schema
    mappings = []
    for entity in schema['entities']:
        if entity['class'] == 'code':
            continue
        terms = [term for term in [entity['label'], *entity['aliases']] if term_mentioned(term, text)]
        if terms:
            mappings.append({'terms': terms, 'canonical': entity['label'], 'nodeId': entity['id'], 'classId': entity['class'], 'basis': '输入命中受控词典；不代表通用自然语言理解'})
    mentioned_models = {item['nodeId'] for item in mappings if item['classId'] == 'model'}
    model_ids = mentioned_models | ({confirmed_model} if confirmed_model else set())
    known_models = {entity['label'].upper() for entity in schema['entities'] if entity['class'] == 'model'}
    unknown_models = sorted({match.group(0).upper() for match in re.finditer(r'(?<![A-Za-z0-9])A-\d{3,6}(?![A-Za-z0-9])', text, re.IGNORECASE) if term_mentioned(match.group(0), text)} - known_models)
    codes = sorted({match.group(0).upper() for match in re.finditer(r'(?<![A-Za-z0-9])E\d{3,6}(?![A-Za-z0-9])', text, re.IGNORECASE) if term_mentioned(match.group(0), text)})
    return {'mappings': mappings, 'modelIds': sorted(model_ids), 'textModelIds': sorted(mentioned_models), 'confirmedModel': confirmed_model or None, 'unknownModels': unknown_models, 'codes': codes, 'symptomIds': [item['nodeId'] for item in mappings if item['classId'] == 'symptom']}


def candidate_pool(documents, text, context, normalized):
    normalized_ids = {item['nodeId'] for item in context['mappings']}
    normalized_ids.update(context['modelIds'])
    result = []
    for document in documents:
        hits = [term for term in document['terms'] if term_mentioned(term, text)]
        if context['confirmedModel'] and document['modelId'] == context['confirmedModel']:
            hits.append('用户补充型号')
        if normalized and document['kind'] == 'symptom' and document['nodeId'] in normalized_ids:
            hits.append('症状别名归一')
        if hits:
            result.append({'id': document['id'], 'title': document['title'], 'matchedBy': sorted(set(hits))})
    return result


def choose_query(context, schema=None):
    schema = SCHEMA if schema is None else schema
    codes, models = context['codes'], context['modelIds']
    if codes and (len(models) != 1 or context['unknownModels']):
        reason = '正文与补充型号不一致，或同时提到多个型号。' if len(models) > 1 else '当前型号未提供或不在已知词典中。'
        return {'allowed': False, 'nextAction': 'clarify_model', 'reason': reason + '不能跳过型号范围查候选部件。', 'tool': 'skipped', 'arguments': {}, 'ruleId': 'model-scope'}
    if len(codes) > 1:
        return {'allowed': False, 'nextAction': 'clarify_code', 'reason': '有多个故障码；请明确当前需要核实的代码，不混合映射。', 'tool': 'skipped', 'arguments': {}, 'ruleId': 'known-code'}
    if codes:
        scoped = [entity for entity in schema['entities'] if entity.get('code') == codes[0] and entity.get('model') == models[0]]
        if len(scoped) != 1:
            return {'allowed': False, 'nextAction': 'manual_review', 'reason': '词典没有当前型号与代码的唯一映射；不猜测候选部件。', 'tool': 'skipped', 'arguments': {}, 'ruleId': 'known-code'}
        return {'allowed': True, 'nextAction': 'professional_review', 'reason': '型号与故障码共同定位到唯一示例实体。', 'tool': 'lookup_fault_knowledge', 'arguments': {'modelId': models[0], 'codeNodeId': scoped[0]['id']}, 'ruleId': 'model-scope'}
    if context['symptomIds']:
        return {'allowed': True, 'nextAction': 'check_external_state', 'reason': '只有现象证据，只查外部状态核实方法，不查询候选部件。', 'tool': 'lookup_symptom_knowledge', 'arguments': {'symptomIds': context['symptomIds']}, 'ruleId': 'symptom-boundary'}
    return {'allowed': False, 'nextAction': 'clarify_context', 'reason': '未命中可识别的症状或故障码；请补充可观察现象。', 'tool': 'skipped', 'arguments': {}, 'ruleId': None}


def lookup_knowledge(documents, query):
    if not query['allowed']:
        raise ValueError('条件门禁未通过，不能执行知识查询')
    if query['tool'] == 'lookup_fault_knowledge':
        arguments = query['arguments']
        return [document for document in documents if document['kind'] == 'fault' and document['nodeId'] == arguments['codeNodeId'] and document['modelId'] == arguments['modelId']]
    if query['tool'] == 'lookup_symptom_knowledge':
        return [document for document in documents if document['kind'] == 'symptom' and document['nodeId'] in query['arguments']['symptomIds']]
    raise ValueError('未注册的本体知识查询工具')


def run_workflow(text, confirmed_model='', proposed_action='review', schema=None):
    schema = SCHEMA if schema is None else schema
    models = {entity['id'] for entity in schema['entities'] if entity['class'] == 'model'}
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise ValueError('请输入 1–500 字的匿名教学问题')
    if not isinstance(confirmed_model, str) or confirmed_model and confirmed_model not in models:
        raise ValueError('补充型号必须来自示例型号列表')
    if proposed_action not in ('review', 'replace'):
        raise ValueError('处理建议只能是复核或换件拦截测试')
    started = time.perf_counter()
    nodes, edges = example_graph(schema)
    indexed = {node['id']: node for node in nodes}
    documents = knowledge_records(schema)
    steps = []

    def record(identifier, title, operation, inputs, status='completed', node_ids=(), edge_ids=()):
        beginning = time.perf_counter()
        output = operation()
        steps.append({'id': identifier, 'title': title, 'status': status, 'durationMs': round((time.perf_counter() - beginning) * 1000, 3), 'input': inputs, 'output': output, 'nodeIds': sorted(set(node_ids)), 'edgeIds': sorted(set(edge_ids))})
        return output

    context = record('normalize', '客户说法 → 规范上下文', lambda: extract_context(text, confirmed_model, schema), {'text': text, 'confirmedModel': confirmed_model or None})
    active = {item['nodeId'] for item in context['mappings']} | set(context['modelIds'])
    alias_edges = [edge for edge in edges if edge['type'] == 'alias_of' and edge['target'] in active and term_mentioned(indexed[edge['source']]['label'], text)]
    active.update(edge['source'] for edge in alias_edges)
    proof_edges = {edge['id'] for edge in alias_edges}
    steps[-1].update(nodeIds=sorted(active), edgeIds=sorted(proof_edges))
    pools = record('compare', '同一知识源的检索对照', lambda: {'literal': candidate_pool(documents, text, context, False), 'normalized': candidate_pool(documents, text, context, True)}, {'source': KNOWLEDGE['version'], 'method': '标准词或代码任一命中；归一组仅增加词典映射，不隐式过滤型号'})
    query = record('gate', '检查查询条件与范围', lambda: choose_query(context, schema), {'models': context['modelIds'], 'unknownModels': context['unknownModels'], 'codes': context['codes'], 'symptoms': context['symptomIds']})
    steps[-1]['status'] = 'completed' if query['allowed'] else 'blocked'
    if query['ruleId']:
        active.add('rule:' + query['ruleId'])
        steps[-1]['nodeIds'] = ['rule:' + query['ruleId']] + context['modelIds']
    if query['nextAction'] == 'clarify_model':
        active.add('ask-model')
        proof_edges.update(edge['id'] for edge in edges if edge['source'] == 'rule:model-scope' and edge['target'] == 'ask-model')
        steps[-1]['nodeIds'].append('ask-model')
        steps[-1]['edgeIds'] = sorted(proof_edges - {edge['id'] for edge in alias_edges})
    retrieved = record('lookup', '读取符合条件的知识', lambda: lookup_knowledge(documents, query) if query['allowed'] else [], {'tool': query['tool'], 'arguments': query['arguments'], 'skipReason': None if query['allowed'] else query['reason']}, 'completed' if query['allowed'] else 'skipped')
    candidates, source_edges = set(), set()
    for document in retrieved:
        active.add(document['nodeId'])
        if document['kind'] == 'fault':
            for edge in edges:
                if edge['source'] == document['nodeId'] and edge['type'] in ('scoped_to', 'candidate_component'):
                    active.add(edge['target'])
                    source_edges.add(edge['id'])
                    if edge['type'] == 'candidate_component':
                        candidates.add(edge['target'])
    steps[-1].update(nodeIds=sorted({document['nodeId'] for document in retrieved} | candidates | (set(context['modelIds']) if retrieved else set())), edgeIds=sorted(source_edges))
    proof_edges.update(source_edges)
    next_action = query['nextAction'] if retrieved or not query['allowed'] else 'manual_review'
    reason = query['reason'] if retrieved or not query['allowed'] else '本体有对应概念，但知识库没有已登记条目；不根据概念自行补写答案。'
    action_blocked = proposed_action == 'replace'
    active.add('rule:candidate-only')
    if next_action in ('professional_review', 'manual_review'):
        active.add('handoff')
    if next_action == 'check_external_state':
        active.add('check-state')
    for edge in edges:
        if edge['source'] in active and edge['target'] in active and edge['type'] in ('governed_by', 'needs_review', 'next_step'):
            proof_edges.add(edge['id'])
    references = [{'id': document['id'], 'version': document['version'], 'nodeId': document['nodeId'], 'title': document['title'], 'content': document['content'], 'source': document['source']} for document in retrieved]
    facts = [{'label': item['canonical'], 'basis': '客户输入词典命中'} for item in context['mappings']]
    facts.extend({'label': code, 'basis': '客户报告的代码，未核验设备读数'} for code in context['codes'])
    facts.extend({'label': model, 'basis': '客户报告的型号，当前词典未覆盖'} for model in context['unknownModels'])
    if confirmed_model:
        facts.append({'label': indexed[confirmed_model]['label'], 'basis': '用户补充型号，未核验设备身份'})
    outcome = record('decision', '形成有边界的处理结果', lambda: {'nextAction': next_action, 'title': ACTION_NAMES[next_action], 'reason': reason, 'actionBlocked': action_blocked, 'actionReason': '直接换件需要真实诊断及授权，本演示禁止执行。' if action_blocked else '仅生成本地建议与交接草稿，不执行业务动作。', 'candidateIds': sorted(candidates), 'candidateNames': [indexed[identifier]['label'] for identifier in sorted(candidates)], 'draft': {'kind': '本地复核草稿，未创建工单', 'facts': facts, 'candidates': [indexed[identifier]['label'] for identifier in sorted(candidates)], 'references': [item['id'] + '@' + item['version'] for item in references], 'nextStep': ACTION_NAMES[next_action], 'unknowns': [reason] if not retrieved else ['尚无专业诊断、维修授权或设备身份核验']}, 'externalActionExecuted': False}, {'proposedAction': proposed_action, 'knowledgeIds': [document['id'] for document in retrieved]}, 'blocked' if action_blocked else 'completed', sorted(active), sorted(proof_edges))
    checks = [
        {'id': 'scope', 'title': '候选有型号与代码依据', 'passed': not candidates or (query['allowed'] and query['tool'] == 'lookup_fault_knowledge' and all(document['modelId'] == context['modelIds'][0] for document in retrieved))},
        {'id': 'gate', 'title': '条件不足未执行查询', 'passed': query['allowed'] or (not retrieved and not candidates and query['tool'] == 'skipped')},
        {'id': 'source', 'title': '引用来自实际读取条目', 'passed': outcome['draft']['references'] == [document['id'] + '@' + document['version'] for document in retrieved]},
        {'id': 'authority', 'title': '未越权执行换件或派单', 'passed': outcome['externalActionExecuted'] is False and (proposed_action != 'replace' or outcome['actionBlocked'])},
    ]
    record('verify', '核对输出与证据', lambda: checks, {'method': '确定性结构约束核对；不是独立质量评分，也不判断维修结论正确性'})
    checks_for_graph = [{'id': query['ruleId'] or 'context', 'status': 'pass' if query['allowed'] else 'blocked', 'title': '知识查询条件', 'reason': reason}, {'id': 'candidate-only', 'status': 'blocked' if action_blocked else 'pass', 'title': '业务动作权限', 'reason': outcome['actionReason']}]
    selected_ids = {document['id'] for document in retrieved}
    exclusions = [{'id': item['id'], 'title': item['title'], 'reason': reason if not query['allowed'] else '当前走故障码查询，只保留相同型号与代码的知识。' if query['tool'] == 'lookup_fault_knowledge' else '当前只有症状证据，不引用故障部件条目。'} for item in pools['normalized'] if item['id'] not in selected_ids]
    return {'protocol': ENGINE_VERSION, 'id': 'ONT-' + uuid.uuid4().hex[:12].upper(), 'createdAt': datetime.now(timezone.utc).isoformat(), 'durationMs': round((time.perf_counter() - started) * 1000, 3), 'input': {'text': text, 'confirmedModel': confirmed_model, 'proposedAction': proposed_action}, 'schemaVersion': schema['version'], 'schemaHash': digest(schema), 'knowledgeVersion': KNOWLEDGE['version'], 'knowledgeHash': digest(KNOWLEDGE), 'context': context, 'comparison': {**pools, 'selected': references, 'excluded': exclusions}, 'query': query, 'outcome': outcome, 'checks': checks, 'steps': steps, 'graph': {'mappings': context['mappings'], 'checks': checks_for_graph, 'activeNodeIds': sorted(active), 'activeEdgeIds': sorted(proof_edges), 'status': 'blocked' if not query['allowed'] or action_blocked else 'checked', 'unknownCodes': sorted(set(context['codes']) - {entity['code'] for entity in schema['entities'] if 'code' in entity}), 'externalCalls': False, 'boundary': BOUNDARY}, 'boundary': BOUNDARY, 'externalCalls': False, 'persisted': False}


def verify_acceptance(schema=None):
    schema = SCHEMA if schema is None else schema
    rows = []
    for case in ACCEPTANCE['cases']:
        inputs = case['input']
        result = run_workflow(inputs['text'], inputs['confirmedModel'], inputs['proposedAction'], schema)
        actual = {'documents': sorted(document['id'] for document in result['comparison']['selected']), 'candidates': result['outcome']['candidateIds'], 'nextAction': result['outcome']['nextAction'], 'actionBlocked': result['outcome']['actionBlocked'], 'tool': result['query']['tool']}
        expected = case['expected']
        checks = [{'id': 'retrieval', 'name': '知识与候选集合', 'passed': actual['documents'] == sorted(expected['documents']) and actual['candidates'] == sorted(expected['candidates'])}, {'id': 'route', 'name': '下一步与查询路径', 'passed': actual['nextAction'] == expected['nextAction'] and actual['tool'] == expected['tool']}, {'id': 'gate', 'name': '换件权限与证据约束', 'passed': actual['actionBlocked'] == expected['actionBlocked'] and all(item['passed'] for item in result['checks'])}]
        rows.append({'id': case['id'], 'name': case['name'], 'input': inputs, 'expected': expected, 'actual': actual, 'checks': checks, 'passed': all(item['passed'] for item in checks), 'literalKnowledgeIds': [document['id'] for document in result['comparison']['literal']]})
    return {'protocol': ENGINE_VERSION, 'createdAt': datetime.now(timezone.utc).isoformat(), 'suiteVersion': ACCEPTANCE['version'], 'suiteHash': digest(ACCEPTANCE), 'schemaHash': digest(schema), 'knowledgeHash': digest(KNOWLEDGE), 'total': len(rows), 'passed': sum(row['passed'] for row in rows), 'rows': rows, 'boundary': ACCEPTANCE['boundary'], 'externalCalls': False, 'persisted': False}
