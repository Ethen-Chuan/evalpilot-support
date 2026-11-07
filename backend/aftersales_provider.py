import copy
import http.client
import json
from pathlib import Path
import re
import secrets
import ssl
import threading
import time
from urllib.parse import urlsplit


QWEN_REGIONS = json.loads(Path(__file__).with_name('qwen_regions.json').read_text())
HARNESS_PROVIDERS = ('deepseek', 'qwen')


SERVICES = {
    'openai': {'modelsPath': '/v1/models', 'name': 'OpenAI', 'host': 'api.openai.com', 'path': '/v1/chat/completions', 'endpoint': 'https://api.openai.com/v1', 'limitField': 'max_completion_tokens'},
    'deepseek': {'modelsPath': '/models', 'name': 'DeepSeek · 云端 API', 'host': 'api.deepseek.com', 'path': '/chat/completions', 'endpoint': 'https://api.deepseek.com', 'limitField': 'max_tokens', 'note': 'Flash 图文模型 ID：deepseek-flash。官方文档核对于 2026-10-22，当时对应 V4.1-Flash-1017；云端别名可能更新。看图通过不代表工具调用或 DSH Agent 循环已验证。'},
    'deepseek_vl2': {'modelsPath': '/v1/models', 'name': 'DeepSeek-VL2 · 私有部署', 'path': '/v1/chat/completions', 'endpoint': 'http://127.0.0.1:8000/v1', 'limitField': 'max_tokens', 'local': True, 'note': '连接你已部署的 VL2 OpenAI 兼容推理服务，不会自动下载模型。仅接受本机回环地址；内网 GPU 服务请先建立 SSH 隧道。局域网地址、公网代理和云端 Key 不可混用。'},
    'anthropic': {'modelsPath': '/v1/models', 'name': 'Anthropic / Claude', 'host': 'api.anthropic.com', 'path': '/v1/messages', 'endpoint': 'https://api.anthropic.com', 'limitField': 'max_tokens'},
    'qwen': {'name': '通义千问 / 阿里云百炼', 'host': 'dashscope.aliyuncs.com', 'path': '/compatible-mode/v1/chat/completions', 'endpoint': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'limitField': 'max_tokens', 'note': '使用按量 API Key，并选择其创建地域；支持官方业务空间专属 Base URL。Coding Plan 专属 Key 不用于本评测接口。模型 ID 从同一地域控制台复制；关闭可选深度思考。'},
    'moonshot': {'name': 'Kimi / Moonshot（中国站）', 'host': 'api.moonshot.cn', 'path': '/v1/chat/completions', 'modelsPath': '/v1/models', 'endpoint': 'https://api.moonshot.cn/v1', 'limitField': 'max_tokens'},
    'zhipu': {'name': '智谱 / GLM', 'host': 'open.bigmodel.cn', 'path': '/api/paas/v4/chat/completions', 'endpoint': 'https://open.bigmodel.cn/api/paas/v4', 'limitField': 'max_tokens', 'note': '使用开放平台通用 API Key，不是 Coding Plan 专属端点；请从控制台复制模型 ID。'},
}


class ProviderError(ValueError):
    pass


def service_catalog():
    return [{'id': identifier, 'name': service['name'], 'endpoint': service['endpoint'], 'discovery': bool(service.get('modelsPath')), 'note': service.get('note', ''), 'harness': identifier in HARNESS_PROVIDERS, **({'regions': QWEN_REGIONS} if identifier == 'qwen' else {}), **({'local': True} if service.get('local') else {})} for identifier, service in SERVICES.items()]


def connection_service(provider, endpoint=None):
    service = SERVICES[provider]
    if provider == 'qwen':
        address = service['endpoint'] if endpoint is None else endpoint
        if not isinstance(address, str):
            raise ValueError('请选择百炼地域或填写官方业务空间 Base URL')
        address = address.rstrip('/')
        regions = '|'.join(re.escape(item['id']) for item in QWEN_REGIONS)
        shared = {item['endpoint'] for item in QWEN_REGIONS if item['endpoint']}
        workspace = re.fullmatch(r'https://[a-z0-9][a-z0-9-]{0,62}\.(' + regions + r')\.maas\.aliyuncs\.com/compatible-mode/v1', address)
        if address not in shared and not workspace:
            raise ValueError('百炼地址须为选定地域的官方 Base URL，或官方业务空间专属地址；不要添加 /chat/completions、查询参数或 Coding Plan 端点')
        return {**service, 'host': urlsplit(address).hostname, 'endpoint': address}
    if not service.get('local'):
        return service
    if not isinstance(endpoint, str):
        raise ValueError('请填写已部署的本机 VL2 服务地址，例如 http://127.0.0.1:8000/v1')
    match = re.fullmatch(r'http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{3,4})/v1/?', endpoint)
    if not match or not 1024 <= int(match[2]) <= 65535:
        raise ValueError('私有服务只允许 http://127.0.0.1:端口/v1 或 http://[::1]:端口/v1，端口需为 1024–65535；内网服务请使用 SSH 隧道')
    return {**service, 'host': match[1].strip('[]'), 'port': int(match[2]), 'endpoint': endpoint.rstrip('/')}


def open_connection(service, timeout):
    if service.get('local'):
        return http.client.HTTPConnection(service['host'], service['port'], timeout=timeout)
    return http.client.HTTPSConnection(service['host'], timeout=timeout, context=ssl.create_default_context())


def credentials(body):
    provider = body.get('provider')
    if not isinstance(provider, str) or provider not in SERVICES or body.get('confirmed') is not True:
        raise ValueError('请选择受支持的服务，并确认授权的发送目的地')
    key = body.get('apiKey', '')
    if isinstance(key, str):
        key = key.strip()
    if provider == 'qwen':
        connection_service(provider, body.get('endpoint'))
        if isinstance(key, str) and key.startswith('sk-sp-'):
            raise ValueError('这是 Coding Plan 专属 Key。本评测使用百炼按量 API，请在对应地域创建普通 API Key；不要把密钥发到聊天里')
    if SERVICES[provider].get('local'):
        connection_service(provider, body.get('endpoint'))
        if key == '':
            return provider, key
    if not isinstance(key, str) or not 8 <= len(key) <= 512 or any(character.isspace() for character in key) or not key.isascii():
        raise ValueError('密钥格式不正确；请在专用输入框中重新填写')
    return provider, key


def provider_headers(provider, key):
    if not key:
        return {'Content-Type': 'application/json'}
    if provider == 'anthropic':
        return {'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'}
    return {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key}


def check_response_status(status, provider=None):
    if status == 200:
        return
    if provider == 'qwen':
        messages = {
            400: '百炼 HTTP 400：请核对模型 ID 及 JSON、工具或图像参数是否受该模型支持；不自动重试',
            401: '百炼 HTTP 401：Key 与地域/业务空间可能不匹配，或密钥已失效；请核对当前地址和普通按量 API Key',
            403: '百炼 HTTP 403：请检查账号已开通百炼、模型调用权限、业务空间授权和账户状态',
            404: '百炼 HTTP 404：模型或调用路径不可用；请从当前地域控制台复制完整模型 ID',
            429: '百炼 HTTP 429：调用频率、并发或额度受限；本次未自动重试，请检查控制台限额',
        }
        if status in messages:
            raise ProviderError(messages[status])
    if status in (401, 403):
        raise ProviderError('模型服务拒绝认证或权限不足，请检查密钥、地域及模型权限')
    if status == 429:
        raise ProviderError('模型服务限流或额度不足，本次没有自动重试')
    if 300 <= status < 400:
        raise ProviderError('模型服务返回重定向，已拒绝转发密钥')
    raise ProviderError(f'模型服务返回 HTTP {status}，请核对模型名称、格式支持与额度；上游正文未记录')


class ProviderVault:
    def __init__(self):
        self.lock = threading.RLock()
        self.configuration = None

    def configure(self, body):
        provider, key = credentials(body)
        models = {}
        for field in ('judgeModel', 'candidateModel'):
            value = body.get(field, '')
            if field == 'candidateModel' and not value:
                value = body.get('judgeModel', '')
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}', value) or (key and key in value):
                raise ValueError('请填写服务商账号中可用的模型名称，而不是密钥')
            models[field] = value
        with self.lock:
            self.configuration = {'provider': provider, 'apiKey': key, 'endpoint': connection_service(provider, body.get('endpoint'))['endpoint'], **models, 'revision': secrets.token_hex(12), 'tested': False, 'testedAt': None, 'visionTested': False}
        return self.status()

    @staticmethod
    def discover(body):
        provider, key = credentials(body)
        service = connection_service(provider, body.get('endpoint'))
        if not service.get('modelsPath'):
            raise ProviderError('此服务暂不支持列表读取，请从官方控制台复制模型 ID，再进行连接测试')
        connection = open_connection(service, 30)
        try:
            connection.request('GET', service['modelsPath'], headers=provider_headers(provider, key))
            response = connection.getresponse()
            check_response_status(response.status, provider)
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ProviderError('模型列表超过接收上限，请手动填写模型 ID')
            decoded = json.loads(raw)
            if not isinstance(decoded, dict) or not isinstance(decoded.get('data'), list):
                raise ProviderError('模型列表格式不兼容，请手动填写模型 ID')
            if key and key in json.dumps(decoded):
                raise ProviderError('模型列表含受保护字段，已隔离响应')
            identifiers = []
            for item in decoded['data'][:1000]:
                model = item.get('id') if isinstance(item, dict) else None
                if isinstance(model, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}', model) and model not in identifiers:
                    identifiers.append(model)
            return {'provider': provider, 'endpoint': service['endpoint'], 'models': identifiers, 'partial': decoded.get('has_more') is True or len(decoded['data']) > 1000, 'inferenceTested': False}
        except ProviderError:
            raise
        except (OSError, TimeoutError, http.client.HTTPException, ValueError, TypeError):
            raise ProviderError('读取模型列表失败；未记录上游正文，请重试或手动填写模型 ID') from None
        finally:
            connection.close()

    def status(self):
        with self.lock:
            if not self.configuration:
                return {'configured': False, 'tested': False, 'services': service_catalog()}
            value = self.configuration
            return {'configured': True, 'provider': value['provider'], 'endpoint': value['endpoint'], 'judgeModel': value['judgeModel'], 'candidateModel': value['candidateModel'], 'revision': value['revision'], 'tested': value['tested'], 'testedAt': value['testedAt'], 'visionTested': value.get('visionTested', False), 'storage': 'memory_only', 'sameModel': value['judgeModel'] == value['candidateModel'], 'services': service_catalog()}

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
        service = connection_service(configuration['provider'], configuration['endpoint'])
        model = configuration['judgeModel' if role == 'judge' else 'candidateModel']
        payload = {'model': model, 'messages': messages, service['limitField']: min(maximum, 1024) if service.get('local') else maximum, 'stream': False}
        if configuration['provider'] == 'openai':
            payload['store'] = False
        if configuration['provider'] == 'qwen':
            payload['enable_thinking'] = False
        has_images = any(isinstance(message.get('content'), list) and any(block.get('type') == 'image_url' for block in message['content']) for message in messages)
        if service.get('local'):
            for message in messages:
                for block in message['content'] if isinstance(message.get('content'), list) else []:
                    if block.get('type') == 'image_url' and (message.get('role') != 'user' or not re.fullmatch(r'data:image/png;base64,[A-Za-z0-9+/]+=*', block.get('image_url', {}).get('url', ''))):
                        raise ProviderError('私有模型只接收已复核的内嵌 PNG 用户图片，不允许模型下载远程地址或读取本地路径')
        if json_output and not service.get('local') and not (configuration['provider'] == 'zhipu' and has_images):
            payload['response_format'] = {'type': 'json_object'}
        headers = provider_headers(configuration['provider'], configuration['apiKey'])
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
        started = time.perf_counter()
        connection = open_connection(service, 90)
        try:
            connection.request('POST', service['path'], body=json.dumps(payload, ensure_ascii=False).encode(), headers=headers)
            response = connection.getresponse()
            check_response_status(response.status, configuration['provider'])
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
            if configuration['apiKey'] and configuration['apiKey'] in content:
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
        configuration = self.snapshot(revision)
        roles = ['judge'] if configuration['candidateModel'] == configuration['judgeModel'] else ['judge', 'candidate']
        with self.lock:
            if self.configuration and self.configuration['revision'] == revision:
                self.configuration.update(tested=False, testedAt=None, visionTested=False)
        for role in roles:
            result = self.complete(revision, role, messages, json_output=True, maximum=2048)
            try:
                valid = json.loads(result['content']) == {'ok': True}
            except ValueError:
                valid = False
            if not valid:
                raise ProviderError('已连接，但模型未返回预期 JSON，不能用于本平台评测')
        with self.lock:
            if self.configuration and self.configuration['revision'] == revision:
                self.configuration.update(tested=True, testedAt=time.time())
        return self.status()

    def test_vision(self, check_image=None):
        from vision_media import calibration_png, image_url
        revision = self.snapshot()['revision']
        with self.lock:
            if self.configuration and self.configuration['revision'] == revision:
                self.configuration['visionTested'] = False
        expected = secrets.token_hex(2).upper()
        content = calibration_png(expected)
        if check_image:
            check_image(content, expected)
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
