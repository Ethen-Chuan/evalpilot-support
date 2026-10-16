import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonViewFromHash, modelPairAllowed, sameModelFamily } from '../src/comparisonSelection.ts';

const baseline = { id: 'MODEL-A', family: 'service-family', provider: 'provider-one' };

test('same provider and family supports version comparison only', () => {
  const candidate = { ...baseline, id: 'MODEL-B' };
  assert.equal(sameModelFamily(baseline, candidate), true);
  assert.equal(modelPairAllowed(baseline, candidate, 'vertical'), true);
  assert.equal(modelPairAllowed(baseline, candidate, 'horizontal'), false);
});

test('different provider stays cross-model even with identical display family', () => {
  const candidate = { ...baseline, id: 'MODEL-B', provider: 'provider-two' };
  assert.equal(sameModelFamily(baseline, candidate), false);
  assert.equal(modelPairAllowed(baseline, candidate, 'vertical'), false);
  assert.equal(modelPairAllowed(baseline, candidate, 'horizontal'), true);
});

test('different family is cross-model and duplicate selection is forbidden', () => {
  assert.equal(modelPairAllowed(baseline, { ...baseline, id: 'MODEL-B', family: 'other-family' }, 'horizontal'), true);
  for (const mode of ['horizontal', 'vertical'] as const) assert.equal(modelPairAllowed(baseline, baseline, mode), false);
});

const legacyRun = { id: 'EVAL-LEGACY', models: [baseline, { ...baseline, id: 'MODEL-B' }] };

test('bare comparison opens model setup even when a previous run is remembered', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?mode=text', legacyRun), { mode: 'horizontal', panel: 'setup' });
});

test('legacy batch links infer version iteration from the actual models', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY', legacyRun), { mode: 'vertical', panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=results', legacyRun), { mode: 'vertical', panel: 'results' });
});

test('cross-provider or mixed-family historical results use cross-model comparison', () => {
  for (const candidate of [{ ...baseline, id: 'MODEL-B', provider: 'provider-two' }, { ...baseline, id: 'MODEL-B', family: 'other-family' }]) {
    assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY', { ...legacyRun, models: [baseline, candidate] }), { mode: 'horizontal', panel: 'results' });
  }
});

test('explicit panel and mode win over stored or inferred comparison settings', () => {
  const run = { ...legacyRun, comparisonMode: 'vertical' as const };
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&comparison=horizontal', run), { mode: 'horizontal', panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=setup', run), { mode: 'horizontal', panel: 'setup' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&panel=setup&comparison=vertical', run), { mode: 'vertical', panel: 'setup' });
});

test('stored mode and result-only links are supported without inferring from a different batch', () => {
  assert.deepEqual(comparisonViewFromHash('#compare?panel=results', legacyRun), { mode: 'vertical', panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY', { ...legacyRun, models: [], comparisonMode: 'vertical' }), { mode: 'vertical', panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-OTHER', legacyRun), { mode: 'horizontal', panel: 'results' });
  assert.deepEqual(comparisonViewFromHash('#compare?run=EVAL-LEGACY&comparison=unknown&panel=unknown', legacyRun), { mode: 'vertical', panel: 'results' });
});
