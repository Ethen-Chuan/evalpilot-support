import hashlib
import json
import random
import re
import statistics
import unicodedata

ENGINE_VERSION = "0.1.0"
DIMENSIONS = [
    {"id": "reasoning", "name": "逻辑推理", "short": "推理", "metric": "Exact Match", "description": "数学与约束推理，归一化后精确匹配标准答案。", "mode": "文本"},
    {"id": "writing", "name": "写作生成", "short": "写作", "metric": "Constraint Coverage", "description": "计算必需信息点覆盖率；不代表完整的文采或事实性评价。", "mode": "规则代理"},
    {"id": "dialogue", "name": "对话交互", "short": "对话", "metric": "Constraint Coverage", "description": "检查上下文中的明确约束与答复信息点。", "mode": "文本"},
    {"id": "memory", "name": "长程记忆", "short": "记忆", "metric": "Constraint Coverage", "description": "多轮上下文事实保留与更新，使用信息点规则。", "mode": "文本"},
    {"id": "rag", "name": "AI 搜索 / RAG", "short": "搜索", "metric": "Evidence Coverage", "description": "答案关键信息及引用标识覆盖率；不是 Ragas 官方指标。", "mode": "规则代理"},
    {"id": "speech", "name": "语音转写", "short": "语音", "metric": "1 − CER", "description": "对已有转写文本计算字符错误率，不调用语音模型。", "mode": "转写结果"},
    {"id": "vision", "name": "视觉理解", "short": "视觉", "metric": "Token F1", "description": "比较空格分隔的对象标签，不输入图像，不等同于 VLM benchmark。", "mode": "标注结果"},
]
DIMENSION_MAP = {dimension["id"]: dimension for dimension in DIMENSIONS}


def normalize(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).lower()).strip("。.!！")


def edit_distance(reference, actual):
    previous = list(range(len(actual) + 1))
    for reference_index, reference_char in enumerate(reference, 1):
        current = [reference_index]
        for actual_index, actual_char in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[actual_index] + 1, previous[actual_index - 1] + (reference_char != actual_char)))
        previous = current
    return previous[-1]


def evaluate(case, actual):
    metric = case["metric"]
    expected = case["expected"]
    if metric == "exact":
        score = float(normalize(actual) == normalize(expected))
        evidence = "归一化答案完全一致" if score else "归一化答案与标准答案不一致"
    elif metric == "coverage":
        required = case["required"]
        found = [term for term in required if normalize(term) in normalize(actual)]
        missing = [term for term in required if term not in found]
        score = len(found) / len(required)
        evidence = f"命中 {len(found)}/{len(required)} 项约束" + (f"；缺失：{'、'.join(missing)}" if missing else "；全部覆盖")
    elif metric == "cer":
        reference = normalize(expected)
        hypothesis = normalize(actual)
        distance = edit_distance(reference, hypothesis)
        error_rate = distance / max(1, len(reference))
        score = max(0.0, 1.0 - error_rate)
        evidence = f"编辑距离 {distance} / 参考字符 {len(reference)}；CER {error_rate:.1%}"
    elif metric == "token_f1":
        reference_tokens = set(expected.lower().split())
        actual_tokens = set(actual.lower().split())
        overlap = len(reference_tokens & actual_tokens)
        denominator = len(reference_tokens) + len(actual_tokens)
        score = 2 * overlap / denominator if denominator else 1.0
        evidence = f"标签交集 {overlap}；参考 {len(reference_tokens)} 项 / 预测 {len(actual_tokens)} 项"
    else:
        raise ValueError("不支持的评估器")
    return {"score": round(score * 100, 2), "passed": score >= case.get("threshold", 0.8), "evidence": evidence, "metric": metric}


def fingerprint(cases):
    payload = json.dumps(cases, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def aggregate(results):
    grouped = {}
    for result in results:
        grouped.setdefault(result["model"], []).append(result)
    summaries = {}
    for model, rows in grouped.items():
        latency = sorted(row.get("latencyMs", 0) for row in rows)
        summaries[model] = {
            "score": round(statistics.mean(row["score"] for row in rows), 1),
            "passRate": round(sum(row["passed"] for row in rows) / len(rows) * 100, 1),
            "passed": sum(row["passed"] for row in rows), "total": len(rows),
            "failures": sum(not row["passed"] for row in rows),
            "p95Ms": round(latency[max(0, int(len(latency) * .95) - 1)], 2),
            "dimensions": {dimension["id"]: round(statistics.mean(row["score"] for row in rows if row["dimension"] == dimension["id"]), 1) for dimension in DIMENSIONS if any(row["dimension"] == dimension["id"] for row in rows)},
        }
    return summaries


def paired_comparison(results, seed=42):
    indexed = {}
    for row in results:
        indexed.setdefault(row["caseId"], {})[row["model"]] = row["score"]
    differences = [scores["candidate"] - scores["baseline"] for scores in indexed.values() if "candidate" in scores and "baseline" in scores]
    if not differences:
        return {"delta": None, "low": None, "high": None, "pairs": 0, "method": "无配对样本"}
    generator = random.Random(seed)
    bootstraps = sorted(statistics.mean(generator.choices(differences, k=len(differences))) for _ in range(1000))
    return {"delta": round(statistics.mean(differences), 2), "low": round(bootstraps[24], 2), "high": round(bootstraps[974], 2), "pairs": len(differences), "method": "配对 bootstrap · 1,000 次 · 95% 区间 · seed 42"}


def make_cases():
    cases = []
    topics = ["露营灯", "保温杯", "便携键盘", "降噪耳机", "旅行背包", "桌面台灯", "跑步手表", "读书支架", "咖啡杯", "骑行头盔", "雨伞", "笔记本"]
    for dimension_index, dimension in enumerate(DIMENSIONS):
        for case_index in range(12):
            topic = topics[case_index]
            required = []
            if dimension["id"] == "reasoning":
                quantity, price, discount = case_index + 3, case_index + 12, case_index + 2
                prompt = f"购买 {quantity} 件商品，每件 {price} 元，整单优惠 {discount} 元。实付多少元？只输出数字。"
                expected = str(quantity * price - discount)
                metric, flawed = "exact", str(quantity * price)
            elif dimension["id"] == "writing":
                required = [topic, "便携", "使用", "注意"]
                prompt = f"为{topic}写一段简短说明，必须包含原词：{'、'.join(required)}。"
                expected = f"这款{topic}设计便携，适合日常使用，请注意遵循说明。"
                metric, flawed = "coverage", f"{topic}设计便携，适合日常生活。"
            elif dimension["id"] == "dialogue":
                required = ["周六", "室内", "两小时", "无需预约"]
                prompt = f"用户想体验{topic}相关活动。用户：我周六有空，不能在室外，只有两小时，不想预约。请复述所有约束，包含原词。"
                expected = f"建议选择周六的室内{topic}体验，控制在两小时，优先无需预约的活动。"
                metric, flawed = "coverage", f"可以周六来体验{topic}，两小时足够。"
            elif dimension["id"] == "memory":
                required = [topic, "绿色", "周日", "两个"]
                prompt = f"第1轮：买一个蓝色{topic}，周六取。第2轮：改成绿色。第3轮：数量改成两个，周日取。请总结最终需求，保留原词。"
                expected = f"最终需求：两个绿色{topic}，周日取。"
                metric, flawed = "coverage", f"最终需求：一个绿色{topic}，周六取。"
            elif dimension["id"] == "rag":
                required = ["七天", "未使用", "包装完整", "[1]"]
                prompt = f"资料[1]：{topic}收货七天内，未使用且包装完整可退。资料[2]：运费另计。问题：退货条件是什么？引用资料编号，保留原词。"
                expected = f"收货七天内、未使用且包装完整可退 [1]。"
                metric, flawed = "coverage", "七天内可以退货，包装完整即可。"
            elif dimension["id"] == "speech":
                prompt = f"离线转写核验：{topic}客服录音的人工转写结果。此用例不含音频。"
                expected = f"请帮我查询一下{topic}的配送时间谢谢"
                metric, flawed = "cer", f"帮我查{topic}配送谢谢"
            else:
                prompt = f"离线对象标注核验：场景编号 {case_index + 1}，比较预存标签。此用例不含图像。"
                expected = f"{topic} 桌子 窗户 绿植"
                metric, flawed = "token_f1", f"{topic} 桌子 人物"
            case_id = f"{dimension['id'][:3].upper()}-{case_index + 1:03}"
            baseline_bad = (case_index + dimension_index) % 4 == 0 or (dimension["id"] == "memory" and case_index % 3 == 0)
            candidate_bad = case_index in ({2, 6, 10} if dimension["id"] in ("memory", "rag") else ({7} if dimension["id"] != "reasoning" else set()))
            cases.append({"id": case_id, "dimension": dimension["id"], "title": f"{dimension['short']} · {topic if dimension['id'] != 'reasoning' else '折扣计算'} · {case_index + 1:02}", "prompt": prompt, "expected": expected, "required": required, "metric": metric, "threshold": .8, "difficulty": "困难" if case_index % 3 == 0 else "中等", "source": "原创合成演示用例", "baseline": flawed if baseline_bad else expected, "candidate": flawed if candidate_bad else expected, "flawed": flawed})
    return cases


def fixture_output(case, model, profile=5):
    if model == "baseline":
        return case["baseline"]
    case_number = int(case["id"].split("-")[-1])
    if profile < 5 and case_number in list(range(1, 6 - profile)):
        return case["flawed"]
    return case["candidate"]
