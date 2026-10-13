import json
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['EVAL_DATA_DIR']).resolve()
if DATA == (ROOT / 'data').resolve() or not DATA.name.startswith('multimodal-browser-'):
    raise RuntimeError('Browser fixtures require an isolated temporary database')
sys.path.insert(0, str(ROOT / 'backend'))
import server
import support_api
from aftersales_provider import ProviderVault


def fixture_completion(self, revision, role, messages, **options):
    self.snapshot(revision)
    material = json.loads(messages[1]['content'][0]['text'])
    if role == 'judge':
        content = {'visualCorrect': True, 'answerAcceptable': True, 'resolved': material['candidate']['decision'] == 'answer', 'reason': '隔离自动化测试替身，非供应商实测成绩', 'evidenceIds': ['image', 'question', 'candidate']}
    else:
        handoff = material['question'] != '设备显示如图，请帮我解释并处理这个提醒。'
        content = {'decision': 'handoff' if handoff else 'answer', 'answer': '隔离 UI 测试答复，不是真实模型：' + ('建议联系人工，不执行真实转接。' if handoff else '校验 E04 表示维护提醒。'), 'visualFindings': ['隔离测试：图像已作为真实字节传入适配层']}
    return {'content': json.dumps(content, ensure_ascii=False), 'usage': {'total_tokens': 9}, 'durationMs': 1, 'model': 'isolated-ui-fixture'}


server.initialize()
support_api.initialize()
ProviderVault.complete = fixture_completion
for provider in ('openai', 'anthropic'):
    connection = support_api.LAB.configure({'provider': provider, 'name': '隔离 UI 测试 ' + provider, 'family': provider, 'candidateModel': 'isolated-ui-fixture', 'judgeModel': 'isolated-ui-fixture', 'apiKey': 'unit-test-placeholder-only', 'confirmed': True})
    support_api.LAB.connections[connection['id']].configuration.update(tested=True, visionTested=True)
print('Isolated multimodal browser fixture ready', flush=True)
ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler).serve_forever()
