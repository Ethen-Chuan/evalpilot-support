import copy
import http.client
import json
import re
import secrets
import ssl
import threading
import time


SERVICES = {
    'openai': {'name': 'OpenAI', 'host': 'api.openai.com', 'path': '/v1/chat/completions', 'endpoint': 'https://api.openai.com/v1', 'limitField': 'max_completion_tokens'},
    'deepseek': {'name': 'DeepSeek', 'host': 'api.deepseek.com', 'path': '/chat/completions', 'endpoint': 'https://api.deepseek.com', 'limitField': 'max_tokens'},
    'anthropic': {'name': 'Anthropic', 'host': 'api.anthropic.com', 'path': '/v1/messages', 'endpoint': 'https://api.anthropic.com', 'limitField': 'max_tokens'},
}


class ProviderError(ValueError):
    pass


class ProviderVault:
    def __init__(self):
        self.lock = threading.RLock()
        self.configuration = None

    def configure(self, body):
        provider = body.get('provider')
        if provider not in SERVICES or body.get('confirmed') is not True:
            raise ValueError('请选择受支持的服务，并确认密钥只用于该官方服务')
        key = body.get('apiKey')
        if not isinstance(key, str) or not 8 <= len(key) <= 512 or any(character.isspace() for character in key) or not key.isascii():
            raise ValueError('密钥格式不正确；请在专用输入框中重新填写')
        models = {}
        for field in ('judgeModel', 'candidateModel'):
            value = body.get(field, '')
            if field == 'candidateModel' and not value:
                value = body.get('judgeModel', '')
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}', value) or value == key:
                raise ValueError('请填写服务商账号中可用的模型名称，而不是密钥')
            models[field] = value
        with self.lock:
            self.configuration = {'provider': provider, 'apiKey': key, **models, 'revision': secrets.token_hex(12), 'tested': False, 'testedAt': None, 'visionTested': False}
        return self.status()

    def status(self):
        with self.lock:
            if not self.configuration:
                return {'configured': False, 'tested': False, 'services': [{'id': key, **{field: value[field] for field in ('name', 'endpoint')}} for key, value in SERVICES.items()]}
            value = self.configuration
            return {'configured': True, 'provider': value['provider'], 'endpoint': SERVICES[value['provider']]['endpoint'], 'judgeModel': value['judgeModel'], 'candidateModel': value['candidateModel'], 'revision': value['revision'], 'tested': value['tested'], 'testedAt': value['testedAt'], 'visionTested': value.get('visionTested', False), 'storage': 'memory_only', 'sameModel': value['judgeModel'] == value['candidateModel'], 'services': [{'id': key, **{field: service[field] for field in ('name', 'endpoint')}} for key, service in SERVICES.items()]}

    def clear(self):
        with self.lock:
            self.configuration = None
        return self.status()

    def snapshot(self, revision=None):
        with self.lock:
            if not self.configuration or (revision and self.configuration['revision'] != revision):
                raise ProviderError('模型连接已清除或变更，请重新配置并确认运行')
            return copy.copy(self.configuration)

    def complete(self, revision, role, messages, json_output=False, maximum=4096):
        configuration = self.snapshot(revision)
        service = SERVICES[configuration['provider']]
        model = configuration['judgeModel' if role == 'judge' else 'candidateModel']
        payload = {'model': model, 'messages': messages, service['limitField']: maximum, 'stream': False}
        if configuration['provider'] == 'openai':
            payload['store'] = False
        if json_output:
            payload['response_format'] = {'type': 'json_object'}
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + configuration['apiKey']}
        if configuration['provider'] == 'anthropic':
            converted = []
            for message in messages:
                if message['role'] == 'system':
                    continue
                content = message['content']
                if isinstance(content, list):
                    blocks = []
                    for block in content:
                        if block['type'] == 'text':
                            blocks.append(block)
                        else:
                            prefix, encoded = block['image_url']['url'].split(',', 1)
                            if prefix != 'data:image/png;base64':
                                raise ProviderError('只接受已复核的本机 PNG 图片')
                            blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': encoded}})
                    content = blocks
                converted.append({'role': message['role'], 'content': content})
            payload = {'model': model, 'max_tokens': maximum, 'messages': converted, 'system': '\n'.join(message['content'] for message in messages if message['role'] == 'system')}
            headers = {'Content-Type': 'application/json', 'x-api-key': configuration['apiKey'], 'anthropic-version': '2023-06-01'}
        started = time.perf_counter()
        connection = http.client.HTTPSConnection(service['host'], timeout=90, context=ssl.create_default_context())
        try:
            connection.request('POST', service['path'], body=json.dumps(payload, ensure_ascii=False).encode(), headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                status = response.status
                if status in (401, 403):
                    raise ProviderError('模型服务拒绝认证或权限不足，请检查密钥及模型权限')
                if status == 429:
                    raise ProviderError('模型服务限流或额度不足，本次没有自动重试')
                if 300 <= status < 400:
                    raise ProviderError('模型服务返回重定向，已拒绝转发密钥')
                raise ProviderError(f'模型服务返回 HTTP {status}，请核对模型名称、格式支持与额度；上游正文未记录')
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ProviderError('模型返回超过接收上限，未保存不完整结果')
            decoded = json.loads(raw)
            if not isinstance(decoded, dict):
                raise ProviderError('模型响应不是预期对象，未保存原始响应')
            if configuration['provider'] == 'anthropic':
                blocks = decoded.get('content')
                if not isinstance(blocks, list) or any(not isinstance(block, dict) for block in blocks):
                    raise ProviderError('模型图文响应结构不兼容')
                content = ''.join(block['text'] for block in blocks if block.get('type') == 'text')
                usage = decoded.get('usage', {})
                usage = usage if isinstance(usage, dict) else {}
                mapped = {field: usage[source] for field, source in [('prompt_tokens', 'input_tokens'), ('completion_tokens', 'output_tokens')] if type(usage.get(source)) is int and usage[source] >= 0}
                if len(mapped) == 2:
                    mapped['total_tokens'] = sum(mapped.values())
                decoded = {'choices': [{'message': {'content': content}, 'finish_reason': 'stop' if decoded.get('stop_reason') == 'end_turn' else 'incomplete'}], 'usage': mapped}
            choice = decoded['choices'][0]
            if not isinstance(choice, dict) or not isinstance(choice.get('message'), dict):
                raise ProviderError('模型消息结构不兼容，未保存原始响应')
            content = choice['message'].get('content')
            if choice.get('finish_reason') != 'stop' or not isinstance(content, str) or not content.strip():
                raise ProviderError('模型输出不完整、被拒绝或不是文本；未使用截断内容评分')
            if configuration['apiKey'] in content:
                raise ProviderError('模型返回含受保护字段，内容已隔离')
            usage = decoded.get('usage', {})
            usage = usage if isinstance(usage, dict) else {}
            usage = {field: usage[field] for field in ('prompt_tokens', 'completion_tokens', 'total_tokens') if isinstance(usage.get(field), int) and not isinstance(usage[field], bool) and usage[field] >= 0}
            return {'content': content, 'usage': usage, 'durationMs': round((time.perf_counter() - started) * 1000, 2), 'model': model, 'finishReason': 'stop'}
        except ProviderError:
            raise
        except (OSError, TimeoutError, http.client.HTTPException, ValueError, KeyError, IndexError, TypeError):
            raise ProviderError('模型连接超时、网络异常或响应格式不兼容；未自动重试，也未记录上游原始响应') from None
        finally:
            connection.close()
            configuration.clear()

    def test(self):
        revision = self.snapshot()['revision']
        messages = [{'role': 'system', 'content': 'Return only a JSON object with the key ok and the boolean value true.'}, {'role': 'user', 'content': 'Connection test. No customer data is included.'}]
        result = self.complete(revision, 'judge', messages, json_output=True, maximum=2048)
        try:
            valid = json.loads(result['content']) == {'ok': True}
        except ValueError:
            valid = False
        if not valid:
            raise ProviderError('已连接，但模型未返回预期 JSON，不能直接作为裁判')
        configuration = self.snapshot(revision)
        if configuration['candidateModel'] != configuration['judgeModel']:
            candidate = self.complete(revision, 'candidate', [{'role': 'user', 'content': 'Connection test: reply OK. No customer data.'}], maximum=1024)
            if 'OK' not in candidate['content'].upper():
                raise ProviderError('答复模型连通性检查未通过')
        with self.lock:
            if self.configuration and self.configuration['revision'] == revision:
                self.configuration.update(tested=True, testedAt=time.time())
        return self.status()

    def test_vision(self, check_image=None):
        from vision_media import calibration_png, image_url
        revision = self.snapshot()['revision']
        expected = secrets.token_hex(2).upper()
        content = calibration_png(expected)
        if check_image:
            check_image(content)
        messages = [{'role': 'system', 'content': 'Read the large code in the image. Return exactly a JSON object with one field code. Do not include other text.'}, {'role': 'user', 'content': [{'type': 'text', 'text': 'Read the large code. This is a locally generated connection test, not customer data.'}, {'type': 'image_url', 'image_url': {'url': image_url(content)}}]}]
        roles = ['candidate'] if self.snapshot()['candidateModel'] == self.snapshot()['judgeModel'] else ['candidate', 'judge']
        for role in roles:
            result = self.complete(revision, role, messages, json_output=True, maximum=1024)
            try:
                if json.loads(result['content']) != {'code': expected}:
                    raise ValueError('wrong')
            except ValueError:
                raise ProviderError('图像读取测试未通过，不能将此连接用于图文评测') from None
        with self.lock:
            if self.configuration and self.configuration['revision'] == revision:
                self.configuration.update(visionTested=True, tested=True, testedAt=time.time())
        return self.status()
