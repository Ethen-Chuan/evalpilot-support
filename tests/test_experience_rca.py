import copy
import unittest

from test_experience import ExperienceTests, outcome, support_api


class RcaTests(ExperienceTests):
    def conversation(self, identifier='CHAT-TEST', project='PROJECT-TEST'):
        source = {'id': identifier, 'datasetId': project, 'title': '隔离投诉对话', 'labelSummary': {'values': {'intent': ['complaint', 'fault_repair']}}, 'messages': [{'id': 'MSG-TEST', 'sequence': 1, 'role': 'user', 'content': '测试投诉诉求', 'at': None}, {'id': 'MSG-SERVICE', 'sequence': 2, 'role': 'human', 'content': '测试人工回复', 'at': None}]}
        support_api.save('imported_dialogue', identifier, source)
        return source

    def draft(self):
        self.conversation()
        item = self.service.rca.items('PROJECT-TEST')[0]
        return {'id': item['id'], 'projectId': 'PROJECT-TEST', 'revision': 1, 'status': 'triage', 'evidence': '隔离测试调查草稿'}

    def confirmed(self):
        return {**self.draft(), 'primary': 'human', 'status': 'confirmed', 'checks': {'human': {'verdict': 'supported', 'note': '已核实人工接入、可用规则和操作条件，隔离测试'}} , 'counterfactual': '测试反事实', 'action': '测试动作', 'owner': 'test-team', 'reviewer': 'reviewer-test', 'confirmed': True}

    def test_complaint_multilabel_included_once_without_fake_dsat_or_writes(self):
        self.conversation()
        self.conversation('CHAT-OTHER', 'PROJECT-OTHER')
        items = self.service.rca.items('PROJECT-TEST')
        self.assertEqual(len(items), 1)
        self.assertIsNone(items[0]['primary'])
        self.assertEqual(items[0]['scope'], 'signals')
        self.assertEqual(support_api.records('cx_rca'), [])
        summary = self.service.rca.analytics(items)
        self.assertEqual(summary['signals']['total'], 1)
        self.assertEqual(summary['signals']['confirmationRate']['value'], 0)
        self.assertIsNone(summary['dsat']['confirmationRate']['value'])
        detail = self.service.rca.detail('PROJECT-TEST', items[0]['id'])
        self.assertEqual(len(detail['messages']), 2)
        self.assertEqual(detail['messages'][1]['role'], 'human')
        with self.assertRaises(ValueError):
            self.service.rca.detail('PROJECT-OTHER', items[0]['id'])

    def test_partial_draft_persists_without_inventing_primary_and_deduplicates(self):
        body = self.draft()
        saved = self.service.rca_save(body)
        self.assertIsNone(saved['primary'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(len(self.service.rca.items('PROJECT-TEST')), 1)
        self.assertTrue(support_api.TRACE_STORE.get(saved['reviewTraceId']))
        with self.assertRaises(ValueError):
            self.service.rca_save(body)

    def test_confirmed_signal_not_dsat_and_multiple_factors_not_double_counted(self):
        body = self.confirmed()
        self.service.rca_save(body)
        summary = self.service.rca.analytics(self.service.rca.items('PROJECT-TEST'))
        self.assertEqual(summary['dsat']['confirmed'], 0)
        self.assertEqual(summary['signals']['confirmed'], 1)
        self.assertEqual(sum(item['count'] for item in summary['signals']['causes']), 1)
        self.assertEqual(summary['signals']['verificationRate']['value'], 0)

    def test_confirmation_needs_supported_checks_reviewer_and_consent(self):
        body = self.confirmed()
        for changes in [{'checks': {}}, {'reviewer': ''}, {'confirmed': False}, {'checks': {'human': {'verdict': 'excluded', 'note': '反证'}}}, {'checks': {'human': {'verdict': 'supported', 'note': ''}}}, {'contributors': ['tool']}, {'projectId': 'PROJECT-OTHER'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.service.rca_save({**body, **changes})
        self.assertEqual(support_api.records('cx_rca'), [])

    def test_missing_source_and_sandbox_never_count_as_dsat(self):
        self.ingest([outcome(rating=1)])
        item = support_api.records('cx_rca')[0]
        false_record = copy.deepcopy(item)
        false_record.update(id='RCA-MISSING', sourceId='UNKNOWN')
        support_api.save('cx_rca', false_record['id'], false_record)
        summary = self.service.rca.analytics(self.service.rca.items('PROJECT-TEST'))
        self.assertEqual(summary['dsat']['total'], 1)
        self.assertEqual(summary['signals']['total'], 1)
        self.assertFalse(self.service.rca.detail('PROJECT-TEST', false_record['id'])['record']['sourceAvailable'])


if __name__ == '__main__':
    unittest.main()
