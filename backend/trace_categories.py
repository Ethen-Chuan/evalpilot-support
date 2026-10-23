SOURCES = {
    'modelops.replay': ('modelops', 'ModelOps 本机规则回放'),
    'modelops.management': ('modelops', 'ModelOps 管理操作'),
    'experience.learning': ('training', '对话字段模型训练'),
    'aftersales.train': ('training', '客服行为模型训练'),
    'experience.replay': ('text_eval', '填单与转人工评测'),
    'aftersales.replay': ('text_eval', '客服行为回合评测'),
    'support.evaluation': ('text_eval', '公开文本评测'),
    'support.uat': ('text_eval', '中文业务回归'),
    'aftersales.vision': ('vision_eval', '图文客服评测'),
    'quality.review': ('quality', '人工质检复核保存'),
    'quality.judge': ('quality', '模型质检裁判'),
    'experience.rca.review': ('rca', 'DSAT归因保存'),
    'support.chat': ('chat', '客服会话'),
    'aftersales.chat': ('chat', '客服模型试聊'),
}
CATEGORIES = {'training': '模型训练', 'text_eval': '文本评测', 'vision_eval': '图文评测', 'chat': '客服对话', 'quality': '质检复核', 'rca': 'DSAT归因', 'modelops': '模型运营沙盒', 'external': '外部Agent', 'other': '其他执行'}


def describe(trace):
    source = trace.get('source', '')
    category, source_name = SOURCES.get(source, ('other', '其他执行'))
    if trace.get('origin') != 'local_instrumented':
        category, source_name = 'external', '外部Agent上报'
    attributes = trace.get('attributes') or {}
    batch = trace.get('runId') or attributes.get('runId') or attributes.get('learningRunId')
    if category == 'external':
        duration_scope = '上报方声明的起止耗时，非本机独立计时。'
    elif category == 'modelops':
        duration_scope = '本机沙盒操作与埋点实际耗时；规则回放不是云端大模型延迟，管理操作不是车辆部署耗时。'
    elif source in ('quality.review', 'experience.rca.review'):
        duration_scope = '本次提交的归因/复核记录与Trace处理耗时，不是人工阅读、思考或处理工单的时长。'
    elif category == 'training':
        duration_scope = '本次训练任务埋点范围的总耗时；包括其中已记录的子步骤，不是单次模型响应时间。'
    else:
        duration_scope = '本次执行从根步骤开始到结束的实际墙钟时间，含范围内模型、工具和等待；不是原始客服会话时长。'
    return {'category': category, 'categoryName': CATEGORIES[category], 'sourceName': source_name, 'batchId': batch, 'durationScope': duration_scope}


def listing(summaries, query):
    import json
    import math
    search = query.get('q', [''])[0].casefold()[:150]
    category = query.get('category', ['all'])[0]
    status = query.get('status', ['all'])[0]
    source = query.get('source', ['all'])[0]
    minimum = float(query.get('minMs', ['0'])[0])
    if category not in {'all', *CATEGORIES} or not math.isfinite(minimum) or minimum < 0:
        raise ValueError('分类或耗时范围不正确')
    page = max(1, int(query.get('page', ['1'])[0]))
    matched = [item for item in summaries if (not search or search in json.dumps({key: item.get(key) for key in ('id', 'name', 'preview', 'sessionId', 'runId', 'batchId', 'conversationId', 'categoryName', 'sourceName')}, ensure_ascii=False).casefold()) and (status == 'all' or (status == 'quality' and item['hasQualityIssue']) or item['status'] == status) and (source == 'all' or item['source'] == source) and (minimum == 0 or (item['durationMs'] is not None and item['durationMs'] >= minimum))]
    categories = [{'id': key, 'name': name, 'count': sum(item['category'] == key for item in matched)} for key, name in CATEGORIES.items()]
    filtered = sorted([item for item in matched if category == 'all' or item['category'] == category], key=lambda item: item['startedAt'], reverse=True)
    page = min(page, max(1, math.ceil(len(filtered) / 20)))
    return {'traces': filtered[(page - 1) * 20:page * 20], 'total': len(filtered), 'page': page, 'pageSize': 20, 'matchedTotal': len(matched), 'categories': categories, 'sources': sorted({item['source'] for item in summaries}), 'stats': {'total': len(filtered), 'errors': sum(item['status'] in ('error', 'interrupted') for item in filtered), 'blocked': sum(item['status'] == 'blocked' for item in filtered), 'quality': sum(item['hasQualityIssue'] for item in filtered)}}
