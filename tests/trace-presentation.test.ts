import assert from 'node:assert/strict';
import test from 'node:test';
import { traceBar, traceCandidateModels, traceConversationUrl, traceElapsed, traceReturnUrl, traceSpanDepths, traceValueSummary } from '../src/tracePresentation.ts';
import type { TraceSpan } from '../src/tracePresentation.ts';

const span = (id: string, parentId: string | null = null, changes: Partial<TraceSpan> = {}): TraceSpan => ({ id, parentId, name: '构造步骤', kind: 'agent', status: 'ok', startMs: 0, durationMs: 100, input: null, output: null, attributes: {}, events: [], error: null, ...changes });

test('reads exact answer without treating weak-label match as correctness', () => {
  const summary = traceValueSummary({ output: { answer: '仅用于测试的实际返回', intent: 'info_query', action: 'clarify' }, intentMatch: true, actionMatch: false, judgeCompleted: false }, { info_query: '信息查询' });
  assert.equal(summary.text, '仅用于测试的实际返回');
  assert.equal(summary.hasLabels, true);
  assert.deepEqual(summary.facts.map(fact => fact.value), ['信息查询', '澄清与补充信息', '一致', '不一致', '未完成']);
});

test('missing data and arbitrary structured content never invent a result', () => {
  assert.equal(traceValueSummary(null).hasValue, false);
  assert.equal(traceValueSummary({ unexpected: 'hidden structured value' }).text, undefined);
  assert.deepEqual(traceValueSummary({ unexpected: 'hidden structured value' }).facts, []);
  assert.equal(traceValueSummary('exact text').text, 'exact text');
  assert.equal(traceElapsed(null), '耗时未记录');
  assert.equal(traceElapsed(0), '0.0 ms');
});

test('usage only displays reported fields, not made-up totals', () => {
  const facts = traceValueSummary({ model: 'fixture-model', usage: { prompt_tokens: 0, completion_tokens: 7 } }).facts;
  assert.deepEqual(facts.map(fact => fact.key), ['model', 'prompt_tokens', 'completion_tokens']);
  assert.equal(facts[1].value, '0');
});

test('timeline positions are bounded, unavailable timing has no fake bar', () => {
  assert.deepEqual(traceBar({ startMs: 90, durationMs: 40 }, 100), { start: 90, width: 10 });
  assert.deepEqual(traceBar({ startMs: -10, durationMs: 200 }, 100), { start: 0, width: 100 });
  assert.equal(traceBar({ startMs: 0, durationMs: null }, 100), null);
  assert.equal(traceBar({ startMs: 0, durationMs: 50 }, null), null);
  assert.equal(traceBar({ startMs: NaN, durationMs: 50 }, 100), null);
});

test('parent depths are stable with missing parents and cycles', () => {
  assert.deepEqual([...traceSpanDepths([span('root'), span('child', 'root'), span('orphan', 'missing')])], [['root', 0], ['child', 1], ['orphan', 0]]);
  assert.equal(traceSpanDepths([span('one', 'two'), span('two', 'one')]).get('one'), 1);
});

test('candidate model identity comes from actual output, never judge or brand guessing', () => {
  assert.deepEqual(traceCandidateModels([span('root'), span('candidate', 'root', { kind: 'model', input: { role: 'candidate' }, output: { model: 'actual-fixture' } }), span('judge', 'root', { kind: 'model', input: { role: 'judge' }, output: { model: 'judge-fixture' } }), span('missing', 'root', { kind: 'model', output: null })]), ['actual-fixture']);
});

test('return links keep the batch, original dashboard context, and conversation round trip', () => {
  const back = 'overview?run=EVAL-TEST&tab=intents';
  assert.equal(traceReturnUrl('#traces?return=' + encodeURIComponent(back), 'EVAL-TEST'), '#' + back);
  assert.equal(traceReturnUrl('#traces', 'MMRUN-TEST'), '#compare?mode=vision&mmrun=MMRUN-TEST');
  assert.equal(traceReturnUrl('#traces?run=EVAL-TEST', null), '#benchmark?run=EVAL-TEST');
  assert.equal(traceReturnUrl('#traces?return=https://untrusted.invalid', null), '');
  const origin = '#traces?trace=trace-fixture&run=EVAL-TEST&project=project-fixture';
  const destination = traceConversationUrl('session-fixture', origin);
  const params = new URLSearchParams(destination.split('?')[1]);
  assert.equal(params.get('return'), origin.slice(1));
  assert.equal(params.get('session'), 'session-fixture');
  assert.equal(params.get('run'), 'EVAL-TEST');
  assert.equal(params.get('project'), 'project-fixture');
});
