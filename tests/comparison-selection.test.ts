import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonViewFromHash, modelPairAllowed } from '../src/comparisonSelection.ts';

const baseline = { id: 'MODEL-A', family: 'service-family', provider: 'provider-one' };

test('same provider and family needs no separate comparison mode', () => {
  assert.equal(modelPairAllowed(baseline, { ...baseline, id: 'MODEL-B' }), true);
});

test('different providers and families use the same comparison function', () => {
  for (const candidate of [{ ...baseline, id: 'MODEL-B', provider: 'provider-two' }, { ...baseline, id: 'MODEL-B', family: 'other-family' }]) {
    assert.equal(modelPairAllowed(baseline, candidate), true);
  }
});

test('duplicate model records remain forbidden', () => {
  assert.equal(modelPairAllowed(baseline, baseline), false);
});

test('bare comparison opens setup', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?mode=text'), { panel: 'setup' });
});

test('legacy batch links open results', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY'), { panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=results'), { panel: 'results' });
});

test('legacy comparison parameters do not add restrictions or another mode', () => {
  for (const mode of ['horizontal', 'vertical', 'unknown']) {
    assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&comparison=' + mode), { panel: 'results' });
    assert.deepEqual(comparisonViewFromHash('#compare?comparison=' + mode), { panel: 'setup' });
  }
});

test('explicit setup wins over a historical run parameter', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=setup&comparison=vertical'), { panel: 'setup' });
});

test('results-only links and unknown panels remain supported', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?panel=results'), { panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=unknown'), { panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?panel=unknown'), { panel: 'setup' });
});
