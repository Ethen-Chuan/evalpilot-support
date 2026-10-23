import type { LabState, Result, Run, Version } from './AgentLab';

export type OpsRun = Omit<Run, 'models'> & { models?: Version[]; versions?: Version[]; datasetId?: string; judgeConnection?: { provider: string; judgeModel: string } | null };

export function projectOfRun(run: OpsRun, state: Pick<LabState, 'bundles'>) {
  return run.datasetId || state.bundles.find(bundle => bundle.id === run.bundleId)?.datasetId || '';
}

export function externalVersions(run: OpsRun, state: Pick<LabState, 'versions'>) {
  return (run.versions || run.models || []).map(version => ({ ...state.versions.find(item => item.id === version.id), ...version })).filter(version => version.kind === 'external');
}

export function reviewFlags(row: Result) {
  if (row.status !== 'completed') return [];
  const flags: string[] = [];
  if (row.intentMatch === false) flags.push('意图与标注不同');
  if (row.actionMatch === false) flags.push('处理方式与参考不同');
  const scores = Object.values(row.judgment?.dimensions || {});
  if (scores.some(value => value != null && value < 3)) flags.push('裁判有低于 3 分项');
  if (scores.some(value => value == null)) flags.push('裁判证据不足');
  return flags;
}

export function runStatistics(run: OpsRun, state: Pick<LabState, 'versions'>) {
  const versions = externalVersions(run, state);
  const rows = (run.results || []).filter(row => versions.some(version => version.id === row.versionId));
  const completed = rows.filter(row => row.status === 'completed');
  const planned = (run.caseIds?.length || 0) * versions.length;
  return { versions, rows, planned, completed: completed.length, failed: rows.filter(row => row.status === 'failed').length, remaining: Math.max(0, planned - rows.length), reviewed: completed.filter(row => !!row.judgment).length, flagged: rows.filter(row => reviewFlags(row).length).length };
}

export function modelOpsLink(page: string, project: string, values: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...(project ? { project } : {}), ...values });
  return `#${page}${params.size ? `?${params}` : ''}`;
}
