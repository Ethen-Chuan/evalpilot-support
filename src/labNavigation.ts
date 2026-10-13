export type RunSummary = { id: string; bundleId: string; status: string; total: number; createdAt: string; models: { id: string }[]; caseHash: string; protocol: string; judgeHash: string };

export function caseCount(run: Pick<RunSummary, 'total' | 'models'>) {
  return run.models.length ? run.total / run.models.length : 0;
}

export function rememberedRun(bundleId?: string) {
  try { return sessionStorage.getItem(`evalpilot.selected-run.${bundleId || 'current'}`) || ''; } catch { return ''; }
}

export function rememberRun(run: Pick<RunSummary, 'id' | 'bundleId'>) {
  try {
    sessionStorage.setItem(`evalpilot.selected-run.${run.bundleId}`, run.id);
    sessionStorage.setItem('evalpilot.selected-run.current', run.id);
  } catch { }
}

export function chooseDefaultRun<T extends RunSummary>(runs: T[], requested = '') {
  return runs.find(run => run.id === requested) || [...runs].filter(run => run.status === 'completed').sort((left, right) => caseCount(right) - caseCount(left) || right.createdAt.localeCompare(left.createdAt))[0] || runs[0];
}

export function comparableRuns(left: RunSummary, right: RunSummary) {
  return left.status === 'completed' && right.status === 'completed' && ['bundleId', 'caseHash', 'protocol', 'judgeHash'].every(key => left[key as keyof RunSummary] === right[key as keyof RunSummary]);
}

export function runUrl(page: string, runId = rememberedRun()) {
  return `#${page}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`;
}

export function runFromHash() {
  const value = new URLSearchParams(location.hash.split('?')[1] || '').get('run') || '';
  return /^(?:EVAL|MMRUN)-[A-Z0-9-]+$/.test(value) ? value : '';
}

export function runLabel(run: RunSummary) {
  const date = new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${caseCount(run)} 个案例 · ${run.models.length} 个版本 · ${date} · ${run.id.slice(-6)}`;
}
