import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseCount, chooseDefaultRun, comparableRuns, rememberRun, rememberedRun, runFromHash, runLabel, runUrl } from '../src/labNavigation.ts';

const original = { id: 'EVAL-ORIGINAL', bundleId: 'BUNDLE', status: 'completed', total: 200, createdAt: '2026-10-10T00:00:00Z', models: [{ id: 'V1' }, { id: 'V2' }], caseHash: 'cases', protocol: 'protocol', judgeHash: 'none' };
const tiny = { ...original, id: 'EVAL-TINY', total: 4, createdAt: '2026-10-11T00:00:00Z' };

test('default prefers a completed larger batch but respects an explicit selection', () => {
  assert.equal(chooseDefaultRun([tiny, original])?.id, original.id);
  assert.equal(chooseDefaultRun([tiny, original], tiny.id)?.id, tiny.id);
  assert.equal(chooseDefaultRun([{ ...original, status: 'running' }, tiny])?.id, tiny.id);
  assert.equal(chooseDefaultRun([]), undefined);
});

test('labels distinguish cases from model outputs', () => {
  assert.equal(caseCount(original), 100);
  assert.match(runLabel(original), /100 个案例 · 2 个版本/);
  assert.equal(caseCount({ total: 0, models: [] }), 0);
});

test('comparison rejects every nonmatching protocol field and unfinished runs', () => {
  assert.equal(comparableRuns(original, { ...original, id: 'EVAL-OTHER' }), true);
  for (const field of ['bundleId', 'caseHash', 'protocol', 'judgeHash', 'status']) {
    assert.equal(comparableRuns(original, { ...original, [field]: 'different' }), false, field);
  }
});

test('navigation remembers only batch identifiers and tolerates unavailable storage', () => {
  const records = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => records.get(key) || null, setItem: (key: string, value: string) => records.set(key, value) } });
  rememberRun(original);
  assert.equal(rememberedRun(original.bundleId), original.id);
  assert.equal(runUrl('overview'), '#overview?run=EVAL-ORIGINAL');
  assert.deepEqual([...records.values()], [original.id, original.id]);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('unavailable'); } });
  assert.equal(rememberedRun(), '');
  assert.doesNotThrow(() => rememberRun(original));
  assert.equal(runUrl('benchmark'), '#benchmark');
});

test('trace return recognizes image batches and rejects invalid identifiers', () => {
  for (const [hash, expected] of [['#traces?run=MMRUN-ABC123', 'MMRUN-ABC123'], ['#traces?run=EVAL-ABC123', 'EVAL-ABC123'], ['#traces?run=javascript:bad', '']]) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash } });
    assert.equal(runFromHash(), expected);
  }
});
