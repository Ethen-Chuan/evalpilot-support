import json
from pathlib import Path
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from aftersales_provider import ProviderError, ProviderVault, SERVICES, service_catalog


class ProviderDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.body = {'provider': 'openai', 'apiKey': 'unit-test-placeholder-only', 'confirmed': True}

    def transport(self, payload, status=200, raw=None):
        response = MagicMock(status=status)
        response.read.return_value = raw if raw is not None else json.dumps(payload).encode()
        connection = MagicMock()
        connection.getresponse.return_value = response
        return patch('aftersales_provider.http.client.HTTPSConnection', return_value=connection), connection

    def test_catalog_contains_only_fixed_official_destinations(self):
        catalog = service_catalog()
        self.assertEqual({item['id'] for item in catalog}, {'openai', 'anthropic', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'deepseek_vl2'})
        self.assertEqual({item['id'] for item in catalog if item['discovery']}, {'openai', 'anthropic', 'deepseek', 'moonshot', 'deepseek_vl2'})
        self.assertTrue(all(set(item) == {'id', 'name', 'endpoint', 'discovery', 'note'} for item in catalog if not item.get('local')))
        self.assertEqual([item['id'] for item in catalog if item.get('local')], ['deepseek_vl2'])

    def test_listing_uses_only_allowed_host_and_get_without_body(self):
        for provider in ['openai', 'deepseek', 'anthropic', 'moonshot']:
            with self.subTest(provider=provider):
                patcher, connection = self.transport({'data': [{'id': 'fixture-model'}]})
                with patcher as factory:
                    result = ProviderVault.discover({**self.body, 'provider': provider, 'endpoint': 'https://untrusted.invalid'})
                self.assertEqual(factory.call_args.args, (SERVICES[provider]['host'],))
                request = connection.request.call_args
                self.assertEqual(request.args, ('GET', SERVICES[provider]['modelsPath']))
                self.assertNotIn('body', request.kwargs)
                headers = request.kwargs['headers']
                if provider == 'anthropic':
                    self.assertEqual(headers['x-api-key'], self.body['apiKey'])
                    self.assertEqual(headers['anthropic-version'], '2023-06-01')
                    self.assertNotIn('Authorization', headers)
                else:
                    self.assertEqual(headers['Authorization'], 'Bearer ' + self.body['apiKey'])
                self.assertFalse(result['inferenceTested'])
                self.assertEqual(result['models'], ['fixture-model'])
                self.assertNotIn(self.body['apiKey'], json.dumps(result))
                connection.close.assert_called_once()

    def test_no_request_before_consent_or_for_unsupported_services(self):
        for changes in [{'confirmed': False}, {'confirmed': 1}, {'provider': []}, {'provider': 'proxy'}, {'apiKey': 'bad\nkey'}, {'provider': 'qwen'}, {'provider': 'zhipu'}]:
            with self.subTest(changes=changes), patch('aftersales_provider.http.client.HTTPSConnection') as factory:
                with self.assertRaises(ValueError):
                    ProviderVault.discover({**self.body, **changes})
                factory.assert_not_called()

    def test_sanitized_deduplicated_ids_and_partial_page(self):
        patcher, _ = self.transport({'data': [{'id': 'model-two', 'name': 'untrusted extra data'}, {'id': 'model-one'}, {'id': 'model-two'}, {}, None, {'id': '<unsafe>'}, {'id': 'x' * 121}], 'has_more': True})
        with patcher:
            result = ProviderVault.discover(self.body)
        self.assertEqual(result['models'], ['model-two', 'model-one'])
        self.assertTrue(result['partial'])
        self.assertNotIn('untrusted', json.dumps(result))

    def test_list_bound_and_empty_not_faked(self):
        for count in [0, 1001]:
            patcher, _ = self.transport({'data': [{'id': f'fixture-{index}'} for index in range(count)]})
            with patcher:
                result = ProviderVault.discover(self.body)
            self.assertEqual(len(result['models']), min(count, 1000))
            self.assertEqual(result['partial'], count > 1000)

    def test_failure_never_echoes_body_and_never_retries_or_redirects(self):
        for status in [301, 307, 401, 403, 429, 500]:
            patcher, connection = self.transport({'error': self.body['apiKey']}, status=status)
            with patcher, self.assertRaises(ProviderError) as error:
                ProviderVault.discover(self.body)
            self.assertNotIn(self.body['apiKey'], str(error.exception))
            self.assertEqual(connection.request.call_count, 1)
            connection.getresponse.return_value.read.assert_not_called()
            connection.close.assert_called_once()

    def test_invalid_oversized_or_secret_bearing_response_rejected(self):
        for raw in [b'[]', b'{"data": {}}', b'invalid-json', b'x' * 1_000_001, json.dumps({'data': [{'id': 'safe-model'}], 'extra': self.body['apiKey']}).encode()]:
            patcher, connection = self.transport(None, raw=raw)
            with patcher, self.assertRaises(ProviderError) as error:
                ProviderVault.discover(self.body)
            self.assertNotIn(self.body['apiKey'], str(error.exception))
            connection.close.assert_called_once()

    def test_network_exception_sanitized(self):
        patcher, connection = self.transport({'data': []})
        connection.request.side_effect = OSError(self.body['apiKey'])
        with patcher, self.assertRaises(ProviderError) as error:
            ProviderVault.discover(self.body)
        self.assertNotIn(self.body['apiKey'], str(error.exception))
        connection.close.assert_called_once()

    def test_new_chat_services_payload_and_destination(self):
        for provider in ['qwen', 'moonshot', 'zhipu', 'deepseek']:
            vault = ProviderVault()
            status = vault.configure({**self.body, 'provider': provider, 'candidateModel': 'test-model', 'judgeModel': 'test-model'})
            patcher, connection = self.transport({'choices': [{'message': {'content': '{"ok":true}'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 5, 'completion_tokens': 2, 'total_tokens': 7}})
            with patcher as factory:
                result = vault.complete(status['revision'], 'candidate', [{'role': 'user', 'content': 'Synthetic JSON test'}], json_output=True)
            self.assertEqual(factory.call_args.args, (SERVICES[provider]['host'],))
            self.assertEqual(connection.request.call_args.args, ('POST', SERVICES[provider]['path']))
            payload = json.loads(connection.request.call_args.kwargs['body'])
            self.assertEqual(payload['response_format'], {'type': 'json_object'})
            self.assertEqual(payload['max_tokens'], 4096)
            self.assertFalse(payload['stream'])
            self.assertEqual(result['usage']['total_tokens'], 7)
            if provider == 'qwen':
                self.assertFalse(payload['enable_thinking'])

    def test_test_checks_candidate_json_not_just_ok_text(self):
        vault = ProviderVault()
        vault.configure({**self.body, 'candidateModel': 'candidate', 'judgeModel': 'judge'})
        with patch.object(vault, 'complete', side_effect=[{'content': '{"ok":true}'}, {'content': 'OK'}]) as complete, self.assertRaises(ProviderError):
            vault.test()
        self.assertFalse(vault.status()['tested'])
        self.assertEqual(complete.call_count, 2)
        self.assertTrue(all(call.kwargs['json_output'] for call in complete.call_args_list))

    def test_glm_vision_omits_text_only_response_format(self):
        vault = ProviderVault()
        status = vault.configure({**self.body, 'provider': 'zhipu', 'candidateModel': 'vision-fixture', 'judgeModel': 'vision-fixture'})
        patcher, connection = self.transport({'choices': [{'message': {'content': '{"code":"ABCD"}'}, 'finish_reason': 'stop'}]})
        with patcher:
            vault.complete(status['revision'], 'candidate', [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,fixture'}}, {'type': 'text', 'text': 'Synthetic JSON test'}]}], json_output=True)
        payload = json.loads(connection.request.call_args.kwargs['body'])
        self.assertNotIn('response_format', payload)
        self.assertEqual(payload['messages'][0]['content'][0]['type'], 'image_url')

    def test_failed_vision_retest_revokes_only_vision(self):
        vault = ProviderVault()
        vault.configure({**self.body, 'candidateModel': 'vision-fixture', 'judgeModel': 'vision-fixture'})
        vault.configuration.update(tested=True, visionTested=True)
        with patch('vision_media.calibration_png', return_value=b'fixture'), patch.object(vault, 'complete', side_effect=ProviderError('isolated vision failure')), self.assertRaises(ProviderError):
            vault.test_vision()
        self.assertFalse(vault.status()['visionTested'])
        self.assertTrue(vault.status()['tested'])

    def test_model_metadata_cannot_embed_key(self):
        vault = ProviderVault()
        with self.assertRaises(ValueError):
            vault.configure({**self.body, 'candidateModel': 'prefix-' + self.body['apiKey'], 'judgeModel': 'fixture'})
        self.assertFalse(vault.status()['configured'])

    def test_failed_retest_invalidates_old_success(self):
        vault = ProviderVault()
        vault.configure({**self.body, 'candidateModel': 'candidate', 'judgeModel': 'candidate'})
        with patch.object(vault, 'complete', return_value={'content': '{"ok":true}'}):
            vault.test()
        self.assertTrue(vault.status()['tested'])
        with patch.object(vault, 'complete', side_effect=ProviderError('isolated failure')), self.assertRaises(ProviderError):
            vault.test()
        self.assertFalse(vault.status()['tested'])
        self.assertIsNone(vault.status()['testedAt'])

    def test_flash_sends_actual_inline_image_to_official_endpoint(self):
        vault = ProviderVault()
        status = vault.configure({**self.body, 'provider': 'deepseek', 'candidateModel': 'deepseek-flash', 'judgeModel': 'deepseek-flash', 'endpoint': 'http://127.0.0.1:8000/v1'})
        messages = [{'role': 'user', 'content': [{'type': 'text', 'text': 'Read the image as JSON'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,dGVzdA=='}}]}]
        patcher, connection = self.transport({'choices': [{'message': {'content': '{"code":"CAFE"}'}, 'finish_reason': 'stop'}]})
        with patcher as factory:
            vault.complete(status['revision'], 'candidate', messages, json_output=True)
        self.assertEqual(factory.call_args.args, ('api.deepseek.com',))
        self.assertEqual(connection.request.call_args.args, ('POST', '/chat/completions'))
        payload = json.loads(connection.request.call_args.kwargs['body'])
        self.assertEqual(payload['model'], 'deepseek-flash')
        self.assertEqual(payload['messages'], messages)
        self.assertFalse(vault.status()['visionTested'])


class PrivateVL2Tests(unittest.TestCase):
    def setUp(self):
        self.body = {'provider': 'deepseek_vl2', 'endpoint': 'http://127.0.0.1:8000/v1', 'apiKey': '', 'confirmed': True, 'candidateModel': 'deepseek-ai/deepseek-vl2-tiny', 'judgeModel': 'deepseek-ai/deepseek-vl2-tiny'}

    def test_addresses_fail_closed_before_any_network(self):
        endpoints = [None, '', 'https://example.com/v1', 'http://localhost:8000/v1', 'http://192.168.1.2:8000/v1', 'http://169.254.169.254:8000/v1', 'http://127.1:8000/v1', 'http://2130706433:8000/v1', 'http://127.0.0.1:80/v1', 'http://127.0.0.1:65536/v1', 'http://127.0.0.1:08000/v1', 'http://127.0.0.1:8000/v1?query=private', 'http://127.0.0.1:8000/v1#fragment', urllib.parse.urlunsplit(('http', '${API_USER}:${API_KEY}@127.0.0.1:8000', '/v1', '', '')), 'http://127.0.0.1:8000/v1/../../admin', 'http://[::ffff:127.0.0.1]:8000/v1', 'http://127.0.0.1:8000/v1\n', []]
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint), patch('aftersales_provider.http.client.HTTPConnection') as http, patch('aftersales_provider.http.client.HTTPSConnection') as https:
                for operation in (ProviderVault().configure, ProviderVault.discover):
                    with self.assertRaises(ValueError):
                        operation({**self.body, 'endpoint': endpoint})
                http.assert_not_called()
                https.assert_not_called()

    def test_consent_required_and_only_local_credentials_optional(self):
        for changes in [{'confirmed': False}, {'confirmed': 1}, {'provider': 'deepseek'}, {'apiKey': 'bad\ncredential'}, {'apiKey': None}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                ProviderVault().configure({**self.body, **changes})
        vault = ProviderVault()
        status = vault.configure(self.body)
        self.assertTrue(status['configured'])
        self.assertFalse(status['tested'])
        self.assertFalse(status['visionTested'])
        self.assertNotIn('apiKey', status)

    def test_private_transport_key_isolated_redirects_rejected(self):
        for endpoint, host in [('http://127.0.0.1:8123/v1/', '127.0.0.1'), ('http://[::1]:8123/v1', '::1')]:
            for key in ['', 'unit-test-placeholder-only']:
                response = MagicMock(status=200)
                response.read.return_value = b'{"data":[{"id":"deepseek-ai/deepseek-vl2-tiny"}]}'
                transport = MagicMock()
                transport.getresponse.return_value = response
                with patch('aftersales_provider.http.client.HTTPConnection', return_value=transport) as http, patch('aftersales_provider.http.client.HTTPSConnection') as https:
                    result = ProviderVault.discover({**self.body, 'endpoint': endpoint, 'apiKey': key})
                self.assertEqual(http.call_args.args, (host, 8123))
                self.assertEqual(transport.request.call_args.args, ('GET', '/v1/models'))
                headers = transport.request.call_args.kwargs['headers']
                self.assertEqual(headers.get('Authorization'), 'Bearer ' + key if key else None)
                self.assertEqual(result['endpoint'], endpoint.rstrip('/'))
                self.assertFalse(result['inferenceTested'])
                https.assert_not_called()
                transport.close.assert_called_once()
        for status in [301, 307, 401, 429, 500]:
            transport = MagicMock()
            transport.getresponse.return_value.status = status
            with patch('aftersales_provider.http.client.HTTPConnection', return_value=transport), self.assertRaises(ProviderError):
                ProviderVault.discover(self.body)
            transport.getresponse.return_value.read.assert_not_called()
            self.assertEqual(transport.request.call_count, 1)

    def test_local_payload_budget_and_strict_json_without_forcing_json_mode(self):
        vault = ProviderVault()
        status = vault.configure(self.body)
        transport = MagicMock()
        response = transport.getresponse.return_value
        response.status = 200
        response.read.return_value = b'{"choices":[{"message":{"content":"Not JSON"},"finish_reason":"stop"}]}'
        with patch('aftersales_provider.http.client.HTTPConnection', return_value=transport), self.assertRaises(ProviderError):
            vault.test()
        payload = json.loads(transport.request.call_args.kwargs['body'])
        self.assertEqual(payload['max_tokens'], 1024)
        self.assertNotIn('response_format', payload)
        self.assertEqual(payload['model'], status['candidateModel'])
        self.assertFalse(vault.status()['tested'])

    def test_local_media_cannot_reference_remote_urls_or_files(self):
        vault = ProviderVault()
        status = vault.configure(self.body)
        for url in ['http://169.254.169.254/latest/', 'file:///etc/passwd', 'data:image/jpeg;base64,dGVzdA==']:
            messages = [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': url}}]}]
            with patch('aftersales_provider.http.client.HTTPConnection') as transport, self.assertRaises(ProviderError):
                vault.complete(status['revision'], 'candidate', messages)
            transport.assert_not_called()

    def test_loopback_discovery_and_image_test_end_to_end_with_synthetic_server(self):
        received = []

        class SyntheticHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                received.append((self.command, self.path, self.headers.get('Authorization'), None))
                self.respond({'data': [{'id': 'deepseek-ai/deepseek-vl2-tiny'}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.command, self.path, self.headers.get('Authorization'), body))
                self.respond({'choices': [{'message': {'content': '{"code":"CAFE"}'}, 'finish_reason': 'stop'}]})

            def respond(self, body):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

        server = ThreadingHTTPServer(('127.0.0.1', 0), SyntheticHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            body = {**self.body, 'endpoint': f'http://127.0.0.1:{server.server_port}/v1'}
            self.assertEqual(ProviderVault.discover(body)['models'], [body['candidateModel']])
            vault = ProviderVault()
            vault.configure(body)
            with patch('aftersales_provider.secrets.token_hex', return_value='cafe'):
                status = vault.test_vision()
            self.assertTrue(status['visionTested'])
            self.assertEqual([(method, path) for method, path, _, _ in received], [('GET', '/v1/models'), ('POST', '/v1/chat/completions')])
            self.assertTrue(all(auth is None for _, _, auth, _ in received))
            self.assertTrue(received[1][3]['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/png;base64,'))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
