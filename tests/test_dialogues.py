import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import support_api
from dialogues import DialogueService, analyze, fingerprint
from tracing import TraceStore


class DialogueTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        folder = Path(self.directory.name)
        self.patchers = [patch.object(support_api, "DATA", folder), patch.object(support_api, "DATABASE", folder / "support.sqlite3"), patch.object(support_api, "TRACE_STORE", TraceStore(folder / "traces.sqlite3")), patch.object(support_api, "local_scan", return_value="unit-test privacy scanner stub")]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()
        self.service = support_api.DIALOGUES

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.directory.cleanup()

    def imported(self, messages=None):
        return self.service.import_dialogue({"title": "匿名验证对话", "sourceLabel": "单元测试构造，不是客户数据", "authorized": True, "messages": messages or [{"role": "user", "content": "退款到账要多久？"}, {"role": "assistant", "content": "请先核实退款审核状态。"}, {"role": "user", "content": "退款到账要多久？"}, {"role": "human", "content": "请在官方售后页面查看进度。\n不在此处提供个人资料。"}]})

    def archive(self, session):
        return self.service.archive(session["id"], {"hash": session["hash"]})

    def draft(self, archive):
        messages = archive["snapshot"]["messages"]
        return self.service.create_draft({"archiveId": archive["id"], "messageIds": [message["id"] for message in messages], "title": "退款进度核实", "question": "如何核实退款进度？", "content": "请在官方售后页面核实审核状态。", "keywords": ["退款进度核实"]})

    def test_full_local_session_not_limited_by_state_recent_thirty(self):
        first = support_api.chat({"message": "退款到账要多久？"})
        for index in range(1, 36):
            turn = copy.deepcopy(first)
            turn.update(id=f"MSG-TEST-{index:04d}", message=f"匿名追问第 {index} 轮", answer=f"答复第 {index} 轮", traceId=None, createdAt=f"2026-10-10T11:{index:02d}:00+00:00")
            support_api.save("conversation", turn["id"], turn)
        session = self.service.assemble(first["sessionId"])
        self.assertEqual(len(session["messages"]), 72)
        self.assertEqual(session["analysis"]["customerTurns"], 36)
        self.assertEqual(session["messages"][0]["content"], first["message"])
        self.assertEqual(session["messages"][-1]["content"], "答复第 35 轮")
        turns, _, _ = support_api.dispatch_get(f"/api/support/sessions/{first['sessionId']}/turns", {})
        self.assertEqual(len(turns), 36)
        self.assertEqual(session["messages"][0]["traceId"], first["traceId"])

    def test_local_multiturn_context_and_whole_conversation_signals(self):
        first = support_api.chat({"message": "退款到账要多久？"})
        second = support_api.chat({"message": "那要多久？", "sessionId": first["sessionId"]})
        third = support_api.chat({"message": "请帮忙写一首古诗", "sessionId": first["sessionId"]})
        support_api.dispatch_post("/api/support/feedback", {"messageId": third["id"], "feedback": "negative"})
        session = self.service.assemble(first["sessionId"])
        self.assertEqual(len(session["messages"]), 6)
        self.assertEqual(session["analysis"]["traceCount"], 3)
        self.assertEqual(session["messages"][3]["metadata"]["source"]["id"], "KB-004")
        kinds = {signal["kind"] for signal in session["analysis"]["signals"]}
        self.assertTrue({"negative_feedback", "handoff", "missing_evidence"}.issubset(kinds))
        self.assertIn("待业务人员确认", session["analysis"]["outcome"])

    def test_import_preserves_long_multiline_messages_and_roles(self):
        body = "  匿名内容\n" + "多行上下文不应被截断。" * 450 + "\n原文末尾  "
        session = self.imported([{"role": "user", "content": body}, {"role": "tool", "content": "工具结果由导入方提供"}, {"role": "human", "content": "人工答复由导入方提供"}])
        self.assertEqual(session["messages"][0]["content"], body)
        self.assertEqual([message["role"] for message in session["messages"]], ["user", "tool", "human"])
        self.assertTrue(all(message["traceId"] is None and message["at"] is None for message in session["messages"]))
        self.assertEqual(session["origin"], "user_imported")
        self.assertEqual(session["analysis"]["traceCount"], 0)
        self.assertEqual(session["analysis"]["sources"], [])

    def test_plain_text_parse_preserves_order_and_multiline(self):
        parsed = DialogueService.parse_text("客户：第一轮\n客服：第一行\n第二行\n客户：追问\n人工客服：人工回复")
        self.assertEqual(len(parsed), 4)
        self.assertEqual(parsed[1]["content"], "第一行\n第二行")
        self.assertEqual(parsed[-1]["role"], "human")
        with self.assertRaises(ValueError):
            DialogueService.parse_text("无标签内容\n客户：问题")

    def test_import_denied_or_oversized_never_partially_saved(self):
        contact = "private" + "@" + "example.com"
        with self.assertRaises(ValueError):
            self.imported([{"role": "user", "content": "匿名问题"}, {"role": "assistant", "content": contact}])
        self.assertEqual(support_api.records("imported_dialogue"), [])
        with self.assertRaises(ValueError):
            self.imported([{"role": "user", "content": "匿名问题"}] * 201)
        self.assertEqual(support_api.records("imported_dialogue"), [])
        with patch.object(support_api, "local_scan", side_effect=ValueError("fixture scanner reject")):
            with self.assertRaises(ValueError):
                self.imported()
        self.assertEqual(support_api.records("imported_dialogue"), [])

    def test_dates_and_authorization_must_be_valid(self):
        for dates in [("invalid", None), ("2026-10-10T10:00:00", None), ("2026-10-10T10:00:00Z", "2026-10-10T09:00:00Z")]:
            with self.subTest(dates=dates), self.assertRaises(ValueError):
                self.imported([{"role": "user", "content": "问题", "at": dates[0]}, {"role": "assistant", "content": "答复", "at": dates[1]}])
        with self.assertRaises(ValueError):
            self.service.import_dialogue({"authorized": False})

    def test_archival_snapshots_are_immutable_and_versioned(self):
        first = support_api.chat({"message": "退款到账要多久？"})
        session = self.service.assemble(first["sessionId"])
        archived = self.archive(session)
        again = self.archive(session)
        self.assertEqual(archived["id"], again["id"])
        self.assertEqual(archived["messageCount"], 2)
        support_api.chat({"message": "那要多久？", "sessionId": first["sessionId"]})
        with self.assertRaises(ValueError):
            self.archive(session)
        updated = self.archive(self.service.assemble(first["sessionId"]))
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["messageCount"], 4)
        self.assertEqual(support_api.get("dialogue_archive", archived["id"])["messageCount"], 2)
        self.assertFalse(archived["usableForAnswers"])
        self.assertEqual(len(support_api.records("knowledge")), 8)

    def test_full_text_search_finds_middle_messages(self):
        session = self.imported()
        result = self.service.sessions({"q": ["个人资料"]})
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["sessions"][0]["id"], session["id"])
        self.assertEqual(self.service.sessions({"status": ["archived"]})["total"], 0)
        self.archive(session)
        self.assertEqual(self.service.sessions({"status": ["archived"]})["total"], 1)

    def test_analysis_does_not_claim_resolution_or_invent_sources(self):
        session = self.imported()
        self.assertIn("repeated_question", [signal["kind"] for signal in session["analysis"]["signals"]])
        self.assertIn("human_reply", [signal["kind"] for signal in session["analysis"]["signals"]])
        self.assertEqual(session["analysis"]["topics"], [])
        self.assertEqual(session["analysis"]["sources"], [])
        self.assertNotIn("missing_evidence", [signal["kind"] for signal in session["analysis"]["signals"]])

    def test_draft_requires_exact_evidence_and_not_automatically_published(self):
        archived = self.archive(self.imported())
        draft = self.draft(archived)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["sourceHash"], archived["hash"])
        self.assertEqual(len(support_api.records("knowledge")), 8)
        wrong = {**draft, "messageIds": ["not-an-evidence-message"]}
        with self.assertRaises(ValueError):
            self.service.create_draft(wrong)
        wrong["messageIds"] = [archived["snapshot"]["messages"][0]["id"]]
        with self.assertRaises(ValueError):
            self.service.create_draft(wrong)

    def test_review_requires_confirmation_and_captures_provenance(self):
        archived = self.archive(self.imported())
        draft = self.draft(archived)
        with self.assertRaises(ValueError):
            self.service.review_draft(draft["id"], {**draft, "approve": True})
        result = self.service.review_draft(draft["id"], {**draft, "approve": True, "reviewed": True})
        knowledge = support_api.get("knowledge", result["knowledgeId"])
        self.assertEqual(result["status"], "approved")
        self.assertEqual(knowledge["provenance"]["messageIds"], draft["messageIds"])
        self.assertEqual(knowledge["provenance"]["sourceHash"], archived["hash"])
        self.assertEqual(knowledge["content"], draft["content"])
        response = support_api.chat({"message": "退款进度核实"})
        self.assertEqual(response["source"]["id"], knowledge["id"])
        with self.assertRaises(ValueError):
            self.service.review_draft(draft["id"], {**draft, "approve": True, "reviewed": True})

    def test_stale_draft_version_and_long_answer_are_rejected(self):
        draft = self.draft(self.archive(self.imported()))
        with self.assertRaises(ValueError):
            self.service.review_draft(draft["id"], {**draft, "version": 0})
        with self.assertRaises(ValueError):
            self.service.review_draft(draft["id"], {**draft, "content": "长文本" * 1500})
        unchanged = support_api.get("knowledge_draft", draft["id"])
        self.assertEqual(unchanged["version"], 1)

    def test_export_keeps_complete_messages(self):
        session = self.imported()
        archived = self.archive(session)
        markdown = self.service.markdown(archived["snapshot"])
        for message in session["messages"]:
            self.assertIn(message["content"], markdown)
        self.assertEqual(markdown.count("## "), 4)
        self.assertEqual(fingerprint(archived["snapshot"]["messages"]), archived["hash"])


if __name__ == "__main__":
    unittest.main()
