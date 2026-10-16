import copy
import hashlib
import json
import re
import threading
import uuid
from collections import Counter

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import f1_score
from sklearn.svm import LinearSVC

from agent_lab import INTENTS, features, group_split, normalized
from tracing import Trace, span
from experiment_records import ExperimentRecords

PROTOCOL = 'first-user-turn-fields-v1'
FIELDS = [('direct_handoff', '直接转人工'), ('intent', '客户意图'), ('product_line', '产品类别（匿名）'), ('fault_domain', '故障域')]
FORM_FIELDS = [field for field, name in FIELDS if field != 'direct_handoff']


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def ratio(correct, total):
    return {'value': round(correct * 100 / total, 2) if total else None, 'numerator': correct, 'denominator': total}


def extract_learning_case(session):
    summary = session.get('labelSummary') or {}
    values = summary.get('values', {})
    if any(value in ('是', 'yes') for value in values.get('is_invalid', [])):
        return None, 'invalid'
    labels = {}
    for field, name in FIELDS:
        candidates = values.get(field, [])
        if field not in summary.get('conflicts', []) and len(candidates) == 1 and isinstance(candidates[0], str):
            labels[field] = candidates[0]
    if labels.get('direct_handoff') not in ('是', '否'):
        labels.pop('direct_handoff', None)
    if labels.get('intent') not in INTENTS:
        labels.pop('intent', None)
    if not labels:
        return None, 'no_labels'
    for index, message in enumerate(session['messages']):
        text = normalized(message['content'])
        if message['role'] == 'user' and len(text) >= 2 and not re.fullmatch(r'你好|您好|在吗|哈喽|hello|hi', text, re.I):
            prefix = session['messages'][:index + 1]
            if sum(len(item['content']) for item in prefix) > 8000:
                return None, 'context_limit'
            reference = next((item['content'] for item in session['messages'][index + 1:] if item['role'] == 'human' and len(normalized(item['content'])) >= 8 and not re.search(r'很高兴为您服务|欢迎您进入|请问有什么可以帮助|正在查看您的问题', item['content'])), '')
            return {'id': session['id'], 'sessionId': session['id'], 'title': session['title'], 'participant': session.get('provenance', {}).get('participant') or session['id'], 'requestGroup': text, 'prefix': copy.deepcopy(prefix), 'question': message['content'], 'reference': reference, 'labels': labels, 'sourceHash': fingerprint([prefix, labels])}, None
    return None, 'no_question'


def replay_metrics(rows, selected):
    fields = {}
    for field, name in FIELDS:
        eligible = [row for row in rows if field in row['expected']]
        evaluated = [row for row in eligible if row['predicted'].get(field) is not None]
        correct = sum(row['predicted'].get(field) == row['expected'][field] for row in eligible)
        classes = sorted({row['expected'][field] for row in eligible} | {row['predicted'][field] for row in evaluated})
        fields[field] = {**ratio(correct, len(eligible)), 'name': name, 'predicted': len(evaluated), 'unavailable': len(eligible) - len(evaluated), 'macroF1': round(f1_score([row['expected'][field] for row in eligible], [row['predicted'].get(field) or '__missing__' for row in eligible], labels=classes, average='macro', zero_division=0) * 100, 2) if evaluated else None}
        if not evaluated:
            fields[field]['value'] = None
    mandatory = [row for row in rows if row['expected'].get('direct_handoff') == '是']
    route_labels = {row['expected']['direct_handoff'] for row in rows if 'direct_handoff' in row['expected']}
    route = fields['direct_handoff'].copy()
    if len(route_labels) < 2:
        route['value'] = None
    form_total = sum(fields[field]['denominator'] for field in FORM_FIELDS)
    form_correct = sum(fields[field]['numerator'] for field in FORM_FIELDS)
    form_predicted = sum(fields[field]['predicted'] for field in FORM_FIELDS)
    full_forms = [row for row in rows if all(field in row['expected'] for field in FORM_FIELDS)]
    return {'selected': selected, 'completed': len(rows), 'route': route, 'routeSingleClass': len(route_labels) < 2, 'mandatoryRecall': ratio(sum(row['predicted'].get('direct_handoff') == '是' for row in mandatory), len(mandatory)), 'missedHandoff': sum(row['predicted'].get('direct_handoff') == '否' for row in mandatory), 'unknownHandoff': sum(row['predicted'].get('direct_handoff') is None for row in mandatory), 'form': {**ratio(form_correct, form_total), 'value': round(form_correct * 100 / form_total, 2) if form_total and form_predicted else None}, 'formExact': ratio(sum(all(row['predicted'].get(field) == row['expected'][field] for field in FORM_FIELDS) for row in full_forms), len(full_forms)), 'fields': fields, 'productionContainment': None}


class ConversationLearning:
    def __init__(self, repository):
        self.repo = repository
        self.cache = {}
        self.experiments = ExperimentRecords(repository)

    def initialize(self):
        for run in self.repo.records('cx_replay'):
            if run['status'] == 'running':
                run.update(status='interrupted', error='服务重启中断，已完成结果保留')
                self.repo.save('cx_replay', run['id'], run)

    def cases(self, project_id, fresh=False):
        project = self.repo.get('corpus', project_id)
        if not project:
            raise ValueError('项目不存在')
        stamp = fingerprint([project.get('files'), project.get('importedAt'), project.get('totals')])
        cached = self.cache.get(project_id)
        if cached and cached[0] == stamp and not fresh:
            return cached[1], cached[2]
        with self.repo.connection() as database:
            source = [json.loads(row[0]) for row in database.execute("SELECT payload FROM documents WHERE kind='imported_dialogue' AND json_extract(payload,'$.datasetId')=?", (project_id,))]
        cases, excluded = [], Counter()
        for session in source:
            case, reason = extract_learning_case(session)
            if case:
                cases.append(case)
            else:
                excluded[reason] += 1
        cases = group_split(cases)
        summary = {'source': len(source), 'eligible': len(cases), 'excluded': dict(excluded), 'splits': dict(Counter(case['split'] for case in cases)), 'handoffLabels': dict(Counter(case['labels']['direct_handoff'] for case in cases if 'direct_handoff' in case['labels'])), 'protocol': PROTOCOL}
        self.cache[project_id] = (stamp, cases, summary)
        return cases, summary

    def overview(self, project_id, requested=''):
        if not project_id:
            return {'inventory': {'source': 0, 'eligible': 0, 'splits': {}, 'handoffLabels': {}}, 'run': None, 'recordCount': 0, 'requestedMissing': bool(requested)}
        cases, inventory = self.cases(project_id)
        runs = self.experiments.summaries(project_id)
        selected_summary = next((run for run in runs if run['id'] == requested), None) if requested else next((run for run in runs if not run['metadata']['archived']), None)
        selected = {**self.repo.get('cx_replay', selected_summary['id']), 'metadata': selected_summary['metadata']} if selected_summary else None
        comparable = [run for run in reversed(runs) if selected and run['status'] == 'completed' and all(run.get(key) == selected.get(key) for key in ('sourceHash', 'caseHash', 'protocol'))]
        history = [{'id': run['id'], 'createdAt': run['createdAt'], 'trainCount': run['trainCount'], 'trainingPercent': run.get('trainingPercent', 100), 'metadata': run['metadata'], 'route': run['metrics']['route'], 'form': run['metrics']['form'], 'formExact': run['metrics']['formExact']} for run in comparable]
        return {'inventory': inventory, 'run': selected, 'recordCount': len(runs), 'history': history, 'requestedMissing': bool(requested and not selected)}

    def examples(self, project_id, intent, page=1):
        if intent not in INTENTS:
            raise ValueError('请选择有效意图叶子')
        if type(page) is not int or not 1 <= page <= 1000000:
            raise ValueError('案例页码应为正整数')
        cases, inventory = self.cases(project_id)
        indexed = {case['id']: case for case in cases}
        with self.repo.connection() as database:
            source = [json.loads(row[0]) for row in database.execute("SELECT payload FROM documents WHERE kind='imported_dialogue' AND json_extract(payload,'$.datasetId')=? AND EXISTS(SELECT 1 FROM json_each(payload,'$.labelSummary.values.intent') WHERE value=?) ORDER BY id", (project_id, intent))]
        entries, excluded = [], Counter()
        multiple = 0
        for session in source:
            summary = session.get('labelSummary') or {}
            intents = summary.get('values', {}).get('intent', [])
            case, reason = extract_learning_case(session)
            multiple += len(intents) > 1
            if not reason and len(intents) > 1:
                reason = 'multiple_intents'
            if not reason and (case or {}).get('labels', {}).get('intent') != intent:
                reason = 'intent_conflict'
            if reason:
                excluded[reason] += 1
            entries.append((session, case, reason, intents))
        page_size = 20
        pages = max(1, (len(entries) + page_size - 1) // page_size)
        page = min(page, pages)
        shown = []
        for session, case, reason, intents in entries[(page - 1) * page_size:page * page_size]:
            messages = session.get('messages', [])
            if case:
                question, reference = case['question'], case['reference']
            else:
                first = next((index for index, message in enumerate(messages) if message['role'] == 'user' and message['content'].strip()), None)
                question = messages[first]['content'] if first is not None else ''
                reference = next((message['content'] for message in messages[first + 1:] if message['role'] == 'human' and message['content'].strip()), '') if first is not None else ''
            shown.append({'id': session['id'], 'question': question, 'reference': reference, 'intents': intents, 'labels': (case or {}).get('labels', {}), 'learningEligible': reason is None, 'learningReason': reason, 'split': indexed.get(session['id'], {}).get('split') if reason is None else None})
        return {'total': len(entries), 'singleIntent': len(entries) - multiple, 'multipleIntents': multiple, 'eligibleTotal': len(entries) - sum(excluded.values()), 'excluded': dict(excluded), 'page': page, 'pageSize': page_size, 'cases': shown, 'scope': '浏览全部含该意图的正式对话，多意图及暂不适合单标签学习的记录仍可查看；历史回复不是当前有效政策'}

    def start(self, body):
        project_id = body.get('projectId')
        if not isinstance(project_id, str) or body.get('confirmed') is not True:
            raise ValueError('请确认在本机学习已脱敏对话；不外发数据')
        cases, inventory = self.cases(project_id, fresh=True)
        training = [case for case in cases if case['split'] == 'train']
        training_percent = body.get('trainingPercent', 100)
        if type(training_percent) is not int or training_percent not in (25, 60, 100):
            raise ValueError('训练数据量仅支持25%、60%或100%，不会改变独立测试集')
        training = sorted(training, key=lambda case: fingerprint(['training-subset-v1', case['id']]))
        training = training[:max(10, len(training) * training_percent // 100)]
        testing = sorted([case for case in cases if case['split'] == 'test'], key=lambda case: fingerprint(['selection-42', case['id']]))
        count = body.get('count')
        if type(count) is not int or not 1 <= count <= min(500, len(testing)):
            raise ValueError('请选择1–500条且不超过独立测试集数量')
        if len(training) < 10 or {case['group'] for case in training} & {case['group'] for case in testing}:
            raise ValueError('训练样本不足或出现分组交叉，已停止学习')
        selected = testing[:count]
        with self.repo.LOCK:
            if any(run['status'] == 'running' for run in self.repo.records('cx_replay')):
                raise ValueError('已有本地学习任务正在运行')
            run = {'id': 'LEARN-' + uuid.uuid4().hex[:12].upper(), 'projectId': project_id, 'status': 'running', 'stage': '提取首轮输入与来源标签', 'createdAt': self.repo.now(), 'protocol': PROTOCOL, 'model': '本地字符TF-IDF + 线性分类器 v1', 'sourceHash': fingerprint(sorted((case['id'], case['sourceHash'], case['split']) for case in cases)), 'caseHash': fingerprint(sorted((case['id'], case['sourceHash']) for case in selected)), 'trainCount': len(training), 'total': count, 'completed': 0, 'results': [], 'models': {}, 'metrics': replay_metrics([], count), 'inventory': inventory, 'scope': '仅凭首轮输入预测整段来源分类标签；不是完整工单填单，也不是线上拦截率'}
            run.update(trainingPercent=training_percent, trainingHash=fingerprint(sorted((case['id'], case['sourceHash']) for case in training)))
            self.repo.save('cx_replay', run['id'], run)
            threading.Thread(target=self.execute, args=(run['id'], training, selected), daemon=True).start()
        return {'id': run['id'], 'total': count}

    def execute(self, run_id, training, testing):
        run = self.repo.get('cx_replay', run_id)
        if not run or run['status'] != 'running':
            return
        try:
            with Trace(self.repo.TRACE_STORE, '正式对话本地学习与回放', 'experience.learning', {'training': len(training), 'testing': len(testing), 'protocol': PROTOCOL}, {'sourceHash': run['sourceHash'], 'externalCalls': False, 'learningRunId': run_id}) as trace:
                run['traceId'] = trace.id
                with self.repo.LOCK:
                    if self.repo.get('cx_replay', run_id)['status'] != 'running':
                        trace.root.outcome('cancelled')
                        return
                    self.repo.save('cx_replay', run_id, run)
                with span('仅在训练分组拟合文本特征和分类器', 'model', {'trainingCases': len(training)}) as observation:
                    vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(2, 4), max_features=24000, sublinear_tf=True)
                    matrix = vectorizer.fit_transform([features(case['prefix']) for case in training])
                    models = {}
                    for field, name in FIELDS:
                        indices = [index for index, case in enumerate(training) if field in case['labels']]
                        labels = [training[index]['labels'][field] for index in indices]
                        classes = sorted(set(labels))
                        run['models'][field] = {'name': name, 'training': len(indices), 'classes': classes, 'available': len(classes) >= 2}
                        if len(classes) >= 2:
                            model = LinearSVC(C=1, class_weight='balanced', random_state=42, max_iter=4000)
                            model.fit(matrix[np.array(indices)], labels)
                            models[field] = model
                    observation.output(run['models'])
                if not models:
                    raise ValueError('来源标签不足以训练可区分的分类器')
                with self.repo.LOCK:
                    if self.repo.get('cx_replay', run_id)['status'] != 'running':
                        trace.root.outcome('cancelled')
                        return
                    run.update(stage='逐条独立测试，保留输出证据')
                    self.repo.save('cx_replay', run_id, run)
                for case in testing:
                    if self.repo.get('cx_replay', run_id)['status'] != 'running':
                        trace.root.outcome('cancelled')
                        return
                    with Trace(self.repo.TRACE_STORE, '独立案例填单与转人工判断', 'experience.replay', {'sessionId': case['id'], 'inputHash': fingerprint(case['prefix'])}, {'protocol': PROTOCOL, 'runId': run_id, 'source': '真实对话脱敏副本'}) as case_trace:
                        case_trace.link(sessionId=case['id'])
                        with span('读取截止首轮的上下文，不读取后续回答和标签', 'internal', {'messages': len(case['prefix'])}) as observation:
                            vector = vectorizer.transform([features(case['prefix'])])
                            observation.output({'characters': sum(len(item['content']) for item in case['prefix'])})
                        with span('执行本地分类器', 'model', {'model': run['model']}) as observation:
                            predictions = {field: str(model.predict(vector)[0]) for field, model in models.items()}
                            observation.output(predictions)
                        row = {'id': case['id'], 'question': case['question'], 'expected': case['labels'], 'predicted': predictions, 'traceId': case_trace.id}
                        case_trace.output({'predicted': predictions, 'expected': case['labels'], 'sourceLabelComparisonOnly': True})
                    run['results'].append(row)
                    run['completed'] = len(run['results'])
                    run['metrics'] = replay_metrics(run['results'], run['total'])
                    with self.repo.LOCK:
                        latest = self.repo.get('cx_replay', run_id)
                        if latest['status'] != 'running':
                            run['status'] = latest['status']
                            run['stage'] = latest['stage']
                        self.repo.save('cx_replay', run_id, run)
                with self.repo.LOCK:
                    if self.repo.get('cx_replay', run_id)['status'] == 'running':
                        run.update(status='completed', stage='已完成独立测试', finishedAt=self.repo.now())
                        self.repo.save('cx_replay', run_id, run)
                    else:
                        trace.root.outcome('cancelled')
                trace.output(run['metrics'])
        except Exception:
            with self.repo.LOCK:
                if self.repo.get('cx_replay', run_id)['status'] == 'running':
                    run.update(status='failed', stage='学习或回放未完成', error='本地特征提取或模型执行失败，已完成记录保留，未补造结果')
                    self.repo.save('cx_replay', run_id, run)

    def cancel(self, identifier):
        if not isinstance(identifier, str):
            raise ValueError('批次编号不正确')
        with self.repo.LOCK:
            run = self.repo.get('cx_replay', identifier)
            if not run:
                raise ValueError('学习批次不存在')
            if run['status'] == 'running':
                run.update(status='cancelled', stage='已停止后续回放')
                self.repo.save('cx_replay', identifier, run)
            return {'id': run['id'], 'status': run['status']}
