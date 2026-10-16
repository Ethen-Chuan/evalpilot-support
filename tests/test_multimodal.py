import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import support_api
from agent_lab import AgentLab
from aftersales_provider import ProviderVault, ProviderError
from multimodal_lab import aggregate, effective, validate_output, validate_review
from tracing import TraceStore
from vision_media import calibration_png, image_url, local_image_check, normalize_image
from public_vision import exact_public_review, reviewed_examples


def review(**changes):
    return {'visualCorrect': True, 'answerAcceptable': True, 'resolved': True, 'reason': '测试专用复核依据', 'evidenceIds': ['image', 'policy', 'candidate'], **changes}


def result(case_id='ONE', decision='answer', expected='self_service', judgment=True):
    value = {'caseId': case_id, 'status': 'completed', 'output': {'decision': decision, 'answer': '测试专用答复', 'visualFindings': ['E04']}, 'expectedRoute': expected, 'latencyMs': 1}
    if judgment:
        value['judgment'] = review()
    return value


class ContainmentTests(unittest.TestCase):
    def test_failure_unknown_and_clarification_never_raise_containment(self):
        cases = [{'id': key, 'expectedRoute': route} for key, route in [('ONE', 'self_service'), ('TWO', 'self_service'), ('THREE', 'must_handoff'), ('FOUR', 'unknown'), ('FIVE', 'self_service')]]
        rows = [result(), {'caseId': 'TWO', 'status': 'failed'}, result('THREE', 'clarify', 'must_handoff'), result('FOUR', 'answer', 'unknown'), result('FIVE', 'clarify')]
        metrics = aggregate(rows, cases)
        self.assertEqual(metrics['effectiveContainment'], {'value': 20.0, 'numerator': 1, 'denominator': 5})
        self.assertEqual(metrics['unsafeInterception']['value'], 100)
        self.assertEqual(metrics['handoffRecall']['value'], 0)
        self.assertEqual(metrics['nonHandoff']['value'], 100)
        self.assertEqual(metrics['failed'], 1)
        self.assertIsNone(metrics['liveContainment'])

    def test_no_reviews_means_unmeasured_not_fake_zero(self):
        metrics = aggregate([result(judgment=False)], [{'id': 'ONE', 'expectedRoute': 'self_service'}])
        self.assertIsNone(metrics['effectiveContainment']['value'])
        self.assertIsNone(metrics['visualAccuracy']['value'])
        self.assertEqual(metrics['reviewCoverage']['value'], 0)

    def test_unfinished_mandatory_is_disclosed(self):
        metrics = aggregate([], [{'id': 'ONE', 'expectedRoute': 'must_handoff'}])
        self.assertEqual(metrics['mandatoryUnfinished'], 1)
        self.assertEqual(metrics['pending'], 1)
        self.assertEqual(metrics['handoffRecall']['value'], 0)

    def test_human_override_and_unknown_review(self):
        row = result()
        self.assertTrue(effective(row))
        row['humanReview'] = review(visualCorrect=False)
        self.assertFalse(effective(row))
        metrics = aggregate([row], [{'id': 'ONE', 'expectedRoute': 'self_service'}])
        self.assertEqual(metrics['humanReviews'], 1)
        self.assertEqual(metrics['judgeReviews'], 0)
        row['humanReview'] = review(resolved=None)
        self.assertFalse(effective(row))

    def test_strict_schema_rejects_invented_evidence_and_numeric_booleans(self):
        for changes in [{'resolved': 1}, {'evidenceIds': ['fake']}, {'reason': ''}]:
            with self.assertRaises(ValueError):
                validate_review(review(**changes))
        for value in [{'decision': 'refund', 'answer': 'no', 'visualFindings': []}, {'decision': 'answer', 'answer': '', 'visualFindings': []}, {'decision': 'answer', 'answer': 'ok', 'visualFindings': [3]}]:
            with self.assertRaises(ValueError):
                validate_output(value)


class ImageTests(unittest.TestCase):
    def test_program_rendering_checks_exact_bytes_and_text_without_faking_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = MagicMock()
            repository.DATA = Path(directory)
            passed = MagicMock(returncode=0, stdout='最高风险 S0', stderr='')
            with patch('vision_media.subprocess.run', return_value=passed):
                report = local_image_check(calibration_png('ABCD'), repository, generated_text='ABCD')
                self.assertEqual(report['automaticTextScan'], 'generated_text_scanned')
                self.assertIsNone(report['ocrCharacters'])
                repository.local_scan.assert_called_with(['LOCAL TEST / NOT CUSTOMER DATA', 'ABCD'])
                with self.assertRaises(ValueError):
                    local_image_check(calibration_png('E04'), repository, generated_text='E09')
                with self.assertRaises(ValueError):
                    local_image_check(reviewed_examples()[0][1], repository, generated_text='ABCD')
            repository.local_scan.side_effect = ValueError('test privacy rejection')
            with self.assertRaises(ValueError):
                local_image_check(calibration_png('ABCD'), repository, generated_text='ABCD')

    def test_public_manual_review_is_exact_and_still_requires_dlp(self):
        content = reviewed_examples()[0][1]
        self.assertIsNotNone(exact_public_review(content))
        self.assertIsNone(exact_public_review(content + b'changed'))
        self.assertIsNone(exact_public_review(calibration_png()))
        with tempfile.TemporaryDirectory() as directory:
            repository = MagicMock()
            repository.DATA = Path(directory)
            passed = MagicMock(returncode=0, stdout='最高风险 S2\n- [S2] image.png｜需要人工复核的视觉内容', stderr='')
            with patch('vision_media.subprocess.run', return_value=passed) as scanner:
                report = local_image_check(content, repository)
                self.assertEqual(report['automaticTextScan'], 'not_run_fixed_public_review')
                self.assertIsNone(report['ocrCharacters'])
                self.assertEqual(report['publicReview']['method'], 'pinned-public-manual-review')
                self.assertEqual(scanner.call_count, 1)
            blocked = MagicMock(returncode=0, stdout='最高风险 S3\n- [S3] 敏感内容', stderr='')
            with patch('vision_media.subprocess.run', return_value=blocked), self.assertRaises(ValueError):
                local_image_check(content, repository)

    def test_normalization_preserves_pixels_and_removes_metadata(self):
        image = Image.new('RGB', (64, 64), '#ffffff')
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text('test_private_field', 'test-only')
        buffer = io.BytesIO()
        image.save(buffer, format='PNG', pnginfo=metadata)
        content, width, height = normalize_image(image_url(buffer.getvalue()))
        normalized = Image.open(io.BytesIO(content))
        self.assertEqual((width, height), (64, 64))
        self.assertEqual(normalized.info, {})
        self.assertEqual(normalized.tobytes(), image.tobytes())

    def test_external_unsupported_corrupt_too_small_or_large_rejected(self):
        for value in ['https://example.invalid/customer.png', 'data:image/svg+xml;base64,AA==', 'data:image/png;base64,invalid', image_url(b'not an image'), 'x' * 5_700_001]:
            with self.assertRaises(ValueError):
                normalize_image(value)
        buffer = io.BytesIO()
        Image.new('RGB', (10, 10)).save(buffer, 'PNG')
        with self.assertRaises(ValueError):
            normalize_image(image_url(buffer.getvalue()))

    def test_scan_failure_closed_and_visual_review_required(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = MagicMock()
            repository.DATA = Path(directory)
            ocr = MagicMock(returncode=0, stdout=json.dumps({'text': 'E04'}).encode())
            dlp = MagicMock(returncode=0, stdout='最高风险 S2\n- [S2] image.png｜需要人工复核的视觉内容', stderr='')
            with patch('vision_media.subprocess.run', side_effect=[MagicMock(returncode=0), ocr, dlp]):
                self.assertTrue(local_image_check(calibration_png(), repository)['visualReviewRequired'])
            for report in ['最高风险 S4\n- [S4] 无法可靠扫描', '最高风险 S2\n- [S2] 姓名', 'malformed']:
                with patch('vision_media.subprocess.run', side_effect=[MagicMock(returncode=0), ocr, MagicMock(returncode=0, stdout=report, stderr='')]), self.assertRaises(ValueError):
                    local_image_check(calibration_png(), repository)
            repository.local_scan.side_effect = ValueError('synthetic privacy block')
            with patch('vision_media.subprocess.run', side_effect=[MagicMock(returncode=0), ocr]), self.assertRaises(ValueError):
                local_image_check(calibration_png(), repository)


class MultimodalServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        self.patchers = [patch.object(support_api, 'DATA', folder), patch.object(support_api, 'DATABASE', folder / 'support.sqlite3'), patch.object(support_api, 'MODELS', folder / 'models'), patch.object(support_api, 'TRACE_STORE', TraceStore(folder / 'traces.sqlite3')), patch.object(support_api, 'local_scan', return_value='test stub'), patch('multimodal_lab.local_image_check', return_value={'visualReviewRequired': True})]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.lab = AgentLab(support_api)
        self.mm = self.lab.multimodal
        self.mm.calibration({'confirmed': True})
        self.ids = ['MMCAL-1', 'MMCAL-2', 'MMCAL-3', 'MMCAL-4']
        self.connections = []
        for provider in ('openai', 'anthropic'):
            value = self.lab.configure({'provider': provider, 'name': provider, 'family': provider, 'apiKey': 'unit-test-placeholder-only', 'candidateModel': 'test-model', 'judgeModel': 'test-judge', 'confirmed': True})
            self.lab.connections[value['id']].configuration.update(visionTested=True, tested=True)
            self.connections.append(value['id'])
        self.versions = support_api.records('lab_version')

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def start(self, **changes):
        with patch('multimodal_lab.threading.Thread'):
            return self.mm.start({'caseIds': self.ids, 'versionIds': [version['id'] for version in self.versions], 'consent': True, **changes})

    def finish(self, run_id):
        run = support_api.get('mm_run', run_id)
        rows = []
        for case in run['cases']:
            for version in run['versions']:
                rows.append({**result(case['id'], 'handoff' if case['expectedRoute'] == 'must_handoff' else 'answer', case['expectedRoute']), 'versionId': version['id']})
        run.update(status='completed', results=rows, completed=len(rows))
        support_api.save('mm_run', run_id, run)
        return run

    def test_calibration_idempotent_and_hashes_match(self):
        self.mm.calibration({'confirmed': True})
        self.assertEqual(len(support_api.records('mm_case')), 4)
        for case in support_api.records('mm_case'):
            asset = support_api.get('mm_asset', case['assetId'])
            self.assertEqual(case['assetHash'], asset['sha256'])
        self.assertNotIn('dataUrl', json.dumps(self.mm.state()))

    def test_public_photos_are_opt_in_idempotent_attributed_and_not_real_cases(self):
        with self.assertRaises(ValueError):
            self.mm.public_examples({})
        with patch.object(ProviderVault, 'complete') as complete:
            first = self.mm.public_examples({'confirmed': True})
            second = self.mm.public_examples({'confirmed': True})
            complete.assert_not_called()
        self.assertEqual(first, second)
        cases = [case for case in self.mm.state()['cases'] if case['suite'] == 'public']
        self.assertEqual(len(cases), 24)
        self.assertEqual(len({case['assetHash'] for case in cases}), 24)
        self.assertEqual(len({case['topic'] for case in cases}), 6)
        self.assertEqual(self.mm.state()['inventory']['real'], 0)
        for case in cases:
            self.assertTrue(case['imageAvailable'])
            self.assertEqual(case['provenance']['license'], 'CC BY 4.0')
            self.assertIn('非真实客户', case['origin'])
            with Image.open(io.BytesIO(self.mm.image(case['assetId']))) as image:
                self.assertEqual(image.info, {})
                self.assertGreater(image.width, 200)

    def test_public_import_scan_failure_is_atomic(self):
        before_cases = copy.deepcopy(support_api.records('mm_case'))
        before_assets = copy.deepcopy(support_api.records('mm_asset'))
        with patch('multimodal_lab.local_image_check', side_effect=[{'visualReviewRequired': True}, ValueError('test privacy rejection')]):
            with self.assertRaises(ValueError):
                self.mm.public_examples({'confirmed': True})
        self.assertEqual(before_cases, support_api.records('mm_case'))
        self.assertEqual(before_assets, support_api.records('mm_asset'))

    def test_public_cases_cannot_mix_with_customer_or_calibration(self):
        public = self.mm.public_examples({'confirmed': True})
        with self.assertRaises(ValueError):
            self.start(caseIds=[public['caseIds'][0], self.ids[0]])

    def test_inventory_and_binary_image_do_not_hide_missing_assets(self):
        source = support_api.get('mm_case', self.ids[0])
        image = self.mm.image(source['assetId'])
        self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
        with patch.object(support_api, 'LAB', self.lab):
            payload, content_type, filename = support_api.dispatch_get('/api/support/lab/multimodal/images/' + source['assetId'], {})
        self.assertEqual((payload, content_type, filename), (image, 'image/png', None))
        support_api.save('corpus', 'INVENTORY-TEST', {'id': 'INVENTORY-TEST', 'totals': {'imagesWithheld': 9}})
        with support_api.connection() as database:
            database.execute('DELETE FROM documents WHERE kind=? AND id=?', ('mm_asset', source['assetId']))
        state = self.mm.state()
        self.assertEqual(state['inventory']['withheldImageMessages'], 9)
        self.assertEqual(state['inventory']['calibration'], 3)
        self.assertEqual(state['inventory']['missingImages'], 1)
        self.assertFalse(next(case for case in state['cases'] if case['id'] == source['id'])['imageAvailable'])
        with self.assertRaises(ValueError):
            self.mm.image(source['assetId'])

    def test_binary_image_rejects_tampered_bytes(self):
        source = support_api.get('mm_case', self.ids[0])
        asset = support_api.get('mm_asset', source['assetId'])
        asset['dataUrl'] = image_url(calibration_png('tampered'))
        support_api.save('mm_asset', asset['id'], asset)
        with self.assertRaises(ValueError):
            self.mm.image(asset['id'])

    def test_consent_vision_test_and_same_model_gate(self):
        with self.assertRaises(ValueError):
            self.start(consent=False)
        self.lab.connections[self.connections[0]].configuration['visionTested'] = False
        with self.assertRaises(ValueError):
            self.start()
        self.lab.connections[self.connections[0]].configuration['visionTested'] = True
        version = self.versions[1]
        version['provider'] = self.versions[0]['provider']
        support_api.save('lab_version', version['id'], version)
        with self.assertRaises(ValueError):
            self.start()

    def test_asset_and_annotation_consent_required(self):
        with self.assertRaises(ValueError):
            self.mm.asset({'dataUrl': image_url(calibration_png())})
        with self.assertRaises(ValueError):
            self.mm.add_case({})
        with self.assertRaises(ValueError):
            self.lab.post('/api/support/lab/connections/test-vision', {'id': self.connections[0]})

    def test_image_probe_also_requires_local_privacy_scan(self):
        with patch('agent_lab.local_image_check', side_effect=ValueError('synthetic scan block')), patch.object(ProviderVault, 'complete') as complete:
            with self.assertRaises(ValueError):
                self.lab.post('/api/support/lab/connections/test-vision', {'id': self.connections[0], 'confirmed': True})
            complete.assert_not_called()

    def test_snapshot_and_mixed_suites_rejected(self):
        case = support_api.get('mm_case', self.ids[0])
        case.update(id='REAL-ONE', suite='real')
        support_api.save('mm_case', case['id'], case)
        with self.assertRaises(ValueError):
            self.start(caseIds=[self.ids[0], case['id']])
        run = self.start()
        case = support_api.get('mm_case', self.ids[0])
        case['question'] = 'changed after freeze'
        support_api.save('mm_case', case['id'], case)
        self.assertNotEqual(support_api.get('mm_run', run['id'])['cases'][0]['question'], case['question'])

    def test_candidate_has_actual_image_no_labels_judge_blinded(self):
        summary = self.start(judgeId=self.connections[0])
        run = support_api.get('mm_run', summary['id'])
        candidate = {'content': json.dumps(result()['output']), 'usage': {'total_tokens': 9}, 'model': 'test-model', 'durationMs': 1}
        judge = {'content': json.dumps(review()), 'usage': {'total_tokens': 4}, 'model': 'test-judge', 'durationMs': 1}
        with patch.object(ProviderVault, 'complete', side_effect=[candidate, judge]) as complete:
            row = self.mm.evaluate(run, run['cases'][0], run['versions'][0])
        self.assertEqual(row['status'], 'completed')
        candidate_messages = complete.call_args_list[0].args[2]
        material = json.loads(candidate_messages[1]['content'][0]['text'])
        self.assertEqual(set(material), {'question', 'policy'})
        image = candidate_messages[1]['content'][1]['image_url']['url']
        self.assertEqual(image, support_api.get('mm_asset', run['cases'][0]['assetId'])['dataUrl'])
        judge_material = json.loads(complete.call_args_list[1].args[2][1]['content'][0]['text'])
        self.assertIn('reference', judge_material)
        self.assertNotIn('model', judge_material)
        self.assertNotIn('provider', judge_material)
        trace = support_api.TRACE_STORE.get(row['traceId'])
        self.assertIsNotNone(trace)
        self.assertNotIn('base64', json.dumps(trace))
        self.assertNotIn('unit-test-placeholder-only', json.dumps(trace))

    def test_judge_failure_does_not_become_success(self):
        summary = self.start(judgeId=self.connections[0])
        run = support_api.get('mm_run', summary['id'])
        with patch.object(self.mm, 'call', side_effect=[{'content': json.dumps(result()['output']), 'usage': {}}, ValueError('test failure')]):
            row = self.mm.evaluate(run, run['cases'][0], run['versions'][0])
        self.assertEqual(row['status'], 'completed')
        self.assertIn('judgeError', row)
        self.assertFalse(effective(row))

    def test_review_override_history_updates_metrics(self):
        run = self.finish(self.start()['id'])
        row = run['results'][0]
        request = {'runId': run['id'], 'caseId': row['caseId'], 'versionId': row['versionId'], 'confirmed': True, 'review': review(resolved=False)}
        summary = self.mm.review(request)
        self.assertEqual(summary['reviewRevision'], 1)
        self.assertEqual(summary['metrics'][row['versionId']]['effectiveContainment']['value'], 0)
        self.mm.review({**request, 'review': review()})
        saved = support_api.get('mm_run', run['id'])['results'][0]
        self.assertEqual(len(saved['reviewHistory']), 2)
        self.assertTrue(saved['judgment']['resolved'])
        self.assertFalse(saved['reviewHistory'][1]['previous']['resolved'])

    def test_compare_same_conditions_only_and_denominator(self):
        run = self.finish(self.start()['id'])
        sides = [{'runId': run['id'], 'versionId': version['id']} for version in self.versions]
        value = self.mm.compare({'sides': sides})
        self.assertEqual(value['pairedReviewed'], 4)
        self.assertEqual(value['groups'], 2)
        self.assertEqual(value['pairedDelta'], 0)
        self.assertEqual(value['mode'], 'horizontal')
        second = self.finish(self.start(caseIds=self.ids[:1], parentRunId=run['id'])['id'])
        with self.assertRaises(ValueError):
            self.mm.compare({'sides': [sides[0], {**sides[1], 'runId': second['id']}]})

    def test_cancel_stops_calls_and_restart_retains_results(self):
        summary = self.start()
        self.mm.post('cancel', {'runId': summary['id']})
        with patch.object(self.mm, 'evaluate') as evaluate:
            self.mm.execute(summary['id'])
            evaluate.assert_not_called()
        self.assertEqual(support_api.get('mm_run', summary['id'])['status'], 'cancelled')
        second = self.start()
        self.lab.initialize()
        self.assertEqual(support_api.get('mm_run', second['id'])['status'], 'interrupted')

    def test_privacy_and_revision_fail_closed(self):
        summary = self.start()
        run = support_api.get('mm_run', summary['id'])
        asset = support_api.get('mm_asset', run['cases'][0]['assetId'])
        asset['dataUrl'] = image_url(calibration_png('changed'))
        support_api.save('mm_asset', asset['id'], asset)
        with patch.object(ProviderVault, 'complete') as complete:
            row = self.mm.evaluate(run, run['cases'][0], run['versions'][0])
            complete.assert_not_called()
        self.assertEqual(row['status'], 'failed')


class VisionProviderTests(unittest.TestCase):
    def configured(self, provider='anthropic'):
        vault = ProviderVault()
        vault.configure({'provider': provider, 'apiKey': 'unit-test-placeholder-only', 'candidateModel': 'test-model', 'judgeModel': 'test-model', 'confirmed': True})
        return vault

    def test_anthropic_adapter_bytes_headers_usage(self):
        vault = self.configured()
        picture = image_url(calibration_png())
        messages = [{'role': 'system', 'content': 'Test JSON only.'}, {'role': 'user', 'content': [{'type': 'text', 'text': 'test'}, {'type': 'image_url', 'image_url': {'url': picture}}]}]
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = json.dumps({'content': [{'type': 'text', 'text': '{"ok":true}'}], 'stop_reason': 'end_turn', 'usage': {'input_tokens': 4, 'output_tokens': 2}}).encode()
        with patch('aftersales_provider.http.client.HTTPSConnection', return_value=connection) as transport:
            output = vault.complete(vault.status()['revision'], 'candidate', messages, json_output=True)
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0], 'api.anthropic.com')
        request = connection.request.call_args
        self.assertEqual(request.args[:2], ('POST', '/v1/messages'))
        self.assertNotIn('Authorization', request.kwargs['headers'])
        self.assertEqual(request.kwargs['headers']['anthropic-version'], '2023-06-01')
        payload = json.loads(request.kwargs['body'])
        self.assertEqual(payload['messages'][0]['content'][1]['source']['data'], picture.split(',')[1])
        self.assertNotIn('response_format', payload)
        self.assertEqual(output['usage']['total_tokens'], 6)

    def test_openai_image_payload_and_store_disabled(self):
        vault = self.configured('openai')
        picture = image_url(calibration_png())
        messages = [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': picture}}]}]
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}'
        with patch('aftersales_provider.http.client.HTTPSConnection', return_value=connection):
            vault.complete(vault.status()['revision'], 'candidate', messages)
        payload = json.loads(connection.request.call_args.kwargs['body'])
        self.assertEqual(payload['messages'], messages)
        self.assertFalse(payload['store'])

    def test_image_probe_requires_actual_code_and_clear_loses_capability(self):
        vault = self.configured()
        with patch('aftersales_provider.secrets.token_hex', return_value='abcd'), patch.object(vault, 'complete', return_value={'content': '{"code":"WRONG"}'}) as complete:
            with self.assertRaises(ProviderError):
                vault.test_vision()
            self.assertFalse(vault.status()['visionTested'])
            self.assertEqual(complete.call_args.args[2][1]['content'][1]['type'], 'image_url')
        with patch('aftersales_provider.secrets.token_hex', return_value='abcd'), patch.object(vault, 'complete', return_value={'content': '{"code":"ABCD"}'}):
            self.assertTrue(vault.test_vision()['visionTested'])
        vault.clear()
        self.assertFalse(vault.status()['configured'])

    def test_malformed_anthropic_and_secret_echo_rejected(self):
        vault = self.configured()
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        for content in [None, [None], [{'type': 'text', 'text': 42}], [{'type': 'text', 'text': 'unit-test-placeholder-only'}]]:
            connection.getresponse.return_value.read.return_value = json.dumps({'content': content, 'stop_reason': 'end_turn'}).encode()
            with patch('aftersales_provider.http.client.HTTPSConnection', return_value=connection), self.assertRaises(ProviderError):
                vault.complete(vault.status()['revision'], 'candidate', [])


if __name__ == '__main__':
    unittest.main()
