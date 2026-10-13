import contextlib
import contextvars
import datetime
import hashlib
import json
import math
import re
import secrets
import sqlite3
import threading
import time
import traceback
from pathlib import Path

CURRENT_TRACE = contextvars.ContextVar("evalpilot_trace", default=None)
CURRENT_SPAN = contextvars.ContextVar("evalpilot_span", default=None)
PRIVATE_KEYS = re.compile(r"(?i)(?:password|passwd|secret|authorization|api.?key|access.?token|refresh.?token|^token$|cookie|credential|身份证|银行卡|密码|验证码)")
VALID_ID = re.compile(r"^[a-f0-9]{32}$")
VALID_SPAN_ID = re.compile(r"^[a-f0-9]{16}$")
VALID_KINDS = {"agent", "guardrail", "memory", "retrieval", "model", "tool", "routing", "evaluation", "storage", "internal"}


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def redact(value, depth=0):
    if depth > 8:
        return "[DEPTH_LIMIT]"
    if isinstance(value, dict):
        return {redact(str(key))[:120]: "[REDACTED]" if PRIVATE_KEYS.search(str(key)) else redact(item, depth + 1) for key, item in list(value.items())[:100]}
    if isinstance(value, (list, tuple)):
        return [redact(item, depth + 1) for item in value[:100]]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return "[REDACTED_NUMBER]" if abs(value) >= 10_000_000 else value
    if isinstance(value, float):
        return "[NON_FINITE]" if not math.isfinite(value) else "[REDACTED_NUMBER]" if abs(value) >= 10_000_000 else value
    text = str(value)
    patterns = [
        (r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)", "[REDACTED_PRIVATE_KEY]"),
        (r"(?i)\b(?:sk-|ghp_|github_pat_|AKIA)[a-z0-9_-]{10,}\b", "[REDACTED_CREDENTIAL]"),
        (r"(?i)\bBearer\s+[^\s\"']+", "Bearer [REDACTED]"),
        (r"(?i)((?:password|api[_-]?key|token|secret|密码|验证码)\s*[:：=]\s*)[^\s,;\"']+", r"\1[REDACTED]"),
        (r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[REDACTED_EMAIL]"),
        (r"(?<![A-Za-z0-9])\+?\d[\d\s().-]{6,}\d(?![A-Za-z0-9])", "[REDACTED_NUMBER]"),
        (r"/(?:Users|home)/[^/\s]+", "/[LOCAL_USER]"),
    ]
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text, flags=re.S)
    return text[:3500] + ("…[TRUNCATED]" if len(text) > 3500 else "")


class TraceStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()

    def initialize(self, recover=True):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, sqlite3.connect(str(self.path), timeout=30) as database:
            database.execute("PRAGMA journal_mode=WAL")
            database.execute("CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
        if recover:
            for trace in self.all():
                if trace["status"] == "running":
                    trace.update(status="interrupted", finishedAt=timestamp(), interruption="服务重启，未将不完整轨迹伪装为完成")
                    for span in trace["spans"]:
                        if span["status"] == "running":
                            span.update(status="interrupted", error={"type": "ServiceRestart", "message": "服务重启前该步骤尚未结束"})
                    self.save(trace)

    def save(self, trace):
        with self.lock, sqlite3.connect(str(self.path), timeout=30) as database:
            database.execute("INSERT OR REPLACE INTO traces(id,payload) VALUES (?,?)", (trace["id"], json.dumps(trace, ensure_ascii=False, allow_nan=False)))

    def get(self, identifier):
        with self.lock, sqlite3.connect(str(self.path), timeout=30) as database:
            row = database.execute("SELECT payload FROM traces WHERE id=?", (identifier,)).fetchone()
        return json.loads(row[0]) if row else None

    def all(self):
        with self.lock, sqlite3.connect(str(self.path), timeout=30) as database:
            rows = database.execute("SELECT payload FROM traces").fetchall()
        return [json.loads(row[0]) for row in rows]

    def annotate(self, identifier, event, attributes):
        with self.lock:
            trace = self.get(identifier)
            if trace:
                trace.setdefault("annotations", []).append({"name": event, "at": timestamp(), "attributes": redact(attributes)})
                self.save(trace)
        return trace

    def ingest(self, payload, gate=None):
        validate_import(payload)
        with self.lock:
            if self.get(payload["id"]):
                raise ValueError("相同 traceId 已存在，禁止覆盖历史证据")
            allowed = {key: payload[key] for key in ("id", "name", "startedAt", "durationMs", "status", "spans")}
            allowed.update(schemaVersion="1.0", origin="client_reported", execution="外部 Agent 自报，服务端未验证其是否实际执行", source=redact(str(payload.get("source", "external-agent"))[:80]), sessionId=None, conversationId=None, runId=None, input=redact(payload.get("input")), output=redact(payload.get("output")), attributes=redact(payload.get("attributes", {})), issues=[], annotations=[], finishedAt=timestamp(), spanCount=len(payload["spans"]), errorCount=sum(span["status"] == "error" for span in payload["spans"]), redaction="入库前字段与内容掩码；无法保证识别人名或所有语义性敏感信息")
            allowed["spans"] = [{key: redact(span.get(key)) if key in {"name", "input", "output", "attributes", "events", "error"} else span.get(key) for key in ("id", "parentId", "name", "kind", "status", "startMs", "durationMs", "input", "output", "attributes", "events", "error")} for span in payload["spans"]]
            allowed["name"] = redact(allowed["name"])
            started = datetime.datetime.fromisoformat(payload["startedAt"].replace("Z", "+00:00"))
            allowed.update(finishedAt=(started + datetime.timedelta(milliseconds=payload["durationMs"])).isoformat(), receivedAt=timestamp())
            for observation in allowed["spans"]:
                observation["attributes"] = observation["attributes"] or {}
                observation["events"] = observation["events"] or []
            if any(span["status"] == "error" for span in allowed["spans"]):
                allowed["issues"].append({"kind": "execution", "code": "reported_step_error", "message": "外部记录包含步骤错误，请核对 Agent 日志", "spanId": next(span["id"] for span in allowed["spans"] if span["status"] == "error")})
            if gate:
                content = {key: allowed[key] for key in ("name", "source", "input", "output", "attributes")}
                content["spans"] = [{key: observation[key] for key in ("name", "input", "output", "attributes", "events", "error")} for observation in allowed["spans"]]
                gate([json.dumps(content, ensure_ascii=False, allow_nan=False)])
            self.save(allowed)
        return allowed


def finite_number(value):
    if not isinstance(value, (float, int)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def validate_import(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not VALID_ID.fullmatch(payload["id"]):
        raise ValueError("traceId 需要 32 位小写十六进制")
    if not isinstance(payload.get("name"), str) or not 1 <= len(payload["name"]) <= 180:
        raise ValueError("Trace 名称需要 1–180 字符")
    try:
        started = datetime.datetime.fromisoformat(payload["startedAt"].replace("Z", "+00:00"))
        if started.tzinfo is None:
            raise ValueError()
    except (KeyError, AttributeError, TypeError, ValueError):
        raise ValueError("开始时间需要含时区的 ISO-8601 日期") from None
    if payload.get("status") not in ("ok", "error", "blocked", "cancelled") or not finite_number(payload.get("durationMs")):
        raise ValueError("仅接收已结束且耗时有效的 Trace")
    try:
        started + datetime.timedelta(milliseconds=payload["durationMs"])
    except (OverflowError, ValueError):
        raise ValueError("Trace 结束时间超出可表示范围") from None
    if not isinstance(payload.get("attributes", {}), dict) or not isinstance(payload.get("source", "external-agent"), str):
        raise ValueError("Trace 属性须为对象，来源须为文本")
    spans = payload.get("spans")
    if not isinstance(spans, list) or not 1 <= len(spans) <= 250:
        raise ValueError("每条 Trace 需要 1–250 个 span")
    indexed = {}
    for span in spans:
        if not isinstance(span, dict) or not isinstance(span.get("id"), str) or not VALID_SPAN_ID.fullmatch(span["id"]) or span["id"] in indexed:
            raise ValueError("spanId 需要唯一的 16 位小写十六进制")
        if not isinstance(span.get("kind"), str) or span["kind"] not in VALID_KINDS or span.get("status") not in ("ok", "error", "blocked", "cancelled"):
            raise ValueError("不支持的步骤类型或状态")
        if not isinstance(span.get("name"), str) or not 1 <= len(span["name"]) <= 180:
            raise ValueError("步骤名称不合法")
        if not finite_number(span.get("startMs")) or not finite_number(span.get("durationMs")):
            raise ValueError("步骤计时必须是有限非负数")
        if span["startMs"] + span["durationMs"] > payload["durationMs"] + 2:
            raise ValueError("步骤耗时超出 Trace 时间范围")
        if span.get("parentId") is not None and (not isinstance(span["parentId"], str) or not VALID_SPAN_ID.fullmatch(span["parentId"])):
            raise ValueError("parentId 须为 spanId 或 null")
        if not isinstance(span.get("attributes", {}), dict):
            raise ValueError("步骤属性须为对象")
        events = span.get("events", [])
        if not isinstance(events, list) or len(events) > 100:
            raise ValueError("步骤事件须为数组，最多 100 条")
        for event in events:
            if not isinstance(event, dict) or not isinstance(event.get("name"), str) or not 1 <= len(event["name"]) <= 180 or not finite_number(event.get("offsetMs")) or not isinstance(event.get("attributes", {}), dict):
                raise ValueError("事件名称、时间或属性不合法")
            if event["offsetMs"] + 2 < span["startMs"] or event["offsetMs"] > span["startMs"] + span["durationMs"] + 2:
                raise ValueError("事件时间超出步骤范围")
        error = span.get("error")
        if error is not None:
            if not isinstance(error, dict) or not isinstance(error.get("type"), str) or not isinstance(error.get("message"), str) or not isinstance(error.get("frames", []), list) or len(error.get("frames", [])) > 20:
                raise ValueError("异常详情格式不合法")
            for frame in error.get("frames", []):
                if not isinstance(frame, dict) or not isinstance(frame.get("file"), str) or not isinstance(frame.get("function"), str) or not isinstance(frame.get("line"), int) or isinstance(frame["line"], bool) or frame["line"] < 1:
                    raise ValueError("异常代码定位格式不合法")
        indexed[span["id"]] = span
    roots = [span for span in spans if span.get("parentId") is None]
    if len(roots) != 1 or roots[0]["status"] != payload["status"]:
        raise ValueError("需要一个与整体状态一致的根 span")
    for span in spans:
        path = {span["id"]}
        current = span
        while current.get("parentId") is not None:
            parent_id = current["parentId"]
            if parent_id not in indexed or parent_id in path:
                raise ValueError("父子关系缺失或包含循环")
            parent = indexed[parent_id]
            if current["startMs"] + 2 < parent["startMs"] or current["startMs"] + current["durationMs"] > parent["startMs"] + parent["durationMs"] + 2:
                raise ValueError("子步骤时间不在父步骤范围内")
            path.add(parent_id)
            current = parent


class Span:
    def __init__(self, trace, name, kind="internal", inputs=None, attributes=None):
        self.trace = trace
        self.started = None
        self.token = None
        if kind not in VALID_KINDS:
            raise ValueError("不支持的步骤类型")
        self.record = {"id": secrets.token_hex(8), "parentId": CURRENT_SPAN.get(), "name": redact(name), "kind": kind, "status": "running", "startMs": 0, "durationMs": None, "input": redact(inputs), "output": None, "attributes": redact(attributes or {}), "events": [], "error": None}

    def __enter__(self):
        self.started = time.perf_counter()
        self.record["startMs"] = round((self.started - self.trace.started) * 1000, 3)
        self.token = CURRENT_SPAN.set(self.record["id"])
        self.trace.record["spans"].append(self.record)
        self.trace.flush()
        return self

    def output(self, value):
        self.record["output"] = redact(value)

    def attributes(self, **attributes):
        self.record["attributes"].update(redact(attributes))

    def event(self, name, attributes=None):
        self.record["events"].append({"name": redact(name), "offsetMs": round((time.perf_counter() - self.trace.started) * 1000, 3), "attributes": redact(attributes or {})})

    def outcome(self, status):
        if status not in ("ok", "error", "blocked", "cancelled"):
            raise ValueError("非法 span 状态")
        self.record["status"] = status

    def __exit__(self, error_type, error, stack):
        self.record["durationMs"] = round((time.perf_counter() - self.started) * 1000, 3)
        if error:
            self.record["status"] = "blocked" if getattr(error, "trace_blocked", False) else "cancelled" if isinstance(error, InterruptedError) else "error"
            self.record["error"] = {"type": error_type.__name__, "message": redact(str(error)), "frames": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name} for frame in traceback.extract_tb(stack)[-6:]]}
        elif self.record["status"] == "running":
            self.record["status"] = "ok"
        CURRENT_SPAN.reset(self.token)
        self.trace.flush()
        return False


class Trace:
    def __init__(self, store, name, source="support.chat", inputs=None, attributes=None):
        self.store = store
        self.started = None
        self.root = None
        self.token = None
        self.parent_token = None
        self.record = {"schemaVersion": "1.0", "id": secrets.token_hex(16), "name": name, "source": source, "origin": "local_instrumented", "execution": "本机埋点记录的实际调用", "sessionId": None, "conversationId": None, "runId": None, "status": "running", "startedAt": timestamp(), "finishedAt": None, "durationMs": None, "input": redact(inputs), "output": None, "attributes": redact(attributes or {}), "spans": [], "issues": [], "annotations": [], "spanCount": 0, "errorCount": 0, "redaction": "入库前掩码；未经检查的用户输入不记录正文；不记录模型隐藏思维链"}
        self.record.update(name=redact(name), source=redact(source))

    @property
    def id(self):
        return self.record["id"]

    def __enter__(self):
        self.started = time.perf_counter()
        self.token = CURRENT_TRACE.set(self)
        self.record["startedAt"] = timestamp()
        self.parent_token = CURRENT_SPAN.set(None)
        self.root = Span(self, self.record["name"], "evaluation" if self.record["source"] in ("support.evaluation", "support.uat") else "agent", self.record["input"])
        self.root.__enter__()
        return self

    def flush(self):
        self.record["spanCount"] = len(self.record["spans"])
        self.record["errorCount"] = sum(span["status"] == "error" for span in self.record["spans"])
        self.store.save(self.record)

    def link(self, **links):
        for key in ("sessionId", "conversationId", "runId"):
            if key in links:
                self.record[key] = links[key]
        self.flush()

    def output(self, value):
        self.record["output"] = redact(value)
        self.root.output(value)

    def issue(self, code, message, kind="quality", span_id=None):
        self.record["issues"].append({"code": code, "message": redact(message), "kind": kind, "spanId": span_id or CURRENT_SPAN.get()})

    def __exit__(self, error_type, error, stack):
        self.root.__exit__(error_type, error, stack)
        self.record.update(status=self.root.record["status"], finishedAt=timestamp(), durationMs=round((time.perf_counter() - self.started) * 1000, 3))
        if error:
            self.issue("input_blocked" if getattr(error, "trace_blocked", False) else "execution_error", "输入被拒绝，正文没有记录" if getattr(error, "trace_blocked", False) else redact(str(error)), kind="execution", span_id=self.record["spans"][-1]["id"])
        self.flush()
        CURRENT_SPAN.reset(self.parent_token)
        CURRENT_TRACE.reset(self.token)
        return False


class NullSpan:
    def output(self, value):
        pass

    def attributes(self, **attributes):
        pass

    def event(self, name, attributes=None):
        pass

    def outcome(self, status):
        pass


@contextlib.contextmanager
def span(name, kind="internal", inputs=None, attributes=None):
    trace = CURRENT_TRACE.get()
    if trace is None:
        yield NullSpan()
    else:
        with Span(trace, name, kind, inputs, attributes) as child:
            yield child
