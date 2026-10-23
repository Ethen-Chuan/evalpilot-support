import copy
import datetime
import hashlib
import json
import re
import uuid
from dataset_labels import add_conditions, facets, parse_filters

ROLES = {"user": "客户", "assistant": "智能客服", "human": "人工客服", "system": "系统", "tool": "工具"}
ROLE_PREFIXES = {"用户": "user", "客户": "user", "客服": "assistant", "助手": "assistant", "智能客服": "assistant", "人工客服": "human", "人工": "human", "系统": "system", "工具": "tool"}


def fingerprint(messages):
    return hashlib.sha256(json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def analyze(messages, intent_labels):
    signals = []
    topics = []
    seen_questions = {}
    previous_intent = None
    sources = {}
    for message in messages:
        if message["role"] == "user":
            normalized = re.sub(r"[\W_]+", "", message["content"].casefold())
            if message.get('metadata', {}).get('redacted') and message['content'].startswith('['):
                normalized = ''
            if normalized and normalized in seen_questions:
                signals.append({"kind": "repeated_question", "title": "客户重复提出相同问题", "description": "归一化文本重复，需结合上下文确认是否未获解决；不是自动结论。", "messageIds": [seen_questions[normalized], message["id"]]})
            elif normalized:
                seen_questions[normalized] = message["id"]
        metadata = message.get("metadata", {})
        intent = metadata.get("intent")
        if intent and intent != "unknown" and intent != previous_intent:
            topics.append({"intent": intent, "label": intent_labels.get(intent, intent), "messageId": message["id"]})
            previous_intent = intent
        if message["role"] == "human":
            signals.append({"kind": "human_reply", "title": "记录包含人工客服发言", "description": "角色由导入方提供，平台没有验证真人身份或工单转接结果。", "messageIds": [message["id"]]})
        if metadata.get("feedback") == "negative":
            signals.append({"kind": "negative_feedback", "title": "此处有用户负反馈", "description": "该标记来自本机会话实际反馈，建议检查前后轮次与回答依据。", "messageIds": [message["id"]]})
        if metadata.get("handoff"):
            signals.append({"kind": "handoff", "title": "客服建议转人工", "description": "记录的是升级建议，不代表人工已接通或业务已完成。", "messageIds": [message["id"]]})
        if metadata.get("observedLocally") and message["role"] == "assistant" and not metadata.get("source"):
            signals.append({"kind": "missing_evidence", "title": "此轮没有可用知识引用", "description": "检查知识未覆盖或分类分差过低的可能性，点击本轮 Trace 核实。", "messageIds": [message["id"]]})
        source = metadata.get("source")
        if source:
            key = f"{source['id']}:v{source['version']}"
            sources.setdefault(key, {"id": source["id"], "title": source["title"], "version": source["version"], "messageIds": []})["messageIds"].append(message["id"])
    customer = [message for message in messages if message["role"] == "user"]
    replies = [message for message in messages if message["role"] in ("assistant", "human")]
    unanswered = bool(messages and messages[-1]["role"] == "user")
    if unanswered:
        signals.append({"kind": "unanswered", "title": "最后一条客户消息尚无后续答复", "description": "仅根据本次记录顺序判断，不推断记录范围以外的处理结果。", "messageIds": [messages[-1]["id"]]})
    return {"method": "全量消息顺序与元数据规则分析；无 LLM 总结或情绪推断", "messageCount": len(messages), "customerTurns": len(customer), "replyCount": len(replies), "humanReplies": sum(message["role"] == "human" for message in messages), "traceCount": len({message.get("traceId") for message in messages if message.get("traceId")}), "openingRequest": customer[0]["content"] if customer else None, "lastReply": replies[-1]["content"] if replies else None, "outcome": "待业务人员确认，不根据有无答复判定解决", "unanswered": unanswered, "topics": topics, "signals": signals, "sources": list(sources.values())}


class DialogueService:
    def __init__(self, repository):
        self.repository = repository

    def initialize_index(self):
        with self.repository.connection() as database:
            database.executescript('''
                CREATE TABLE IF NOT EXISTS dialogue_summaries(id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, payload TEXT NOT NULL, search_text TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS dialogue_dataset ON dialogue_summaries(dataset_id);
                CREATE INDEX IF NOT EXISTS archive_session ON documents(json_extract(payload,'$.sessionId')) WHERE kind='dialogue_archive';
                CREATE TABLE IF NOT EXISTS dialogue_dirty(id TEXT PRIMARY KEY);
            ''')
            for action, reference in [('INSERT', 'new'), ('UPDATE', 'new'), ('DELETE', 'old')]:
                database.execute(f'''CREATE TRIGGER IF NOT EXISTS dialogue_index_{action.lower()} AFTER {action} ON documents
                    WHEN {reference}.kind IN ('conversation','imported_dialogue','dialogue_archive') BEGIN
                    INSERT OR IGNORE INTO dialogue_dirty(id) VALUES (CASE WHEN {reference}.kind='imported_dialogue' THEN {reference}.id ELSE json_extract({reference}.payload,'$.sessionId') END);
                    END''')
            database.execute('''INSERT OR IGNORE INTO dialogue_dirty(id)
                SELECT CASE WHEN kind='imported_dialogue' THEN id ELSE json_extract(payload,'$.sessionId') END AS session_id
                FROM documents WHERE kind IN ('conversation','imported_dialogue') AND session_id NOT IN (SELECT id FROM dialogue_summaries)''')

    @staticmethod
    def index_session(database, session):
        row = {key: session[key] for key in ('id', 'title', 'origin', 'sourceLabel', 'createdAt', 'updatedAt', 'hash', 'archives')}
        row.update(datasetId=session.get('datasetId', ''), labelSummary=session.get('labelSummary'), messageCount=len(session['messages']), customerTurns=session['analysis']['customerTurns'], signalCount=len(session['analysis']['signals']), preview=session['messages'][-1]['content'][:120])
        search_text = '\n'.join([session['title'], session['id']] + [message['content'] for message in session['messages']]).casefold()
        database.execute('INSERT OR REPLACE INTO dialogue_summaries(id,dataset_id,payload,search_text) VALUES (?,?,?,?)', (session['id'], session.get('datasetId', ''), json.dumps(row, ensure_ascii=False), search_text))
        database.execute('DELETE FROM dialogue_dirty WHERE id=?', (session['id'],))

    def refresh_index(self):
        with self.repository.LOCK, self.repository.connection() as database:
            dirty = [row[0] for row in database.execute('SELECT id FROM dialogue_dirty')]
            for identifier in dirty:
                try:
                    session = self.assemble(identifier)
                except ValueError:
                    database.execute('DELETE FROM dialogue_summaries WHERE id=?', (identifier,))
                    database.execute('DELETE FROM dialogue_dirty WHERE id=?', (identifier,))
                    continue
                self.index_session(database, session)

    def assemble(self, identifier, turns=None):
        imported = self.repository.get("imported_dialogue", identifier)
        if imported:
            result = copy.deepcopy(imported)
        else:
            turns = turns if turns is not None else [turn for turn in self.repository.records("conversation") if turn["sessionId"] == identifier]
            turns = sorted(turns, key=lambda turn: (turn.get("sequence", 0), turn["createdAt"], turn["id"]))
            if not turns:
                raise ValueError("会话不存在")
            messages = []
            for turn in turns:
                common = {"traceId": turn.get("traceId"), "turnId": turn["id"]}
                messages.append({**common, "id": turn["id"] + "-user", "role": "user", "content": turn["message"], "at": turn.get("requestedAt"), "metadata": {"observedLocally": True}})
                messages.append({**common, "id": turn["id"] + "-assistant", "role": "assistant", "content": turn["answer"], "at": turn["createdAt"], "metadata": {"observedLocally": True, "source": turn["source"], "intent": turn["intent"], "handoff": turn["handoff"], "feedback": turn.get("feedback"), "method": turn["method"]}})
            result = {"id": identifier, "title": turns[0]["message"][:80], "origin": "local_test", "sourceLabel": "本机客服试用 · 非生产客户记录", "createdAt": turns[0].get("requestedAt", turns[0]["createdAt"]), "updatedAt": turns[-1]["createdAt"], "messages": messages, "completeness": "包含此会话所有已保存的成功问答；被隐私门禁拒绝的输入不保留原文，失败尝试仅见 Trace。"}
        for index, message in enumerate(result["messages"], 1):
            message["sequence"] = index
        result["hash"] = fingerprint(result["messages"])
        result["analysis"] = analyze(result["messages"], self.repository.INTENTS)
        with self.repository.connection() as database:
            archives = database.execute('''SELECT json_object('id',id,'version',json_extract(payload,'$.version'),'createdAt',json_extract(payload,'$.createdAt'),'hash',json_extract(payload,'$.hash'),'messageCount',json_extract(payload,'$.messageCount'),'title',json_extract(payload,'$.title'))
                FROM documents WHERE kind='dialogue_archive' AND json_extract(payload,'$.sessionId')=? ORDER BY json_extract(payload,'$.version') DESC''', (identifier,)).fetchall()
        result["archives"] = [json.loads(row[0]) for row in archives]
        return result

    def sessions(self, query):
        scope, labels = parse_filters(query)
        include_facets = query.get('facets', ['0'])[0] == '1'
        dataset = query.get('dataset', [''])[0]
        if include_facets and (not dataset or not self.repository.get('corpus', dataset)):
            raise ValueError('分类统计需要选择已导入的项目')
        self.refresh_index()
        search = query.get("q", [""])[0].casefold()[:200]
        status = query.get("status", ["all"])[0]
        conditions, parameters = ['1=1'], []
        if search:
            conditions.append('instr(search_text,?)>0')
            parameters.append(search)
        if dataset:
            conditions.append('dataset_id=?')
            parameters.append(dataset)
        filters = {'archived': "json_array_length(payload,'$.archives')>0", 'unarchived': "json_array_length(payload,'$.archives')=0", 'attention': "json_extract(payload,'$.signalCount')>0", 'imported': "json_extract(payload,'$.origin')='user_imported'", 'gap': "EXISTS(SELECT 1 FROM json_each(dialogue_summaries.payload,'$.labelSummary.values.kb_expectation') WHERE value='gap')", 'invalid': "EXISTS(SELECT 1 FROM json_each(dialogue_summaries.payload,'$.labelSummary.values.is_invalid') WHERE value IN ('yes','是'))", 'label_conflict': "json_array_length(payload,'$.labelSummary.conflicts')>0"}
        if status in filters:
            conditions.append(filters[status])
        add_conditions(conditions, parameters, scope, labels)
        page = max(1, int(query.get("page", ["1"])[0]))
        where = ' AND '.join(conditions)
        with self.repository.connection() as database:
            database.execute('BEGIN')
            total = database.execute('SELECT count(*) FROM dialogue_summaries WHERE ' + where, parameters).fetchone()[0]
            rows = database.execute("SELECT payload FROM dialogue_summaries WHERE " + where + " ORDER BY json_extract(payload,'$.updatedAt') DESC,id LIMIT 20 OFFSET ?", parameters + [(page - 1) * 20]).fetchall()
            stats = database.execute("SELECT count(*),coalesce(sum(json_extract(payload,'$.messageCount')),0),coalesce(sum(json_array_length(payload,'$.archives')>0),0) FROM dialogue_summaries").fetchone()
            distribution = facets(database, where, parameters, dataset, scope, labels) if include_facets else None
        result = {'sessions': [json.loads(row[0]) for row in rows], 'total': total, 'page': page, 'pageSize': 20, 'corpora': self.repository.records('corpus'), 'stats': {'sessions': stats[0], 'messages': stats[1], 'archived': stats[2], 'drafts': sum(draft['status'] == 'draft' for draft in self.repository.records('knowledge_draft'))}}
        if include_facets:
            result['facets'] = distribution
        return result

    def import_dialogue(self, body):
        if body.get("authorized") is not True:
            raise ValueError("请确认有权导入且已人工脱敏；自动规则不能替代业务审核")
        title = self.repository.text(body.get("title"), 120)
        source_label = self.repository.text(body.get("sourceLabel", "用户提供的匿名会话"), 120)
        supplied = body.get("messages")
        if supplied is None and isinstance(body.get("transcript"), str):
            supplied = self.parse_text(body["transcript"])
        if not isinstance(supplied, list) or not 2 <= len(supplied) <= 200:
            raise ValueError("一次导入需要 2–200 条消息，超限请先分卷；不会静默截断")
        messages = []
        scan_values = [title, source_label]
        last_at = None
        for index, incoming in enumerate(supplied, 1):
            if not isinstance(incoming, dict) or not isinstance(incoming.get("role"), str) or incoming["role"] not in ROLES:
                raise ValueError(f"第 {index} 条消息角色不合法")
            if set(incoming) - {"role", "content", "at"}:
                raise ValueError(f"第 {index} 条消息包含当前不支持的字段；请先转换为 role/content/at，避免静默丢失附件或工具参数")
            self.repository.text(incoming.get("content"), 12000)
            content = incoming["content"]
            at = incoming.get("at")
            if at is not None:
                try:
                    parsed = datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))
                    if parsed.tzinfo is None or (last_at is not None and parsed < last_at):
                        raise ValueError()
                    last_at = parsed
                    at = parsed.isoformat()
                except (TypeError, AttributeError, ValueError):
                    raise ValueError(f"第 {index} 条消息时间需为含时区 ISO 日期，且顺序不能倒退") from None
            messages.append({"id": "IM-" + uuid.uuid4().hex[:12].upper(), "sequence": index, "role": incoming["role"], "content": content, "at": at, "traceId": None, "turnId": None, "metadata": {"observedLocally": False}})
            scan_values.append(content)
        if not any(message["role"] == "user" for message in messages):
            raise ValueError("会话须包含至少一条客户消息")
        if sum(len(value) for value in scan_values) > 100000:
            raise ValueError("会话文本超过十万字符，请先分卷；没有导入或截断任何消息")
        self.repository.local_scan(scan_values)
        identifier = "DIALOG-" + uuid.uuid4().hex[:12].upper()
        now = self.repository.now()
        value = {"id": identifier, "title": title, "sourceLabel": source_label, "origin": "user_imported", "messages": messages, "createdAt": now, "updatedAt": now, "completeness": "完整保留本次提供的消息顺序和正文；平台不能验证上游是否删减，角色及时间均由导入方提供。"}
        self.repository.save("imported_dialogue", identifier, value)
        return self.assemble(identifier)

    @staticmethod
    def parse_text(transcript):
        messages = []
        prefix = re.compile(r"^(用户|客户|智能客服|人工客服|客服|助手|人工|系统|工具)[：:] ?(.*)$")
        for line in transcript.splitlines():
            matched = prefix.match(line)
            if matched:
                messages.append({"role": ROLE_PREFIXES[matched[1]], "content": matched[2]})
            elif messages:
                messages[-1]["content"] += "\n" + line
            elif line.strip():
                raise ValueError("文本须以“客户：”“客服：”等角色标签开头；多行消息可直接换行")
        return messages

    def archive(self, identifier, body):
        with self.repository.LOCK:
            session = self.assemble(identifier)
            if body.get("hash") != session["hash"]:
                raise ValueError("对话已有新消息或反馈，请刷新后保存完整的新版本")
            existing = next((asset for asset in session["archives"] if asset["hash"] == session["hash"]), None)
            if existing:
                return self.repository.get("dialogue_archive", existing["id"])
            title = self.repository.text(body.get("title", session["title"]), 120)
            self.repository.local_scan([title] + [message["content"] for message in session["messages"]])
            archive_id = "DOC-" + uuid.uuid4().hex[:10].upper()
            snapshot = {key: copy.deepcopy(value) for key, value in session.items() if key != "archives"}
            value = {"id": archive_id, "sessionId": identifier, "title": title, "version": len(session["archives"]) + 1, "createdAt": self.repository.now(), "hash": session["hash"], "messageCount": len(session["messages"]), "kind": "conversation_evidence", "usableForAnswers": False, "snapshot": snapshot}
            self.repository.save("dialogue_archive", archive_id, value)
            return value

    def create_draft(self, body):
        archive = self.repository.get("dialogue_archive", body.get("archiveId", ""))
        if not archive:
            raise ValueError("请先将完整对话保存为知识库资料")
        selected = body.get("messageIds")
        if not isinstance(selected, list) or not selected or not all(isinstance(identifier, str) for identifier in selected) or len(set(selected)) != len(selected):
            raise ValueError("请选择不重复的原文消息作为知识依据")
        evidence = [message for message in archive["snapshot"]["messages"] if message["id"] in selected]
        if len(evidence) != len(selected) or not any(message["role"] == "user" for message in evidence) or not any(message["role"] in ("assistant", "human") for message in evidence):
            raise ValueError("依据须来自此对话版本，并至少包含一条客户问题和一条客服答复")
        title, question, content, keywords = self.draft_fields(body)
        identifier = "DRAFT-" + uuid.uuid4().hex[:10].upper()
        value = {"id": identifier, "title": title, "question": question, "content": content, "keywords": keywords, "status": "draft", "version": 1, "archiveId": archive["id"], "archiveVersion": archive["version"], "sessionId": archive["sessionId"], "sourceHash": archive["hash"], "messageIds": [message["id"] for message in evidence], "createdAt": self.repository.now(), "updatedAt": self.repository.now(), "knowledgeId": None, "review": None}
        self.repository.save("knowledge_draft", identifier, value)
        return value

    def draft_fields(self, body):
        title = self.repository.text(body.get("title"), 120)
        question = self.repository.text(body.get("question"), 4000)
        content = self.repository.text(body.get("content"), 4000)
        keywords = body.get("keywords", [])
        if not isinstance(keywords, list) or len(keywords) > 15:
            raise ValueError("匹配词须为数组，最多 15 个")
        keywords = list(dict.fromkeys(self.repository.text(keyword, 40) for keyword in keywords))
        self.repository.local_scan([title, question, content] + keywords)
        return title, question, content, keywords

    def review_draft(self, identifier, body):
        with self.repository.LOCK:
            draft = self.repository.get("knowledge_draft", identifier)
            if not draft or draft["status"] != "draft":
                raise ValueError("该草稿不存在或已审核，不能覆盖历史审核记录")
            if body.get("version") != draft["version"]:
                raise ValueError("草稿已被修改，请重新打开")
            title, question, content, keywords = self.draft_fields(body)
            approved = body.get("approve") is True
            if approved and (body.get("reviewed") is not True or not keywords):
                raise ValueError("发布前必须填写匹配词并确认已核对上下文和业务政策")
            draft.update(title=title, question=question, content=content, keywords=keywords, version=draft["version"] + 1, updatedAt=self.repository.now())
            knowledge = None
            if approved:
                knowledge_id = "KB-D-" + uuid.uuid4().hex[:8].upper()
                knowledge = {"id": knowledge_id, "title": title, "content": content, "category": "会话整理", "version": 1, "updatedAt": self.repository.now(), "origin": "本机人工确认发布的对话整理知识；审核者身份未认证", "intents": ["reviewed_dialogue_knowledge"], "keywords": keywords, "provenance": {"draftId": identifier, "archiveId": draft["archiveId"], "archiveVersion": draft["archiveVersion"], "sessionId": draft["sessionId"], "sourceHash": draft["sourceHash"], "messageIds": draft["messageIds"]}}
                draft.update(status="approved", knowledgeId=knowledge_id, review={"at": self.repository.now(), "actor": "本机操作人员，身份未认证", "confirmation": "已核对上下文与业务政策"})
            with self.repository.connection() as database:
                if knowledge:
                    database.execute("INSERT INTO documents(kind,id,payload) VALUES (?,?,?)", ("knowledge", knowledge["id"], json.dumps(knowledge, ensure_ascii=False)))
                database.execute("UPDATE documents SET payload=? WHERE kind='knowledge_draft' AND id=?", (json.dumps(draft, ensure_ascii=False), identifier))
            return draft

    @staticmethod
    def markdown(session):
        rows = [f"# {session['title']}", "", f"会话：{session['id']}", f"来源：{session['sourceLabel']}", f"完整性：{session['completeness']}", f"消息数：{len(session['messages'])}；SHA-256：{session['hash']}", "", "这是原始对话资料，不是审核通过的客服承诺。", ""]
        for message in session["messages"]:
            displayed_time = f"相对 +{message['elapsedSeconds']} 秒（绝对时间已移除）" if 'elapsedSeconds' in message else message['at'] or '原记录未提供'
            rows.extend([f"## {message['sequence']:03d} · {ROLES[message['role']]}", "", f"消息：{message['id']}；时间：{displayed_time}", ""])
            if message.get("traceId"):
                rows.extend([f"Trace：{message['traceId']}", ""])
            rows.extend([message["content"], ""])
        if session.get('annotationSets'):
            rows.extend(['## 原始标注（脱敏后保留，非模型评测结果）', '', '```json', json.dumps(session['annotationSets'], ensure_ascii=False, indent=2), '```', ''])
        if session.get('provenance'):
            rows.extend(['## 数据来源与处理范围', '', '```json', json.dumps(session['provenance'], ensure_ascii=False, indent=2), '```'])
        return "\n".join(rows)
