import collections
import json


FIELDS = {
    'intent': '客户意图', 'emotion': '用户情绪', 'product_line': '产品类别',
    'fault_domain': '故障域', 'type': '工单类型', 'kb_expectation': '知识覆盖',
    'expected_system': '关联系统', 'knowledge_category': '知识分类',
}
SCOPES = {'all': '全部会话', 'regular': '常规会话', 'invalid': '无效会话', 'handoff': '直接转人工', 'unclassified': '范围待确认'}


def label_values(summary, field):
    values = (summary or {}).get('values', {}).get(field, [])
    return {value.strip() for value in values if isinstance(value, str) and value.strip()} if isinstance(values, list) else set()


def session_scope(summary):
    invalid = label_values(summary, 'is_invalid')
    handoff = label_values(summary, 'direct_handoff')
    if invalid.intersection({'是', 'yes'}):
        return 'invalid'
    if handoff.intersection({'是', 'yes'}):
        return 'handoff'
    if invalid.intersection({'否', 'no'}) and handoff.intersection({'否', 'no'}):
        return 'regular'
    return 'unclassified'


def values_expression(field):
    return f"json_each(dialogue_summaries.payload,'$.labelSummary.values.{field}')"


def contains(field, entries):
    literals = ','.join("'" + value + "'" for value in entries)
    return f"EXISTS(SELECT 1 FROM {values_expression(field)} WHERE type='text' AND trim(value) IN ({literals}))"


def scope_sql(scope):
    invalid = contains('is_invalid', ('是', 'yes'))
    handoff = contains('direct_handoff', ('是', 'yes'))
    regular = f"({contains('is_invalid', ('否', 'no'))} AND {contains('direct_handoff', ('否', 'no'))})"
    return {'all': '1=1', 'invalid': invalid, 'handoff': f'NOT {invalid} AND {handoff}', 'regular': f'NOT {invalid} AND NOT {handoff} AND {regular}', 'unclassified': f'NOT {invalid} AND NOT {handoff} AND NOT {regular}'}[scope]


def parse_filters(query):
    scope = query.get('scope', ['all'])[0]
    if scope not in SCOPES:
        raise ValueError('不支持的会话统计范围')
    raw = query.get('labels', ['{}'])[0]
    if not isinstance(raw, str) or len(raw) > 4000:
        raise ValueError('分类筛选格式不正确')
    try:
        labels = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError('分类筛选需要 JSON 对象') from None
    if not isinstance(labels, dict) or len(labels) > len(FIELDS):
        raise ValueError('分类筛选需要已支持的字段')
    for field, value in labels.items():
        if field not in FIELDS or (value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 240)):
            raise ValueError('分类字段或标签不正确；缺失标签请使用 null')
    intent = query.get('intent', [''])[0]
    if intent:
        if not isinstance(intent, str) or len(intent) > 240 or ('intent' in labels and labels['intent'] != intent.strip()):
            raise ValueError('客户意图筛选条件不一致')
        labels['intent'] = intent.strip()
    return scope, {field: value.strip() if value is not None else None for field, value in labels.items()}


def add_conditions(conditions, parameters, scope, labels):
    conditions.append('(' + scope_sql(scope) + ')')
    for field, value in labels.items():
        expression = values_expression(field)
        if value is None:
            conditions.append(f"NOT EXISTS(SELECT 1 FROM {expression} WHERE type='text' AND trim(value)<>'')")
        else:
            conditions.append(f"EXISTS(SELECT 1 FROM {expression} WHERE type='text' AND trim(value)=?)")
            parameters.append(value)


def facets(database, where, parameters, dataset, scope, labels):
    rows = database.execute("SELECT json_extract(payload,'$.labelSummary') FROM dialogue_summaries WHERE " + where, parameters).fetchall()
    summaries = [json.loads(row[0]) if row[0] else {} for row in rows]
    all_rows = database.execute("SELECT json_extract(payload,'$.labelSummary') FROM dialogue_summaries WHERE dataset_id=?", (dataset,)).fetchall()
    scope_counts = collections.Counter(session_scope(json.loads(row[0]) if row[0] else {}) for row in all_rows)
    scope_counts['all'] = len(all_rows)
    dimensions = []
    for field, name in FIELDS.items():
        counts = collections.Counter()
        covered = multi = conflicts = 0
        for summary in summaries:
            values = label_values(summary, field)
            counts.update(values)
            covered += bool(values)
            multi += len(values) > 1
            conflicts += field in (summary.get('conflicts') or [])
        total = len(summaries)
        dimensions.append({'field': field, 'name': name, 'total': total, 'covered': covered, 'missing': total - covered,
                           'coverage': covered / total if total else None, 'multiValueSessions': multi, 'conflictSessions': conflicts,
                           'values': [{'value': value, 'count': count, 'ratio': count / total if total else None} for value, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]})
    return {'total': len(summaries), 'projectTotal': len(all_rows), 'scope': scope, 'filters': labels,
            'scopes': [{'id': identifier, 'name': name, 'count': scope_counts[identifier]} for identifier, name in SCOPES.items()],
            'dimensions': dimensions, 'source': 'imported_human_labels', 'unit': 'unique_conversation',
            'policy': '汇总已导入的有效提交标注；草稿及取消标注不计。每个标签按完整会话去重，缺失不推断，多值与分歧均保留。'}
