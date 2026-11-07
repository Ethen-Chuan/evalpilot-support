export function plainLanguage(text: string): string {
  return text.replaceAll('断言', '规则检查').replaceAll('回归集', '复测案例').replaceAll('回归', '复测').replaceAll('受控片段', '已审核答复内容').replaceAll('审核片段', '已审核答复内容').replaceAll('发布门禁', '回复安全检查').replaceAll('提案已阻断', '不合规答复已拦截').replaceAll('提案', '候选答复').replaceAll('安全兜底', '安全提示').replaceAll('沙箱', '本地模拟').replaceAll('Rubric', '评分标准').replaceAll('Harness', '客服运行规则').replaceAll('冻结', '保存');
}

export function retestStatus(status: string): { label: string; tone: 'amber' | 'red' } {
  if (status.startsWith('断言通过') || status.startsWith('规则检查通过')) return { label: '规则检查通过 · 答复质量待人工确认', tone: 'amber' };
  if (status === '仍有失败') return { label: '仍有未通过的检查', tone: 'red' };
  return { label: '已保存 · 待再次测试', tone: 'amber' };
}

export function sameRuntime(record: { runtimeHash?: string }, runtimeHash?: string): boolean {
  return !!runtimeHash && record.runtimeHash === runtimeHash;
}

export const toolLabels: Record<string, string> = { read_case_memory: '查看客户已经说过什么', search_knowledge: '查找相关客服知识', read_policy: '读取对应处理规则', lookup_service: '核对模拟业务状态', create_handoff_draft: '整理人工交接信息' };

export function eventDetails(event: { type: string; name: string; status?: string; output: unknown }): string[] {
  const output = event.output && typeof event.output === 'object' ? event.output as Record<string, unknown> : {};
  if (event.name === '本体执行前校验') return [output.allowed ? `本体 V${output.revision} 允许此工具，随后才执行。` : `本体 V${output.revision} 未放行此工具，没有执行业务操作。`];
  if (event.status === 'blocked') return ['必要信息或前置检查未满足，本次操作没有执行。'];
  if (event.type !== 'tool') return [event.status === 'started' ? '开始处理当前客户问题。' : '本次处理已结束，后续结果仍需经过规则检查。'];
  if (event.name === 'read_case_memory') return [`读取了 ${Array.isArray(output.history) ? output.history.length : 0} 条历史消息。`, ...Object.values(output.facts && typeof output.facts === 'object' ? output.facts : {}).filter((value): value is string => typeof value === 'string').map(plainLanguage)];
  if (event.name === 'search_knowledge') {
    const results = Array.isArray(output.results) ? output.results as { title?: string; matchedTerms?: string[] }[] : [];
    return results.length ? results.map(item => `${item.title || '相关知识'}${item.matchedTerms?.length ? `；匹配到：${item.matchedTerms.join('、')}` : ''}`) : ['没有找到相关知识，不能编造依据。'];
  }
  if (event.name === 'read_policy') return (Array.isArray(output.documents) ? output.documents as { title?: string; policy?: string }[] : []).map(item => plainLanguage(`${item.title || '处理规则'}：${item.policy || '已读取'}`));
  if (event.name === 'create_handoff_draft') return ['已在本机整理交接信息。这里只生成草稿，没有接通真人或提交工单。'];
  if (event.name === 'lookup_service') return ['读取了案例里的模拟业务状态，没有连接真实订单或资金系统。'];
  return ['已保存本次处理记录。'];
}
