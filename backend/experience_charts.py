from collections import Counter


def ratio(numerator, denominator):
    return {'value': round(numerator * 100 / denominator, 2) if denominator else None, 'numerator': numerator, 'denominator': denominator}


def review_classification(record, rule_version):
    original = record.get('originalResult')
    review = record.get('review')
    if original not in ('合格', '不合格'):
        return 'unresolved'
    if review and review.get('ruleVersion') == rule_version and type(review.get('passed')) is bool:
        updated = '合格' if review['passed'] else '不合格'
        return 'maintained' if original == updated else 'changed'
    status = record.get('originalStatus')
    if status == '维持原判':
        return 'maintained'
    expected_original = {'调整为合格': '不合格', '降级为不合格': '合格'}.get(status)
    if expected_original:
        return 'changed' if original == expected_original else 'conflict'
    return 'unresolved'


def review_analytics(records, rule_version):
    classifications = {record['id']: review_classification(record, rule_version) for record in records}
    counts = Counter(classifications.values())
    comparable = counts['changed'] + counts['maintained']
    confirmed = sum(bool(record.get('review')) for record in records)
    return {
        'total': len(records), 'changed': counts['changed'], 'maintained': counts['maintained'], 'unresolved': counts['unresolved'], 'conflict': counts['conflict'],
        'changedRate': ratio(counts['changed'], comparable), 'coverage': ratio(comparable, len(records)), 'localCompletion': ratio(confirmed, len(records)),
        'classifications': classifications,
        'slices': [{'id': key, 'name': label, 'count': counts[key], **ratio(counts[key], len(records))} for key, label in [('changed', '明确改判'), ('maintained', '明确维持'), ('unresolved', '状态含义待核实'), ('conflict', '前后标记冲突')]],
        'scope': '以明确原判对照明确复核结果；本平台同规则人工复核优先，其次使用来源明确改判或维持状态。含糊的通过/不通过不推定为最终质检结论。仅为可核对复核样本，不代表全部质检的准确率。',
    }


def model_analysis(run):
    if not run:
        return None
    case_ids = list(dict.fromkeys(run.get('caseIds', [])))
    versions = run.get('versions', [])
    grouped = {}
    for row in run.get('results', []):
        key = (row.get('versionId'), row.get('caseId'))
        grouped.setdefault(key, []).append(row)
    cumulative, models = [], []
    counters = {version['id']: {'correct': 0, 'completed': 0, 'failed': 0, 'missing': 0, 'conflict': 0} for version in versions}
    for index, case_id in enumerate(case_ids, 1):
        point = {'seen': index, 'models': {}}
        for version in versions:
            counter = counters[version['id']]
            rows = grouped.get((version['id'], case_id), [])
            if len(rows) > 1:
                counter['conflict'] += 1
            elif not rows:
                counter['missing'] += 1
            else:
                row = rows[0]
                expected = row.get('expectedIntent')
                actual = (row.get('output') or {}).get('intent')
                if row.get('status') == 'completed' and isinstance(expected, str) and expected and isinstance(actual, str) and actual:
                    counter['completed'] += 1
                    counter['correct'] += expected == actual
                else:
                    counter['failed'] += 1
            point['models'][version['id']] = {**ratio(counter['correct'], index), 'value': round(counter['correct'] * 100 / index, 2) if counter['completed'] else None}
        cumulative.append(point)
    for version in versions:
        counter = counters[version['id']]
        measured = ratio(counter['correct'], len(case_ids))
        if not counter['completed']:
            measured['value'] = None
        models.append({'id': version['id'], 'name': version['name'], 'provider': version.get('provider', ''), **counter, 'accuracy': measured})
    return {'runId': run['id'], 'total': len(case_ids), 'models': models, 'cumulative': cumulative, 'scope': '按原批次固定案例顺序累计，失败、缺失或重复结果不算正确；不是时间趋势，不代表模型越跑越会，也不改变模型。'}
