import json
from pathlib import Path
import re

from ontology import digest, term_mentioned


SEED = json.loads(Path(__file__).with_name('ontology_domain_seed.json').read_text())
PROTOCOL = 'ontology-domain-v1'
WINDOW_TURNS = 6
THRESHOLD = 80
RELATIONS = {
    'possible_cause': ('可能根因', 'symptom', 'cause'),
    'affects': ('影响部件', 'cause', 'component'),
    'has_spare': ('对应备件', 'component', 'spare'),
    'allows_action': ('允许复核方式', 'symptom', 'action'),
    'forbids_action': ('禁止复核方式', 'symptom', 'action'),
    'excludes_part': ('排除部件', 'symptom', 'component'),
    'has_severity': ('风险等级', 'symptom', 'severity'),
    'has_part': ('组成部件', 'model', 'component'),
}
TOOLS = {'query_spare': '备件只读查询', 'precheck_work_order': '工单条件预校验', 'engineer_draft': '工程师复核草稿'}
MODES = {'normal': '正常业务', 'unrelated_part': '注入无关备件查询', 'unsafe_output': '注入违规维修结论', 'major_remote': '注入重大故障仅远程处理', 'unavailable': '模拟本体不可用'}


def text(value, limit=120):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError('文本为空或超过允许长度')
    return value.strip()


def validate_schema(schema):
    if not isinstance(schema, dict) or any(not isinstance(schema.get(key), list) for key in ('classes', 'entities', 'relations', 'rules', 'documents')):
        raise ValueError('本体数据结构不完整')
    if any(len(schema[key]) > limit for key, limit in [('classes', 30), ('entities', 300), ('relations', 1000), ('rules', 100), ('documents', 100)]):
        raise ValueError('超过本机本体容量上限')
    for group in ('classes', 'entities', 'relations', 'rules', 'documents'):
        identifiers = []
        for item in schema[group]:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', item['id']):
                raise ValueError('每个对象需要有效且稳定的编号')
            identifiers.append(item['id'])
        if len(identifiers) != len(set(identifiers)):
            raise ValueError('对象编号重复')
    classes = {item['id'] for item in schema['classes']}
    if not {item['id'] for item in SEED['classes']}.issubset(classes):
        raise ValueError('七类运行时基础概念不能删除，可以添加自定义分类')
    for item in schema['classes']:
        text(item.get('label'), 40)
    if len({item['label'].strip().casefold() for item in schema['classes']}) != len(schema['classes']):
        raise ValueError('分类名称不能重复')
    entities = {item['id']: item for item in schema['entities']}
    models = {item['id'] for item in schema['entities'] if item.get('class') == 'model'}

    def check_scope(item):
        scope = item.get('modelIds')
        if not isinstance(scope, list) or any(not isinstance(identifier, str) for identifier in scope) or len(scope) != len(set(scope)) or any(identifier not in models for identifier in scope):
            raise ValueError('适用机型必须引用存在的设备机型，空列表表示通用')

    names = {}
    for item in schema['entities']:
        if not isinstance(item.get('class'), str) or item['class'] not in classes or type(item.get('enabled')) is not bool:
            raise ValueError('实体分类或启用状态不正确')
        label = text(item.get('label'), 60)
        aliases = item.get('aliases')
        if not isinstance(aliases, list) or len(aliases) > 40:
            raise ValueError('每个实体最多四十条别名')
        words = [label, *(text(alias, 60) for alias in aliases)]
        if item['label'] != label or aliases != words[1:]:
            raise ValueError('标准名称和别名不能带首尾空白')
        for word in words:
            normalized = word.casefold()
            if normalized in names:
                raise ValueError('标准名或别名重复，不能保存有歧义的词典')
            names[normalized] = item['id']
        check_scope(item)
        attributes = item.get('attributes')
        if not isinstance(attributes, dict) or len(attributes) > 12 or any(not isinstance(key, str) or len(key) > 40 or not isinstance(value, (str, bool, int, float)) or len(str(value)) > 500 for key, value in attributes.items()):
            raise ValueError('实体属性仅接受有限的文本、数字或开关')
        for flag in ('discontinued', 'replaceable'):
            if flag in attributes and type(attributes[flag]) is not bool:
                raise ValueError('停产与可更换属性必须为布尔开关')
    relations = set()
    for item in schema['relations']:
        if any(not isinstance(item.get(key), str) for key in ('source', 'target', 'type')):
            raise ValueError('关系类型和端点必须是文本编号')
        check_scope(item)
    for item in schema['relations']:
        source, target = entities.get(item.get('source')), entities.get(item.get('target'))
        template = RELATIONS.get(item.get('type'))
        if not source or not target or not template or (source['class'], target['class']) != template[1:]:
            raise ValueError('关系端点不符合概念类型，或引用了不存在的实体')
        check_scope(item)
        key = (item['source'], item['target'], item['type'], tuple(sorted(item['modelIds'])))
        if key in relations:
            raise ValueError('重复关系不能保存')
        relations.add(key)
        for other in schema['relations']:
            overlap = not item['modelIds'] or not other.get('modelIds') or set(item['modelIds']).intersection(other['modelIds'])
            if overlap and item['source'] == other.get('source') and item['target'] == other.get('target') and {item['type'], other.get('type')} == {'allows_action', 'forbids_action'}:
                raise ValueError('同一机型范围同时允许和禁止同一动作，不能保存')
    for item in schema['rules']:
        text(item.get('label'), 80)
        text(item.get('description'), 500)
        if item.get('template') not in ('major_dispatch', 'discontinued_spare') or type(item.get('enabled')) is not bool:
            raise ValueError('规则必须使用受支持的可执行模板，不执行自由文本代码')
        if item['template'] == 'major_dispatch' and (item.get('entityId') != 'major' or item.get('actionId') != 'onsite' or entities.get('major', {}).get('class') != 'severity' or entities.get('onsite', {}).get('class') != 'action'):
            raise ValueError('核心红线固定为重大故障与现场工程师复核，不能改为普通等级或远程动作')
    for template in ('major_dispatch', 'discontinued_spare'):
        active = [item for item in schema['rules'] if item['template'] == template and item['enabled']]
        if len(active) != 1:
            raise ValueError('每个核心红线模板必须保留且仅有一条启用规则')
    for rule in schema['rules']:
        if rule['enabled'] and rule['template'] == 'major_dispatch':
            if not entities[rule['entityId']]['enabled'] or not entities[rule['actionId']]['enabled']:
                raise ValueError('核心红线引用的等级和动作不可停用')
    for document in schema['documents']:
        check_scope(document)
        text(document.get('title'), 100)
        text(document.get('content'), 1000)
        if not isinstance(document.get('entityIds'), list) or any(not isinstance(identifier, str) or identifier not in entities for identifier in document['entityIds']):
            raise ValueError('知识条目引用了不存在的实体')
        if not isinstance(document.get('harnessKnowledgeIds', []), list) or any(identifier not in ('KB-BLACKSCREEN', 'KB-SAFETY', 'KB-HANDOFF') for identifier in document.get('harnessKnowledgeIds', [])):
            raise ValueError('只能关联已审核的教学客服知识')
    for model in models:
        for symptom in [item['id'] for item in schema['entities'] if item['class'] == 'symptom']:
            denied = {item['target'] for item in schema['relations'] if item['source'] == symptom and item['type'] == 'excludes_part' and scoped(item, model)}
            candidates, unused = candidate_parts(schema, model, [symptom])
            if denied.intersection(candidates):
                raise ValueError('同一机型中部件同时被候选链包含和排除，不能保存')
    return True


def scoped(item, model):
    return not item['modelIds'] or model in item['modelIds']


def enabled_entities(schema):
    return {item['id']: item for item in schema['entities'] if item['enabled']}


def candidate_parts(schema, model, symptoms):
    entities = enabled_entities(schema)
    roots = [edge for edge in schema['relations'] if edge['source'] in symptoms and edge['type'] == 'possible_cause' and edge['source'] in entities and edge['target'] in entities and scoped(edge, model) and scoped(entities[edge['source']], model) and scoped(entities[edge['target']], model)]
    edges = [edge for edge in schema['relations'] if edge['source'] in {root['target'] for root in roots} and edge['type'] == 'affects' and edge['target'] in entities and scoped(edge, model) and scoped(entities[edge['target']], model)]
    return sorted({edge['target'] for edge in edges}), [edge['id'] for edge in roots + edges]


def mentions(schema, content):
    candidates = []
    for entity in schema['entities']:
        for term in [entity['label'], *entity['aliases']]:
            pattern = re.escape(term)
            if re.search(r'[A-Za-z0-9]', term):
                pattern = r'(?<![A-Za-z0-9])' + pattern + r'(?![A-Za-z0-9])'
            for match in re.finditer(pattern, content, re.I):
                prefix = content[max(0, match.start() - 12):match.start()]
                suffix = content[match.end():match.end() + 8]
                negated = bool(re.search(r'(不是|并非|没有|未出现|不报|没有报|不再|现在不|已经不|不)\s*$', prefix) or re.match(r'\s*(已经好了|好了|已恢复|恢复正常|解决了)', suffix))
                candidates.append({'entity': entity, 'term': term, 'start': match.start(), 'end': match.end(), 'negated': negated})
    selected = []
    for candidate in sorted(candidates, key=lambda item: (-(item['end'] - item['start']), item['start'])):
        if not any(candidate['start'] < previous['end'] and previous['start'] < candidate['end'] for previous in selected):
            selected.append(candidate)
    return selected


def align(schema, message, history=None):
    history = history or []
    retained = [item for item in history if item.get('role') == 'user'][-(WINDOW_TURNS - 1):]
    inputs = [item['content'] for item in retained] + [message]
    slots, evidence = {}, {}
    unknown, disabled = [], []
    known_models = {word.upper() for entity in schema['entities'] if entity['class'] == 'model' for word in [entity['label'], *entity['aliases']]}
    for turn_index, content in enumerate(inputs):
        hits = []
        observed = mentions(schema, content)
        for mention in observed:
            entity = mention['entity']
            if mention['negated'] or not entity['enabled']:
                class_id = entity['class']
                if class_id == 'model' and entity['id'] in slots.get('model', []):
                    slots, evidence = {}, {}
                slots[class_id] = [identifier for identifier in slots.get(class_id, []) if identifier != entity['id']]
                evidence[class_id] = [item for item in evidence.get(class_id, []) if item['entityId'] != entity['id']]
        for entity in schema['entities']:
            terms = [item['term'] for item in observed if item['entity']['id'] == entity['id'] and not item['negated']]
            if not terms:
                continue
            if not entity['enabled']:
                if turn_index == len(inputs) - 1:
                    disabled.append(entity['id'])
                continue
            longest = max(terms, key=len)
            hits.append({'entityId': entity['id'], 'classId': entity['class'], 'canonical': entity['label'], 'term': longest, 'score': 100 if longest == entity['label'] else 90, 'sourceTurn': turn_index + 1, 'fromHistory': turn_index < len(inputs) - 1, 'basis': '标准名精确命中' if longest == entity['label'] else '受控别名命中'})
        incoming_models = {item['entityId'] for item in hits if item['classId'] == 'model'}
        unknown_here = [match.group(0).upper() for match in re.finditer(r'(?<![A-Za-z0-9-])[A-Z]{1,3}-\d{2,6}(?![A-Za-z0-9-])', content, re.I) if match.group(0).upper() not in known_models and term_mentioned(match.group(0), content)]
        if unknown_here or (incoming_models and incoming_models != set(slots.get('model', []))) or re.search(r'换一台|另一台|另一辆|换个设备|换一辆|换成|换到|改用|现在是', content):
            slots, evidence = {}, {}
        if incoming_models or unknown_here:
            unknown = unknown_here
        for class_id in {item['classId'] for item in hits}:
            matches = [item for item in hits if item['classId'] == class_id]
            slots[class_id] = [item['entityId'] for item in matches]
            evidence[class_id] = matches
    weak = bool(re.search(r'不亮|不工作|有问题', message)) and not slots.get('symptom')
    unknown = sorted(set(unknown))
    entities = enabled_entities(schema)
    model_ids = slots.get('model', [])
    model = model_ids[0] if len(model_ids) == 1 and not unknown else None
    conflicts = [class_id for class_id in ('model', 'symptom', 'component', 'severity') if len(slots.get(class_id, [])) > 1]
    if model:
        for class_id in ('component', 'spare', 'symptom', 'cause', 'action', 'severity'):
            if any(not scoped(entities[identifier], model) for identifier in slots.get(class_id, [])):
                conflicts.append(class_id + '_model_scope')
    inferred = [edge for edge in schema['relations'] if edge['type'] == 'has_severity' and edge['source'] in slots.get('symptom', []) and edge['target'] in entities and scoped(edge, model)]
    if inferred:
        slots['severity'] = sorted(set(slots.get('severity', [])) | {edge['target'] for edge in inferred})
        if len(slots['severity']) > 1 and 'severity' not in conflicts:
            conflicts.append('severity')
    issues = []
    if not model:
        issues.append('请补充一个已收录的当前设备型号，不从其他描述猜测型号。')
    if not slots.get('symptom'):
        issues.append('请具体说明可观察现象，例如是否为屏幕黑屏；“不亮”不直接等同于黑屏。')
    if unknown or disabled:
        issues.append('存在未收录或停用的实体，交由专家核对，不强制匹配。')
    if conflicts:
        issues.append('实体或机型适用范围冲突，请澄清当前对象。')
    score = min([item['score'] for items in evidence.values() for item in items] or [0])
    if weak:
        score = 45
    if issues:
        score = min(score, 45)
    return {'modelId': model, 'slots': slots, 'mappings': [item for items in evidence.values() for item in items], 'score': score, 'threshold': THRESHOLD, 'scoreMeaning': '规则匹配分，不是校准后的正确概率', 'status': 'clarify' if issues or score < THRESHOLD else 'aligned', 'issues': issues, 'unknownModels': unknown, 'disabledEntityIds': disabled, 'conflicts': conflicts, 'inferredSeverityEdges': [edge['id'] for edge in inferred], 'window': {'retainedUserTurns': len(inputs), 'droppedUserTurns': max(0, len([item for item in history if item.get('role') == 'user']) + 1 - WINDOW_TURNS), 'limit': WINDOW_TURNS}, 'schemaHash': digest(schema)}


def applicable_relations(schema, alignment):
    entities = enabled_entities(schema)
    model = alignment['modelId']
    return [edge for edge in schema['relations'] if edge['source'] in entities and edge['target'] in entities and scoped(edge, model) and scoped(entities[edge['source']], model) and scoped(entities[edge['target']], model)]


def required_action(schema, alignment):
    for rule in schema['rules']:
        if rule['enabled'] and rule['template'] == 'major_dispatch' and rule['entityId'] in alignment['slots'].get('severity', []):
            return rule['actionId'], rule['id']
    return None, None


def validate_call(schema, alignment, call):
    reasons, proof = [], []
    entities = enabled_entities(schema)
    if call.get('tool') not in TOOLS:
        reasons.append('unknown_tool')
    arguments = call.get('arguments')
    if not isinstance(arguments, dict) or set(arguments) != {'modelId', 'symptomId', 'partId', 'actionId'} or any(value is not None and not isinstance(value, str) for value in arguments.values()):
        return {'allowed': False, 'reasons': ['invalid_arguments'], 'edgeIds': []}
    if alignment['status'] != 'aligned':
        reasons.append('clarification_required')
    for key, class_id in [('modelId', 'model'), ('symptomId', 'symptom'), ('partId', 'component'), ('actionId', 'action')]:
        identifier = arguments.get(key)
        if identifier is not None and (identifier not in entities or entities[identifier]['class'] != class_id):
            reasons.append('unknown_or_disabled_' + key)
    if arguments.get('modelId') != alignment['modelId'] or not arguments.get('modelId'):
        reasons.append('model_scope')
    if arguments.get('symptomId') not in alignment['slots'].get('symptom', []):
        reasons.append('symptom_scope')
    if reasons:
        return {'allowed': False, 'reasons': sorted(set(reasons)), 'edgeIds': proof}
    model, symptom, part, action = (arguments[key] for key in ('modelId', 'symptomId', 'partId', 'actionId'))
    edges = applicable_relations(schema, alignment)
    mandatory, rule_id = required_action(schema, alignment)
    if mandatory and (call['tool'] != 'engineer_draft' or action != mandatory):
        reasons.append('major_requires_engineer')
        proof.append(rule_id)
    if call['tool'] == 'query_spare':
        if action is not None or part is None:
            reasons.append('invalid_tool_parameters')
        candidates, candidate_edges = candidate_parts(schema, model, [symptom])
        proof.extend(candidate_edges)
        excluded = [edge for edge in edges if edge['type'] == 'excludes_part' and edge['source'] == symptom and edge['target'] == part]
        if excluded or part not in candidates:
            reasons.append('unrelated_part')
            proof.extend(edge['id'] for edge in excluded)
        spares = [edge for edge in edges if edge['source'] == part and edge['type'] == 'has_spare' and scoped(entities[edge['target']], model)]
        if not spares:
            reasons.append('no_applicable_spare')
        if spares and all(entities[edge['target']]['attributes'].get('discontinued') for edge in spares):
            reasons.append('discontinued_spare')
        proof.extend(edge['id'] for edge in spares)
    else:
        if part is not None:
            reasons.append('invalid_tool_parameters')
        matches = [edge for edge in edges if edge['source'] == symptom and edge['target'] == action and edge['type'] in ('allows_action', 'forbids_action')]
        proof.extend(edge['id'] for edge in matches)
        if not action or not any(edge['type'] == 'allows_action' for edge in matches) or any(edge['type'] == 'forbids_action' for edge in matches):
            reasons.append('action_not_allowed')
        if call['tool'] == 'engineer_draft' and action != 'onsite':
            reasons.append('engineer_action_mismatch')
    return {'allowed': not reasons, 'reasons': sorted(set(reasons)), 'edgeIds': sorted(set(proof))}


def plan_calls(schema, alignment, mode='normal'):
    model = alignment['modelId']
    symptom = next(iter(alignment['slots'].get('symptom', [])), None)
    candidates, unused = candidate_parts(schema, model, [symptom])
    part = next(iter(alignment['slots'].get('component', []) or candidates), None)
    action, unused = required_action(schema, alignment)
    if action:
        planned = [{'tool': 'engineer_draft', 'arguments': {'modelId': model, 'symptomId': symptom, 'partId': None, 'actionId': action}}]
    else:
        actions = alignment['slots'].get('action', [])
        options = [edge['target'] for edge in applicable_relations(schema, alignment) if edge['type'] == 'allows_action' and edge['source'] == symptom]
        action = next(iter(actions or options), None)
        planned = [{'tool': 'precheck_work_order', 'arguments': {'modelId': model, 'symptomId': symptom, 'partId': None, 'actionId': action}}]
        if part:
            planned.insert(0, {'tool': 'query_spare', 'arguments': {'modelId': model, 'symptomId': symptom, 'partId': part, 'actionId': None}})
    if mode == 'unrelated_part':
        planned.append({'tool': 'query_spare', 'arguments': {'modelId': model, 'symptomId': symptom, 'partId': 'speaker', 'actionId': None}})
    if mode == 'major_remote':
        planned = [{'tool': 'precheck_work_order', 'arguments': {'modelId': model, 'symptomId': symptom, 'partId': None, 'actionId': 'remote'}}]
    return [{**call, 'id': 'call-' + str(index + 1)} for index, call in enumerate(planned)]


def execute_local(schema, call):
    entities = enabled_entities(schema)
    arguments = call['arguments']
    if call['tool'] == 'query_spare':
        spares = [entities[edge['target']] for edge in schema['relations'] if edge['type'] == 'has_spare' and edge['source'] == arguments['partId'] and edge['target'] in entities and scoped(edge, arguments['modelId']) and scoped(entities[edge['target']], arguments['modelId']) and not entities[edge['target']]['attributes'].get('discontinued')]
        return {'kind': 'sandbox_spare_catalog', 'spareIds': [item['id'] for item in spares], 'codes': [item['attributes'].get('code', item['id']) for item in spares], 'replacementExecuted': False}
    return {'kind': 'engineer_review_draft' if call['tool'] == 'engineer_draft' else 'work_order_precheck', 'modelId': arguments['modelId'], 'symptomId': arguments['symptomId'], 'actionId': arguments['actionId'], 'productionCreated': False, 'status': '本地复核材料，尚未派单或预约'}


def validate_output(schema, alignment, proposal, executions):
    reasons = []
    if proposal.get('confirmedDiagnosis') or proposal.get('productionExecuted'):
        reasons.append('unverified_business_claim')
    if alignment['status'] != 'aligned':
        reasons.append('clarification_required')
    successful = [item for item in executions if item['status'] == 'succeeded']
    if not successful:
        reasons.append('no_verified_tool_output')
    allowed_spares = {identifier for item in successful for identifier in item['output'].get('spareIds', [])}
    allowed_actions = {item['output']['actionId'] for item in successful if item['output'].get('actionId')}
    allowed_parts = {item['call']['arguments']['partId'] for item in successful if item['call']['tool'] == 'query_spare'}
    if not set(proposal.get('spareIds', [])).issubset(allowed_spares) or not set(proposal.get('partIds', [])).issubset(allowed_parts):
        reasons.append('unsupported_part_or_spare')
    if not set(proposal.get('actionIds', [])).issubset(allowed_actions):
        reasons.append('unsupported_action')
    action, rule_id = required_action(schema, alignment)
    if action and (action not in proposal.get('actionIds', []) or not any(item['call']['tool'] == 'engineer_draft' for item in successful)):
        reasons.append('major_requires_engineer')
    return {'allowed': not reasons, 'reasons': reasons, 'ruleId': rule_id, 'method': '仅发布经本体与实际工具证据验证的结构化结果，拒绝自由维修结论'}


def runtime_contract(schema, message, history):
    alignment = align(schema, message, history)
    matched = [item for item in schema['documents'] if alignment['status'] == 'aligned' and scoped(item, alignment['modelId']) and set(item['entityIds']).intersection(alignment['slots'].get('symptom', []))]
    knowledge_ids = sorted({identifier for item in matched for identifier in item.get('harnessKnowledgeIds', [])})
    return {'protocol': PROTOCOL, 'schemaHash': digest(schema), 'alignment': alignment, 'allowedHarnessTools': ['read_case_memory', 'search_knowledge', 'read_policy', 'create_handoff_draft'] + (['lookup_service'] if alignment['status'] == 'aligned' else []), 'requiredAction': 'handoff' if required_action(schema, alignment)[0] else None, 'knowledgeIds': knowledge_ids, 'documentIds': [item['id'] for item in matched], 'canonicalQuery': ' '.join(item['canonical'] for item in alignment['mappings']), 'boundary': SEED['boundary']}


def validate_harness_output(contract, proposal, events):
    reasons = []
    succeeded = [event for event in events if event.get('type') == 'tool' and event.get('status') == 'succeeded']
    if any(event['name'] not in contract['allowedHarnessTools'] for event in succeeded):
        reasons.append('本体工具白名单不允许已执行的操作')
    if contract['requiredAction'] == 'handoff' and (proposal.get('action') != 'handoff' or not any(event['name'] == 'create_handoff_draft' for event in succeeded)):
        reasons.append('本体重大故障必须升级，并有实际交接草稿证据')
    if contract['alignment']['status'] != 'aligned' and proposal.get('action') != 'handoff':
        reasons.append('本体信息未对齐，不发布维修或业务结论，先澄清当前对象')
    if contract['alignment']['status'] == 'unavailable':
        reasons.append('本体不可用，停止发布业务结论')
    return {'allowed': not reasons, 'reasons': reasons, 'schemaHash': contract['schemaHash'], 'method': '本体工具白名单与动作校验 + 既有审核片段门禁；不接受自由维修文本'}


def graph_payload(schema):
    nodes = [{'id': item['id'], 'label': item['label'], 'classId': item['class'], 'kind': 'entity', 'provenance': 'example', 'description': item['attributes'].get('description', ''), 'aliases': item['aliases'], 'enabled': item['enabled'], 'modelIds': item['modelIds']} for item in schema['entities']]
    nodes.extend({'id': 'class:' + item['id'], 'label': item['label'], 'classId': item['id'], 'kind': 'class', 'provenance': 'schema', 'description': '概念分类，不表示故障因果关系'} for item in schema['classes'])
    edges = [{'id': item['id'], 'source': item['source'], 'target': item['target'], 'type': item['type'], 'modelIds': item['modelIds'], 'label': RELATIONS[item['type']][0] + (' · ' + '/'.join(next(entity['label'] for entity in schema['entities'] if entity['id'] == model) for model in item['modelIds']) if item['modelIds'] else ' · 通用'), 'provenance': 'example'} for item in schema['relations']]
    for entity in schema['entities']:
        edges.append({'id': entity['id'] + ':class', 'source': entity['id'], 'target': 'class:' + entity['class'], 'type': 'instance_of', 'label': '属于概念', 'provenance': 'schema'})
        for model in entity['modelIds']:
            edges.append({'id': entity['id'] + ':scope:' + model, 'source': model, 'target': entity['id'], 'type': 'entity_scope', 'label': '适用机型', 'modelIds': [model], 'provenance': 'schema'})
        for alias in entity['aliases']:
            identifier = 'alias:' + digest([entity['id'], alias])[:16]
            nodes.append({'id': identifier, 'label': alias, 'classId': entity['class'], 'kind': 'alias', 'provenance': 'example', 'description': '规范叫法 → ' + entity['label'], 'modelIds': entity['modelIds'] if entity['class'] != 'model' else [entity['id']], 'enabled': entity['enabled']})
            edges.append({'id': identifier + ':edge', 'source': identifier, 'target': entity['id'], 'type': 'alias_of', 'label': '规范叫法', 'provenance': 'example'})
    for rule in schema['rules']:
        identifier = 'rule:' + rule['id']
        nodes.append({'id': identifier, 'label': rule['label'], 'classId': 'severity' if rule['template'] == 'major_dispatch' else 'spare', 'kind': 'rule', 'provenance': 'schema', 'description': rule['description'], 'enabled': rule['enabled'], 'ruleId': rule['id']})
        properties = {'provenance': 'schema', 'enabled': rule['enabled'], 'ruleId': rule['id']}
        if rule['template'] == 'major_dispatch':
            edges.append({'id': rule['id'] + ':trigger', 'source': rule['entityId'], 'target': identifier, 'type': 'triggers_rule', 'label': '命中等级后触发规则', **properties})
            edges.append({'id': rule['id'], 'source': identifier, 'target': rule['actionId'], 'type': 'requires_action', 'label': '必须升级现场复核', **properties})
        elif rule['template'] == 'discontinued_spare':
            edges.append({'id': rule['id'], 'source': identifier, 'target': 'class:spare', 'type': 'validates_spare', 'label': '查询前检查停产与可更换属性', **properties})
    return {'nodes': nodes, 'edges': edges}
