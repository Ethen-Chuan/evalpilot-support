export const flowTypes = ['normal', 'exception', 'stress'] as const;
export type FlowType = typeof flowTypes[number];
export const flowNames: Record<FlowType, string> = { normal: '正常流', exception: '异常流', stress: '压力流' };
export type DialogueTestNode = { id: string; parentId: string | null; branch: string; user: string; check: string; flow: FlowType };
export type DialogueTestTree = { schema: 'dialogue-test-tree-v1'; projectId: string; name: string; revision: number; updatedAt: string | null; target: Record<FlowType, number>; plannedCount: number; source: { sessionId: string; messageId: string; question: string } | null; nodes: DialogueTestNode[] };
export type DialoguePath = { id: string; nodes: DialogueTestNode[]; flow: FlowType };
const STORAGE_PREFIX = 'evalpilot.dialogue-test-draft.v1.';

export function sampleDialogueTree(projectId: string): DialogueTestTree {
  const nodes: DialogueTestNode[] = [
    { id: 'start', parentId: null, branch: '共同起点', user: '设备开机后一直黑屏，电源灯是亮的，该怎么处理？', check: '区分无电与有电黑屏；先澄清设备型号和现象，不编造故障原因。', flow: 'normal' },
    { id: 'normal', parentId: 'start', branch: '继续排查', user: '是会议室那台设备，断电重启后还是没有画面。', check: '记住已尝试断电重启，不重复要求；提供低风险、可执行的下一步。', flow: 'normal' },
    { id: 'normal-end', parentId: 'normal', branch: '问题解决', user: '换了信号线，现在有画面了，还需要做什么吗？', check: '确认恢复并告知观察事项；不能凭空派单或声称维修完成。', flow: 'normal' },
    { id: 'correction', parentId: 'start', branch: '中途纠错 / 换设备', user: '刚才说错了，不是会议室那台，是前台那台设备，电源灯也不亮。', check: '识别设备对象和症状均变更；重新确认新设备信息，不能沿用上一台设备的黑屏结论。', flow: 'exception' },
    { id: 'correction-end', parentId: 'correction', branch: '明确边界', user: '不要再查之前那台了，我只想知道新这台怎么报修。', check: '只处理当前设备，确认报修所需信息；无工单接口时不能声称已报修。', flow: 'exception' },
    { id: 'stress-1', parentId: 'start', branch: '反复纠错 / 长对话', user: '先别急，我需要再确认一下是哪个设备出了问题。', check: '保留待确认状态，不提前绑定设备或执行操作。', flow: 'stress' },
  ];
  const turns = [
    ['stress-2', '先看设备甲，它在会议室，刚才有人说是信号线的问题。', '把设备甲标为当前对象；传闻不视为已经证实的原因。'],
    ['stress-3', '更正一下，甲现在已经恢复了。', '记录甲已恢复，不继续安排对甲的故障操作。'],
    ['stress-4', '现在要处理的是设备乙，在前台，按电源也没有反应。', '切换到乙，保留甲已恢复的事实，不混用诊断。'],
    ['stress-5', '乙之前没有做过断电重启，别记成已经做过了。', '纠正操作历史，只记录用户确认过的操作。'],
    ['stress-6', '我刚问了同事，乙的电源线可能没插紧，但还没检查。', '将原因保留为待验证假设，不认定问题已解决。'],
    ['stress-7', '线插好了，乙已经正常了。', '更新乙为恢复，不重复无效排查或创建不必要工单。'],
    ['stress-8', '那你总结一下，两台现在分别是什么情况，不要弄混。', '分别总结甲和乙的最新状态、已确认与未确认信息，不编造维修记录。'],
  ];
  for (const [index, [id, user, check]] of turns.entries()) nodes.push({ id, parentId: index === 0 ? 'stress-1' : turns[index - 1][0], branch: `持续追问 ${index + 2}`, user, check, flow: 'stress' });
  return { schema: 'dialogue-test-tree-v1', projectId, name: '设备故障排查 · 多轮分支示例', revision: 0, updatedAt: null, target: { normal: 60, exception: 30, stress: 10 }, plannedCount: 10, source: null, nodes };
}

export function dialoguePaths(tree: DialogueTestTree): DialoguePath[] {
  const root = tree.nodes.find(node => node.parentId === null);
  if (!root) return [];
  const children = new Map<string, DialogueTestNode[]>();
  for (const node of tree.nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) || []), node]);
  const paths: DialoguePath[] = [];
  const walk = (node: DialogueTestNode, prefix: DialogueTestNode[]) => {
    if (prefix.some(item => item.id === node.id) || prefix.length >= 20 || paths.length >= 200) return;
    const trail = [...prefix, node];
    const descendants = children.get(node.id) || [];
    if (!descendants.length) paths.push({ id: node.id, nodes: trail, flow: trail.some(item => item.flow === 'stress') ? 'stress' : trail.some(item => item.flow === 'exception') ? 'exception' : 'normal' });
    else descendants.forEach(child => walk(child, trail));
  };
  walk(root, []);
  return paths;
}

export function testAllocation(count: number, target: Record<FlowType, number>) {
  if (!Number.isInteger(count) || count < 1 || count > 200 || flowTypes.some(flow => !Number.isInteger(target[flow]) || target[flow] < 0 || target[flow] > 100) || flowTypes.reduce((sum, flow) => sum + target[flow], 0) !== 100) return null;
  const entries = flowTypes.map((flow, index) => ({ flow, index, value: Math.floor(count * target[flow] / 100), fraction: count * target[flow] / 100 % 1 }));
  const remaining = count - entries.reduce((sum, item) => sum + item.value, 0);
  [...entries].sort((left, right) => right.fraction - left.fraction || left.index - right.index).slice(0, remaining).forEach(item => item.value++);
  return Object.fromEntries(entries.map(item => [item.flow, item.value])) as Record<FlowType, number>;
}

export function validateDialogueTree(value: unknown, projectId: string): string[] {
  const tree = value as DialogueTestTree;
  if (!tree || typeof tree !== 'object' || tree.schema !== 'dialogue-test-tree-v1' || tree.projectId !== projectId || !Array.isArray(tree.nodes) || !tree.target) return ['草稿格式或所属项目不匹配，未加载。'];
  const problems: string[] = [];
  if (typeof tree.name !== 'string' || !tree.name.trim() || tree.name.length > 80) problems.push('填写 1–80 字的场景名称。');
  if (!Number.isInteger(tree.revision) || tree.revision < 0) problems.push('草稿版本无效。');
  if (tree.updatedAt !== null && (typeof tree.updatedAt !== 'string' || !Number.isFinite(Date.parse(tree.updatedAt)))) problems.push('草稿时间无效。');
  if (tree.nodes.length < 1 || tree.nodes.length > 60) problems.push('每棵树保留 1–60 个用户回合。');
  if (!testAllocation(tree.plannedCount, tree.target)) problems.push('目标配比需为 0–100 的整数且合计 100%，计划数量需为 1–200。');
  if (tree.nodes.some(node => !node || typeof node !== 'object' || typeof node.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(node.id) || (node.parentId !== null && (typeof node.parentId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(node.parentId))) || !flowTypes.includes(node.flow))) return [...problems, '回合编号或分类无效。'];
  if (new Set(tree.nodes.map(node => node.id)).size !== tree.nodes.length) problems.push('回合编号重复。');
  if (tree.nodes.filter(node => node.parentId === null).length !== 1) problems.push('必须且只能有一个共同起点。');
  const indexed = new Map(tree.nodes.map(node => [node.id, node]));
  for (const node of tree.nodes) {
    if (typeof node.branch !== 'string' || !node.branch.trim() || node.branch.length > 50 || typeof node.user !== 'string' || !node.user.trim() || node.user.length > 2000 || typeof node.check !== 'string' || !node.check.trim() || node.check.length > 1000) problems.push('每轮都需填写分支名、用户消息和检查点，且不能超过长度限制。');
    if (node.parentId && !indexed.has(node.parentId)) problems.push('存在无法连接到父回合的分支。');
    if (tree.nodes.filter(item => item.parentId === node.id).length > 3) problems.push('一个节点最多三个分支，避免测试树难以维护。');
    const seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent && indexed.has(parent)) {
      if (seen.has(parent)) { problems.push('分支不能形成循环。'); break; }
      seen.add(parent); parent = indexed.get(parent)!.parentId;
      if (seen.size > 20) { problems.push('单条路径最多 20 个用户回合。'); break; }
    }
  }
  if (tree.source !== null && (!tree.source || typeof tree.source.sessionId !== 'string' || !tree.source.sessionId.trim() || typeof tree.source.messageId !== 'string' || !tree.source.messageId.trim() || typeof tree.source.question !== 'string' || !tree.source.question.trim() || tree.source.question.length > 2000)) problems.push('来源引用无效。');
  const serialized = JSON.stringify(tree);
  if (/-----BEGIN .*PRIVATE KEY-----|(?:sk-|ghp_|github_pat_|AKIA)[a-zA-Z0-9_-]{12,}|(?:api[_ -]?key|password|token|密码)\s*[:=]\s*\S{5,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{16,19}(?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(serialized)) problems.push('发现疑似凭证或个人信息，请先替换为匿名占位符，再保存。');
  return [...new Set(problems)];
}

export function removeDialogueBranch(tree: DialogueTestTree, id: string) {
  if (!tree.nodes.find(node => node.id === id)?.parentId) return tree;
  const removed = new Set([id]);
  let changed = true;
  while (changed) { changed = false; for (const node of tree.nodes) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); changed = true; } }
  return { ...tree, nodes: tree.nodes.filter(node => !removed.has(node.id)) };
}

export function loadDialogueDraft(storage: Pick<Storage, 'getItem'>, projectId: string): DialogueTestTree | null {
  const content = storage.getItem(STORAGE_PREFIX + projectId);
  if (!content) return null;
  if (content.length > 300000) throw new Error('草稿超过上限，未加载；原保存内容未改动。');
  const value = JSON.parse(content);
  const errors = validateDialogueTree(value, projectId);
  if (errors.length) throw new Error(errors.join(' '));
  return value;
}

export function saveDialogueDraft(storage: Pick<Storage, 'setItem'>, tree: DialogueTestTree) {
  const problems = validateDialogueTree(tree, tree.projectId);
  if (problems.length) throw new Error(problems.join(' '));
  const saved = { ...tree, revision: tree.revision + 1, updatedAt: new Date().toISOString() };
  storage.setItem(STORAGE_PREFIX + tree.projectId, JSON.stringify(saved));
  return saved;
}
