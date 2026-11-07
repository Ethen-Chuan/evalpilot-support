import copy
import datetime
import hashlib
import json
from pathlib import Path
import re


BASE_DOCUMENTS = json.loads(Path(__file__).with_name('simulator_knowledge.json').read_text())


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def reference(document):
    return document['id'] + '@' + document['version']


def available(document, today):
    return document.get('status') == 'approved' and document['effectiveFrom'] <= today and (not document.get('expiresAt') or today < document['expiresAt'])


def search(documents, query, today):
    text = query.casefold()
    matches = []
    for document in documents:
        if document['id'] == 'KB-BOUNDARY' or not available(document, today):
            continue
        terms = [term for term in document['aliases'] if term.casefold() in text]
        if terms:
            matches.append({'id': document['id'], 'reference': reference(document), 'title': document['title'], 'score': len(terms) * 10 + document['priority'], 'matchedTerms': terms, 'source': document['source']})
    return sorted(matches, key=lambda item: (-item['score'], item['id']))[:3]


def context_for(scenario, message, history):
    prior = ' '.join(item['content'] for item in history if item.get('role') == 'user')
    current = message.casefold()
    facts = scenario.get('facts', {})
    risk = bool(facts.get('risk')) or bool(re.search(r'焦味|冒烟|发烫|特别烫|螺丝刀|拆开|拆机|继续开机', current))
    escalation = bool(re.search(r'人工|真人|不想再排查|不要让我重复', current)) or bool(facts.get('preference'))
    tried_cable = bool(re.search(r'换了线|换线.*(无效|还是|没用)', message + ' ' + prior))
    return {'risk': risk, 'handoff': risk or escalation or tried_cable, 'inputKnown': bool(re.search(r'菜单可以|菜单能|hdmi', (message + ' ' + prior).casefold())), 'alreadyTried': bool(facts.get('attempted')), 'deviceSwitched': bool(facts.get('previousDevice')), 'device': facts.get('device', '当前设备')}


def eligible_codes(document, context):
    if document['id'] == 'KB-BOUNDARY':
        return ['boundary']
    if context['risk']:
        return ['safety_stop'] if document['id'] == 'KB-SAFETY' else ['handoff'] if document['id'] == 'KB-HANDOFF' else []
    if context['handoff']:
        return ['handoff'] if document['id'] == 'KB-HANDOFF' else ['black_escalate'] if document['id'] == 'KB-BLACKSCREEN' else []
    if document['id'] == 'KB-SAFETY':
        return []
    if document['id'] == 'KB-HANDOFF':
        return ['handoff']
    if document['id'] == 'KB-BLACKSCREEN':
        return ['black_input' if context['inputKnown'] else 'black_clarify']
    return [response['code'] for response in document['responses']]


def retrieval_query(message, history, context, documents=None, today=None):
    previous = next((item['content'] for item in reversed(history) if item.get('role') == 'user'), '')
    suffix = ' 焦味 专业售后' if context['risk'] else ' 人工' if context['handoff'] else ''
    current = message + suffix
    if documents is not None and search(documents, current, today):
        return current[:1800]
    inherit = bool(re.search(r'还是|仍然|继续|刚才|之前|说明.*依据|重复|整理', message))
    return (current + (' ' + previous if inherit else ''))[:1800]


def prepare_catalog(documents, context):
    return [{**copy.deepcopy(document), 'eligibleCodes': eligible_codes(document, context)} for document in documents]


def inspect_proposal(proposal, events, documents, context, today, source_query=None):
    completed = [event for event in events if event.get('type') == 'tool' and event.get('status', 'succeeded') == 'succeeded']
    names = [event['name'] for event in completed]
    reasons = []
    required = ['read_case_memory', 'search_knowledge', 'read_policy']
    ordered = all(name in names for name in required) and [names.index(name) for name in required] == sorted(names.index(name) for name in required)
    if not ordered:
        reasons.append('缺少按顺序执行的记忆、知识检索和政策读取证据')
    found = set()
    for event in completed:
        if event['name'] == 'search_knowledge':
            results = search(documents, event.get('input', {}).get('query', ''), today)
            found.update(item['id'] for item in results)
    read_ids = set()
    for event in completed:
        if event['name'] == 'read_policy':
            read_ids.update(event.get('input', {}).get('ids', []))
    schema = isinstance(proposal, dict) and set(proposal) == {'action', 'intent', 'responseCodes', 'evidenceIds'}
    codes = proposal.get('responseCodes', []) if schema else []
    citations = proposal.get('evidenceIds', []) if schema else []
    structured = schema and isinstance(codes, list) and 1 <= len(codes) <= 3 and all(isinstance(code, str) for code in codes) and len(codes) == len(set(codes)) and isinstance(citations, list) and all(isinstance(item, str) for item in citations)
    if not structured:
        reasons.append('自由文本或不完整提案不能作为受控业务回复')
        codes, citations = [], []
    indexed = {response['code']: (document, response) for document in documents for response in document['responses']}
    selected = [indexed[code] for code in codes if code in indexed]
    if len(selected) != len(codes) or not selected:
        reasons.append('没有可验证的已审核回复片段')
    expected_refs = {reference(document) for document, _response in selected}
    if set(citations) != expected_refs or len(citations) != len(set(citations)):
        reasons.append('引用必须逐一对应所选回复片段，不能补造或遗漏')
    if 'boundary' not in codes:
        reasons.append('缺少沙箱权限边界说明')
    domain = [(document, response) for document, response in selected if document['id'] != 'KB-BOUNDARY']
    if not domain:
        reasons.append('没有找到适用于当前问题的业务知识')
    applicable = {document['id'] for document, _response in domain}
    ambiguous = False
    if source_query is not None:
        matches = search(documents, source_query, today)
        applicable = {item['id'] for item in matches}
        if any(document['id'] not in applicable for document, _response in domain):
            reasons.append('检索结果与当前问题的受控主题匹配不足，不能用无关政策作答')
        if not context['handoff'] and len(matches) > 1 and matches[0]['score'] == matches[1]['score']:
            ambiguous = True
            reasons.append('多个业务主题匹配相近，须先澄清，不能擅自套用政策')
    if any(not available(document, today) or document['id'] not in read_ids or (document['id'] != 'KB-BOUNDARY' and document['id'] not in found) for document, _response in selected):
        reasons.append('引用知识未检索读取、未审核、尚未生效或已过期')
    if any(response['code'] not in eligible_codes(document, context) for document, response in selected):
        reasons.append('回复片段不满足当前对象、已尝试步骤或风险状态的前置条件')
    if any(response['action'] not in ('any', proposal.get('action')) for _document, response in selected):
        reasons.append('业务动作与所选政策片段不一致')
    if context['handoff'] and proposal.get('action') != 'handoff':
        reasons.append('当前风险或人工诉求必须升级处理')
    if context['risk'] and 'safety_stop' not in codes:
        reasons.append('安全风险必须先停止使用，不能进入常规排查')
    if proposal.get('action') == 'handoff' and 'create_handoff_draft' not in names:
        reasons.append('升级处理缺少本地交接草稿')
    if any(document['id'] in ('KB-REFUND', 'KB-WARRANTY') for document, _response in selected) and 'lookup_service' not in names:
        reasons.append('涉及服务状态但缺少沙箱查询证据')
    answer = ''.join(response['text'] for _document, response in selected)
    evidence = [{'code': response['code'], 'reference': reference(document), 'source': document['source'], 'text': response['text']} for document, response in selected]
    if context['alreadyTried'] and not context['handoff'] and domain:
        statement = '已记录你已经尝试过的步骤，不再要求重复无效重启。'
        answer = statement + answer
        evidence.insert(0, {'code': 'memory_attempted', 'reference': 'case-memory@current-turn', 'source': '本轮记忆工具的已尝试事实 · 应用固定提示', 'text': statement})
    if context['deviceSwitched']:
        statement = '本轮只处理当前设备，已隔离上一台设备的信息。'
        answer = statement + answer
        evidence.insert(0, {'code': 'memory_device', 'reference': 'case-memory@current-turn', 'source': '本轮记忆工具的对象事实 · 应用固定提示', 'text': statement})
    proofs = {
        'structured': bool(structured),
        'knownBlocks': bool(domain) and len(selected) == len(codes),
        'knownReferences': set(citations).issubset({reference(document) for document in documents}),
        'referencesMatch': set(citations) == expected_refs and len(citations) == len(set(citations)),
        'retrieved': bool(domain) and all(document['id'] in found for document, _response in domain),
        'read': bool(domain) and all(document['id'] in read_ids for document, _response in selected),
        'available': bool(domain) and all(available(document, today) for document, _response in selected),
        'applicable': bool(domain) and not ambiguous and all(document['id'] in applicable for document, _response in domain),
        'eligible': bool(domain) and all(response['code'] in eligible_codes(document, context) for document, response in selected),
        'memory': 'read_case_memory' in names,
        'ordered': ordered,
        'queryComplete': not any(document['id'] in ('KB-REFUND', 'KB-WARRANTY') for document, _response in selected) or 'lookup_service' in names,
        'handoffComplete': proposal.get('action') != 'handoff' or 'create_handoff_draft' in names,
        'actionMatches': bool(domain) and all(response['action'] in ('any', proposal.get('action')) for _document, response in selected),
        'escalationMatches': not context['handoff'] or proposal.get('action') == 'handoff',
        'riskStopped': not context['risk'] or 'safety_stop' in codes,
        'boundaryPresent': 'boundary' in codes,
    }
    return {'allowed': not reasons, 'reasons': list(dict.fromkeys(reasons)), 'answer': answer, 'evidence': evidence, 'ordered': ordered, 'readIds': sorted(read_ids), 'foundIds': sorted(found), 'proofs': proofs}


def safe_fallback(context):
    if context['risk']:
        return {'answer': '当前情况涉及安全风险，请停止使用，不要拆机或接触内部元件，并通过官方售后入口联系专业人员。本轮提案未通过验证，没有接通真人或执行维修。', 'action': 'handoff', 'intent': 'fault_repair'}
    return {'answer': '本轮依据不足或提案未通过验证，我不能确认业务结果。请补充当前设备和问题现象，或通过官方售后入口继续核实。这里是本地沙箱，没有执行真实业务操作。', 'action': 'clarify', 'intent': 'unclear'}


class KnowledgeReleases:
    def __init__(self, repository):
        self.repo = repository

    def today(self):
        return datetime.datetime.now(datetime.timezone.utc).date().isoformat()

    def base(self):
        return {'id': 'KNOWLEDGE-BASE-1', 'documents': copy.deepcopy(BASE_DOCUMENTS), 'hash': digest(BASE_DOCUMENTS), 'createdAt': '2026-01-01T00:00:00Z', 'source': '本机内置审核示例', 'previousId': None}

    def get(self, identifier):
        release = self.base() if identifier == self.base()['id'] else self.repo.get('sim_knowledge_release', identifier)
        if not release or digest(release['documents']) != release['hash']:
            raise ValueError('知识版本缺失或完整性验证失败')
        return release

    def active(self):
        pointer = self.repo.get('sim_knowledge_pointer', 'active')
        return self.get(pointer['releaseId']) if pointer else self.base()

    def state(self):
        active = self.active()
        releases = [self.base(), *self.repo.records('sim_knowledge_release')]
        return {'activeId': active['id'], 'activeHash': active['hash'], 'documents': active['documents'], 'releases': [{key: item.get(key) for key in ('id', 'createdAt', 'source', 'previousId')} for item in releases], 'scope': '经验发布仅增加已审核主题的检索别名；不自动修改政策、业务权限或模型参数。'}
