import json
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['EVAL_DATA_DIR']).resolve()
if DATA == (ROOT / 'data').resolve() or not DATA.name.startswith('experience-browser-'):
    raise RuntimeError('Only an isolated test database is permitted')
sys.path.insert(0, str(ROOT / 'backend'))
import server
import support_api
from aftersales_provider import ProviderVault
from experience import DIMENSIONS, RULE_VERSION
from test_conversation_learning import conversation
from conversation_learning import replay_metrics


def fixture_completion(self, revision, role, messages, **options):
    self.snapshot(revision)
    if role != 'judge':
        raise ValueError('Browser test only permits the judge stub')
    material = json.loads(messages[1]['content'])
    if 'originalScore' in material['case'] or 'suggestedScore' in material['case']:
        raise ValueError('Unexpected reference score leakage')
    result = {'verdicts': {item['id']: 'unknown' for item in DIMENSIONS}, 'reason': '隔离测试替身：摘录不足，不给总分。不是实测成绩。', 'evidenceIds': ['machine_excerpt']}
    return {'content': json.dumps(result, ensure_ascii=False), 'usage': {'total_tokens': 1}, 'durationMs': 1, 'model': 'isolated-test-judge'}


server.initialize()
support_api.initialize()
support_api.save('corpus', 'PROJECT-BROWSER', {'id': 'PROJECT-BROWSER', 'name': '隔离浏览器测试项目', 'nature': '自动化测试构造，不是真实客户', 'intentDistribution': {'fault_repair': 50, 'complaint': 50}, 'totals': {'sessions': 100, 'messages': 300, 'gapSessions': 0}, 'scanStatus': 'passed', 'importedAt': support_api.now()})
for index in range(100):
    source = conversation(index, datasetId='PROJECT-BROWSER')
    support_api.save('imported_dialogue', source['id'], source)
if os.environ.get('EVAL_EXPERIMENT_FIXTURES') == '1':
    for index in range(35):
        identifier = f'LEARN-FIXTURE-{index:03}'
        support_api.save('cx_replay', identifier, {'id': identifier, 'projectId': 'PROJECT-BROWSER', 'model': 'isolated-record-fixture', 'status': 'cancelled', 'stage': '隔离构造记录，未运行', 'createdAt': f'2026-01-01T00:00:{index:02}+00:00', 'total': 5, 'completed': 0, 'trainCount': 30, 'trainingPercent': 100, 'sourceHash': 'isolated-record-fixture', 'caseHash': 'isolated-record-fixture', 'protocol': 'isolated-record-fixture', 'results': [], 'models': {}, 'metrics': replay_metrics([], 5)})
support_api.save('qc_rule', RULE_VERSION, {'text': '隔离测试规则文档，不包含真实客户规则原文。'})
for index in range(3):
    identifier = 'QC-BROWSER-' + str(index)
    support_api.save('qc_case', identifier, {'id': identifier, 'projectId': 'PROJECT-BROWSER', 'sourceRow': index + 2, 'channel': '在线', 'machineExcerpt': '隔离测试机审摘录，无完整对话。', 'originalResult': '不合格', 'originalStatus': '已通过', 'originalScore': 80 if index == 0 else None, 'suggestedScore': 85 if index == 1 else None, 'opinion': '隔离测试意见', 'appeal': '隔离测试申诉', 'basis': '仅为规则建议，需补证据', 'warning': '不能作为独立质检金标', 'completeness': '复核摘要，非完整会话', 'revision': 1, 'review': None, 'history': []})
support_api.save('cx_rca', 'RCA-BROWSER', {'id': 'RCA-BROWSER', 'projectId': 'PROJECT-BROWSER', 'title': '隔离测试复核线索', 'sourceType': 'review_signal', 'sourceId': 'QC-BROWSER-0', 'sourceEvidence': '隔离构造线索，非真实DSAT工单', 'traceId': None, 'status': 'triage', 'primary': None, 'contributors': [], 'revision': 1, 'updatedAt': support_api.now(), 'history': []})
ProviderVault.complete = fixture_completion
connection = support_api.LAB.configure({'provider': 'openai', 'name': '隔离测试裁判', 'family': 'isolated-test', 'candidateModel': 'isolated-test-judge', 'judgeModel': 'isolated-test-judge', 'apiKey': 'unit-test-placeholder-only', 'confirmed': True})
support_api.LAB.connections[connection['id']].configuration.update(tested=True)
print('Isolated experience fixture ready', flush=True)
ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler).serve_forever()
