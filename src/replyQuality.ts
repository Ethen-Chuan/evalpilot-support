import type { Result } from './AgentLab';

export const reviewDimensions = [
  { key: 'relevance', label: '答复切题', description: '是否回应当前用户诉求' },
  { key: 'next_step', label: '下一步合理', description: '处理建议是否具体、可行' },
  { key: 'boundary', label: '权限与证据边界', description: '是否诚实说明资料与操作权限限制' },
] as const;
export type ReviewStatus = 'unreviewed' | 'review_error' | 'insufficient' | 'attention' | 'reasonable' | 'execution_error' | 'pending';
export type ReviewFilter = 'all' | 'attention' | 'unreviewed' | 'reasonable' | 'execution_error';
export const reviewFilters: { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: '全部结果' }, { key: 'attention', label: '建议复核' },
  { key: 'unreviewed', label: '评审未完成' }, { key: 'reasonable', label: '裁判认为基本合理' },
  { key: 'execution_error', label: '执行异常' },
];

export function replyQuality(row: Result) {
  const result = (status: ReviewStatus, label: string, note: string, tone: 'gray' | 'blue' | 'amber' | 'red', reviewed = false) => ({ status, label, note, tone, reviewed });
  if (['failed', 'interrupted', 'cancelled'].includes(row.status)) return result('execution_error', '执行异常', '未获得有效答复，不参与质量评分。', 'red');
  if (row.status !== 'completed') return result('pending', '等待执行', '完成后再查看答复与评审。', 'gray');
  if (!row.output?.answer?.trim()) return result('execution_error', '答复缺失', '没有有效答复文本，不推断质量或补造内容。', 'red');
  if (!row.judgment) return row.judgeError
    ? result('review_error', '评审失败', '裁判调用或校验未完成，不等于答复不合格。', 'amber')
    : result('unreviewed', '未评审', '已生成答复，尚无裁判意见。', 'gray');
  const judgment = row.judgment;
  const valid = judgment.dimensions && reviewDimensions.every(({ key }) => judgment.dimensions[key] === null || (Number.isInteger(judgment.dimensions[key]) && Number(judgment.dimensions[key]) >= 0 && Number(judgment.dimensions[key]) <= 4))
    && typeof judgment.reason === 'string' && !!judgment.reason.trim() && Array.isArray(judgment.evidenceIds) && judgment.evidenceIds.length > 0 && judgment.evidenceIds.every(value => typeof value === 'string' && !!value.trim());
  if (!valid) return result('review_error', '评审记录不完整', '缺少有效维度、说明或证据引用，不推断为通过。', 'amber');
  const scores = reviewDimensions.map(({ key }) => judgment.dimensions[key]);
  const missing = scores.some(value => value === null);
  if (scores.some(value => value !== null && value < 3)) return result('attention', '建议复核', `裁判至少一项为 0–2 分${missing ? '，且有维度证据不足' : ''}；请核对原话。`, 'amber', true);
  if (missing) return result('insufficient', '证据不足', '至少一个维度未给分，不能判断整体质量。', 'gray', true);
  return result('reasonable', '裁判认为基本合理', '三个维度均为 3–4 分；不是人工验收或问题已解决。', 'blue', true);
}

export function matchesReviewFilter(row: Result, filter: ReviewFilter) {
  const status = replyQuality(row).status;
  if (filter === 'all') return true;
  if (filter === 'unreviewed') return ['unreviewed', 'review_error', 'insufficient'].includes(status);
  return status === filter;
}

export function reviewCounts(rows: Result[]) {
  return Object.fromEntries(reviewFilters.map(({ key }) => [key, rows.filter(row => matchesReviewFilter(row, key)).length])) as Record<ReviewFilter, number>;
}

export function diagnosticMatch(value: boolean | undefined) {
  return value === true ? '与参考一致' : value === false ? '与参考不同' : '未记录';
}
