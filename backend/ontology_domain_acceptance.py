from ontology import digest
from ontology_domain import align, execute_local, plan_calls, validate_call, validate_output


CASES = [
    {'id': 'alias-control', 'name': '控制板归一为主板', 'message': '我的 A-100 控制板不工作，开机屏幕不亮，能上门修吗？', 'model': 'model-a', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 0, 'mode': 'normal', 'output': True},
    {'id': 'alias-main', 'name': '主控板与同一标准现象', 'message': 'A-100 主控板有问题，屏幕黑屏，需要上门维修。', 'model': 'model-a', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 0, 'mode': 'normal', 'output': True},
    {'id': 'missing-model', 'name': '没有型号不补造', 'message': '主控板不工作，开机屏幕不亮。', 'model': None, 'part': ['mainboard'], 'symptom': ['black'], 'status': 'clarify', 'blocked': 2, 'mode': 'normal', 'output': False},
    {'id': 'weak', 'name': '不亮不能直接确认为黑屏', 'message': 'A-100 不亮了。', 'model': 'model-a', 'part': [], 'symptom': [], 'status': 'clarify', 'blocked': 1, 'mode': 'normal', 'output': False},
    {'id': 'unknown-model', 'name': '未收录型号保留未知', 'message': 'A-999 主板黑屏了。', 'model': None, 'part': ['mainboard'], 'symptom': ['black'], 'status': 'clarify', 'blocked': 2, 'mode': 'normal', 'output': False},
    {'id': 'unrelated', 'name': '黑屏查喇叭在执行前拦截', 'message': 'A-100 主板屏幕黑屏，需要上门修。', 'model': 'model-a', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 1, 'mode': 'unrelated_part', 'output': True},
    {'id': 'unsafe-output', 'name': '维修结论再次校验', 'message': 'A-100 主板屏幕黑屏，需要上门修。', 'model': 'model-a', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 0, 'mode': 'unsafe_output', 'output': False},
    {'id': 'major', 'name': '重大故障升级专业现场复核', 'message': 'A-100 冒烟了。', 'model': 'model-a', 'part': [], 'symptom': ['heat'], 'status': 'aligned', 'blocked': 0, 'mode': 'normal', 'output': True},
    {'id': 'major-remote', 'name': '重大故障仅远程方案被拦截', 'message': 'A-100 冒烟了。', 'model': 'model-a', 'part': [], 'symptom': ['heat'], 'status': 'aligned', 'blocked': 1, 'mode': 'major_remote', 'output': False},
    {'id': 'retired', 'name': '停产机型不查询推荐停产备件', 'message': 'A-090 主板屏幕黑屏，需要上门修。', 'model': 'model-old', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 1, 'mode': 'normal', 'output': True},
    {'id': 'model-scope', 'name': '不同机型不能共用上门条件', 'message': 'A-200 屏幕黑屏，需要上门修。', 'model': 'model-b', 'part': [], 'symptom': ['black'], 'status': 'aligned', 'blocked': 2, 'mode': 'normal', 'output': False},
    {'id': 'multi-turn', 'name': '后续省略对象时复用窗口', 'history': [{'role': 'user', 'content': 'A-100 主控板屏幕黑屏。'}], 'message': '那能上门修吗？', 'model': 'model-a', 'part': ['mainboard'], 'symptom': ['black'], 'status': 'aligned', 'blocked': 0, 'mode': 'normal', 'output': True},
    {'id': 'switch', 'name': '切换设备清除旧实体', 'history': [{'role': 'user', 'content': 'A-100 主板黑屏。'}], 'message': '换一台 A-200。', 'model': 'model-b', 'part': [], 'symptom': [], 'status': 'clarify', 'blocked': 1, 'mode': 'normal', 'output': False},
]


def verify(schema):
    rows = []
    for case in CASES:
        alignment = align(schema, case['message'], case.get('history'))
        calls = plan_calls(schema, alignment, case['mode'])
        executions = []
        for call in calls:
            check = validate_call(schema, alignment, call)
            executions.append({'call': call, 'status': 'succeeded' if check['allowed'] else 'blocked', 'output': execute_local(schema, call) if check['allowed'] else {}})
        proposal = {'partIds': [item['call']['arguments']['partId'] for item in executions if item['status'] == 'succeeded' and item['call']['tool'] == 'query_spare'], 'spareIds': [identifier for item in executions if item['status'] == 'succeeded' for identifier in item['output'].get('spareIds', [])], 'actionIds': [item['output']['actionId'] for item in executions if item['status'] == 'succeeded' and item['output'].get('actionId')], 'confirmedDiagnosis': case['mode'] == 'unsafe_output', 'productionExecuted': False}
        if case['mode'] == 'unsafe_output':
            proposal['partIds'] = ['speaker']
        gate = validate_output(schema, alignment, proposal, executions)
        actual = {'model': alignment['modelId'], 'part': alignment['slots'].get('component', []), 'symptom': alignment['slots'].get('symptom', []), 'status': alignment['status'], 'blocked': sum(item['status'] == 'blocked' for item in executions), 'output': gate['allowed']}
        expected = {key: case[key] for key in actual}
        rows.append({'id': case['id'], 'name': case['name'], 'message': case['message'], 'expected': expected, 'actual': actual, 'passed': actual == expected})
    return {'protocol': 'ontology-domain-acceptance-v1', 'total': len(rows), 'passed': sum(row['passed'] for row in rows), 'rows': rows, 'schemaHash': digest(schema), 'boundary': '固定合成验收，不计入调试业务统计，不代表真实实体准确率或生产幻觉拦截率。95% 与性能指标仍为待测目标。'}
