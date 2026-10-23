export type ComparisonMode = 'horizontal' | 'vertical';
export type ComparisonPanel = 'setup' | 'results';
export function modelPairAllowed(left: { id: string }, right: { id: string }) {
  return left.id !== right.id;
}

export function comparisonViewFromHash(hash: string): { panel: ComparisonPanel } {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const requestedPanel = params.get('panel');
  const panel = requestedPanel === 'setup' || requestedPanel === 'results' ? requestedPanel : params.get('run') ? 'results' : 'setup';
  return { panel };
}
