import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))
import support_api
from sdk import AgentTrace
from tracing import CURRENT_SPAN, CURRENT_TRACE, Trace, TraceStore, redact, span, validate_import


class TracingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = TraceStore(Path(self.directory.name) / "traces.sqlite3")
        self.store.initialize()

    def tearDown(self):
        self.directory.cleanup()

    def test_nested_spans_and_exact_operations(self):
        with Trace(self.store, "test-agent", inputs={"query": "anonymous question"}) as trace:
            with span("tool", "tool", {"quantity": 3}) as tool:
                with span("child", "retrieval") as child:
                    child.output({"items": ["policy"]})
                tool.output({"success": True})
            trace.output({"answer": "policy"})
        saved = self.store.get(trace.id)
        self.assertEqual(saved["status"], "ok")
        self.assertEqual(saved["spanCount"], 3)
        self.assertEqual(saved["spans"][1]["parentId"], saved["spans"][0]["id"])
        self.assertEqual(saved["spans"][2]["parentId"], saved["spans"][1]["id"])
        self.assertLessEqual(saved["spans"][2]["durationMs"], saved["spans"][1]["durationMs"] + 1)
        self.assertIsNone(CURRENT_TRACE.get())
        self.assertIsNone(CURRENT_SPAN.get())
        validate_import(saved)

    def test_exception_preserved_and_captured(self):
        with self.assertRaises(TimeoutError):
            with Trace(self.store, "agent") as trace:
                with span("failing retrieval", "tool"):
                    raise TimeoutError("fixture timeout")
        saved = self.store.get(trace.id)
        self.assertEqual(saved["status"], "error")
        self.assertEqual(saved["spans"][1]["error"]["type"], "TimeoutError")
        self.assertTrue(saved["spans"][1]["error"]["frames"])
        self.assertEqual(saved["spans"][1]["error"]["frames"][-1]["file"], "test_tracing.py")

    def test_sensitive_values_not_persisted(self):
        credential = "sk-" + "testfixture" * 3
        email = "person" + "@" + "example.com"
        with Trace(self.store, "agent", inputs={"authorization": credential, "question": email, "account": "1234" * 4}) as trace:
            with span("tool", inputs={"api_key": credential}) as tool:
                tool.output({"contact": email})
        serialized = json.dumps(self.store.get(trace.id))
        self.assertNotIn(credential, serialized)
        self.assertNotIn(email, serialized)
        self.assertNotIn("1234" * 4, serialized)
        self.assertIn("REDACTED", serialized)

    def test_names_events_keys_and_numeric_identifiers_are_redacted(self):
        contact = "reviewer" + "@" + "example.com"
        long_number = int("9876" * 4)
        with Trace(self.store, contact, source=contact, inputs={contact: long_number, "token": "fixture-value"}) as trace:
            with span(contact) as observation:
                observation.event(contact, {"account": float(long_number)})
        serialized = json.dumps(self.store.get(trace.id))
        self.assertNotIn(contact, serialized)
        self.assertNotIn(str(long_number), serialized)
        self.assertNotIn("fixture-value", serialized)
        self.assertIn("REDACTED_NUMBER", serialized)

    def test_concurrent_context_isolated(self):
        barrier = threading.Barrier(2)
        identifiers = []
        def run_agent(name):
            with Trace(self.store, name) as trace:
                with span(name + "-tool", "tool"):
                    barrier.wait(timeout=5)
                identifiers.append(trace.id)
        workers = [threading.Thread(target=run_agent, args=(name,)) for name in ("alpha", "beta")]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=6)
        self.assertEqual(len(identifiers), 2)
        for identifier in identifiers:
            saved = self.store.get(identifier)
            self.assertEqual(saved["spans"][1]["parentId"], saved["spans"][0]["id"])
            self.assertEqual(saved["spans"][1]["name"], saved["name"] + "-tool")

    def test_recover_marks_interrupted(self):
        with Trace(self.store, "pending") as trace:
            snapshot = copy.deepcopy(trace.record)
        self.store.save(snapshot)
        self.store.initialize(recover=True)
        self.assertEqual(self.store.get(trace.id)["status"], "interrupted")
        self.assertEqual(self.store.get(trace.id)["spans"][0]["status"], "interrupted")

    def test_ingest_requires_tree_and_never_overwrites(self):
        with Trace(self.store, "external") as trace:
            with span("child", "tool"):
                pass
        imported_store = TraceStore(Path(self.directory.name) / "imported.sqlite3")
        imported_store.initialize()
        imported = imported_store.ingest(trace.record)
        self.assertEqual(imported["origin"], "client_reported")
        with self.assertRaises(ValueError):
            imported_store.ingest(trace.record)
        invalid = copy.deepcopy(trace.record)
        invalid["spans"][1]["parentId"] = "f" * 16
        with self.assertRaises(ValueError):
            validate_import(invalid)
        invalid = copy.deepcopy(trace.record)
        invalid["spans"][1]["parentId"] = invalid["spans"][1]["id"]
        with self.assertRaises(ValueError):
            validate_import(invalid)
        invalid = copy.deepcopy(trace.record)
        invalid["durationMs"] = float("nan")
        with self.assertRaises(ValueError):
            validate_import(invalid)

    def test_malformed_import_shapes_are_rejected(self):
        with Trace(self.store, "schema-fixture") as trace:
            pass
        mutations = [("id", 123), ("parentId", []), ("kind", {}), ("attributes", []), ("events", {}), ("events", [{"name": "fixture", "offsetMs": 100000, "attributes": {}}]), ("error", {"type": "Test", "message": "fixture", "frames": "invalid"}), ("error", {"type": "Test", "message": "fixture", "frames": [{}]})]
        for key, value in mutations:
            with self.subTest(field=key, value_type=type(value).__name__):
                payload = copy.deepcopy(trace.record)
                payload["spans"][0][key] = value
                with self.assertRaises(ValueError):
                    validate_import(payload)

    def test_ingest_privacy_gate_runs_after_masking_before_save(self):
        contact = "reviewer" + "@" + "example.com"
        with Trace(self.store, "gate-fixture", inputs={"query": contact}) as trace:
            pass
        target = TraceStore(Path(self.directory.name) / "gate.sqlite3")
        target.initialize()
        def reject(values):
            self.assertNotIn(contact, values[0])
            raise ValueError("fixture privacy rejection")
        with self.assertRaises(ValueError):
            target.ingest(trace.record, gate=reject)
        self.assertIsNone(target.get(trace.id))


class SupportTraceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        folder = Path(self.directory.name)
        self.patchers = [patch.object(support_api, "DATA", folder), patch.object(support_api, "DATABASE", folder / "support.sqlite3"), patch.object(support_api, "TRACE_STORE", TraceStore(folder / "traces.sqlite3"))]
        for patcher in self.patchers:
            patcher.start()
        support_api.initialize()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.directory.cleanup()

    @patch.object(support_api, "local_scan", return_value="unit-test scanner stub; not real scanner")
    def test_chat_real_route_snapshot_and_context(self, scanner):
        response = support_api.chat({"message": "退款到账要多久？"})
        self.assertEqual(response["source"]["id"], "KB-004")
        trace = support_api.TRACE_STORE.get(response["traceId"])
        self.assertEqual(trace["conversationId"], response["id"])
        self.assertEqual(trace["status"], "ok")
        self.assertGreaterEqual(len(trace["spans"]), 8)
        retrieval = next(step for step in trace["spans"] if step["kind"] == "retrieval")
        self.assertEqual(retrieval["output"]["selected"]["id"], "KB-004")
        self.assertTrue(retrieval["output"]["candidates"])
        followup = support_api.chat({"message": "那要多久？", "sessionId": response["sessionId"]})
        self.assertEqual(followup["source"]["id"], "KB-004")
        latest = support_api.TRACE_STORE.get(followup["traceId"])
        memory = next(step for step in latest["spans"] if step["kind"] == "memory")
        self.assertEqual(memory["output"]["previousTraceId"], response["traceId"])

    def test_privacy_block_creates_trace_without_input(self):
        message = "账号 " + "1234" * 4
        with self.assertRaises(support_api.TracedRequestError) as caught:
            support_api.chat({"message": message})
        saved = support_api.TRACE_STORE.get(caught.exception.trace_id)
        self.assertEqual(saved["status"], "blocked")
        self.assertNotIn(message, json.dumps(saved, ensure_ascii=False))
        self.assertEqual(support_api.records("conversation"), [])
        self.assertEqual(saved["spans"][1]["status"], "blocked")

    @patch.object(support_api, "local_scan", return_value="unit-test scanner stub")
    def test_unknown_is_quality_issue_not_execution_error(self, scanner):
        response = support_api.chat({"message": "请帮忙作一首古诗"})
        saved = support_api.TRACE_STORE.get(response["traceId"])
        self.assertEqual(saved["status"], "ok")
        self.assertTrue(response["handoff"])
        self.assertTrue(support_api.trace_summary(saved)["hasQualityIssue"])
        support_api.dispatch_post("/api/support/feedback", {"messageId": response["id"], "feedback": "negative"})
        action = support_api.dispatch_post("/api/support/actions", {"messageId": response["id"], "title": "复核知识覆盖"})
        self.assertEqual(action["source"]["traceId"], response["traceId"])
        updated = support_api.TRACE_STORE.get(response["traceId"])
        self.assertEqual([annotation["name"] for annotation in updated["annotations"]], ["user.feedback", "action.created"])

    @patch.object(support_api, "local_scan", return_value="unit-test scanner stub")
    @patch.object(support_api, "predict_intent", side_effect=TimeoutError("fixture model timeout"))
    def test_model_failure_is_traceable(self, model, scanner):
        with self.assertRaises(support_api.TracedRequestError) as caught:
            support_api.chat({"message": "cancel my order"})
        saved = support_api.TRACE_STORE.get(caught.exception.trace_id)
        self.assertEqual(saved["status"], "error")
        self.assertEqual(saved["spans"][0]["error"]["type"], "TimeoutError")
        self.assertTrue(any(step["kind"] == "model" and step["error"]["type"] == "TimeoutError" for step in saved["spans"] if step.get("error")))
        self.assertEqual(support_api.records("conversation"), [])

    @patch.object(support_api.Path, "is_file", return_value=False)
    def test_scanner_unavailable_blocks_persistence(self, missing_scanner):
        with self.assertRaises(support_api.TracedRequestError) as caught:
            support_api.chat({"message": "退款进度"})
        self.assertEqual(support_api.TRACE_STORE.get(caught.exception.trace_id)["status"], "blocked")
        self.assertEqual(support_api.records("conversation"), [])

    def test_uat_trace_is_actual_execution(self):
        result = support_api.run_uat()
        self.assertEqual(result["total"], 12)
        self.assertEqual(result["passed"], 12)
        trace = support_api.TRACE_STORE.get(result["traceId"])
        self.assertEqual(trace["source"], "support.uat")
        self.assertEqual(trace["status"], "ok")
        self.assertEqual(trace["spanCount"], 37)


class SDKTests(unittest.TestCase):
    def test_local_only_endpoint(self):
        for endpoint in ("https://example.com", "http://127.0.0.1:4287/path", "http://localhost:4287?extra=1", "http://[::1]:4287"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                AgentTrace("endpoint-test", endpoint=endpoint)

    def test_nested_steps_and_schema(self):
        with AgentTrace("sdk-fixture", auto_submit=False) as trace:
            with trace.step("retrieve", "retrieval") as retrieval:
                retrieval.event("retrieved", {"count": 1})
                retrieval.output({"policy": "fixture"})
            trace.output({"answer": "fixture"})
        self.assertEqual(len(trace.record["spans"]), 2)
        from backend.tracing import validate_import as validate_sdk
        validate_sdk(trace.record)

    @patch.object(AgentTrace, "submit", side_effect=ConnectionError("fixture transport error"))
    def test_agent_error_is_not_hidden_by_telemetry_failure(self, submit):
        with self.assertRaisesRegex(TimeoutError, "fixture tool failure"):
            with AgentTrace("sdk-failure") as trace:
                with trace.step("failed-tool"):
                    raise TimeoutError("fixture tool failure")
        self.assertEqual(trace.record["status"], "error")
        self.assertEqual(trace.submission_error, "ConnectionError")

    @patch.object(AgentTrace, "submit", side_effect=ConnectionError("fixture transport error"))
    def test_success_does_not_silently_drop_telemetry(self, submit):
        with self.assertRaisesRegex(RuntimeError, "Trace 上报失败"):
            with AgentTrace("sdk-submit-failure"):
                pass


if __name__ == "__main__":
    unittest.main()
