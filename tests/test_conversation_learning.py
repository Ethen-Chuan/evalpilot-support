import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from agent_lab import features, group_split
from conversation_learning import ConversationLearning, extract_learning_case, replay_metrics
from tracing import TraceStore


def conversation(index=0, **changes):
    positive = index % 2 == 0
    return {'id': f'TEST-DIALOGUE-{index}', 'datasetId': 'TEST-PROJECT', 'title': '隔离测试构造对话', 'provenance': {'participant': f'TEST-USER-{index}'}, 'labelSummary': {'conflicts': [], 'values': {'is_invalid': ['否'], 'direct_handoff': ['是' if positive else '否'], 'intent': ['complaint' if positive else 'fault_repair'], 'product_line': ['匿名类别A' if positive else '匿名类别B'], 'fault_domain': ['不适用' if positive else '硬件域']}}, 'messages': [{'role': 'bot', 'content': '您好'}, {'role': 'user', 'content': ('我要投诉，请转人工处理' if positive else '设备无法开机需要维修') + f'。隔离测试序号{index}'}, {'role': 'human', 'content': '这是后续人工回答，仅能展示，不能输入分类器。'}], **changes}


class Repository:
    def __init__(self, folder):
        self.data = {}
        self.path = folder / 'test.sqlite3'
        self.LOCK = threading.RLock()
        self.TRACE_STORE = TraceStore(folder / 'traces.sqlite3')
        self.TRACE_STORE.initialize()
        with self.connection() as database:
            database.execute('CREATE TABLE documents (kind TEXT, id TEXT, payload TEXT)')

    def connection(self):
        return sqlite3.connect(str(self.path))

    def get(self, kind, identifier):
        return copy.deepcopy(self.data.get((kind, identifier)))

    def records(self, kind):
        return [copy.deepcopy(value) for (category, identifier), value in self.data.items() if category == kind]

    def save(self, kind, identifier, value):
        self.data[(kind, identifier)] = copy.deepcopy(value)
        with self.connection() as database:
            database.execute('DELETE FROM documents WHERE kind=? AND id=?', (kind, identifier))
            database.execute('INSERT INTO documents VALUES (?,?,?)', (kind, identifier, json.dumps(value)))

    def now(self):
        return '2026-10-14T00:00:00+00:00'


class ExtractionTests(unittest.TestCase):
    def test_first_meaningful_question_never_contains_future_reply(self):
        source = conversation()
        source['messages'].insert(1, {'role': 'user', 'content': '您好！'})
        case, reason = extract_learning_case(source)
        self.assertIsNone(reason)
        self.assertEqual(len(case['prefix']), 3)
        self.assertNotIn('后续人工回答', features(case['prefix']))
        self.assertIn('后续人工回答', case['reference'])
        source['messages'][2]['content'] = '原件变化'
        self.assertNotIn('原件变化', features(case['prefix']))

    def test_exclusions_conflicts_and_route_only_positive(self):
        source = conversation()
        source['labelSummary']['values']['is_invalid'] = ['是', '否']
        self.assertEqual(extract_learning_case(source)[1], 'invalid')
        source['labelSummary'] = {'conflicts': ['intent'], 'values': {'intent': ['complaint'], 'direct_handoff': ['是']}}
        case, reason = extract_learning_case(source)
        self.assertEqual(case['labels'], {'direct_handoff': '是'})
        source['labelSummary']['values']['direct_handoff'] = ['是', '否']
        self.assertEqual(extract_learning_case(source)[1], 'no_labels')
        source['labelSummary']['values'] = {'direct_handoff': ['否'], 'intent': ['not-an-intent']}
        self.assertEqual(extract_learning_case(source)[0]['labels'], {'direct_handoff': '否'})

    def test_empty_and_long_inputs_are_not_truncated(self):
        source = conversation(messages=[{'role': 'user', 'content': '你好'}])
        self.assertEqual(extract_learning_case(source)[1], 'no_question')
        source['messages'] = [{'role': 'user', 'content': '测试' * 4001}]
        self.assertEqual(extract_learning_case(source)[1], 'context_limit')

    def test_same_participant_or_duplicate_question_share_group(self):
        cases = [extract_learning_case(conversation(index))[0] for index in range(5)]
        cases[1]['participant'] = cases[0]['participant']
        cases[2]['requestGroup'] = cases[1]['requestGroup']
        split = group_split(cases)
        self.assertEqual(len({case['group'] for case in split[:3]}), 1)
        self.assertEqual(len({case['split'] for case in split[:3]}), 1)
        self.assertEqual(split, group_split(copy.deepcopy(split)))


class ReplayMetricTests(unittest.TestCase):
    def test_one_class_is_not_a_perfect_routing_score(self):
        result = replay_metrics([{'expected': {'direct_handoff': '否'}, 'predicted': {'direct_handoff': '否'}}], 1)
        self.assertIsNone(result['route']['value'])
        self.assertTrue(result['routeSingleClass'])
        self.assertIsNone(result['productionContainment'])

    def test_missing_predictions_count_as_wrong_in_accuracy_and_f1(self):
        rows = [{'expected': {'intent': 'complaint'}, 'predicted': {'intent': 'complaint'}}, {'expected': {'intent': 'complaint'}, 'predicted': {}}]
        result = replay_metrics(rows, 3)
        self.assertEqual(result['form']['value'], 50)
        self.assertEqual(result['fields']['intent']['macroF1'], 66.67)
        self.assertEqual(result['fields']['intent']['unavailable'], 1)
        self.assertEqual((result['completed'], result['selected']), (2, 3))

    def test_positive_recall_distinguishes_wrong_and_missing(self):
        rows = [{'expected': {'direct_handoff': '是'}, 'predicted': {'direct_handoff': '是'}}, {'expected': {'direct_handoff': '是'}, 'predicted': {'direct_handoff': '否'}}, {'expected': {'direct_handoff': '是'}, 'predicted': {}}, {'expected': {'direct_handoff': '否'}, 'predicted': {'direct_handoff': '否'}}]
        result = replay_metrics(rows, 4)
        self.assertEqual(result['route']['value'], 50)
        self.assertEqual(result['mandatoryRecall']['value'], 33.33)
        self.assertEqual((result['missedHandoff'], result['unknownHandoff']), (1, 1))

    def test_unavailable_models_do_not_produce_scores(self):
        result = replay_metrics([{'expected': {'intent': 'complaint', 'direct_handoff': '是'}, 'predicted': {}}], 1)
        self.assertIsNone(result['form']['value'])
        self.assertIsNone(result['fields']['intent']['value'])
        self.assertEqual(result['form']['denominator'], 1)


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Repository(Path(self.temp.name))
        self.service = ConversationLearning(self.repo)
        for identifier in ('TEST-PROJECT', 'OTHER-PROJECT'):
            self.repo.save('corpus', identifier, {'id': identifier, 'files': [], 'totals': {}})
        for index in range(100):
            source = conversation(index)
            self.repo.save('imported_dialogue', source['id'], source)

    def tearDown(self):
        self.temp.cleanup()

    def start(self, **changes):
        with patch('conversation_learning.threading.Thread'):
            return self.service.start({'projectId': 'TEST-PROJECT', 'count': 2, 'confirmed': True, **changes})

    def execute(self, identifier):
        cases, inventory = self.service.cases('TEST-PROJECT')
        self.service.execute(identifier, [case for case in cases if case['split'] == 'train'], [case for case in cases if case['split'] == 'test'][:2])

    def test_training_size_is_real_nested_and_preserves_test_snapshot(self):
        batches = []
        groups = []
        for percentage in (25, 60, 100):
            with patch('conversation_learning.threading.Thread') as worker:
                started = self.service.start({'projectId': 'TEST-PROJECT', 'count': 2, 'confirmed': True, 'trainingPercent': percentage})
                arguments = worker.call_args.kwargs['args']
                groups.append({case['id'] for case in arguments[1]})
                self.service.execute(*arguments)
            batches.append(self.repo.get('cx_replay', started['id']))
        self.assertTrue(groups[0] < groups[1] < groups[2])
        self.assertEqual(len({batch['caseHash'] for batch in batches}), 1)
        self.assertEqual(len({batch['sourceHash'] for batch in batches}), 1)
        self.assertEqual(len({batch['trainingHash'] for batch in batches}), 3)
        history = self.service.overview('TEST-PROJECT', batches[-1]['id'])['history']
        self.assertEqual(len(history), 3)
        self.assertEqual(sorted(row['trainCount'] for row in history), [len(group) for group in groups])
        for percentage in (True, 0, 101, '25'):
            with self.assertRaises(ValueError):
                self.start(trainingPercent=percentage)

    def test_project_scope_and_snapshot_refresh(self):
        cases, inventory = self.service.cases('TEST-PROJECT')
        self.assertEqual(inventory['source'], 100)
        self.assertEqual(self.service.cases('OTHER-PROJECT')[1]['source'], 0)
        self.assertTrue(self.service.examples('TEST-PROJECT', 'complaint')['cases'])
        self.assertEqual(self.service.examples('OTHER-PROJECT', 'complaint')['cases'], [])
        with self.assertRaises(ValueError):
            self.service.examples('TEST-PROJECT', 'unknown-intent')
        self.repo.save('imported_dialogue', 'TEST-DIALOGUE-100', conversation(100))
        self.assertEqual(self.service.cases('TEST-PROJECT', fresh=True)[1]['source'], 101)
        self.assertFalse({case['group'] for case in cases if case['split'] == 'train'} & {case['group'] for case in cases if case['split'] == 'test'})

    def test_consent_count_and_running_guards(self):
        for changes in [{'confirmed': False}, {'count': True}, {'count': 0}, {'count': 501}, {'count': '2'}, {'projectId': 'MISSING'}, {'projectId': 'OTHER-PROJECT'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.start(**changes)
        run = self.start()
        with self.assertRaises(ValueError):
            self.start()
        self.assertIsNone(self.service.overview('OTHER-PROJECT', run['id'])['run'])

    def test_all_eight_cases_remain_browsable_with_five_multi_intent_cases(self):
        self.repo.save('corpus', 'COUNT-PROJECT', {'id': 'COUNT-PROJECT', 'files': [], 'totals': {}})
        for index in range(8):
            source = conversation(index + 100, datasetId='COUNT-PROJECT')
            source['labelSummary']['values']['intent'] = ['complaint'] if index < 3 else ['complaint', 'fault_repair']
            self.repo.save('imported_dialogue', source['id'], source)
        result = self.service.examples('COUNT-PROJECT', 'complaint')
        self.assertEqual((result['total'], result['singleIntent'], result['multipleIntents'], result['eligibleTotal']), (8, 3, 5, 3))
        self.assertEqual(len(result['cases']), 8)
        self.assertEqual(result['excluded'], {'multiple_intents': 5})
        self.assertEqual(sum(case['learningEligible'] for case in result['cases']), 3)
        multi = [case for case in result['cases'] if len(case['intents']) > 1]
        self.assertTrue(all(case['question'] and case['reference'] and case['split'] is None for case in multi))
        training, inventory = self.service.cases('COUNT-PROJECT')
        self.assertEqual(sum('intent' in case['labels'] for case in training), 3)
        self.assertEqual(sum('direct_handoff' in case['labels'] for case in training), 8)
        self.assertEqual(self.service.examples('COUNT-PROJECT', 'fault_repair')['total'], 5)
        self.assertEqual(self.service.examples('TEST-PROJECT', 'complaint')['total'], 50)

    def test_examples_pagination_has_no_three_case_cap_or_duplicates(self):
        pages = [self.service.examples('TEST-PROJECT', 'complaint', page) for page in (1, 2, 3)]
        self.assertEqual([len(result['cases']) for result in pages], [20, 20, 10])
        self.assertTrue(all(result['total'] == 50 and result['pageSize'] == 20 for result in pages))
        self.assertEqual(len({case['id'] for result in pages for case in result['cases']}), 50)
        self.assertEqual(self.service.examples('TEST-PROJECT', 'complaint', 999)['page'], 3)
        for invalid in [True, 0, -1, '1', 1.5, 1000001]:
            with self.subTest(page=invalid), self.assertRaises(ValueError):
                self.service.examples('TEST-PROJECT', 'complaint', invalid)

    def test_invalid_and_no_question_still_browse_with_explicit_reasons(self):
        invalid = conversation(100)
        invalid['labelSummary']['values']['is_invalid'] = ['是']
        no_question = conversation(102, messages=[{'role': 'human', 'content': '隔离测试原始客服消息'}])
        for source in [invalid, no_question]:
            self.repo.save('imported_dialogue', source['id'], source)
        result = self.service.examples('TEST-PROJECT', 'complaint')
        self.assertEqual((result['total'], result['eligibleTotal']), (52, 50))
        self.assertEqual(result['excluded'], {'invalid': 1, 'no_question': 1})
        indexed = {case['id']: case for page in (1, 2, 3) for case in self.service.examples('TEST-PROJECT', 'complaint', page)['cases']}
        self.assertEqual(indexed[invalid['id']]['learningReason'], 'invalid')
        self.assertEqual(indexed[no_question['id']]['question'], '')
        self.assertIsNone(indexed[no_question['id']]['split'])

    def test_actual_fit_predictions_and_trace_have_no_reference_input(self):
        run = self.start()
        with patch('conversation_learning.features', wraps=features) as inputs:
            self.execute(run['id'])
        saved = self.repo.get('cx_replay', run['id'])
        self.assertEqual((saved['status'], saved['completed']), ('completed', 2))
        self.assertTrue(all('后续人工回答' not in features(call.args[0]) for call in inputs.call_args_list))
        self.assertIsNotNone(self.repo.TRACE_STORE.get(saved['traceId']))
        self.assertTrue(all(self.repo.TRACE_STORE.get(row['traceId']) for row in saved['results']))
        self.assertIsNone(saved['metrics']['productionContainment'])

    def test_cancel_before_fit_and_during_fit(self):
        run = self.start()
        self.service.cancel(run['id'])
        with patch('conversation_learning.TfidfVectorizer') as vectorizer:
            self.execute(run['id'])
            vectorizer.assert_not_called()
        second = self.start()
        from conversation_learning import TfidfVectorizer
        original = TfidfVectorizer.fit_transform

        def cancelled_fit(vectorizer, corpus):
            self.service.cancel(second['id'])
            return original(vectorizer, corpus)

        with patch.object(TfidfVectorizer, 'fit_transform', cancelled_fit):
            self.execute(second['id'])
        saved = self.repo.get('cx_replay', second['id'])
        self.assertEqual((saved['status'], saved['completed']), ('cancelled', 0))
        self.assertEqual(self.repo.TRACE_STORE.get(saved['traceId'])['status'], 'cancelled')

    def test_cancel_inflight_retains_completed_evidence_and_status(self):
        run = self.start()

        def cancel_at_result(rows, selected):
            if rows:
                self.service.cancel(run['id'])
            return replay_metrics(rows, selected)

        with patch('conversation_learning.replay_metrics', side_effect=cancel_at_result):
            self.execute(run['id'])
        saved = self.repo.get('cx_replay', run['id'])
        self.assertEqual((saved['status'], saved['completed']), ('cancelled', 1))
        self.assertEqual(saved['stage'], '已停止后续回放')
        self.assertEqual(self.repo.TRACE_STORE.get(saved['traceId'])['status'], 'cancelled')

    def test_failure_and_restart_never_invent_results(self):
        run = self.start()
        with patch('conversation_learning.TfidfVectorizer.fit_transform', side_effect=ValueError('isolated test failure')):
            self.execute(run['id'])
        self.assertEqual(self.repo.get('cx_replay', run['id'])['status'], 'failed')
        self.assertEqual(self.repo.get('cx_replay', run['id'])['results'], [])
        second = self.start()
        self.service.initialize()
        self.assertEqual(self.repo.get('cx_replay', second['id'])['status'], 'interrupted')

    def test_single_class_model_abstains_while_other_fields_run(self):
        run = self.start()
        cases, inventory = self.service.cases('TEST-PROJECT')
        training = [case for case in cases if case['split'] == 'train']
        for case in training:
            case['labels']['direct_handoff'] = '否'
        self.service.execute(run['id'], training, [case for case in cases if case['split'] == 'test'][:2])
        saved = self.repo.get('cx_replay', run['id'])
        self.assertFalse(saved['models']['direct_handoff']['available'])
        self.assertTrue(all('direct_handoff' not in row['predicted'] for row in saved['results']))


if __name__ == '__main__':
    unittest.main()
