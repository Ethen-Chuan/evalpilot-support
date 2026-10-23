import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['EVAL_DATA_DIR']).resolve()
if DATA == (ROOT / 'data').resolve() or not DATA.name.startswith('dataset-labels-browser-'):
    raise RuntimeError('Only an isolated dataset label fixture database is permitted')
sys.path.insert(0, str(ROOT / 'backend'))
import server
import support_api
from test_dataset_labels import fixture_session

server.initialize()
support_api.initialize()
support_api.save('corpus', 'LABEL-TEST', {'id': 'LABEL-TEST', 'name': '匿名业务项目 · 标签交互测试', 'nature': '隔离测试构造，不是真实客户数据', 'importedAt': support_api.now(), 'scanStatus': 'passed', 'totals': {'sessions': 32, 'messages': 64, 'gapSessions': 4, 'invalidSessions': 2, 'conflictSessions': 1, 'imagesWithheld': 0, 'videosWithheld': 0}, 'intentDistribution': {'complaint': 8, 'fault_repair': 32}})
for index in range(32):
    values = {'intent': ['complaint', 'fault_repair'] if index < 8 else ['fault_repair'], 'is_invalid': ['是' if index >= 30 else '否'], 'direct_handoff': ['是' if index >= 28 else '否'], 'emotion': ['不满（安抚话术）' if index < 8 else '平稳（正常沟通）'], 'product_line': ['类别-ANONYMOUS'], 'fault_domain': ['硬件域' if index % 2 else '软件域'], 'type': ['报修'], 'kb_expectation': ['gap' if index < 4 else 'has_answer'], 'expected_system': [f'类别-SYSTEM{index % 7}']}
    if index < 24:
        values['knowledge_category'] = ['常见故障']
    session = fixture_session(index, values=values, conflicts=['intent'] if index == 0 else [])
    support_api.save('imported_dialogue', session['id'], session)
support_api.DIALOGUES.refresh_index()
print('Isolated dataset label fixture ready; no real customer content', flush=True)
ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler).serve_forever()
