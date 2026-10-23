export type TraceSpan = {
  id: string; parentId: string | null; name: string; kind: string; status: string;
  startMs: number; durationMs: number | null; input: unknown; output: unknown;
  attributes: Record<string, unknown>; events: { name: string; offsetMs: number; attributes: unknown }[];
  error: { type: string; message: string; frames?: { file: string; line: number; function: string }[] } | null;
};
export type TraceRecord = {
  id: string; name: string; source: string; origin: string; execution: string; status: string;
  sessionId: string | null; conversationId: string | null; runId: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  input: unknown; output: unknown; attributes: Record<string, unknown>;
  issues: { kind: string; code: string; message: string; spanId: string }[];
  annotations: { name: string; at: string; attributes: Record<string, unknown> }[];
  spans: TraceSpan[]; spanCount: number; errorCount: number;
  preview: string; hasQualityIssue: boolean; redaction: string;
  category: string; categoryName: string; sourceName: string; batchId: string | null; durationScope: string;
};

export const traceKinds: Record<string, string> = { agent: '整体执行', guardrail: '安全检查', memory: '上下文', retrieval: '检索', model: '模型', tool: '工具', routing: '决策路由', evaluation: '评测', storage: '存储', internal: '内部操作' };
export const traceLabels: Record<string, string> = { running: '执行中', ok: '执行成功', error: '执行异常', blocked: '输入拦截', cancelled: '已取消', interrupted: '服务中断' };
export const traceElapsed = (duration: number | null | undefined) => duration == null || !Number.isFinite(duration) ? '耗时未记录' : duration < 1000 ? `${duration.toFixed(1)} ms` : `${(duration / 1000).toFixed(2)} s`;
export const traceObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const fieldNames: Record<string, string> = { model: '实际调用模型', intent: '识别意图', action: '下一步建议', decision: '路由建议', intentMatch: '意图与来源标签', actionMatch: '行为与弱标签', judgeCompleted: '模型裁判', reviewed: '评审状态', productionExecuted: '真实业务操作', productionActionExecuted: '真实业务操作', productionConnection: '生产连接', environment: '运行环境', role: '调用角色', messageCount: '消息数', allowed: '隐私检查', passed: '检查结果', resolution: '解决率', liveContainment: '线上拦截率', finishReason: '输出结束状态' };
const actionNames: Record<string, string> = { clarify: '澄清与补充信息', explain: '解释与答疑', lookup: '查询信息', handoff: '建议转人工', ticket: '整理工单', answer: '直接答复', refuse: '拒绝处理', collect: '收集信息' };
const values: Record<string, string> = { candidate: '候选模型', judge: '裁判模型', sandbox: '本机沙箱', not_measurable: '不可测量', not_measured: '尚未测量', stop: '完整返回', self_service: '自助处理', must_handoff: '必须转人工' };

export function traceValueSummary(value: unknown, intentNames: Record<string, string> = {}) {
  const record = traceObject(value);
  const output = traceObject(record.output);
  const fields = { ...record, ...output };
  const text = typeof value === 'string' ? value : [fields.answer, fields.result, fields.message, fields.text, fields.question].find(item => typeof item === 'string') as string | undefined;
  const facts = Object.entries(fieldNames).flatMap(([key, label]) => {
    const current = fields[key];
    if (current === undefined || current === null || typeof current === 'object') return [];
    let display = String(current);
    if (key === 'intent') display = intentNames[display] || display;
    else if (key === 'action' || key === 'decision') display = actionNames[display] || values[display] || display;
    else if (typeof current === 'boolean') {
      if (key === 'intentMatch' || key === 'actionMatch') display = current ? '一致' : '不一致';
      else if (key === 'judgeCompleted' || key === 'reviewed') display = current ? '已完成' : '未完成';
      else if (key.startsWith('production')) display = current ? '已记录执行 / 连接' : '未执行 / 未连接';
      else display = current ? '通过' : '未通过';
    } else display = values[display] || display;
    return [{ key, label, value: display }];
  });
  const usage = traceObject(fields.usage);
  for (const [key, label] of [['prompt_tokens', '输入 Token'], ['completion_tokens', '输出 Token'], ['total_tokens', '总 Token']]) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0) facts.push({ key, label, value: String(usage[key]) });
  }
  return { text, facts, hasValue: value !== null && value !== undefined, hasLabels: 'intentMatch' in fields || 'actionMatch' in fields };
}

export function traceSpanDepths(spans: TraceSpan[]) {
  const indexed = new Map(spans.map(span => [span.id, span]));
  return new Map(spans.map(span => {
    let parent = span.parentId;
    let depth = 0;
    const seen = new Set([span.id]);
    while (parent && indexed.has(parent) && !seen.has(parent)) { depth++; seen.add(parent); parent = indexed.get(parent)!.parentId; }
    return [span.id, Math.min(depth, 4)];
  }));
}

export function traceBar(span: Pick<TraceSpan, 'startMs' | 'durationMs'>, total: number | null) {
  const measured = total !== null && Number.isFinite(total) && total > 0 && span.durationMs !== null && Number.isFinite(span.durationMs) && span.durationMs >= 0 && Number.isFinite(span.startMs);
  if (!measured) return null;
  const start = Math.max(0, Math.min(100, span.startMs / total * 100));
  return { start, width: Math.max(0, Math.min(100 - start, span.durationMs! / total * 100)) };
}

export function traceCandidateModels(spans: TraceSpan[]) {
  return [...new Set(spans.filter(span => span.kind === 'model' && traceObject(span.input).role !== 'judge' && !span.name.includes('裁判')).flatMap(span => {
    const model = traceObject(span.output).model;
    return typeof model === 'string' && model ? [model] : [];
  }))];
}

export function traceReturnUrl(hash: string, runId: string | null) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const previous = params.get('return');
  if (previous && /^overview(?:\?|$)/.test(previous)) return `#${previous}`;
  const currentRun = runId || params.get('run');
  if (!currentRun) return '';
  if (currentRun.startsWith('MMRUN-')) return `#compare?mode=vision&mmrun=${encodeURIComponent(currentRun)}`;
  return currentRun.startsWith('EVAL-') ? `#benchmark?run=${encodeURIComponent(currentRun)}` : '';
}

export function traceConversationUrl(sessionId: string, hash: string) {
  const current = new URLSearchParams(hash.split('?')[1] || '');
  const next = new URLSearchParams({ session: sessionId });
  for (const key of ['run', 'project']) {
    if (current.get(key)) next.set(key, current.get(key)!);
  }
  if (/^#traces(?:\?|$)/.test(hash)) next.set('return', hash.slice(1));
  return `#knowledge?${next}`;
}
