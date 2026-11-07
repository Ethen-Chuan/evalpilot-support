import assert from 'node:assert/strict';
import test from 'node:test';
import { eventDetails, plainLanguage, retestStatus, sameRuntime } from '../src/simulatorPresentation.ts';

test('rule passes never look like final human acceptance', () => {
  assert.deepEqual(retestStatus('断言通过 · 待人工复核'), { label: '规则检查通过 · 答复质量待人工确认', tone: 'amber' });
  assert.equal(retestStatus('仍有失败').tone, 'red');
  assert.equal(retestStatus('待回归').label, '已保存 · 待再次测试');
});

test('old records and missing runtime metadata remain read only', () => {
  assert.equal(sameRuntime({ runtimeHash: 'current' }, 'current'), true);
  assert.equal(sameRuntime({ runtimeHash: 'old' }, 'current'), false);
  assert.equal(sameRuntime({}, 'current'), false);
  assert.equal(sameRuntime({}), false);
});

test('presentation translates old technical labels without altering records', () => {
  const source = '断言通过，原始提案按Rubric冻结，已入回归集';
  assert.equal(plainLanguage(source), '规则检查通过，原始候选答复按评分标准保存，已入复测案例');
  assert.ok(source.includes('断言'));
});

test('trace details display actual retrieval results rather than raw protocol', () => {
  assert.deepEqual(eventDetails({ type: 'tool', name: 'search_knowledge', output: { results: [{ title: '黑屏排查', matchedTerms: ['黑屏'] }], internal: 'not displayed' } }), ['黑屏排查；匹配到：黑屏']);
  assert.deepEqual(eventDetails({ type: 'tool', name: 'search_knowledge', output: { results: [] } }), ['没有找到相关知识，不能编造依据。']);
  assert.match(eventDetails({ type: 'tool', name: 'read_case_memory', status: 'blocked', output: null })[0], /没有执行/);
});
