import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalVersions, modelOpsLink, projectOfRun, reviewFlags, runStatistics } from '../src/modelopsData.ts';
import type { OpsRun } from '../src/modelopsData.ts';
import type { LabState, Result } from '../src/AgentLab.ts';

const state = { versions: [{ id: 'external', kind: 'external', name: 'current' }, { id: 'local', kind: 'local' }], bundles: [{ id: 'bundle', datasetId: 'project' }] } as LabState;
const success = { caseId: 'case', versionId: 'external', status: 'completed', intentMatch: true, actionMatch: true } as Result;
const run = { bundleId: 'bundle', models: [{ id: 'external' }, { id: 'local' }], caseIds: ['first', 'second'], results: [success, { ...success, caseId: 'second', status: 'failed' }, { ...success, versionId: 'local' }] } as OpsRun;

test('only registered external candidates count, not local or unknown versions', () => {
  assert.deepEqual(externalVersions(run, state).map(version => version.id), ['external']);
  assert.equal(externalVersions({ ...run, models: [{ id: 'unknown', provider: 'remote' }] } as OpsRun, state).length, 0);
  assert.equal(externalVersions({ ...run, versions: [{ id: 'external', kind: 'external', name: 'frozen' }] } as OpsRun, state)[0].name, 'frozen');
});

test('counts candidates independently from judge calls, with failures and remaining work separate', () => {
  const result = runStatistics(run, state);
  assert.equal(result.planned, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.reviewed, 0);
  assert.equal(result.flagged, 0);
  assert.equal(runStatistics({ ...run, results: [] }, state).remaining, 2);
});

test('machine review counts one reviewed answer even when dimensions lack evidence', () => {
  const row = { ...success, intentMatch: false, actionMatch: false, judgment: { dimensions: { relevance: 4, next_step: 2, boundary: null }, reason: 'fixture only', evidenceIds: ['message'] } };
  const result = runStatistics({ ...run, results: [row] }, state);
  assert.equal(result.reviewed, 1);
  assert.equal(result.flagged, 1);
  assert.equal(reviewFlags(row).length, 4);
  assert.equal(result.remaining, 1);
});

test('missing labels or judge errors are not automatically a bad answer', () => {
  assert.deepEqual(reviewFlags({ ...success, intentMatch: undefined, actionMatch: undefined, judgeError: 'fixture error' }), []);
  assert.deepEqual(reviewFlags({ ...success, status: 'failed', actionMatch: false }), []);
  assert.deepEqual(reviewFlags({ ...success, judgment: { dimensions: { relevance: 3 }, reason: '', evidenceIds: [] } }), []);
});

test('project lookup uses explicit dataset or bundle, never an unrelated default', () => {
  assert.equal(projectOfRun(run, state), 'project');
  assert.equal(projectOfRun({ ...run, datasetId: 'different' }, state), 'different');
  assert.equal(projectOfRun({ ...run, bundleId: 'missing' }, state), '');
});

test('links preserve exact project, run, and trace with URL encoding', () => {
  const hash = modelOpsLink('traces', 'project & one', { run: 'EVAL-EXACT', trace: 'trace?1' });
  const params = new URLSearchParams(hash.split('?')[1]);
  assert.equal(params.get('project'), 'project & one');
  assert.equal(params.get('run'), 'EVAL-EXACT');
  assert.equal(params.get('trace'), 'trace?1');
  assert.equal(modelOpsLink('datasets', ''), '#datasets');
});
