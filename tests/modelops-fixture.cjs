function createFixture() {
  const versions = [
    { id: 'VERSION-A', name: '售后模型 A', model: 'fixture-model-a', provider: 'fixture', kind: 'external', family: 'fixture', connectionId: 'CONNECTION-A' },
    { id: 'VERSION-B', name: '售后模型 B', model: 'fixture-model-b', provider: 'fixture', kind: 'external', family: 'fixture', connectionId: 'CONNECTION-B' },
    { id: 'VERSION-LOCAL', name: '本地基线', model: 'classifier', provider: 'local', kind: 'local' },
  ];
  const judged = { dimensions: { relevance: 4, next_step: 2, boundary: null }, reason: '构造测试：需要先确认用户的设备与权限。', evidenceIds: ['fixture-message'] };
  const result = { caseId: 'CASE-1', sessionId: 'SESSION-1', versionId: 'VERSION-A', status: 'completed', traceId: 'TRACE-A', output: { answer: '构造测试答复：请先确认设备型号，我再为您提供对应的排查步骤。', intent: 'fault_repair', action: 'clarify' }, intentMatch: true, actionMatch: false, latencyMs: 1000, judgment: judged };
  const metric = { total: 3, completed: 1, failed: 0, pending: 2, p95Ms: 1000, providerTokens: 1200, tokenReports: 1 };
  const mixed = { id: 'EVAL-MIXED', bundleId: 'BUNDLE-A', datasetId: 'project-a', status: 'running', createdAt: '2026-10-21T08:00:00Z', total: 9, completed: 4, caseIds: ['CASE-1', 'CASE-2', 'CASE-3'], versions, models: versions.map(({ id, name, provider, family }) => ({ id, name, provider, family })), judgeId: 'CONNECTION-A', metrics: { 'VERSION-A': { ...metric, failed: 1, pending: 1 }, 'VERSION-B': { ...metric, providerTokens: 0, tokenReports: 0 }, 'VERSION-LOCAL': metric }, results: [result, { ...result, caseId: 'CASE-2', sessionId: 'SESSION-2', status: 'failed', output: undefined, judgment: undefined, error: '构造测试：候选执行失败。' }, { ...result, versionId: 'VERSION-B', traceId: 'TRACE-B', intentMatch: false, judgment: undefined, judgeError: '构造测试：裁判未完成。' }, { ...result, versionId: 'VERSION-LOCAL' }] };
  const complete = { ...mixed, id: 'EVAL-OLD', status: 'completed', createdAt: '2026-10-20T08:00:00Z', caseIds: ['CASE-1'], total: 2, completed: 2, versions: versions.slice(0, 2), models: versions.slice(0, 2), metrics: Object.fromEntries(versions.slice(0, 2).map(version => [version.id, { ...metric, total: 1, pending: 0 }])), results: versions.slice(0, 2).map(version => ({ ...result, versionId: version.id, intentMatch: true, actionMatch: true, judgment: { ...judged, dimensions: { relevance: 4, next_step: 4, boundary: 4 } } })) };
  const local = { ...complete, id: 'EVAL-LOCAL', models: [versions[2]], versions: [versions[2]], total: 1, results: [{ ...result, versionId: 'VERSION-LOCAL' }] };
  const other = { ...complete, id: 'EVAL-OTHER', bundleId: 'BUNDLE-B', datasetId: 'project-b' };
  const corpora = [{ id: 'project-a', name: '售后测试项目（构造数据）' }, { id: 'project-b', name: '第二测试项目（构造数据）' }, { id: 'project-empty', name: '无运行记录的测试项目' }];
  const state = { versions, bundles: [{ id: 'BUNDLE-A', datasetId: 'project-a' }, { id: 'BUNDLE-B', datasetId: 'project-b' }], runs: [mixed, other, local].map(({ results, caseIds, versions, ...summary }) => summary), connections: versions.slice(0, 2).map(version => ({ id: version.connectionId, name: version.name, provider: 'fixture', model: version.model, configured: true, tested: true })), actions: { clarify: '澄清设备信息' }, intents: { fault_repair: '故障维修' }, training: [], protocol: 'fixture' };
  return { corpora, state, runs: { [mixed.id]: mixed, [complete.id]: complete, [local.id]: local, [other.id]: other } };
}
module.exports = { createFixture };
