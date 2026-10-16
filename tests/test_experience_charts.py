import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from experience_charts import model_analysis, review_analytics, review_classification

RULE_VERSION = 'isolated-test-rule'


def record(identifier, original='不合格', status='调整为合格', **changes):
    return {'id': identifier, 'originalResult': original, 'originalStatus': status, **changes}


def batch():
    return {'id': 'TEST-RUN', 'caseIds': ['CASE-1', 'CASE-2', 'CASE-3', 'CASE-4'], 'versions': [{'id': 'MODEL-A', 'name': '隔离模型A', 'provider': 'local'}, {'id': 'MODEL-B', 'name': '隔离模型B', 'provider': 'local'}], 'results': []}


def prediction(case_id, version='MODEL-A', actual='complaint', **changes):
    return {'caseId': case_id, 'versionId': version, 'status': 'completed', 'expectedIntent': 'complaint', 'output': {'intent': actual}, **changes}


class ReviewChartTests(unittest.TestCase):
    def test_explicit_changes_do_not_include_contradictory_source(self):
        records = [record(str(index)) for index in range(2)] + [record('down', '合格', '降级为不合格'), record('conflict', '不合格', '降级为不合格'), record('same-1', status='维持原判'), record('same-2', status='维持原判')]
        records += [record('unknown-' + str(index), status='已通过') for index in range(4)]
        result = review_analytics(records, RULE_VERSION)
        self.assertEqual((result['total'], result['changed'], result['maintained'], result['unresolved'], result['conflict']), (10, 3, 2, 4, 1))
        self.assertEqual(result['changedRate'], {'value': 60, 'numerator': 3, 'denominator': 5})
        self.assertEqual(result['coverage'], {'value': 50, 'numerator': 5, 'denominator': 10})
        self.assertEqual(sum(slice['count'] for slice in result['slices']), 10)
        self.assertEqual(result['localCompletion']['value'], 0)

    def test_no_implicit_judgment_from_ambiguous_status_or_score(self):
        for status in ['已通过', '不通过', '部分通过', '', None]:
            self.assertEqual(review_classification(record('test', status=status, originalScore=20, suggestedScore=100), RULE_VERSION), 'unresolved')
        self.assertEqual(review_classification(record('test', original='未知'), RULE_VERSION), 'unresolved')
        self.assertEqual(review_classification(record('test', original='合格'), RULE_VERSION), 'conflict')

    def test_current_human_review_updates_ratios_without_replacing_source(self):
        source = record('test', status='已通过', review={'ruleVersion': RULE_VERSION, 'passed': True})
        original = copy.deepcopy(source)
        result = review_analytics([source], RULE_VERSION)
        self.assertEqual((result['changedRate']['value'], result['localCompletion']['value']), (100, 100))
        self.assertEqual(source, original)
        source['review']['passed'] = False
        self.assertEqual(review_analytics([source], RULE_VERSION)['maintained'], 1)
        source['review']['ruleVersion'] = 'older-rule'
        self.assertEqual(review_analytics([source], RULE_VERSION)['unresolved'], 1)

    def test_unknown_and_empty_denominators_are_null(self):
        for records in [[], [record('test', status='部分通过')]]:
            self.assertIsNone(review_analytics(records, RULE_VERSION)['changedRate']['value'])
        self.assertIsNone(review_analytics([], RULE_VERSION)['coverage']['value'])
        self.assertEqual(review_analytics([record('test', status='部分通过')], RULE_VERSION)['coverage']['value'], 0)


class ModelChartTests(unittest.TestCase):
    def test_every_point_uses_original_case_order_and_all_selected_denominator(self):
        run = batch()
        run['results'] = [prediction('CASE-4'), prediction('CASE-2', actual='fault_repair'), prediction('CASE-1'), prediction('CASE-3', status='failed'), prediction('CASE-1', version='MODEL-B'), prediction('CASE-2', version='MODEL-B'), prediction('CASE-3', version='MODEL-B'), prediction('CASE-4', version='MODEL-B', actual='fault_repair')]
        result = model_analysis(run)
        self.assertEqual([point['seen'] for point in result['cumulative']], [1, 2, 3, 4])
        self.assertEqual([point['models']['MODEL-A']['value'] for point in result['cumulative']], [100, 50, 33.33, 50])
        self.assertEqual([model['accuracy']['value'] for model in result['models']], [50, 75])
        self.assertEqual(result['models'][0]['failed'], 1)
        self.assertEqual(result['models'][0]['completed'], 3)

    def test_recompute_from_expected_and_output_not_cached_match_flag(self):
        run = batch()
        run['results'] = [prediction('CASE-1', actual='fault_repair', intentMatch=True)]
        metric = model_analysis(run)['models'][0]
        self.assertEqual(metric['accuracy'], {'value': 0, 'numerator': 0, 'denominator': 4})
        self.assertEqual(metric['missing'], 3)

    def test_duplicate_and_foreign_results_do_not_inflate_scores(self):
        run = batch()
        run['results'] = [prediction('CASE-1'), prediction('CASE-1'), prediction('CASE-2'), prediction('OTHER-CASE')]
        result = model_analysis(run)
        metric = result['models'][0]
        self.assertEqual((metric['conflict'], metric['missing'], metric['correct']), (1, 2, 1))
        self.assertIsNone(result['cumulative'][0]['models']['MODEL-A']['value'])
        self.assertEqual(metric['accuracy']['value'], 25)

    def test_missing_failed_and_invalid_predictions_do_not_make_fake_zero_curve(self):
        run = batch()
        run['results'] = [prediction('CASE-1', status='failed'), prediction('CASE-2', output=None), prediction('CASE-3', expectedIntent=None)]
        result = model_analysis(run)
        self.assertTrue(all(point['models']['MODEL-A']['value'] is None for point in result['cumulative']))
        self.assertIsNone(result['models'][0]['accuracy']['value'])
        self.assertEqual((result['models'][0]['failed'], result['models'][0]['missing']), (3, 1))
        self.assertIsNone(model_analysis(None))


if __name__ == '__main__':
    unittest.main()
