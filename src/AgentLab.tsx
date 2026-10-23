import { useCallback, useEffect, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowsLeftRight, ChartBar, Check, CircleNotch, Flask, GitBranch, Headset, Key, Play, Plus, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Modal, Panel, number } from './ui';
import { ConversationPlayback } from './ConversationPlayback';
import type { ConversationMessage } from './ConversationPlayback';
import type { Corpus } from './CorpusLabels';
import { caseCount, chooseDefaultRun, comparableRuns, rememberRun, rememberedRun, runLabel, runUrl } from './labNavigation';
import './agent-lab.css';
import { TextComparisonSetup } from './TextComparisonSetup';
import { CaseComparison } from './CaseComparison';
import type { ComparisonPreset } from './CaseComparison';
import { comparisonViewFromHash } from './comparisonSelection';
import type { ComparisonMode, ComparisonPanel } from './comparisonSelection';
import { RunModal } from './RunModal';
import { ReplyResults } from './ReplyResults';
import { ResultEvidence } from './ResultEvidence';
import { replyQuality, reviewDimensions } from './replyQuality';

export type Bundle = { id: string; datasetId: string; sourceSessions: number; eligible: number; splits: Record<string, number>; excluded: Record<string, number>; createdAt: string; groupCount: number; traceId: string; versionIds: string[] };
export type Version = { id: string; name: string; family: string; provider: string; model: string; kind: string; bundleId?: string; connectionId?: string; createdAt: string; trainCount?: number; validation?: Record<string, number> };
export type { Connection } from './ModelConnection';
import type { Connection } from './ModelConnection';
export { ConnectionModal } from './ModelConnection';
import { ConnectionModal } from './ModelConnection';
type Metric = { total: number; completed: number; failed: number; pending: number; intentAccuracy: number | null; actionAccuracy: number | null; jointAccuracy: number | null; intentMacroF1: number | null; actionMacroF1: number | null; perIntent: { intent: string; n: number; intentAccuracy: number; actionAccuracy: number }[]; p95Ms: number | null; judge: Record<string, { mean: number | null; n: number }>; judgeErrors: number; contextLimited: number; providerTokens: number; tokenReports: number };
export type Result = { caseId: string; sessionId: string; versionId: string; traceId: string; expectedIntent: string; expectedAction: string; status: string; error?: string; output?: { intent: string; action: string; answer: string }; intentMatch?: boolean; actionMatch?: boolean; latencyMs?: number; judgeError?: string; judgment?: { dimensions: Record<string, number | null>; reason: string; evidenceIds: string[] }; sandbox?: { result: string; draftId: string | null }; references?: { sessionId: string; similarity: number }[] };
export type Run = { id: string; bundleId: string; status: string; createdAt: string; completed: number; total: number; caseHash: string; protocol: string; judgeHash: string; parentRunId: string | null; models: Version[]; metrics: Record<string, Metric>; results?: Result[]; caseIds?: string[]; judgeId: string | null; error?: string; comparisonMode?: ComparisonMode };
export type LabState = { bundles: Bundle[]; versions: Version[]; connections: Connection[]; training: { id: string; status: string; stage: string; traceId?: string; error?: string }[]; runs: Run[]; actions: Record<string, string>; intents: Record<string, string>; protocol: string };
export type Case = { id: string; sessionId: string; title: string; question?: string; intent: string; action: string; contextLimited: boolean; prefix?: ConversationMessage[]; reference?: ConversationMessage; sourceSnapshot?: { messages: ConversationMessage[] } };
type Comparison = { groups: number; mode: string; versions: Version[]; n: number; selected: number; excluded: number; delta: number; interval: number[]; wins: number; losses: number; ties: number; metrics: Metric[]; pairs: { caseId: string; sessionId: string; delta: number; left: Result; right: Result }[]; caseHash: string; method: string };
type Chat = { id: string; messages: ConversationMessage[]; steps: { traceId: string; intent: string; action: string; sandbox: { result: string }; references: { sessionId: string; similarity: number }[] }[] };
type View = 'dashboard' | 'runs' | 'compare' | 'simulate' | 'models';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成');
  return value;
}
const score = (value: number | null | undefined, suffix = '%') => value == null ? '未测' : `${value.toFixed(1)}${suffix}`;
const runNames: Record<string, string> = { running: '运行中', completed: '执行结束', failed: '失败', cancelled: '已取消', cancelling: '取消中', interrupted: '已中断' };
function TraceButton({ id }: { id?: string }) { return id ? <button className="text-link" onClick={() => window.dispatchEvent(new CustomEvent('evalpilot:trace', { detail: id }))}>查看执行步骤 <ArrowRight size={12} /></button> : null; }

export function AgentLab({ view, corpora }: { view: View; corpora: Corpus[] }) {
  const [state, setState] = useState<LabState | null>(null);
  const [bundleId, setBundleId] = useState('');
  const [routeParams, setRouteParams] = useState(() => new URLSearchParams(location.hash.split('?')[1] || ''));
  const [runId, setRunId] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('run') || rememberedRun());
  const [historicalRun, setHistoricalRun] = useState<Run | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [showLocalModels, setShowLocalModels] = useState(false);
  const [reconnect, setReconnect] = useState<Connection | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [parent, setParent] = useState<Run | null>(null);
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [evidence, setEvidence] = useState<Result | null>(null);
  const [focusJudge, setFocusJudge] = useState(false);
  const refresh = useCallback(async () => { try { setState(await request<LabState>('state')); } catch (problem) { setError(problem instanceof Error ? problem.message : '读取失败'); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3500); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { const update = () => { const params = new URLSearchParams(location.hash.split('?')[1] || ''); setRouteParams(params); if (params.get('run')) setRunId(params.get('run')!); }; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const availableRuns = [...(state?.runs || []), ...(historicalRun && !state?.runs.some(item => item.id === historicalRun.id) ? [historicalRun] : [])];
  const requestedRun = availableRuns.find(item => item.id === runId);
  const requestedProject = routeParams.get('project');
  const bundle = state?.bundles.find(item => item.id === (bundleId || requestedRun?.bundleId) && (!requestedProject || item.datasetId === requestedProject)) || state?.bundles.find(item => !requestedProject || item.datasetId === requestedProject);
  const runs = availableRuns.filter(value => value.bundleId === bundle?.id);
  const awaitingRequestedRun = !!runId && !requestedRun;
  const run = awaitingRequestedRun ? undefined : chooseDefaultRun(runs, runId || rememberedRun(bundle?.id));
  useEffect(() => {
    if (!state || !runId || state.runs.some(item => item.id === runId) || historicalRun?.id === runId) return;
    let active = true;
    request<Run>(`runs/${encodeURIComponent(runId)}`).then(value => { if (active) setHistoricalRun(value); }).catch(() => { if (active) { setError('指定的评测批次不存在，已回到可用记录。'); setRunId(''); } });
    return () => { active = false; };
  }, [!!state, runId, historicalRun?.id]);
  useEffect(() => { if (run && (!runId || requestedRun)) rememberRun(run); }, [run?.id, runId, !!requestedRun]);
  const chooseRun = (identifier: string) => {
    setRunId(identifier);
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    params.set('run', identifier);
    location.hash = `${location.hash.slice(1).split('?')[0]}?${params}`;
  };
  useEffect(() => {
    if (!run) { setDetail(null); return; }
    let active = true;
    request<Run>(`runs/${run.id}`).then(value => { if (active) setDetail(value); }).catch(problem => { if (active) { setDetail(null); setError(problem.message); } });
    return () => { active = false; };
  }, [run?.id, run?.completed, run?.status]);
  const act = async (operation: () => Promise<unknown>) => { setPending(true); setError(''); try { await operation(); await refresh(); } catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败'); } finally { setPending(false); } };
  if (!state) return <div className="lab-loading">{error ? <><span role="alert">{error}</span><Button onClick={() => { setError(''); void refresh(); }}>重新读取</Button></> : <><CircleNotch size={22} className="spin" />读取评测工作区…</>}</div>;
  const active = state.training.find(task => task.status === 'running');
  const current = detail?.id === run?.id ? detail : null;
  const openRun = (previous: Run | null = null, judge = false) => { setParent(previous); setFocusJudge(judge); setRunOpen(true); };
  const titles: Record<View, string> = { dashboard: '结果大盘', runs: '运行评测', compare: '模型对比', simulate: '客服试聊', models: '模型连接' };
  const descriptions: Record<View, string> = { dashboard: '先看实际答复与裁判依据；标签一致不代表业务处理正确。', runs: '选模型和案例，查看真实答复；加入裁判后再评审回复质量。', compare: '同一个客服案例，并排看两个模型的回复与处理结果。', simulate: '输入匿名问题，体验本地行为模型。试聊不会计入评测分数。', models: '接入你的真实模型，测试后用于同例对比。密钥仅保存在本地服务内存。' };
  return <div className="agent-lab">
    <div className="page-head"><div><h1>{titles[view]}</h1><p>{descriptions[view]}</p></div><div className="page-actions">{view === 'models' ? <Button primary onClick={() => { setReconnect(null); setModelOpen(true); }}><Plus size={16} />添加模型连接</Button> : view === 'runs' ? <Button primary onClick={() => bundle ? openRun() : setTrainingOpen(true)} disabled={!!active}>{bundle ? <Play size={15} /> : <GitBranch size={15} />}{bundle ? '新建评测' : '训练本地基线'}</Button> : null}</div></div>

    {error && <div className="notice error" role="alert"><WarningCircle size={17} /><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
    {active && <div className="notice" role="status"><CircleNotch size={17} className="spin" /><span>{active.stage}</span><TraceButton id={active.traceId} /></div>}
    {state.training[0]?.status === 'failed' && <div className="notice error">训练失败：{state.training[0].error}<TraceButton id={state.training[0].traceId} /></div>}
    {bundle && view !== 'simulate' && view !== 'models' && <div className="lab-context"><span><ShieldCheck size={15} />{corpora.find(item => item.id === bundle.datasetId)?.name || '当前项目'}</span><span>{number(bundle.splits.test)} 个独立测试案例</span>{state.bundles.length > 1 && <select aria-label="选择数据快照" className="select" value={bundle.id} onChange={event => { setBundleId(event.target.value); setRunId(''); }}>{state.bundles.map(value => <option key={value.id} value={value.id}>{corpora.find(item => item.id === value.datasetId)?.name || value.datasetId} · {value.id.slice(-6)}</option>)}</select>}</div>}
    {awaitingRequestedRun && <p className="lab-no-data" role="status">正在读取指定评测批次…</p>}
    {!bundle && view !== 'models' ? <Empty title="先从真实售后数据训练一个可核验基线" description="本机拟合两个意图 / 行为分类版本，按匿名客户和重复问题分组隔离测试集。不是从零训练大语言模型。" action={<Button primary disabled={pending || !!active || !corpora.length} onClick={() => setTrainingOpen(true)}>开始训练本地基线</Button>} /> : <>
      {view === 'dashboard' && bundle && <LabDashboard state={state} bundle={bundle} run={run} runs={runs} choose={chooseRun} start={() => openRun()} inspect={setEvidence} detail={current} />}
      {view === 'runs' && bundle && <LabRuns state={state} runs={runs} current={current} choose={chooseRun} run={run} inspect={setEvidence} rerun={() => current && openRun(current)} reviewAgain={() => current && openRun(current, true)} cancel={() => run && void act(() => request('cancel', { runId: run.id }))} pending={pending} />}
      {view === 'compare' && bundle && !awaitingRequestedRun && <LabComparison key={`${bundle.id}:${run?.id}`} state={state} bundle={bundle} runs={runs} preferredRun={run?.id} inspect={setEvidence} refresh={refresh} submitted={async value => { rememberRun(value); setRunId(value.id); location.hash = `compare?project=${encodeURIComponent(bundle.datasetId)}&run=${value.id}&mode=text&panel=results`; await refresh(); }} />}
      {view === 'simulate' && bundle && <LabSimulation key={bundle.id} versions={state.versions.filter(version => version.kind === 'local' && version.bundleId === bundle.id)} state={state} />}
      {view === 'models' && <><div className="lab-section-head"><h2>在线模型连接</h2></div><label className="lab-check"><input type="checkbox" checked={showLocalModels} onChange={event => setShowLocalModels(event.target.checked)} />显示本地分类器基线（非在线大模型）</label><div className="lab-version-grid">{state.versions.filter(version => showLocalModels || version.kind === 'external').map(version => { const connection = state.connections.find(value => value.id === version.connectionId); return <Panel className="lab-version" key={version.id}><div><Badge tone={version.kind === 'local' ? 'blue' : connection?.tested ? 'green' : 'amber'}>{version.kind === 'local' ? '本地分类器 + 模板' : connection?.tested ? '已通过连接测试' : '待输入密钥 / 测试'}</Badge><GitBranch size={20} /></div><h3>{version.name}</h3><p>{version.model}</p><code>{version.id}</code><dl><div><dt>版本族</dt><dd>{version.family}</dd></div><div><dt>建立时间</dt><dd><DateText value={version.createdAt} /></dd></div>{version.trainCount && <div><dt>训练案例</dt><dd>{number(version.trainCount)}</dd></div>}</dl>{version.validation && <p>验证集意图 {score(version.validation.intent)} · 行为 {score(version.validation.action)}<br />仅验证分数，不冒充测试成绩。</p>}{connection && <div className="lab-row-actions"><Button onClick={() => { setReconnect(connection); setModelOpen(true); }}>{connection.configured ? '管理连接' : '重新连接'}</Button>{connection.configured && <Button onClick={() => void act(() => request('connections/clear', { id: connection.id }))}>清除密钥</Button>}</div>}</Panel>; })}</div>{!state.versions.some(version => showLocalModels || version.kind === 'external') && <Empty title="还没有接入在线模型" description="点击右上方添加模型连接。在弹窗输入 Key、选择模型并测试；这里不会用本地模板冒充真实大模型。" />}<details className="lab-disclosure"><summary>本地训练（首次体验不需要）</summary><p>本地分类器用于离线基线，不代替在线模型。重复训练同一数据不会制造版本升级。</p><Button onClick={() => setTrainingOpen(true)} disabled={!!active}>训练本地基线</Button></details></>}
    </>}
    <div className="lab-boundary"><InfoLine />行为标签由人工回复规则推导，尚未经人工逐条复核；历史回放不是闭环用户模拟。真实解决率、客户满意度和生产工具成功率暂不可测。</div>
    <Modal open={trainingOpen} onClose={() => setTrainingOpen(false)} title="训练售后行为基线" description="在本机拟合分类器，不调用外部 API，不进行大模型微调。"><p className="lab-modal-copy">跳过无效 / 标注冲突 / 没有有效人工回合的会话。按匿名客户与重复问题隔离训练、验证、测试；只用历史前缀预测下一轮行为。两个版本采用不同分类器，结果好坏都如实展示。</p><label className="form-field">真实数据项目<select id="lab-training-corpus" defaultValue={corpora[0]?.id}>{corpora.map(corpus => <option value={corpus.id} key={corpus.id}>{corpus.name}</option>)}</select></label><div className="notice">训练后的答复使用安全模板；相似案例只作为处理方向参考，不是正式维修政策。</div><div className="modal-actions"><Button onClick={() => setTrainingOpen(false)}>取消</Button><Button primary disabled={pending || !!active || !corpora.length} onClick={() => void act(async () => { const datasetId = (document.getElementById('lab-training-corpus') as HTMLSelectElement).value; await request('train', { datasetId, confirmed: true }); setTrainingOpen(false); })}>确认本机训练</Button></div></Modal>
    <ConnectionModal open={modelOpen} connection={reconnect} close={() => { setModelOpen(false); setReconnect(null); }} changed={refresh} />
    {bundle && <RunModal focusJudge={focusJudge} open={runOpen} bundle={bundle} state={state} parent={parent} close={() => setRunOpen(false)} submitted={async value => { rememberRun(value); setRunId(value.id); setRunOpen(false); location.hash = `benchmark?run=${value.id}`; await refresh(); }} />}
    <Modal open={!!evidence} onClose={() => setEvidence(null)} title="对话与答复质量" description="先看实际答复和裁判证据；标签诊断仅用于解释与参考的差异。" wide>{evidence && <ResultEvidence key={evidence.caseId + evidence.versionId} row={evidence} state={state} runId={run?.id} close={() => setEvidence(null)} />}</Modal>
  </div>;
}

function InfoLine() { return <ShieldCheck size={17} />; }

function RunSelect({ run, runs, choose }: { run?: Run; runs: Run[]; choose: (value: string) => void }) { return <label className="lab-run-select">评测批次<select className="select" aria-label="选择评测批次" value={run?.id || ''} onChange={event => choose(event.target.value)}>{!runs.length && <option value="">尚无评测</option>}{runs.map(item => <option value={item.id} key={item.id}>{runLabel(item)} · {runNames[item.status]}</option>)}</select></label>; }

function LabDashboard({ state, bundle, run, runs, choose, start, inspect, detail }: { state: LabState; bundle: Bundle; run?: Run; runs: Run[]; choose: (id: string) => void; start: () => void; inspect: (row: Result) => void; detail: Run | null }) {
  const [selectedVersion, setSelectedVersion] = useState('');
  const version = run?.models.find(item => item.id === selectedVersion) || run?.models[0];
  const metric = version && run?.metrics[version.id];
  return <><div className="lab-selection"><RunSelect run={run} runs={runs} choose={choose} />{run && <select className="select" aria-label="大盘模型版本" value={version?.id || ''} onChange={event => setSelectedVersion(event.target.value)}>{run.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<Badge tone={run?.status === 'completed' ? 'green' : 'amber'}>{run ? runNames[run.status] : '未评测'}</Badge></div>
    <div className="lab-kpis">{[...reviewDimensions.map(dimension => ({ name: dimension.label, value: score(metric?.judge[dimension.key]?.mean, ' / 4'), note: '模型裁判均分 · 有效分母 ' + (metric?.judge[dimension.key]?.n || 0) })), { name: '执行耗时 P95', value: score(metric?.p95Ms, ' ms'), note: '候选执行耗时，不含裁判；不是生产 SLA' }].map(item => <Panel key={item.name} className="lab-kpi"><span>{item.name}</span><strong>{item.value}</strong><p>{item.note}</p></Panel>)}</div>
    <Panel className="lab-section"><div className="lab-section-head"><div><h2>同批模型评审</h2><p>均分来自已记录的裁判评分；各维度分母分别显示，缺证据不记作零分。不是模型排行榜或真实拦截率。</p></div><a className="text-link" href={runUrl('compare', run?.id)}>逐例对照<ArrowRight size={14} /></a></div>{run ? <div className="table-wrap"><table className="lab-table"><thead><tr><th>模型</th><th>执行记录</th>{reviewDimensions.map(dimension => <th key={dimension.key}>{dimension.label}</th>)}</tr></thead><tbody>{run.models.map(item => { const value = run.metrics[item.id]; return <tr key={item.id}><td>{item.name}</td><td>{value.completed} 完成 / {value.total} 计划 · {value.failed} 失败</td>{reviewDimensions.map(dimension => <td key={dimension.key}>{score(value.judge[dimension.key]?.mean, ' / 4')} · n={value.judge[dimension.key]?.n || 0}</td>)}</tr>; })}</tbody></table></div> : <Empty title="还没有测试结果" action={<Button primary onClick={start}>运行同批评测</Button>} />}{run && !run.judgeId && <p>本批未运行模型裁判，质量暂未评审。前往运行评测，可选择裁判并重跑；旧记录不变。</p>}</Panel>
    <div className="lab-dashboard-grid"><Panel className="lab-section"><details><summary>数据与训练详情（可选）</summary><h2>数据与训练证据</h2><dl className="lab-facts"><div><dt>原始项目会话</dt><dd>{number(bundle.sourceSessions)}</dd></div><div><dt>进入行为学习</dt><dd>{number(bundle.eligible)}</dd></div><div><dt>排除或无有效人工回合</dt><dd>{number(bundle.sourceSessions - bundle.eligible)}</dd></div><div><dt>匿名用户 / 重复问题连通分组</dt><dd>{number(bundle.groupCount)}</dd></div><div><dt>当前批次资料受限</dt><dd>{metric?.contextLimited || 0} 个（含脱敏占位或媒体引用）</dd></div></dl><TraceButton id={bundle.traceId} /></details></Panel><Panel className="lab-section"><h2>待复核或待评审案例</h2><p>按执行状态和裁判记录筛选，不将标签不同直接视为错误。</p><div className="lab-issue-list">{detail?.results?.filter(row => row.versionId === version?.id && (['attention', 'execution_error', 'review_error', 'insufficient', 'unreviewed'].includes(replyQuality(row).status))).slice(0, 6).map(row => <button key={row.caseId + row.versionId} onClick={() => inspect(row)}><span>{row.sessionId}<small>{replyQuality(row).label}</small></span><Badge tone="amber">复盘</Badge></button>)}{run && !detail ? <p className="lab-no-data" role="status">正在读取本批逐例证据，尚不能判断问题案例。</p> : !detail?.results?.some(row => row.versionId === version?.id && (['attention', 'execution_error', 'review_error', 'insufficient', 'unreviewed'].includes(replyQuality(row).status))) && <p className="lab-no-data">当前选定批次暂无已记录的问题案例；不是全业务无错误的保证。</p>}</div></Panel></div>
    <details className="lab-disclosure"><summary>标签诊断与分场景统计（辅助）</summary><Panel className="lab-section"><div className="lab-section-head"><div><h2>与历史标签的一致性</h2><p>防止大量常见问题掩盖小类问题。当前批次意图 Macro F1 {score(metric?.intentMacroF1)}，行为 Macro F1 {score(metric?.actionMacroF1)}。</p></div></div>{metric?.perIntent?.length ? <div className="table-wrap"><table className="lab-table"><thead><tr><th>人工意图分类</th><th>完成案例</th><th>意图匹配率</th><th>行为弱标签匹配率</th></tr></thead><tbody>{metric.perIntent.map(item => <tr key={item.intent}><td>{state.intents[item.intent]}</td><td>{item.n}</td><td>{score(item.intentAccuracy)}</td><td>{score(item.actionAccuracy)}</td></tr>)}</tbody></table></div> : <p>尚无分场景结果。</p>}<p className="lab-no-data">测试批次未覆盖的类别不显示；Macro F1 按本批参考或预测出现的类别等权计算。原标签是整段会话意图，早期上下文可能不足以判断。</p></Panel></details>
  </>;
}

function LabRuns({ state, runs, run, current, choose, inspect, rerun, reviewAgain, cancel, pending }: { state: LabState; runs: Run[]; run?: Run; current: Run | null; choose: (value: string) => void; inspect: (row: Result) => void; rerun: () => void; reviewAgain: () => void; cancel: () => void; pending: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportEvidence = async () => {
    if (!run) return;
    setExporting(true); setExportError('');
    try {
      const value = await request(`runs/${run.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${run.id}_redacted.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) { setExportError(problem instanceof Error ? problem.message : '导出被隐私门禁拦截'); }
    finally { setExporting(false); }
  };
  return <><div className="lab-selection"><RunSelect run={run} runs={runs} choose={choose} />{run && <><Badge>{runNames[run.status]} · {caseCount(run)} 个案例 / {run.completed} 条执行记录</Badge>{run.status === 'running' || run.status === 'cancelling' ? <Button disabled={pending || run.status === 'cancelling'} onClick={cancel}>取消后续执行</Button> : <Button disabled={!current} onClick={rerun}><ArrowClockwise size={15} />重跑本批案例</Button>}<a className="text-link" href={runUrl('overview', run.id)}>查看本批大盘<ArrowRight size={14} /></a><a className="text-link" href={runUrl('compare', run.id)}>对比本批版本<ArrowRight size={14} /></a></>}</div>{run && <details className="lab-disclosure"><summary>记录详情与导出（可选）</summary><div className="lab-selection"><Button disabled={exporting || run.status !== 'completed'} onClick={() => void exportEvidence()}>{exporting ? '复扫并准备导出…' : '导出冻结证据 JSON'}</Button><small>含完整消息与结果，仅供获授权的本机复核；外发前仍需人工检查。未通过扫描时不能导出。</small></div></details>}{exportError && <div className="notice error" role="alert">{exportError}</div>}{run && <details className="lab-disclosure"><summary>本批来源与取消规则</summary><span>案例指纹 {run.caseHash.slice(0, 16)} · {run.parentRunId ? `重跑来源 ${run.parentRunId}` : '首次批次'}。取消时允许在途调用结束，不再发起后续请求；已经完成的结果保留。</span></details>}<ReplyResults key={run?.id || "empty"} state={state} run={current} loading={!!run && !current} inspect={inspect} reviewAgain={reviewAgain} /></>;
}

function LabComparison({ state, bundle, runs, preferredRun, inspect, refresh, submitted }: { state: LabState; bundle: Bundle; runs: Run[]; preferredRun?: string; inspect: (row: Result) => void; refresh: () => Promise<void>; submitted: (run: Run) => Promise<void> }) {
  const currentRun = runs.find(run => run.id === preferredRun);
  const [view, setView] = useState(() => comparisonViewFromHash(location.hash));
  const { panel } = view;
  const [preset, setPreset] = useState<ComparisonPreset | null>(null);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const setPanel = (panel: ComparisonPanel) => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    params.delete('comparison');
    params.set('panel', panel);
    params.set('mode', 'text');
    location.hash = 'compare?' + params;
  };
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const update = () => { setView(comparisonViewFromHash(location.hash)); setLeft(''); setRight(''); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [currentRun]);
  const waitingForCurrent = !!preferredRun && !runs.some(run => run.id === preferredRun && run.status === 'completed');
  const options = [...runs].sort((leftRun, rightRun) => Number(rightRun.id === preferredRun) - Number(leftRun.id === preferredRun)).flatMap(run => run.models.map(version => ({ key: `${run.id}|${version.id}`, run, version })));
  const first = options.find(item => item.key === left) || options[0];
  const rightOptions = options.filter(item => item.key !== first?.key && !!first && (['bundleId', 'caseHash', 'protocol', 'judgeHash'] as const).every(field => first.run[field] === item.run[field]));
  const second = rightOptions.find(item => item.key === right) || rightOptions[0];
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setComparison(null); setError(''); setPage(1); setPending(false);
    if (panel !== 'results' || !statisticsOpen || !first || !second) return;
    let active = true;
    setPending(true);
    request<Comparison>('compare', { sides: [first, second].map(item => ({ runId: item.run.id, versionId: item.version.id })) })
      .then(value => { if (active) setComparison(value); })
      .catch(problem => { if (active) setError(problem instanceof Error ? problem.message : '对比失败'); })
      .finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [panel, statisticsOpen, first?.key, second?.key, first?.run.status, second?.run.status, retry]);
  return <><div hidden={panel !== 'setup'}><TextComparisonSetup key={preset ? preset.sourceRunId + preset.caseId : 'new'} preset={preset || undefined} state={state} bundle={bundle} runs={runs} refresh={refresh} submitted={submitted} showHistory={() => setPanel('results')} /></div>{panel === 'results' && <>
    <Panel className="lab-section text-comparison-results">
      <div className="text-comparison-results-head"><h2>同一案例对照</h2><Button onClick={() => { setPreset(null); setPanel('setup'); }}><Plus size={15} />新建对比</Button></div>
      {currentRun && currentRun.status !== 'completed' && <div className="text-comparison-progress" role="status"><strong>{runNames[currentRun.status]} · {currentRun.completed}/{currentRun.total}条输出</strong><progress value={currentRun.completed} max={currentRun.total || 1} aria-label="同批对比执行进度" /><a className="text-link" href={runUrl('benchmark', currentRun.id)}>查看逐例执行与Trace</a>{currentRun.error && <p>{currentRun.error}</p>}</div>}
      <details className="case-records"><summary>切换模型 / 运行记录</summary><div className="lab-compare-select"><label className="form-field">模型 A 的结果<select aria-label="对比基线" value={first?.key || ''} onChange={event => setLeft(event.target.value)}><option value="" disabled>选择运行记录</option>{options.map(item => <option value={item.key} key={item.key}>{item.version.name} · {runLabel(item.run)}</option>)}</select></label><ArrowsLeftRight size={20} /><label className="form-field">模型 B 的结果<select aria-label="对比候选" value={second?.key || ''} onChange={event => setRight(event.target.value)}><option value="" disabled>尚无可比结果</option>{rightOptions.map(item => <option value={item.key} key={item.key}>{item.version.name} · {runLabel(item.run)}</option>)}</select></label></div>
      <p>两边使用相同案例与评测条件。切换记录只读取已有回复，不重新调用模型。</p></details>
      {!rightOptions.length && <div className="notice amber">{waitingForCurrent ? '当前批次尚未完成。完成后自动显示结果；执行异常可通过 Trace 查看。' : '还没有同条件的两份结果。点击「新建对比」，选择两个模型一起运行。'}</div>}
    </Panel>
    {first && second && <CaseComparison key={first.key + ':' + second.key} left={first} right={second} state={state} inspect={inspect} rerun={value => { setPreset(value); setPanel('setup'); }} />}
    <details className="case-statistics" open={statisticsOpen} onToggle={event => setStatisticsOpen(event.currentTarget.open)}><summary>标签差异统计（诊断，不是质量排名）</summary>
      {pending && <p role="status">正在计算批次差异…</p>}
      {error && <div className="notice" role="status">{error}<Button onClick={() => setRetry(value => value + 1)}>重试读取</Button></div>}
    {comparison && <><div className="notice" role="status">{comparison.interval[0] <= 0 && comparison.interval[1] >= 0 ? '本批差异尚不确定，不能据此认定候选版本更好或更差。请结合逐例对照与人工复核。' : '本批存在匹配率差异，但不能直接推导真实业务解决效果。请核对逐例证据。'}</div><div className="lab-kpis">{[{ name: '共同完成案例', value: `${comparison.n} / ${comparison.selected}`, note: `${comparison.excluded} 个非共同完成案例排除，单独展示失败率` }, { name: '标签同时一致率变化', value: `${comparison.delta > 0 ? '+' : ''}${comparison.delta.toFixed(1)} 个百分点`, note: `95% 差异区间 [${comparison.interval.join(', ')}] 个百分点` }, { name: '标签一致增加 / 减少', value: `${comparison.wins} / ${comparison.losses}`, note: `${comparison.ties} 个持平 · 不是裁判偏好胜率` }, { name: '比较边界', value: '同例配对', note: '只比较标签一致性，不判断业务优劣' }].map(item => <Panel className="lab-kpi" key={item.name}><span>{item.name}</span><strong>{item.value}</strong><p>{item.note}</p></Panel>)}</div><Panel className="lab-section"><h2>指标差异</h2><div className="table-wrap"><table className="lab-table"><thead><tr><th>指标</th>{comparison.versions.map(version => <th key={version.id}>{version.name}</th>)}</tr></thead><tbody>{([['intentAccuracy', '意图匹配率'], ['actionAccuracy', '行为弱标签匹配率'], ['jointAccuracy', '同时匹配率'], ['intentMacroF1', '意图 Macro F1'], ['actionMacroF1', '行为 Macro F1（弱标签）'], ['p95Ms', '执行耗时 P95']] as const).map(([field, title]) => <tr key={field}><td>{title}</td>{comparison.metrics.map((metric, index) => <td key={index}>{score(metric[field], field === 'p95Ms' ? ' ms' : '%')}</td>)}</tr>)}{[['relevance', '裁判：相关性'], ['next_step', '裁判：下一步'], ['boundary', '裁判：边界']].map(([field, title]) => <tr key={field}><td>{title}</td>{comparison.metrics.map((metric, index) => <td key={index}>{score(metric.judge[field].mean, '/4')} · n={metric.judge[field].n}</td>)}</tr>)}</tbody></table></div><p className="lab-no-data">裁判维度各自分母可能不同，仅描述展示，不用于配对胜负。判定版本优劣还需更大样本与人工复核。</p></Panel><Panel className="lab-section"><h2>逐例对照</h2><div className="table-wrap"><table className="lab-table"><thead><tr><th>案例</th><th>基线</th><th>候选</th><th>变化</th><th>对照证据</th></tr></thead><tbody>{comparison.pairs.slice((page - 1) * 15, page * 15).map(pair => <tr key={pair.caseId}><td><code>{pair.sessionId}</code></td><td>{state.actions[pair.left.output?.action || '']}</td><td>{state.actions[pair.right.output?.action || '']}</td><td><Badge tone="gray">{pair.delta > 0 ? '标签一致增加' : pair.delta < 0 ? '标签一致减少' : '标签一致持平'}</Badge></td><td><div className="lab-row-actions"><Button onClick={() => inspect(pair.left)}>基线</Button><Button onClick={() => inspect(pair.right)}>候选</Button></div></td></tr>)}</tbody></table></div><div className="pagination"><span>第 {page} / {Math.ceil(comparison.pairs.length / 15)} 页</span><div><Button disabled={page === 1} onClick={() => setPage(value => value - 1)}>上一页</Button><Button disabled={page * 15 >= comparison.pairs.length} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div></Panel></>}</details></>}</>;
}

function LabSimulation({ versions, state }: { versions: Version[]; state: LabState }) {
  const [versionId, setVersionId] = useState(versions[0]?.id || '');
  const [chat, setChat] = useState<Chat | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const latest = chat?.steps.at(-1);
  return <><div className="lab-selection"><select className="select" aria-label="试用训练版本" disabled={pending} value={versionId} onChange={event => { setVersionId(event.target.value); setChat(null); }}>{versions.map(version => <option key={version.id} value={version.id}>{version.name}</option>)}</select><Button onClick={() => setChat(null)} disabled={pending}>新建试用会话</Button><Badge tone="blue">本地行为模型 · 安全模板答复</Badge></div><div className="lab-simulation-grid"><Panel className="lab-section">{chat ? <ConversationPlayback messages={chat.messages} compact selectionMode={false} selected={[]} focusedId={null} query="" onSelect={() => {}} /> : <Empty title="让训练后的 Agent 判断下一步" description="例如：设备开机后黑屏，已经检查电源。可连续追问，完整保存本机试用上下文与操作 Trace。" />}<form className="lab-composer" onSubmit={async event => { event.preventDefault(); setPending(true); setError(''); try { setChat(await request<Chat>('chat', { versionId, message, sessionId: chat?.id })); setMessage(''); } catch (problem) { setError(problem instanceof Error ? problem.message : '试用失败'); } finally { setPending(false); } }}><textarea aria-label="售后试用消息" value={message} onChange={event => setMessage(event.target.value)} placeholder="输入匿名售后问题，不提交私人资料…" maxLength={2000} /><Button primary type="submit" disabled={pending || !message.trim() || !versionId}>{pending ? '执行中…' : '发送并执行'}</Button></form>{error && <div className="notice error">{error}</div>}</Panel><Panel className="lab-section"><h2>本轮实际执行</h2>{latest ? <><dl className="lab-facts"><div><dt>预测意图</dt><dd>{state.intents[latest.intent]}</dd></div><div><dt>预测行为</dt><dd>{state.actions[latest.action]}</dd></div><div><dt>沙箱结果</dt><dd>{latest.sandbox.result}</dd></div></dl><TraceButton id={latest.traceId} /><h3>训练侧相似案例</h3>{latest.references.map(reference => <a className="lab-source-link" href={`#knowledge?session=${reference.sessionId}`} key={reference.sessionId}>{reference.sessionId}<span>相似度 {reference.similarity.toFixed(3)}</span></a>)}<small>相似度不是正确概率；参考仅用于处理方向，不执行历史危险操作。</small></> : <p>发送后展示意图分类、行为分类、训练案例检索与沙箱动作。</p>}<div className="notice amber">没有真实订单、派单或人工坐席连接。此试用不会计入冻结测试集大盘。</div></Panel></div></>;
}
