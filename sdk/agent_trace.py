import copy
import json
import urllib.parse
import urllib.request

from backend.tracing import Trace, span


class MemoryStore:
    def __init__(self):
        self.record = None

    def save(self, record):
        self.record = copy.deepcopy(record)


class AgentTrace(Trace):
    def __init__(self, name, endpoint="http://127.0.0.1:4287", inputs=None, attributes=None, source="external.python-agent", auto_submit=True):
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("此 SDK 只允许向本机 EvalPilot 上报，不会向外部发送 Agent 数据")
        self.endpoint = endpoint.rstrip("/")
        self.auto_submit = auto_submit
        self.submission_error = None
        self.receipt = None
        super().__init__(MemoryStore(), name, source, inputs, attributes)

    def __exit__(self, error_type, error, stack):
        result = super().__exit__(error_type, error, stack)
        if self.auto_submit:
            try:
                self.receipt = self.submit()
            except Exception as submission_error:
                self.submission_error = submission_error.__class__.__name__
                if error is None:
                    raise RuntimeError("Agent 执行已结束，但 Trace 上报失败；可检查 submission_error 并显式重试 submit()") from None
        return result

    def submit(self):
        if self.record["status"] == "running":
            raise ValueError("请在 Trace 结束后上报")
        request = urllib.request.Request(self.endpoint + "/api/support/traces/ingest", data=json.dumps(self.record, ensure_ascii=False).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def step(self, name, kind="tool", inputs=None, attributes=None):
        return span(name, kind, inputs, attributes)


agent_step = span
