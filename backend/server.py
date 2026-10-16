import csv
import datetime
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine import ENGINE_VERSION, DIMENSIONS, DIMENSION_MAP, aggregate, evaluate, fingerprint, fixture_output, make_cases, paired_comparison
from providers import infer, provider_status
import support_api

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("EVAL_DATA_DIR", str(ROOT / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE = DATA_DIR / "evalpilot.sqlite3"
LOCK = threading.RLock()
PORT = int(os.environ.get("PORT", "4287"))
MAX_BODY = 256_000


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def connect():
    database = sqlite3.connect(str(DATABASE), timeout=30)
    database.execute("PRAGMA journal_mode=WAL")
    return database


def save(kind, key, value):
    with LOCK, connect() as database:
        database.execute("INSERT OR REPLACE INTO records(kind,id,payload) VALUES (?,?,?)", (kind, key, json.dumps(value, ensure_ascii=False)))


def load(kind, key):
    with LOCK, connect() as database:
        row = database.execute("SELECT payload FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
    return json.loads(row[0]) if row else None


def all_records(kind):
    with LOCK, connect() as database:
        rows = database.execute("SELECT payload FROM records WHERE kind=?", (kind,)).fetchall()
    return [json.loads(row[0]) for row in rows]


def safe_text(value, maximum=300):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("文本不能为空或超过长度限制")
    patterns = [r"-----BEGIN .*PRIVATE KEY-----", r"(?i)(?:sk-|ghp_|github_pat_|AKIA)[a-zA-Z0-9_-]{12,}", r"(?i)(?:api[_ -]?key|password|token|密码)\s*[:=]\s*\S{5,}", r"(?<!\d)\d{16,19}(?!\d)", r"(?<!\d)1[3-9]\d{9}(?!\d)", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"]
    if any(re.search(pattern, value) for pattern in patterns):
        raise ValueError("发现疑似敏感信息，请替换为匿名内容后重试；原文未保存")
    return value.strip()


def scan_outbound(cases):
    candidates = [Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "dlp/dlp", Path.home() / ".config/ept/codex/dlp/dlp", Path.home() / ".codex/dlp/dlp"]
    scanner = next((path for path in candidates if path.is_file()), None)
    if scanner is None:
        raise ValueError("外发门禁：本地脱敏扫描器不可用，禁止向模型发送用例")
    with tempfile.TemporaryDirectory(prefix="evalpilot-scan-") as directory:
        payload = Path(directory) / "eval-outbound.json"
        payload.write_text(json.dumps(cases, ensure_ascii=False))
        result = subprocess.run([str(scanner), "report", str(payload)], capture_output=True, text=True, timeout=30)
        report = result.stdout + result.stderr
        if result.returncode != 0 or not re.search(r"最高风险\s*S0", report):
            raise ValueError("外发门禁：扫描未通过或需要人工复核；未发送任何用例")


def selected_cases(dataset_id):
    dataset = load("dataset", dataset_id)
    if dataset is None:
        raise ValueError("评测集不存在")
    cases = [load("case", case_id) for case_id in dataset["caseIds"]]
    return dataset, cases


def result_for(case, model, mode="demo", profile=5):
    started = time.perf_counter()
    actual = fixture_output(case, model, profile) if mode == "demo" else infer(case["prompt"], model)
    measured = evaluate(case, actual)
    return {"caseId": case["id"], "dimension": case["dimension"], "title": case["title"], "model": model, "actual": actual, "expected": case["expected"], "prompt": case["prompt"], "threshold": case["threshold"], "latencyMs": round((time.perf_counter() - started) * 1000, 3), **measured}


def complete(run):
    run.update(status="completed", finishedAt=now(), summary=aggregate(run["results"]), comparison=paired_comparison(run["results"]))
    save("run", run["id"], run)
    if run.get("actionId"):
        action = load("action", run["actionId"])
        if action:
            candidate_rows = [row for row in run["results"] if row["model"] == "candidate"]
            action.update(status="done" if candidate_rows and all(row["passed"] for row in candidate_rows) else "progress", regressionRun=run["id"], verification="通过" if candidate_rows and all(row["passed"] for row in candidate_rows) else "仍有失败用例", updatedAt=now())
            save("action", action["id"], action)


def execute(run_id):
    run = load("run", run_id)
    try:
        if run["mode"] == "live":
            scan_outbound(run["snapshot"])
        for case in run["snapshot"]:
            for model in ("baseline", "candidate"):
                with LOCK:
                    latest = load("run", run_id)
                    if latest["status"] == "cancelled":
                        return
                row = result_for(case, model, run["mode"], run["profile"])
                with LOCK:
                    latest = load("run", run_id)
                    if latest["status"] == "cancelled":
                        return
                    run["results"].append(row)
                    run["completed"] = len(run["results"])
                    save("run", run_id, run)
                if run["mode"] == "demo":
                    time.sleep(.025)
        with LOCK:
            if load("run", run_id)["status"] != "cancelled":
                complete(run)
    except Exception as error:
        with LOCK:
            if load("run", run_id)["status"] == "cancelled":
                return
            run.update(status="failed", error=str(error) if isinstance(error, ValueError) else "评测失败，内部错误详情未对外暴露", finishedAt=now())
            save("run", run_id, run)


def create_run(body):
    name = safe_text(body.get("name", "新建综合评测"), 80)
    dataset, cases = selected_cases(body.get("datasetId", "core-v1"))
    mode = body.get("mode", "demo")
    if mode not in ("demo", "live"):
        raise ValueError("无效运行模式")
    if mode == "live":
        if body.get("consent") is not True:
            raise ValueError("真实评测需要确认外发用例及可能产生的费用")
        if not provider_status()["configured"]:
            raise ValueError("真实模型服务尚未配置")
        if any(case["dimension"] in ("speech", "vision") for case in cases):
            raise ValueError("文本端点不支持语音/视觉结果代理集，请选择文本集")
    action_id = body.get("actionId")
    if action_id:
        action = load("action", action_id)
        if not action:
            raise ValueError("优化任务不存在")
        cases = [case for case in cases if case["id"] in action["caseIds"]]
        if not cases:
            raise ValueError("当前评测集未包含此任务的回归样本")
    with LOCK:
        if any(run["status"] == "running" for run in all_records("run")):
            raise ValueError("已有任务执行中，请完成或取消后再试")
        run_id = "RUN-" + uuid.uuid4().hex[:8].upper()
        run = {"id": run_id, "name": name, "datasetId": dataset["id"], "datasetName": dataset["name"], "datasetVersion": dataset["version"], "hash": fingerprint(cases), "snapshot": cases, "engineVersion": ENGINE_VERSION, "seed": 42, "profile": 5, "mode": mode, "models": {"baseline": "Demo v1" if mode == "demo" else provider_status()["baseline"], "candidate": "Demo v2" if mode == "demo" else provider_status()["candidate"]}, "status": "running", "createdAt": now(), "total": len(cases) * 2, "completed": 0, "results": [], "actionId": action_id}
        save("run", run_id, run)
        if action_id:
            action.update(status="verify", regressionRun=run_id, verification="回归执行中", updatedAt=now())
            save("action", action_id, action)
    threading.Thread(target=execute, args=(run_id,), daemon=True).start()
    return run


def initialize():
    with connect() as database:
        database.execute("CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id))")
    for run in all_records("run"):
        if run["status"] == "running":
            run.update(status="failed", error="服务重启中断了此任务，可重新运行", finishedAt=now())
            save("run", run["id"], run)
    if load("meta", "seed"):
        return
    cases = make_cases()
    for case in cases:
        save("case", case["id"], case)
    datasets = [
        {"id": "core-v1", "name": "通用能力评测集", "description": "覆盖七大能力的原创合成用例，适合演示完整评测闭环。", "caseIds": [case["id"] for case in cases], "category": "综合", "version": "1.0.0"},
        {"id": "text-v1", "name": "文本与推理专项", "description": "推理、写作、对话、记忆与 RAG，可接入真实文本模型。", "caseIds": [case["id"] for case in cases if case["dimension"] not in ("speech", "vision")], "category": "文本", "version": "1.0.0"},
        {"id": "rag-v1", "name": "检索增强与引用一致性", "description": "基于给定材料的答案信息点与引用标识核验。", "caseIds": [case["id"] for case in cases if case["dimension"] == "rag"], "category": "RAG", "version": "1.0.0"},
        {"id": "multimodal-v1", "name": "多模态结果核验集", "description": "语音转写 CER 与图像对象标签 F1；仅离线结果核验。", "caseIds": [case["id"] for case in cases if case["dimension"] in ("speech", "vision")], "category": "多模态代理", "version": "1.0.0"},
        {"id": "regression-v1", "name": "用户反馈回归集", "description": "从匿名合成交互反馈沉淀的回归样本。", "caseIds": ["MEM-003", "RAG-007", "DIA-008"], "category": "回归", "version": "1.0.0"},
    ]
    for dataset in datasets:
        save("dataset", dataset["id"], dataset)
    for index in range(6):
        run_id = f"RUN-DEMO-{index + 1:03}"
        started = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=(5-index)*2, hours=1)).isoformat()
        rows = [result_for(case, model, profile=index) for case in cases for model in ("baseline", "candidate")]
        run = {"id": run_id, "name": ["基础能力基线", "对话约束评测", "记忆保持回归", "检索增强验证", "多维能力回归", "通用能力 · 版本迭代评测"][index], "datasetId": "core-v1", "datasetName": "通用能力评测集", "datasetVersion": "1.0.0", "hash": fingerprint(cases), "snapshot": cases, "engineVersion": ENGINE_VERSION, "seed": 42, "profile": index, "mode": "demo", "models": {"baseline": "Demo v1", "candidate": f"Demo v2 · 快照 {index + 1}"}, "status": "completed", "createdAt": started, "finishedAt": started, "completed": len(rows), "total": len(rows), "results": rows, "summary": aggregate(rows), "comparison": paired_comparison(rows)}
        save("run", run_id, run)
    actions = [
        {"id": "OPT-001", "title": "修复多轮对话中的最终约束遗失", "dimension": "memory", "priority": "P1", "owner": "算法团队", "status": "progress", "caseIds": ["MEM-003", "MEM-007", "MEM-011"], "description": "将用户最新更新提取为结构化记忆，区分已覆盖的旧约束。验收：关联样本全部达到阈值。"},
        {"id": "OPT-002", "title": "补全检索答案的证据与引用", "dimension": "rag", "priority": "P1", "owner": "工程团队", "status": "todo", "caseIds": ["RAG-003", "RAG-007", "RAG-011"], "description": "生成前校验引用标识，证据缺失时输出保守答复。验收：关联样本全部达到阈值。"},
        {"id": "OPT-003", "title": "对话体验：显式确认用户限制", "dimension": "dialogue", "priority": "P2", "owner": "产品团队", "status": "todo", "caseIds": ["DIA-008"], "description": "先总结用户限制，再生成建议，避免遗漏室内与预约要求。"},
    ]
    for action in actions:
        action.update(createdAt=now(), updatedAt=now(), source="合成演示任务")
        save("action", action["id"], action)
    for index, case_id in enumerate(["MEM-003", "RAG-007", "DIA-008", "WRI-008", "MEM-011", "RAG-003", "REA-001", "DIA-002"]):
        case = next(case for case in cases if case["id"] == case_id)
        trace = {"id": f"TRACE-{index + 1:04}", "session": f"匿名会话 {index + 1:03}", "caseId": case_id, "dimension": case["dimension"], "query": case["prompt"], "response": case["candidate"], "feedback": "negative" if index < 6 else "positive", "reason": ["没有保留最终约束", "引用不完整", "没有满足所有限制", "生成信息不完整", "重复确认已经提供的信息", "遗漏来源条件", "答复正确", "满足要求"][index], "createdAt": now(), "source": "合成反馈，非真实用户日志"}
        save("trace", trace["id"], trace)
    save("meta", "seed", {"version": 1})


def public_run(run, full=False):
    excluded = {"snapshot"} if full else {"snapshot", "results"}
    return {key: value for key, value in run.items() if key not in excluded}


def state():
    datasets = all_records("dataset")
    for dataset in datasets:
        cases = [load("case", case_id) for case_id in dataset["caseIds"]]
        dataset.update(count=len(cases), hash=fingerprint(cases), dimensions=list(dict.fromkeys(case["dimension"] for case in cases)))
    return {"runs": [public_run(run) for run in sorted(all_records("run"), key=lambda row: row["createdAt"], reverse=True)], "datasets": datasets, "dimensions": DIMENSIONS, "actions": all_records("action"), "traces": all_records("trace"), "references": json.loads((ROOT / "backend/references.json").read_text()), "provider": provider_status(), "engine": {"version": ENGINE_VERSION, "seed": 42, "mode": "local", "database": "SQLite", "privacy": "本地存储 · 演示模式无外部模型调用"}}


def report(run):
    summaries = run.get("summary", {})
    candidate, baseline = summaries.get("candidate", {}), summaries.get("baseline", {})
    comparison = run.get("comparison", {})
    lines = [f"# {run['name']}", "", f"运行编号：{run['id']}", f"数据性质：{'合成演示数据，不是真实模型成绩' if run['mode'] == 'demo' else '真实模型 API 结果'}", f"评测集：{run['datasetName']} / {run['datasetVersion']}", f"内容哈希：{run['hash']}", f"引擎：{run['engineVersion']} / 随机种子：42 / Fixture profile：{run['profile']}", f"基线：{run['models']['baseline']} / 候选：{run['models']['candidate']}", "", "## 结果", f"候选综合得分：{candidate.get('score', '未完成')} / 基线：{baseline.get('score', '未完成')}", f"候选通过率：{candidate.get('passRate', '未完成')}%", f"配对提升：{comparison.get('delta')} 分；95% 区间 [{comparison.get('low')}, {comparison.get('high')}]；配对样本 {comparison.get('pairs', 0)}", "统计：逐样本等权平均；配对 bootstrap 1000 次，seed 42。小规模合成样本不能外推为总体能力或生产上线依据。", "", "## 各维度", "| 维度 | 基线 | 候选 | 指标 |", "| --- | ---: | ---: | --- |"]
    for dimension in DIMENSIONS:
        if dimension["id"] in candidate.get("dimensions", {}):
            lines.append(f"| {dimension['name']} | {baseline.get('dimensions', {}).get(dimension['id'])} | {candidate['dimensions'][dimension['id']]} | {dimension['metric']} |")
    lines.extend(["", "## 失败样本及改进建议"])
    for result in run["results"]:
        if result["model"] == "candidate" and not result["passed"]:
            lines.append(f"- {result['caseId']} / {result['score']} 分：{result['evidence']}。建议：补齐约束或检查参考标签，并加入回归集。")
    lines.extend(["", "## 能力边界", "写作、记忆、RAG 使用透明规则代理，不等同于人工或 LLM Judge 的综合评价。语音只核验转写文本，视觉只核验对象标签，未运行原始音频或图像模型。未计算模型 Token 费用，不将本地规则耗时冒充推理耗时。", "", "## 可复现配置", "下载同一运行的 config.json 可检查完整样本快照、断言、模型与参数。真实模型服务本身可能非确定性，seed 仅控制本地 bootstrap。"])
    return "\n".join(lines)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format_string, *args):
        pass

    def send(self, status, body, content_type="application/json; charset=utf-8", filename=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        body = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api") else "no-cache")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        return self.headers.get("Host", "") in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, {"error": "只允许本地访问"})
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/support/"):
            try:
                payload, content_type, filename = support_api.dispatch_get(path, urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
                return self.send(200, payload, content_type or "application/json; charset=utf-8", filename)
            except (ValueError, KeyError, TypeError):
                return self.send(400, {"error": "请求参数不正确或记录不存在"})
        if path == "/api/state":
            return self.send(200, state())
        if path.startswith("/api/runs/"):
            parts = path.split("/")
            run = load("run", parts[3])
            if not run:
                return self.send(404, {"error": "评测任务不存在"})
            if len(parts) == 4:
                return self.send(200, public_run(run, True))
            if parts[-1] == "report.md":
                return self.send(200, report(run), "text/markdown; charset=utf-8", f"{run['id']}-report.md")
            if parts[-1] == "config.json":
                payload = {key: run[key] for key in ("id", "datasetId", "datasetVersion", "hash", "snapshot", "engineVersion", "seed", "profile", "mode", "models")}
                payload.update(temperature=0, maxTokens=512, aggregation="micro-average", bootstrapIterations=1000)
                return self.send(200, payload, filename=f"{run['id']}-config.json")
            if parts[-1] == "results.csv":
                stream = io.StringIO()
                writer = csv.writer(stream)
                writer.writerow(["case_id", "dimension", "model", "score", "passed", "actual", "expected", "evidence"])
                for row in run["results"]:
                    values = [row[key] for key in ("caseId", "dimension", "model", "score", "passed", "actual", "expected", "evidence")]
                    writer.writerow(["'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value for value in values])
                return self.send(200, "\ufeff" + stream.getvalue(), "text/csv; charset=utf-8", f"{run['id']}-results.csv")
        if path.startswith("/api/datasets/"):
            try:
                dataset, cases = selected_cases(path.split("/")[3])
                return self.send(200, {"dataset": dataset, "cases": cases})
            except ValueError as error:
                return self.send(404, {"error": str(error)})
        if path.startswith("/api/"):
            return self.send(404, {"error": "接口不存在"})
        dist = ROOT / "dist"
        target = (dist / urllib.parse.unquote(path).lstrip("/")).resolve()
        if not target.is_relative_to(dist.resolve()):
            return self.send(403, {"error": "拒绝访问"})
        if not target.is_file():
            target = dist / "index.html"
        if not target.exists():
            return self.send(503, {"error": "请先构建前端"})
        return self.send(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")

    def do_POST(self):
        origin = self.headers.get("Origin")
        if not self.valid_host() or (origin and origin not in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}", "http://127.0.0.1:5173", "http://localhost:5173"}):
            return self.send(403, {"error": "来源校验失败"})
        if self.path.startswith(('/api/support/lab/', '/api/support/experience/')) and self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.send(415, {'error': '模型配置和执行接口只接受 JSON 请求'})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body_limit = 6_000_000 if urllib.parse.urlparse(self.path).path == '/api/support/lab/multimodal/assets' else MAX_BODY
            if length <= 0 or length > body_limit:
                return self.send(413, {"error": "请求内容为空或超过限制"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("请求需要 JSON 对象")
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/support/"):
                return self.send(200, support_api.dispatch_post(path, body))
            if path == "/api/datasets":
                name = safe_text(body.get("name"), 80)
                raw_cases = body.get("cases")
                if not isinstance(raw_cases, list) or not 1 <= len(raw_cases) <= 100:
                    raise ValueError("需要 1–100 条用例组成的 JSON 数组")
                dataset_id = "custom-" + uuid.uuid4().hex[:8]
                cases = []
                for index, raw in enumerate(raw_cases, 1):
                    if not isinstance(raw, dict):
                        raise ValueError("每条用例必须是 JSON 对象")
                    dimension = raw.get("dimension")
                    metric = raw.get("metric")
                    threshold = raw.get("threshold", .8)
                    if dimension not in DIMENSION_MAP or metric not in ("exact", "coverage", "cer", "token_f1"):
                        raise ValueError("用例维度或评估器不受支持")
                    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 <= threshold <= 1:
                        raise ValueError("threshold 必须是 0–1 之间的数值")
                    required = raw.get("required", [])
                    if not isinstance(required, list) or len(required) > 30 or (metric == "coverage" and not required):
                        raise ValueError("coverage 需要 1–30 个 required 信息点")
                    required = list(dict.fromkeys(safe_text(term, 100) for term in required))
                    case = {"id": f"CUS{dataset_id[-4:].upper()}-{index:03}", "dimension": dimension, "title": safe_text(raw.get("title", f"自定义样本 {index}"), 80), "prompt": safe_text(raw.get("prompt"), 4000), "expected": safe_text(raw.get("expected"), 4000), "baseline": safe_text(raw.get("baseline"), 4000), "candidate": safe_text(raw.get("candidate"), 4000), "metric": metric, "required": required, "threshold": threshold, "source": "用户提供的匿名文本用例", "difficulty": "自定义"}
                    case["flawed"] = case["baseline"]
                    cases.append(case)
                scan_outbound([{"datasetName": name, "cases": cases}])
                dataset = {"id": dataset_id, "name": name, "description": "用户自定义的匿名业务用例；通过本地扫描后保存。", "caseIds": [case["id"] for case in cases], "category": "自定义", "version": "1.0.0"}
                with LOCK, connect() as database:
                    for case in cases:
                        database.execute("INSERT INTO records(kind,id,payload) VALUES (?,?,?)", ("case", case["id"], json.dumps(case, ensure_ascii=False)))
                    database.execute("INSERT INTO records(kind,id,payload) VALUES (?,?,?)", ("dataset", dataset_id, json.dumps(dataset, ensure_ascii=False)))
                return self.send(201, dataset)
            if path == "/api/runs":
                return self.send(201, public_run(create_run(body)))
            if path.endswith("/cancel") and path.startswith("/api/runs/"):
                with LOCK:
                    run = load("run", path.split("/")[3])
                    if not run or run["status"] != "running":
                        raise ValueError("任务不存在或已结束")
                    run.update(status="cancelled", finishedAt=now())
                    save("run", run["id"], run)
                return self.send(200, public_run(run))
            if path == "/api/actions":
                case_ids = body.get("caseIds", [])
                if not isinstance(case_ids, list) or not case_ids or len(case_ids) > 100 or not all(isinstance(case_id, str) and load("case", case_id) for case_id in case_ids):
                    raise ValueError("请选择有效的关联样本")
                title = safe_text(body.get("title"), 100)
                action_id = "OPT-" + uuid.uuid4().hex[:6].upper()
                action = {"id": action_id, "title": title, "description": safe_text(body.get("description", "修复后运行关联样本回归；全部通过后自动验收。"), 1000), "owner": safe_text(body.get("owner", "算法团队"), 40), "priority": "P1", "status": "todo", "caseIds": list(dict.fromkeys(case_ids)), "dimension": load("case", case_ids[0])["dimension"], "createdAt": now(), "updatedAt": now(), "source": "失败样本分析"}
                save("action", action_id, action)
                return self.send(201, action)
            if path.startswith("/api/actions/"):
                with LOCK:
                    action = load("action", path.split("/")[3])
                    if not action:
                        raise ValueError("任务不存在")
                    status = body.get("status")
                    if status not in ("todo", "progress"):
                        raise ValueError("任务必须通过关联样本回归才能验收完成")
                    action.update(status=status, updatedAt=now())
                    save("action", action["id"], action)
                return self.send(200, action)
            if path == "/api/traces/promote":
                with LOCK:
                    trace = load("trace", body.get("traceId", ""))
                    if not trace:
                        raise ValueError("交互记录不存在")
                    dataset = load("dataset", "regression-v1")
                    if trace["caseId"] not in dataset["caseIds"]:
                        dataset["caseIds"].append(trace["caseId"])
                        version_parts = dataset["version"].split(".")
                        dataset["version"] = ".".join(version_parts[:2] + [str(int(version_parts[2]) + 1)])
                        save("dataset", dataset["id"], dataset)
                return self.send(200, dataset)
            return self.send(404, {"error": "接口不存在"})
        except support_api.TracedRequestError as error:
            return self.send(400 if error.trace_blocked else 500, {"error": str(error), "traceId": error.trace_id, "blocked": error.trace_blocked})
        except (ValueError, TypeError, KeyError) as error:
            return self.send(400, {"error": str(error) if isinstance(error, ValueError) else "请求字段格式不正确"})
        except Exception:
            return self.send(500, {"error": "服务暂时无法处理请求"})


if __name__ == "__main__":
    initialize()
    support_api.initialize()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"EvalPilot ready: http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
