import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, CheckCircle, CircleNotch, Play, TerminalWindow, WarningCircle, X } from '@phosphor-icons/react';
import type { GraphEdge, GraphNode, OntologyGraph, Resolution } from './ontologyGraph';
import './ontology-commands.css';

type Change = { kind: string; action: string; id: string; label: string; before: Partial<GraphNode & GraphEdge> | null; after: Partial<GraphNode & GraphEdge> | null };
type Execution = { id: string; protocol: string; createdAt: string; status: string; command: string; function: string; arguments: Record<string, string>; revision: string; previewId?: string; canCommit?: boolean; writesApplied: boolean; error?: string; changes?: Change[]; checks?: { passed: number; total: number; failedCases?: string[] }; trace: { function: string; status: string }[]; output?: { node?: GraphNode; relations?: GraphEdge[]; graph?: Resolution; outcome?: { title: string; reason: string; candidateNames: string[]; actionBlocked: boolean }; comparison?: { selected: { id: string; title: string }[] }; steps?: { id: string; title: string; status: string }[]; total?: number; passed?: number; boundary?: string } };
type Workspace = { protocol: string; revision: string; undoAvailable: boolean; history: Execution[]; examples: string[]; functions: string[]; relations: Record<string, string>; boundary: string };
const names: Record<string, string> = { validate_command: '检查指令与约束', inspect_node: '查询元素及关系', add_alias: '添加别名', remove_alias: '移除别名', update_description: '改写元素说明', create_entity: '新增实体', add_relation: '添加业务关系', remove_relation: '移除业务关系', run_customer_task: '执行客服任务', verify_workspace: '运行固定验收', undo_change: '撤销上次修改' };
const statuses: Record<string, string> = { completed: '已执行', dry_run: '试算，未保存', awaiting_confirmation: '等待确认', blocked: '已阻止' };

export function OntologyCommandPanel({ graph, selected, changed, focus }: { graph: OntologyGraph; selected?: GraphNode; changed: (identifier: string) => Promise<void>; focus: (resolution: Resolution, title: string) => void }) {
  const [state, setState] = useState<Workspace | null>(null);
  const [command, setCommand] = useState('');
  const [pending, setPending] = useState<Execution | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const stateController = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const selectedId = useRef(selected?.id || '');
  const input = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); stateController.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(); stateController.current?.abort(); stateController.current = request;
    setError(''); setLoading(true);
    fetch('/api/support/ontology/workbench/state', { signal: request.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok || value.protocol !== 'ontology-commands-v1') throw new Error('当前服务没有业务操作台，请打开新版服务后重试。');
      if (!request.signal.aborted) setState(value);
    }).catch(problem => { if (!request.signal.aborted) setError(problem instanceof Error ? problem.message : '工作区读取失败'); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [graph.workspaceRevision, retry]);
  useEffect(() => {
    selectedId.current = selected?.id || '';
    setPending(null);
  }, [selected?.id, graph.workspaceRevision]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [state?.history, pending]);
  const append = (execution: Execution) => setState(previous => previous ? { ...previous, revision: execution.writesApplied ? execution.revision : previous.revision, history: [...previous.history.filter(item => item.id !== execution.id), execution].slice(-20) } : previous);
  const send = async (confirm = false) => {
    if (!state || busy || loading || (confirm && !pending)) return;
    stateController.current?.abort();
    const request = new AbortController(); controller.current = request;
    const target = selectedId.current;
    const preview = pending;
    setBusy(true); setError(''); setNotice('');
    if (!confirm) setPending(null);
    let applied = false;
    try {
      const body = confirm ? { previewId: preview!.previewId, expectedRevision: preview!.revision, confirm: true } : { command, selectedNodeId: target, expectedRevision: state.revision };
      const response = await fetch('/api/support/ontology/workbench/' + (confirm ? 'commit' : 'command'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: request.signal });
      const value = await response.json();
      if (request.signal.aborted) return;
      if (!response.ok || value.protocol !== 'ontology-commands-v1') throw new Error(value.error || '函数执行未完成，请检查服务版本。');
      applied = value.writesApplied;
      append(value);
      if (applied) {
        setPending(null); setCommand('');
        await changed(value.arguments.nodeId || value.arguments.sourceId || target);
        if (alive.current) setNotice('修改已保存到本机工作区，图谱已刷新；客服任务会使用更新后的定义。');
      } else if (value.status === 'preview' && target === selectedId.current) {
        setPending(value);
      } else if (value.status === 'preview') setNotice('预览期间选中对象已变化，没有自动确认；请按当前目标重新预览。');
      else setCommand('');
    } catch (problem) {
      if (confirm && !request.signal.aborted) setPending(null);
      if (!request.signal.aborted) setError((applied ? '修改已保存，但图谱刷新未完成，请点击刷新图谱。' : confirm ? '未收到完整确认结果，请刷新记录核对是否已保存，不要重复提交。' : '') + (problem instanceof Error ? problem.message : '请求未完成'));
    } finally { if (!request.signal.aborted && alive.current) setBusy(false); }
  };
  const choose = (text: string) => { setCommand(text); setPending(null); setError(''); input.current?.focus(); };
  const stale = Boolean(state && graph.workspaceRevision && state.revision !== graph.workspaceRevision);
  return <section className="ontology-command-panel" aria-label="图谱业务操作台" aria-busy={busy || loading}>
    <header><div><TerminalWindow size={18} /><strong>业务操作台</strong></div><button aria-label="刷新操作记录" disabled={busy || loading} onClick={() => { setPending(null); setRetry(value => value + 1); }}><ArrowClockwise size={15} /></button></header>
    <div className="oc-context"><span>当前选中</span><strong>{selected?.label || '未选中元素'}</strong><p>{selected?.description || '可以先点击图谱节点，或使用带完整元素名称的指令。'}</p><small>本机函数 · 真实保存 · 不调用模型</small></div>
    {loading && !error && <p className="oc-loading" role="status"><CircleNotch className="spin" size={16} />读取本机工作区…</p>}
    <div className="oc-log" ref={log} role="log" aria-label="业务函数执行记录">
      {state && !state.history.length && <div className="oc-welcome"><strong>不止看关系，也能修改和验证。</strong><p>先添加一个新叫法，确认保存，再运行一句使用新叫法的客户问题，验证检索是否发生变化。</p><button disabled={busy || loading} onClick={() => choose('给“启动异常”添加别名“启动没反应”')}>带入第一条指令<ArrowRight size={14} /></button></div>}
      {state?.history.map(execution => <article key={execution.id} className={'oc-event ' + execution.status}>
        <p className="oc-user">{execution.command}</p>
        <div className="oc-event-heading">{execution.status === 'blocked' ? <WarningCircle size={15} /> : <CheckCircle size={15} />}<strong>{names[execution.function] || execution.function}</strong><span>{execution.writesApplied ? '已保存' : execution.status === 'preview' ? '仅预览' : execution.status === 'blocked' ? '已阻止' : '已执行只读函数'}</span></div>
        {!!execution.changes?.length && <ul className="oc-changes">{execution.changes.map(change => <li key={change.id}><b>{change.action}</b><span>{change.kind} · {change.label}</span>{change.kind === '元素' && change.before && change.after && <small>{change.before.description !== change.after.description ? `${change.before.description} → ${change.after.description}` : `${'aliases' in change.before ? change.before.aliases?.join(' / ') : ''} → ${'aliases' in change.after ? change.after.aliases?.join(' / ') : ''}`}</small>}</li>)}</ul>}
        {execution.checks && <p className="oc-validation">固定验收 {execution.checks.passed} / {execution.checks.total}{execution.checks.failedCases?.length ? `；阻止原因：${execution.checks.failedCases.join('、')}` : '，未改变已有案例预期'}</p>}
        {execution.error && <p className="oc-validation">没有执行：{execution.error}</p>}
        {execution.output?.node && <div className="oc-read"><strong>{execution.output.node.label}</strong><p>{execution.output.node.description}</p><p>实际查到 {execution.output.relations?.length || 0} 条相连关系</p><ul>{execution.output.relations?.map(relation => <li key={relation.id}>{graph.nodes.find(node => node.id === relation.source)?.label || relation.source} → {relation.label} → {graph.nodes.find(node => node.id === relation.target)?.label || relation.target}</li>)}</ul></div>}
        {execution.output?.outcome && <div className="oc-read"><strong>{execution.output.outcome.title}</strong><p>{execution.output.outcome.reason}</p><p>引用：{execution.output.comparison?.selected.map(item => item.title + '（' + item.id + '）').join('、') || '没有可引用知识'}</p><p>候选：{execution.output.outcome.candidateNames.join('、') || '无'}，不是确诊；没有执行派单或换件。</p>{execution.output.graph && <button onClick={() => focus(execution.output!.graph!, `指令窗口执行依据 · ${execution.id}`)}>定位这次执行关系<ArrowRight size={13} /></button>}</div>}
        {execution.output?.total !== undefined && <p className="oc-validation">实际验收 {execution.output.passed} / {execution.output.total}。{execution.output.boundary}</p>}
        <details className="oc-call"><summary>函数、参数与执行记录</summary><code>{execution.function}({JSON.stringify(execution.arguments)})</code><ol>{execution.trace.map((step, index) => <li key={index}>{step.function} · {statuses[step.status] || step.status}</li>)}</ol>{execution.output?.steps && <ol>{execution.output.steps.map(step => <li key={step.id}>{step.title} · {step.status === 'skipped' ? '未调用' : step.status === 'blocked' ? '已拦截' : '已执行'}</li>)}</ol>}<small>{execution.createdAt} · {execution.id}<br />工作区版本 {execution.revision}</small><details><summary>完整返回值及变更前后</summary><pre>{JSON.stringify(execution, null, 2)}</pre></details></details>
      </article>)}
    </div>
    {stale && <p className="oc-warning" role="status">图谱与工作区版本不同，请刷新图谱后再执行，避免改错旧版本。</p>}
    {notice && <p className="oc-notice" role="status">{notice}</p>}
    {error && <p className="oc-error" role="alert">{error}</p>}
    {pending && <div className="oc-confirm"><strong>预览未保存，是否执行以上修改？</strong><span>确认只授权本次函数和参数；切换节点或修改指令后需要重新预览。</span><div><button disabled={busy || loading || stale} onClick={() => void send(true)}>{busy ? <CircleNotch className="spin" size={14} /> : <Play size={14} />}确认执行本次修改</button><button disabled={busy || loading} onClick={() => setPending(null)}><X size={14} />取消</button></div></div>}
    <form className="oc-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="ontology-command-input">给图谱下业务指令</label><textarea id="ontology-command-input" ref={input} aria-label="图谱业务指令" value={command} onChange={event => { setCommand(event.target.value); setPending(null); }} disabled={busy || loading} maxLength={500} rows={3} placeholder="例如：添加别名“启动没反应”" /><div><small>{state ? `本机版本 ${state.revision.split(':')[0]}` : '等待工作区'} · 非系统命令行</small><button type="submit" disabled={busy || loading || !state || stale || !command.trim()}>{busy ? <CircleNotch className="spin" size={15} /> : <Play size={15} />}{busy ? '正在处理…' : '发送指令'}</button></div></form>
    <details className="oc-help"><summary>支持哪些指令？</summary><p>只支持下列明确格式，不会猜测或执行任意命令。点击带入，不会立即执行。</p>{state?.examples.map(example => <button key={example} disabled={busy || loading} onClick={() => choose(example)}>{example}</button>)}<p>新增关系需先选中起点。可用关系：{Object.values(state?.relations || {}).join('、')}。</p><p>写入前执行结构检查与 12 条回归；失败就不能保存。撤销同样先预览，最多保留最近 50 次可撤销修改。</p><p>{state?.boundary}</p></details>
  </section>;
}
