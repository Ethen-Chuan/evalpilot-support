import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RUN_CASES, restrictCasePool, sampleCaseIds } from '../src/caseSampling.ts';

test('sampling returns distinct IDs from the input without mutating it', () => {
  const pool = ['first', 'second', 'third', 'fourth'];
  assert.deepEqual(sampleCaseIds(pool, 2, () => 0.99), ['fourth', 'first']);
  assert.deepEqual(pool, ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(sampleCaseIds(['first', 'first', 'second'], 2, () => 0), ['first', 'second']);
  assert.deepEqual(sampleCaseIds(pool, 4, () => 0).sort(), [...pool].sort());
});

test('partial shuffle covers all ordered pairs, not the first N or a fixed seed', () => {
  const outcomes = new Set<string>();
  for (let first = 0; first < 3; first += 1) {
    for (let second = 0; second < 2; second += 1) {
      const draws = [(first + 0.5) / 3, (second + 0.5) / 2];
      outcomes.add(sampleCaseIds(['first', 'second', 'third'], 2, () => draws.shift()!).join(','));
    }
  }
  assert.equal(outcomes.size, 6);
});

test('invalid quantities never silently clamp, fallback or create an oversized run', () => {
  const pool = Array.from({ length: 205 }, (_, index) => `case-${index}`);
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 201]) assert.deepEqual(sampleCaseIds(pool, quantity), []);
  assert.deepEqual(sampleCaseIds([], 1), []);
  assert.deepEqual(sampleCaseIds(['only'], 2), []);
  assert.equal(sampleCaseIds(pool, MAX_RUN_CASES).length, 200);
  for (const value of [-1, 1, NaN]) assert.throws(() => sampleCaseIds(pool, 1, () => value));
});

test('reruns fail closed if parent case IDs are missing or no longer available', () => {
  const pool = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  assert.deepEqual(restrictCasePool(pool, { caseIds: ['second'] }), [{ id: 'second' }]);
  assert.deepEqual(restrictCasePool([...pool, pool[0]]), pool);
  assert.throws(() => restrictCasePool(pool, {}));
  assert.throws(() => restrictCasePool(pool, { caseIds: [] }));
  assert.throws(() => restrictCasePool(pool, { caseIds: ['first', 'missing'] }));
  assert.deepEqual(sampleCaseIds(restrictCasePool(pool, { caseIds: ['second', 'third'] }).map(item => item.id), 2).sort(), ['second', 'third']);
});
