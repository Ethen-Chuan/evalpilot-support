import json
import os
import urllib.error
import urllib.parse
import urllib.request


def provider_status():
    configured = all(os.environ.get(name) for name in ("EVAL_API_BASE", "EVAL_API_KEY", "EVAL_BASELINE_MODEL", "EVAL_CANDIDATE_MODEL"))
    return {"configured": configured, "adapter": os.environ.get("EVAL_ADAPTER", "http"), "baseline": os.environ.get("EVAL_BASELINE_MODEL", "未配置"), "candidate": os.environ.get("EVAL_CANDIDATE_MODEL", "未配置")}


def infer(prompt, model):
    if not provider_status()["configured"]:
        raise ValueError("请先在服务端配置评测端点、凭证及两个模型名称")
    endpoint = os.getenv("EVAL_API_BASE", "").rstrip("/")
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("远程模型端点必须使用 HTTPS")
    model_name = os.getenv("EVAL_CANDIDATE_MODEL" if model == "candidate" else "EVAL_BASELINE_MODEL")
    authentication = os.getenv("EVAL_API_KEY", "")
    if os.environ.get("EVAL_ADAPTER") == "langchain":
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ValueError("可选 LangChain 适配器尚未安装，请参阅说明") from None
        configuration = {"model": model_name, "base_url": endpoint, "api_key": authentication, "temperature": 0, "timeout": 40, "max_retries": 0, "max_tokens": 512}
        response = ChatOpenAI(**configuration).invoke(prompt)
        if not isinstance(response.content, str):
            raise ValueError("模型返回了不支持的非文本内容")
        return response.content[:4000]
    request = urllib.request.Request(endpoint + "/chat/completions", data=json.dumps({"model": model_name, "messages": [{"role": "user", "content": prompt}], "temperature": 0, "max_tokens": 512}).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + authentication})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            payload = json.loads(response.read(1_000_000))
        content = payload["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("非文本响应")
        return content[:4000]
    except (urllib.error.URLError, KeyError, ValueError, IndexError, TimeoutError):
        raise ValueError("模型请求失败，请检查服务端配置、配额或响应格式；上游响应已隐藏") from None
