import collections
import hashlib
import json
from pathlib import Path
import re
import threading
import time
from statistics import NormalDist

import joblib
import numpy as np
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score, f1_score, precision_recall_fscore_support
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.svm import LinearSVC
from threadpoolctl import threadpool_limits
from tracing import span

ENGINE_VERSION = "support-0.2.0"
FIT_LOCK = threading.Lock()
MODEL_CACHE = {}


def rows_for(root, dataset_id):
    with span("读取并校验公开数据", "retrieval", {"datasetId": dataset_id}) as observation:
        result = _rows_for(root, dataset_id)
        observation.output({"datasetId": dataset_id, "sha256": result[0]["sha256"], "rowCount": len(result[1]), "splits": result[0]["splits"]})
        return result


def _rows_for(root, dataset_id):
    if dataset_id not in ("bitext", "banking77"):
        raise ValueError("请选择已接入的公开数据集")
    metadata = next(item for item in json.loads((root / "datasets/manifest.json").read_text()) if item["id"] == dataset_id)
    path = root / "datasets" / metadata["file"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != metadata["sha256"]:
        raise ValueError("数据完整性校验失败，请重新导入公开数据")
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    return metadata, rows


def normalize_question(text):
    return re.sub(r"[^\w]+", " ", text.casefold()).strip()


def leakage_check(rows):
    split_sets = {split: {normalize_question(row["text"]) for row in rows if row["split"] == split} for split in ("train", "validation", "test")}
    overlaps = {"trainTest": len(split_sets["train"] & split_sets["test"]), "validationTest": len(split_sets["validation"] & split_sets["test"]), "trainValidation": len(split_sets["train"] & split_sets["validation"])}
    if any(overlaps.values()):
        raise ValueError("训练 / 验证 / 测试集发现归一化相同问题，评测已停止")
    return overlaps


def cache_key(metadata):
    return hashlib.sha256((metadata["sha256"] + ENGINE_VERSION + sklearn.__version__).encode()).hexdigest()[:20]


def build_models():
    baseline = Pipeline([("text", TfidfVectorizer(ngram_range=(1, 1), sublinear_tf=True, max_features=25000)), ("classifier", MultinomialNB(alpha=.5))])
    features = FeatureUnion([("word", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, max_features=45000)), ("character", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, sublinear_tf=True, max_features=65000))])
    candidate = Pipeline([("text", features), ("classifier", LinearSVC(C=1.0, dual="auto", max_iter=3000, random_state=42))])
    return {"baseline": baseline, "candidate": candidate}


def infer_matrix(model, texts, variant):
    values = model.decision_function(texts) if variant == "candidate" else model.predict_log_proba(texts)
    ordering = np.argsort(values, axis=1)[:, ::-1]
    classes = model.classes_
    predicted = classes[ordering[:, 0]]
    margins = values[np.arange(len(texts)), ordering[:, 0]] - values[np.arange(len(texts)), ordering[:, 1]]
    top_three = classes[ordering[:, :3]].tolist()
    return predicted, margins, top_three


def calibrate(model, validation):
    texts = [row["text"] for row in validation]
    labels = np.array([row["intent"] for row in validation])
    predictions, margins, _ = infer_matrix(model, texts, "candidate")
    choices = []
    for threshold in np.unique(np.quantile(margins, np.linspace(0, 1, 101))):
        accepted = margins >= threshold
        count = int(accepted.sum())
        if count >= 30:
            accuracy = float(np.mean(predictions[accepted] == labels[accepted]))
            if accuracy >= .95:
                choices.append((count, float(threshold), accuracy))
    count, threshold, accuracy = max(choices, key=lambda choice: choice[0]) if choices else (0, float(margins.max() + 1), None)
    return {"threshold": round(threshold, 8), "validationCount": len(validation), "accepted": count, "accuracy": round(accuracy * 100, 2) if accuracy is not None else None, "method": "仅在 validation 上选取经验准确率 ≥95% 且至少30条的最大覆盖 margin 阈值；不是校准概率或生产 SLA。"}


def fit_models(root, model_dir, dataset_id, progress=lambda stage: None):
    with span("准备意图模型", "model", {"datasetId": dataset_id}, {"architecture": "TF-IDF + NB / LinearSVC", "remoteCalls": False}) as observation:
        result = _fit_models(root, model_dir, dataset_id, progress)
        observation.output({"cacheHit": result[3], "dataHash": result[1]["sha256"], "engineVersion": ENGINE_VERSION, "sklearnVersion": sklearn.__version__, "threshold": result[0]["calibration"]["threshold"]})
        return result


def _fit_models(root, model_dir, dataset_id, progress):
    metadata, rows = rows_for(root, dataset_id)
    with span("训练、验证与测试集隔离检查", "guardrail") as observation:
        observation.output(leakage_check(rows))
    key = cache_key(metadata)
    with FIT_LOCK:
        if key in MODEL_CACHE:
            with span("读取进程内模型缓存", "storage", {"cacheKey": key}) as observation:
                observation.output({"hit": True})
                return MODEL_CACHE[key], metadata, rows, True
        model_dir.mkdir(parents=True, exist_ok=True)
        path = model_dir / f"{dataset_id}-{key}.joblib"
        if path.exists():
            progress("读取本机训练缓存，并核对数据指纹")
            with span("读取本机模型文件", "storage", {"cacheKey": key, "trustedSource": "本应用自己训练的本地缓存"}) as observation:
                trained = joblib.load(path)
                observation.output({"engineVersion": trained["engineVersion"], "dataHash": trained["hash"]})
            MODEL_CACHE[key] = trained
            return trained, metadata, rows, True
        train = [row for row in rows if row["split"] == "train"]
        validation = [row for row in rows if row["split"] == "validation"]
        models = build_models()
        started = time.perf_counter()
        with threadpool_limits(limits=2):
            for variant, model in models.items():
                progress("训练词级朴素贝叶斯基线" if variant == "baseline" else "训练词级 + 字符级线性 SVM 候选")
                with span("拟合朴素贝叶斯基线" if variant == "baseline" else "拟合线性 SVM 候选", "model", {"fitSplit": "train", "rowCount": len(train), "variant": variant}) as observation:
                    model.fit([row["text"] for row in train], [row["intent"] for row in train])
                    observation.output({"classes": len(model.classes_), "testUsedForFit": False})
            progress("只用验证集选择建议转人工阈值")
            with span("验证集路由阈值选择", "evaluation", {"split": "validation", "rowCount": len(validation)}) as observation:
                calibration = calibrate(models["candidate"], validation)
                observation.output(calibration)
        trained = {"models": models, "calibration": calibration, "trainSeconds": round(time.perf_counter() - started, 2), "hash": metadata["sha256"], "engineVersion": ENGINE_VERSION, "sklearnVersion": sklearn.__version__}
        temporary = path.with_suffix(".temporary")
        joblib.dump(trained, temporary)
        temporary.replace(path)
        MODEL_CACHE[key] = trained
        return trained, metadata, rows, False


def wilson(correct, total):
    proportion = correct / total
    z_value = NormalDist().inv_cdf(.975)
    denominator = 1 + z_value ** 2 / total
    center = (proportion + z_value ** 2 / (2 * total)) / denominator
    radius = z_value * np.sqrt(proportion * (1 - proportion) / total + z_value ** 2 / (4 * total ** 2)) / denominator
    return [round(float(max(0, center - radius) * 100), 2), round(float(min(1, center + radius) * 100), 2)]


def paired_interval(baseline_correct, candidate_correct):
    differences = candidate_correct.astype(float) - baseline_correct.astype(float)
    generator = np.random.default_rng(42)
    bootstraps = [float(generator.choice(differences, len(differences), replace=True).mean()) for _ in range(1000)]
    return {"delta": round(float(differences.mean() * 100), 2), "interval": [round(float(value * 100), 2) for value in np.quantile(bootstraps, [.025, .975])], "method": "配对 bootstrap 1,000 次 / seed 42 / 单位：百分点"}


def evaluate_public(root, model_dir, dataset_id, progress, cancelled):
    trained, metadata, rows, cache_hit = fit_models(root, model_dir, dataset_id, lambda stage: progress(stage, 0, 0))
    if cancelled():
        raise InterruptedError("评测已取消")
    testing = [row for row in rows if row["split"] == "test"]
    texts = [row["text"] for row in testing]
    truth = np.array([row["intent"] for row in testing])
    labels = sorted(set(truth.tolist()))
    progress("在独立测试集上执行基线与候选模型", 0, len(testing) * 2)
    metrics, predictions, margins, top_three, correct_arrays = {}, {}, {}, {}, {}
    elapsed_total = 0
    with threadpool_limits(limits=2):
        for variant, model in trained["models"].items():
            started = time.perf_counter()
            guesses, confidence, top = [], [], []
            batch_latencies = []
            for offset in range(0, len(testing), 128):
                if cancelled():
                    raise InterruptedError("评测已取消")
                batch_start = time.perf_counter()
                with span(f"测试集批次 · {variant}", "model", {"split": "test", "offset": offset, "batchCount": len(texts[offset:offset + 128])}) as observation:
                    predicted, batch_margins, best = infer_matrix(model, texts[offset:offset + 128], variant)
                    observation.output({"predictionCount": len(predicted), "variant": variant})
                batch_latencies.append((time.perf_counter() - batch_start) * 1000)
                guesses.extend(predicted.tolist())
                confidence.extend(batch_margins.tolist())
                top.extend(best)
                progress(f"测试集推理 · {'基线' if variant == 'baseline' else '候选'}", (len(testing) if variant == "candidate" else 0) + len(guesses), len(testing) * 2)
            elapsed = time.perf_counter() - started
            elapsed_total += elapsed
            predictions[variant], margins[variant], top_three[variant] = np.array(guesses), np.array(confidence), top
            correct = np.array(guesses) == truth
            correct_arrays[variant] = correct
            precision, recall, score, support = precision_recall_fscore_support(truth, guesses, labels=labels, zero_division=0)
            metrics[variant] = {"accuracy": round(float(accuracy_score(truth, guesses) * 100), 2), "macroF1": round(float(f1_score(truth, guesses, average="macro") * 100), 2), "top3": round(sum(truth[index] in items for index, items in enumerate(top)) / len(testing) * 100, 2), "correct": int(correct.sum()), "total": len(testing), "failed": int((~correct).sum()), "accuracyInterval": wilson(int(correct.sum()), len(testing)), "batchP95Ms": round(float(np.percentile(batch_latencies, 95)), 2), "batchSize": 128, "throughput": round(len(testing) / elapsed, 1), "perIntent": [{"intent": label, "precision": round(float(precision[index] * 100), 2), "recall": round(float(recall[index] * 100), 2), "f1": round(float(score[index] * 100), 2), "support": int(support[index])} for index, label in enumerate(labels)]}
    accepted = margins["candidate"] >= trained["calibration"]["threshold"]
    acceptance = {"count": int(accepted.sum()), "coverage": round(float(accepted.mean() * 100), 2), "accuracy": round(float(correct_arrays["candidate"][accepted].mean() * 100), 2) if accepted.any() else None, "deferred": int((~accepted).sum()), "label": "仅意图路由建议覆盖率，不是自动解决率；无域外检测保证"}
    confusion = collections.Counter((truth[index], predictions["candidate"][index]) for index in range(len(testing)) if not correct_arrays["candidate"][index])
    results = [{"id": row["id"], "text": row["text"], "expected": row["intent"], "baseline": str(predictions["baseline"][index]), "candidate": str(predictions["candidate"][index]), "passed": bool(correct_arrays["candidate"][index]), "baselinePassed": bool(correct_arrays["baseline"][index]), "top3": top_three["candidate"][index], "margin": round(float(margins["candidate"][index]), 5), "defer": not bool(accepted[index]), "sourceRow": row["originalRow"], "sourceFile": row["sourceFile"]} for index, row in enumerate(testing)]
    with span("汇总指标与配对置信区间", "evaluation", {"testCount": len(testing), "bootstrapIterations": 1000, "seed": 42}) as observation:
        comparison = paired_interval(correct_arrays["baseline"], correct_arrays["candidate"])
        observation.output({"accuracy": metrics["candidate"]["accuracy"], "failures": metrics["candidate"]["failed"], "comparison": comparison, "routing": acceptance})
    return {"metrics": metrics, "comparison": comparison, "routing": acceptance, "calibration": trained["calibration"], "confusions": [{"expected": expected, "actual": actual, "count": count} for (expected, actual), count in confusion.most_common(15)], "results": results, "dataset": metadata, "protocol": {"engine": ENGINE_VERSION, "sklearn": sklearn.__version__, "seed": 42, "fitSplit": "train", "calibrationSplit": "validation", "evaluationSplit": "test", "models": {"baseline": "TF-IDF unigram + MultinomialNB α=0.5", "candidate": "TF-IDF word(1,2) + char_wb(3,5) + LinearSVC C=1"}, "leakage": leakage_check(rows), "trainSeconds": trained["trainSeconds"], "evaluationSeconds": round(elapsed_total, 2), "cacheHit": cache_hit, "timestampSource": "本机实测", "boundary": "本次仅评估英文闭集意图分类；不是 LLM 答复质量、中文能力或实际业务解决率。"}}


def predict_intent(root, model_dir, dataset_id, text):
    trained, metadata, _, _ = fit_models(root, model_dir, dataset_id)
    started = time.perf_counter()
    with span("执行英文意图分类", "model", {"query": text}, {"datasetId": dataset_id, "model": "TF-IDF word + char / LinearSVC", "dataHash": metadata["sha256"], "marginIsProbability": False}) as observation:
        predicted, margins, top = infer_matrix(trained["models"]["candidate"], [text], "candidate")
        result = {"intent": str(predicted[0]), "margin": round(float(margins[0]), 5), "top3": top[0], "defer": bool(margins[0] < trained["calibration"]["threshold"]), "threshold": trained["calibration"]["threshold"], "latencyMs": round((time.perf_counter() - started) * 1000, 2), "datasetHash": metadata["sha256"]}
        observation.output(result)
        return result
