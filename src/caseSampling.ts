export const MAX_RUN_CASES = 200;

export function sampleCaseIds(identifiers: readonly string[], count: number, random: () => number = Math.random): string[] {
  const pool = [...new Set(identifiers)];
  if (!Number.isInteger(count) || count < 1 || count > Math.min(MAX_RUN_CASES, pool.length)) return [];
  for (let index = 0; index < count; index += 1) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机数必须在 0 到 1 之间');
    const target = index + Math.floor(value * (pool.length - index));
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return pool.slice(0, count);
}

export function restrictCasePool<T extends { id: string }>(cases: T[], parent?: { caseIds?: string[] } | null): T[] {
  const unique = [...new Map(cases.map(item => [item.id, item])).values()];
  if (!parent) return unique;
  if (!parent.caseIds?.length) throw new Error('原批次的案例清单尚未读取，请关闭窗口后重试。');
  const identifiers = new Set(parent.caseIds);
  const available = unique.filter(item => identifiers.has(item.id));
  if (available.length !== identifiers.size) throw new Error('原批次有案例已不可用，暂不能重跑。请先核对原批次，或新建评测。');
  return available;
}
