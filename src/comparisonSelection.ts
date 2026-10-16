export type ComparisonMode = 'horizontal' | 'vertical';
export type ComparisonPanel = 'setup' | 'results';
type ModelIdentity = { id: string; family: string; provider: string };

export function sameModelFamily(left: ModelIdentity, right: ModelIdentity) {
  return left.provider === right.provider && left.family === right.family;
}

export function modelPairAllowed(left: ModelIdentity, right: ModelIdentity, mode: ComparisonMode) {
  return left.id !== right.id && (mode === 'vertical' ? sameModelFamily(left, right) : !sameModelFamily(left, right));
}

export function comparisonViewFromHash(hash: string, run?: { id: string; models: ModelIdentity[]; comparisonMode?: ComparisonMode }): { mode: ComparisonMode; panel: ComparisonPanel } {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const requestedPanel = params.get('panel');
  const panel = requestedPanel === 'setup' || requestedPanel === 'results' ? requestedPanel : params.get('run') ? 'results' : 'setup';
  const requestedMode = params.get('comparison');
  if (requestedMode === 'vertical' || requestedMode === 'horizontal') return { mode: requestedMode, panel };
  if (panel === 'results' && run && (!params.get('run') || params.get('run') === run.id)) {
    if (run.comparisonMode === 'vertical' || run.comparisonMode === 'horizontal') return { mode: run.comparisonMode, panel };
    if (run.models.length >= 2 && run.models.every(model => sameModelFamily(model, run.models[0]))) return { mode: 'vertical', panel };
  }
  return { mode: 'horizontal', panel };
}
