import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import unicodedata


def normalized(text):
    return re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", text).lower()).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unsafe(text):
    patterns = [r"\d[\d\s-]{6,}\d", r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", r"(?i)https?://\S+", r"(?i)\bconfidential\b|\binternal.only\b|\bsecret\b", r"(?i)\b(?:customer|client|contact)\s+list\b", r"(?i)(?:password|pin|token)\s*[:=]\s*\S+"]
    return any(re.search(pattern, text) for pattern in patterns)


def partition(rows, test_keys=None, has_official_split=False):
    groups = collections.defaultdict(list)
    seen = set()
    duplicate_count = 0
    cross_split = 0
    for row in rows:
        key = normalized(row["text"])
        if test_keys is not None and key in test_keys:
            cross_split += 1
            continue
        if key in seen:
            duplicate_count += 1
            continue
        seen.add(key)
        groups[row["intent"]].append(row)
    output = []
    for intent, entries in sorted(groups.items()):
        entries.sort(key=lambda row: hashlib.sha256(("42:" + normalized(row["text"])).encode()).hexdigest())
        count = len(entries)
        validation_count = max(1, round(count * .1))
        test_count = 0 if has_official_split else max(1, round(count * .1))
        for index, row in enumerate(entries):
            row["split"] = "validation" if index < validation_count else "test" if index < validation_count + test_count else "train"
            output.append(row)
    return output, duplicate_count, cross_split


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw, output = Path(args.raw), Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    metadata = []
    for dataset_id in ("bitext", "banking77"):
        rejected, rows, source_counts = 0, [], {}
        filenames = ["bitext_original.csv"] if dataset_id == "bitext" else ["banking77_train.csv", "banking77_test.csv"]
        for filename in filenames:
            with (raw / filename).open(newline="", encoding="utf-8-sig") as stream:
                records = list(csv.DictReader(stream))
            source_counts[filename] = len(records)
            for index, record in enumerate(records, 1):
                text = record["instruction" if dataset_id == "bitext" else "text"].strip()
                if unsafe(text):
                    rejected += 1
                    continue
                row = {"id": f"{dataset_id.upper()}-{'TEST' if 'test.csv' in filename else 'SRC'}-{index:05}", "text": text, "intent": record["intent" if dataset_id == "bitext" else "category"], "category": record.get("category", "banking"), "originalRow": index, "sourceFile": filename, "language": "en"}
                rows.append(row)
        if dataset_id == "banking77":
            official_test = [row for row in rows if "test.csv" in row["sourceFile"]]
            test_keys = {normalized(row["text"]) for row in official_test}
            train, duplicates, overlap = partition([row for row in rows if "train.csv" in row["sourceFile"]], test_keys, True)
            for row in official_test:
                row["split"] = "test"
            prepared = train + official_test
            split_policy = "官方 test 保持隔离；原 train 内按标签分层取 10% validation；清除 train/test 归一化重复；固定 SHA-256 排序 seed 42。"
        else:
            prepared, duplicates, overlap = partition(rows)
            split_policy = "官方无测试拆分。本地按意图分层 80/10/10，先归一化去重后按 SHA-256 排序；seed 42。模板近义改写仍可能跨集合，因此分数不外推到生产。"
        prepared.sort(key=lambda row: row["id"])
        destination = output / f"{dataset_id}_redacted.jsonl"
        destination.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in prepared) + "\n")
        splits = collections.Counter(row["split"] for row in prepared)
        metadata.append({"id": dataset_id, "name": "Bitext · 电商客服意图" if dataset_id == "bitext" else "BANKING77 · 银行业客服意图", "provider": "Bitext" if dataset_id == "bitext" else "PolyAI / Casanueva et al.", "nature": "公开混合合成语料" if dataset_id == "bitext" else "公开标注银行客服查询", "language": "英语原文", "scope": "电商客服 · 订单 / 售后 / 账户" if dataset_id == "bitext" else "银行客服 · 外部泛化参照，不提供金融建议", "license": "CDLA-Sharing-1.0" if dataset_id == "bitext" else "CC-BY-4.0", "source": "https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset" if dataset_id == "bitext" else "https://github.com/PolyAI-LDN/task-specific-datasets", "revision": "430d1a89bd93bd1fa23c16f29dd53e73f0087443" if dataset_id == "bitext" else "57ec275d8078af65b7731c2a98be812d844a6d6b", "downloadedAt": "2026-10-10", "originalCount": sum(source_counts.values()), "sourceCounts": source_counts, "count": len(prepared), "intents": len({row['intent'] for row in prepared}), "splits": dict(splits), "excludedSensitive": rejected, "deduplicated": duplicates, "crossSplitRemoved": overlap, "file": destination.name, "sha256": digest(destination), "rawHashes": {name: digest(raw / name) for name in filenames}, "splitPolicy": split_policy, "preprocessing": "保留问题、意图及行号；不导入模板回答；隔离疑似联系方式、长编号、保密标记及私人链接所在问题；不翻译，不修改保留问题的原文。", "scan": "待复扫", "limitations": "不是中文客服成绩，不证明生成回答质量或业务解决率。"})
    (output / "manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    shutil.copyfile(raw / "banking77_LICENSE.txt", output / "BANKING77_LICENSE.txt")
    shutil.copyfile(raw / "banking77_README.md", output / "BANKING77_DATA_CARD.md")
    shutil.copyfile(raw / "bitext_README.md", output / "BITEXT_DATA_CARD.md")
    shutil.copyfile(raw / "CDLA-Sharing-1.0.html", output / "BITEXT_LICENSE.html")
    print(json.dumps([{key: item[key] for key in ("id", "originalCount", "count", "intents", "splits", "excludedSensitive", "deduplicated", "crossSplitRemoved")} for item in metadata], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
