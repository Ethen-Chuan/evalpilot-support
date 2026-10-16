import json
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['EVAL_DATA_DIR']).resolve()
if DATA == (ROOT / 'data').resolve() or not DATA.name.startswith('text-comparison-browser-'):
    raise RuntimeError('Only an isolated comparison fixture database is permitted')
sys.path.insert(0, str(ROOT / 'backend'))
import server
import support_api
from agent_lab import PROTOCOL, extract_case
from aftersales_provider import ProviderVault, ProviderError
from test_agent_lab import synthetic_session


def fixture_completion(self, revision, role, messages, **options):
    configuration = self.snapshot(revision)
    if configuration['candidateModel'] == 'unavailable-fixture':
        raise ProviderError('隔离测试：连接失败，不调用外网')
    if any('Connection test' in str(message['content']) for message in messages):
        content = {'ok': True} if role == 'judge' else 'OK'
    elif role == 'judge':
        material = json.loads(messages[1]['content'])
        content = {'dimensions': {'relevance': 3, 'next_step': 3, 'boundary': 4}, 'reason': '隔离测试裁判替身，不是供应商实测', 'evidenceIds': [material['candidate']['id']]}
    else:
        material = json.loads(messages[1]['content'])
        if 'historicalReference' in material or 'reference' in material or 'expectedIntent' in material:
            raise ValueError('Reference leaked into candidate input')
        content = {'intent': 'fault_repair', 'action': 'clarify', 'answer': '隔离测试答复，请补充设备现象；未执行实际操作。'}
    return {'content': content if isinstance(content, str) else json.dumps(content, ensure_ascii=False), 'usage': {'total_tokens': 1}, 'durationMs': 1, 'finishReason': 'stop', 'model': configuration['candidateModel']}


def fixture_local(version, prefix):
    return {'intent': 'fault_repair', 'action': 'clarify', 'answer': '隔离本地测试替身答复，不是训练效果。'}, []


server.initialize()
support_api.initialize()
ProviderVault.complete = fixture_completion
support_api.LAB.local_infer = fixture_local
project_id = 'TEXT-BROWSER-PROJECT'
bundle_id = 'TEXT-BROWSER-BUNDLE'
support_api.save('corpus', project_id, {'id': project_id, 'name': '隔离模型选择测试项目', 'nature': '自动化测试构造，不是真实客户资料', 'totals': {'sessions': 6, 'messages': 24}, 'scanStatus': 'passed', 'intentDistribution': {'fault_repair': 6}})
versions = []
for index in range(2):
    version = {'id': f'VER-LOCAL-{index}', 'name': f'隔离本地版本{index + 1}', 'family': '隔离客服系列', 'provider': 'local', 'model': 'isolated-local-fixture', 'kind': 'local', 'bundleId': bundle_id, 'createdAt': support_api.now(), 'protocol': PROTOCOL}
    versions.append(version)
    support_api.save('lab_version', version['id'], version)
support_api.save('lab_bundle', bundle_id, {'id': bundle_id, 'datasetId': project_id, 'createdAt': support_api.now(), 'sourceSessions': 6, 'eligible': 6, 'splits': {'train': 0, 'validation': 0, 'test': 6}, 'excluded': {}, 'groupCount': 6, 'versionIds': [version['id'] for version in versions], 'protocol': PROTOCOL})
for index in range(6):
    source = synthetic_session(f'TEXT-SESSION-{index}', f'TEXT-GROUP-{index}')
    source['datasetId'] = project_id
    support_api.save('imported_dialogue', source['id'], source)
    case, reason = extract_case(source)
    case.update(id=f'TEXT-CASE-{index}', bundleId=bundle_id, split='test', group=f'TEXT-GROUP-{index}')
    support_api.save('lab_case', case['id'], case)
print('Isolated text comparison fixture ready; all model calls are local test doubles', flush=True)
ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler).serve_forever()
