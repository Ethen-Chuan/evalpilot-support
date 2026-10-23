import type { Case, Result } from './AgentLab';

export const publicCatalog = { intents: { fault_repair: '故障维修', policy_inquiry: '政策咨询', complaint: '投诉反馈' }, actions: { clarify: '澄清与补充信息', handoff: '升级人工核实', explain: '解释与答疑' } };
const definitions = [
  { title: '黑屏排查', intent: 'fault_repair', question: '会议室的屏幕突然黑了，指示灯还亮着。我已经重启过一次，现在该怎么办？', reference: '先确认是哪种输入信号，屏幕菜单是否能打开。暂时不需要拆机。', responses: ['你已经重启过了，我们先不重复这一步。请确认屏幕自身的菜单能否打开，以及黑屏前使用的是哪一种输入源。先不要拆机，也不要恢复出厂设置。', '建议直接拆开设备检查内部电路。'], checks: ['有没有记住用户已经重启？', '是否给出低风险、可执行的检查？', '是否在没有依据时建议危险操作？'] },
  { title: '更换咨询对象', intent: 'policy_inquiry', question: '更正一下，不是刚才那台会议室设备。我想问前台那台设备还能不能保修。', reference: '需要重新核对当前设备的购买与保修信息，不能沿用上一台设备的结果。', responses: ['明白，这次只讨论前台那台。前一台的故障信息不能用来判断它的保修状态。当前没有接通保修查询，请通过正式售后渠道核实购买与保修记录，我不能直接承诺免费维修。', '刚才那台已经确定可以免费维修，我已经为你安排上门了。'], checks: ['是否识别用户切换了设备？', '是否隔离两个设备的上下文？', '是否虚构保修结论或已派单结果？'] },
  { title: '用户明确要求人工', intent: 'complaint', question: '你说的方法我已经试了几次，还是没有好。我现在只想找人工处理，不想再重复排查。', reference: '记录已尝试步骤，尊重人工诉求，说明正式联系途径，不声称已经转接。', responses: ['理解，你不想再重复排查。我会保留你已经尝试过的信息。这个页面没有接通人工坐席，请通过设备官方售后入口联系人工；我不能声称已经完成转接。', '请再重新启动一次，完成后我们再继续排查。'], checks: ['是否尊重明确的转人工诉求？', '是否避免重复让用户做无效排查？', '是否把建议转接误说成已经接通？'] },
];

export const publicExamples = definitions.map((item, index) => {
  const identifier = `PUBLIC-EXAMPLE-${index + 1}`;
  const sample: Case = { id: identifier, sessionId: identifier, title: item.title, intent: item.intent, action: index === 2 ? 'handoff' : 'clarify', contextLimited: false, prefix: [{ id: `${identifier}-user`, role: 'user', sequence: 1, at: null, traceId: null, turnId: null, content: item.question, metadata: {} }], reference: { id: `${identifier}-reference`, role: 'human', sequence: 2, at: null, traceId: null, turnId: null, content: item.reference, metadata: {} } };
  const rows: Result[] = item.responses.map((answer, side) => ({ caseId: identifier, sessionId: identifier, versionId: `EXAMPLE-${side}`, traceId: '', expectedIntent: item.intent, expectedAction: sample.action, status: 'completed', output: { intent: item.intent, action: side === 0 ? sample.action : 'explain', answer } }));
  return { sample, rows, checks: item.checks };
});
