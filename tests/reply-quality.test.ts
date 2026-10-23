import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticMatch, matchesReviewFilter, replyQuality, reviewCounts } from '../src/replyQuality.ts';
import type { Result } from '../src/AgentLab';

const row: Result = { caseId: 'case-fixture', sessionId: 'session-fixture', versionId: 'version-fixture', traceId: 'trace-fixture', expectedIntent: 'fault_repair', expectedAction: 'clarify', status: 'completed', intentMatch: true, actionMatch: true, output: { intent: 'fault_repair', action: 'clarify', answer: '匿名测试答复' } };
const judged = (relevance: number | null, next_step: number | null, boundary: number | null): Result => ({ ...row, judgment: { dimensions: { relevance, next_step, boundary }, reason: '隔离测试意见，不是真实评分', evidenceIds: ['candidate'] } });

test('matching both labels never manufactures a quality assessment', () => {
  assert.equal(replyQuality(row).status, 'unreviewed');
  assert.equal(replyQuality(row).reviewed, false);
  assert.equal(replyQuality({ ...row, intentMatch: false, actionMatch: false }).status, 'unreviewed');
});

test('review failure and candidate failure remain distinct', () => {
  assert.equal(replyQuality({ ...row, judgeError: '测试错误' }).status, 'review_error');
  assert.equal(replyQuality({ ...judged(4, 4, 4), status: 'failed' }).status, 'execution_error');
  assert.equal(replyQuality({ ...row, status: 'running' }).status, 'pending');
  assert.equal(replyQuality({ ...judged(4, 4, 4), output: undefined }).status, 'execution_error');
});

test('actual scores determine triage without using label matches', () => {
  assert.equal(replyQuality({ ...judged(3, 4, 3), intentMatch: false, actionMatch: false }).status, 'reasonable');
  assert.equal(replyQuality(judged(4, 2, 4)).status, 'attention');
  assert.equal(replyQuality(judged(0, 4, 4)).status, 'attention');
  assert.equal(replyQuality(judged(3, 3, 3)).tone, 'blue');
});

test('null evidence is neither zero nor overall pass', () => {
  assert.equal(replyQuality(judged(4, null, 4)).status, 'insufficient');
  assert.equal(replyQuality(judged(null, null, null)).reviewed, true);
  assert.equal(replyQuality(judged(1, null, 4)).status, 'attention');
  assert.ok(replyQuality(judged(1, null, 4)).note.includes('证据不足'));
});

test('out-of-range, missing, malformed score, reason or evidence fails closed', () => {
  for (const value of [5, -1, NaN, Infinity, 1.5, '4', true, undefined]) {
    const result = judged(4, 4, 4);
    result.judgment!.dimensions.boundary = value as number;
    assert.equal(replyQuality(result).status, 'review_error');
  }
  for (const patch of [{ reason: '' }, { evidenceIds: [] }, { evidenceIds: [''] }, { dimensions: {} }]) {
    assert.equal(replyQuality({ ...row, judgment: { ...judged(4, 4, 4).judgment!, ...patch } }).reviewed, false);
  }
});

test('counts derive from recorded outputs and do not count missing reviews as failures', () => {
  const rows = [row, { ...row, judgeError: '测试错误' }, judged(4, null, 4), judged(4, 2, 4), judged(4, 4, 4), { ...row, status: 'failed' }];
  assert.deepEqual(reviewCounts(rows), { all: 6, attention: 1, unreviewed: 3, reasonable: 1, execution_error: 1 });
  assert.equal(matchesReviewFilter(row, 'execution_error'), false);
  assert.equal(reviewCounts(rows.slice(0, 1)).all, 1);
  assert.deepEqual(reviewCounts([]), { all: 0, attention: 0, unreviewed: 0, reasonable: 0, execution_error: 0 });
});

test('diagnostics distinguish absent fields from a known difference', () => {
  assert.equal(diagnosticMatch(true), '与参考一致');
  assert.equal(diagnosticMatch(false), '与参考不同');
  assert.equal(diagnosticMatch(undefined), '未记录');
});
