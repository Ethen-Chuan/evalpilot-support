import { useCallback, useEffect, useState } from 'react';
import { ArrowClockwise, ArrowRight, ChartLineUp, Info, Plus, ShieldCheck } from '@phosphor-icons/react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Button, DateText, Empty, Modal, Panel, PanelHead, SearchInput } from './ui';
import { ConnectionModal } from './AgentLab';
import type { Connection } from './AgentLab';
import { visionSources } from './visionSources';
import { ConversationLearning } from './ConversationLearning';
import type { LearningState } from './ConversationLearning';
import { IntentExplorer } from './IntentExplorer';
import { ModelPerformance, QualityOverview } from './ExperienceCharts';
import type { ModelAnalysis, QualityAnalytics } from './ExperienceCharts';
import { RootCauses } from './RcaWorkbench';
import type { Cause, Rca, RcaAnalytics } from './RcaWorkbench';
import './experience.css';

type Ratio = { value: number | null; numerator: number; denominator: number };
type Verdict = 'violated' | 'clear' | 'unknown';
type Dimension = { id: string; name: string; points: number; items: string[] };
type Review = { score: number; passed: boolean; verdicts: Record<string, Verdict>; reviewer: string; reason: string; at: string; traceId: string };
type QualityCase = { id: string; sourceRow: number; channel: string; originalResult: string; originalStatus: string; appeal: string; opinion: string; machineExcerpt: string; originalScore: number | null; suggestedScore: number | null; basis: string; warning: string; revision: number; review: Review | null; history: Review[]; completeness: string };
type QualityRun = { id: string; model: string; status: string; total: number; completed: number; createdAt: string; results: { caseId: string; traceId: string; score?: number | null; reason?: string; error?: string; status: string }[] };
export type ExperienceState = {
  projectId: string; projects: { id: string; name: string }[];
  rules: { version: string; base: number; threshold: number; dimensions: Dimension[]; scope: string; source: string; text: string };
  reviews: QualityCase[]; qualityCounts: { total: number; original: number; suggested: number; pending: number; confirmed: number }; qualityRuns: QualityRun[];
  qualityAnalytics: QualityAnalytics; modelAnalysis: ModelAnalysis | null;
  rca: Rca[]; rcaAnalytics: RcaAnalytics; causes: Cause[];
  metrics: { sessions: number; sandbox: number; mature: number; eligible: number; missingOutcome: number; containment: Ratio; unsafeInterception: Ratio; formAccuracy: Ratio; formExact: Ratio; qualityAccuracy: Ratio; intentAccuracy: Ratio; toolSuccess: Ratio; satisfaction: Ratio; dsat: Ratio; stages: { name: string; count: number }[] };
  daily: { day: string; containment: number | null; form: number | null; quality: number | null; sessions: number }[];
  trend: { runId: string; at: string; model: string; modelId: string; provider: string; intent: number | null; correct: number; count: number; total: number }[];
  runId: string | null; runOptions: { id: string; at: string; count: number }[]; requestedRunMissing: boolean;
  vision: { id: string; suite: string; status: string; models: { id: string; name: string; metrics: { effectiveContainment: Ratio; unsafeInterception: Ratio; visualAccuracy: Ratio; reviewCoverage: Ratio; completed: number; selected: number; failed: number; mandatoryUnfinished: number } }[] } | null;
  visionOptions: { id: string; suite: string; status: string }[]; requestedVisionMissing: boolean;
  tree: { id: string; name: string; actions: string; leaves: { id: string; name: string; count: number }[] }[]; treeVersion: string;
  learning: LearningState;
};
type Tab = 'business' | 'quality' | 'rca' | 'intents';
const tabs: [Tab, string][] = [['business', '业务指标'], ['quality', '质检复核'], ['rca', 'DSAT归因'], ['intents', '意图树']];
const states: Record<string, string> = { triage: '待归因', confirmed: '归因已确认', fixing: '修复中', verified: '人工回归已验收', running: '运行中', completed: '已结束', cancelled: '已取消', interrupted: '已中断' };
const display = (value: number | null | undefined) => value == null ? '待接入' : `${value.toFixed(1)}%`;
const trace = (id: string) => { location.hash = `traces?trace=${encodeURIComponent(id)}&return=${encodeURIComponent(location.hash.slice(1))}`; };
function readLocation() { const params = new URLSearchParams(location.hash.split('?')[1] || ''); const tab = params.get('tab'); return { project: params.get('project') || '', run: params.get('run') || '', mmrun: params.get('mmrun') || '', replay: params.get('replay') || '', qc: params.get('qc') || 'all', tab: tabs.some(([key]) => key === tab) ? tab as Tab : 'business' as Tab }; }
function navigate(changes: Record<string, string>) { const params = new URLSearchParams(location.hash.split('?')[1] || ''); for (const [key, value] of Object.entries(changes)) { if (value) params.set(key, value); else params.delete(key); } location.hash = `overview?${params}`; }
async function request<Value>(path: string, body?: unknown): Promise<Value> { const response = await fetch(`/api/support/experience/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '操作未完成'); return payload; }

export function ExperienceDashboard() {
  const [route, setRoute] = useState(readLocation);
  const [state, setState] = useState<ExperienceState | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => { const update = () => setRoute(readLocation()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => {
    let active = true;
    let selectedReplay = route.replay;
    let loading = false;
    const load = async () => { if (loading) return; loading = true; try { const next = await request<ExperienceState>(`state?${new URLSearchParams({ project: route.project, run: route.run, mmrun: route.mmrun, replay: selectedReplay })}`); if (active) { selectedReplay = selectedReplay || next.learning.run?.id || ''; setState(next); setError(''); } } catch (problem) { if (active) setError(problem instanceof Error ? problem.message : '读取失败'); } finally { loading = false; } };
    setState(null); void load(); const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [route.project, route.run, route.mmrun, route.replay, revision]);
  const refresh = () => setRevision(value => value + 1);
  if (!state) return <div className="cx-loading">{error ? <><p role="alert">{error}</p><Button onClick={refresh}>重试</Button></> : '正在读取真实记录与评测结果…'}</div>;
  return <div className="cx-dashboard">
    <div className="page-head"><div><span className="eyebrow">CUSTOMER EXPERIENCE</span><h1>结果大盘</h1><p>先看业务效果，再沿着证据找到问题。</p></div><div className="page-actions"><Button onClick={refresh}><ArrowClockwise size={16} />刷新</Button><Button primary onClick={() => setImportOpen(true)}><Plus size={16} />接入业务结果</Button></div></div>
    <div className="cx-context"><label>当前项目<select aria-label="大盘项目" value={state.projectId} onChange={event => navigate({ project: event.target.value, run: '', replay: '', mmrun: '' })}>{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span><ShieldCheck size={15} />真实来源、辅助建议与线上结果分开统计</span></div>
    <nav className="cx-tabs" aria-label="结果大盘内容">{tabs.map(([key, name]) => <button key={key} aria-current={route.tab === key ? 'page' : undefined} onClick={() => navigate({ tab: key, qc: '' })}>{name}{key === 'quality' && <small>{state.qualityCounts.total}</small>}</button>)}</nav>
    {error && <div role="alert" className="notice error">{error}，当前为上次读取结果。</div>}
    {route.tab === 'business' && <Business state={state} connect={() => setImportOpen(true)} changed={id => id ? navigate({ replay: id }) : refresh()} />}
    {route.tab === 'quality' && <Quality key={`${state.projectId}:${route.qc}`} state={state} refresh={refresh} />}
    {route.tab === 'rca' && <RootCauses key={state.projectId} state={state} refresh={refresh} connect={() => setImportOpen(true)} />}
    {route.tab === 'intents' && <IntentExplorer key={state.projectId} state={state} />}
    <OutcomeImport open={importOpen} close={() => setImportOpen(false)} projectId={state.projectId} ruleVersion={state.rules.version} done={() => { setImportOpen(false); refresh(); }} />
  </div>;
}

function MetricCard({ title, metric, definition, action }: { title: string; metric: Ratio; definition: string; action?: () => void }) { return <Panel className="cx-metric"><span>{title}</span><strong>{display(metric.value)}</strong><small>{metric.denominator ? `${metric.numerator} / ${metric.denominator} · 分子 / 分母` : '暂无符合口径的样本，不显示0%'}</small><p>{definition}</p>{metric.value == null && action && <button className="text-link" onClick={action}>补齐结果数据<ArrowRight size={13} /></button>}</Panel>; }

function Business({ state, connect, changed }: { state: ExperienceState; connect: () => void; changed: (id?: string) => void }) {
  const [mode, setMode] = useState(state.metrics.sessions ? 'online' : 'replay');
  const quality = state.qualityAnalytics;
  return <><div className="learning-mode" aria-label="结果数据来源"><button aria-pressed={mode === 'replay'} onClick={() => setMode('replay')}>正式对话回放<span>现在可体验</span></button><button aria-pressed={mode === 'online'} onClick={() => setMode('online')}>线上业务结果<span>{state.metrics.sessions}通已接入</span></button><p>{mode === 'replay' ? '先用已有正式语料看效果，学习、回放、查证据一条路径。' : '真实解决和72小时重联只在这里统计，不和离线预测混在一起。'}</p></div>{mode === 'replay' ? <><ConversationLearning key={state.projectId} projectId={state.projectId} learning={state.learning} quality={quality} changed={changed} comparison={<ModelHistory state={state} />} />{state.vision && <OfflineVision state={state} />}</> : <ProductionBusiness state={state} connect={connect} />}</>;
}

function ProductionBusiness({ state, connect }: { state: ExperienceState; connect: () => void }) {
  const [scoreSource, setScoreSource] = useState('original');
  const metric = state.metrics;
  if (!metric.sessions) return <Panel className="production-onboarding"><PanelHead title="线上业务数据还没有接入" description="现有对话可以做离线训练和评测，但不能推算真实解决、72小时重联或满意度；这里不再展示整排空指标。" /><div><section><h3>有效转人工拦截率</h3><p>需接入是否解决、是否转人工、必转规则、安全结果及72小时重联记录。</p></section><section><h3>填单与质检准确率</h3><p>需有真实模型输出和人工确认的对照；历史质检申诉比例不能替代。</p></section><section><h3>当前可体验</h3><p>切回「正式对话回放」可运行本地训练实验、查看批次变化与逐例Trace。</p></section></div><p className="learning-boundary">线上结果 0 通 · 沙箱 {metric.sandbox} 通（不进入线上KPI）。接入符合条件的生产结果后，本页自动切换为指标大盘。</p><div className="modal-actions"><Button primary onClick={connect}>接入业务结果</Button><a className="text-link" href="#compare?mode=vision">准备图文模型评测<ArrowRight size={14} /></a></div></Panel>;
  const histogram = [0, 60, 70, 80, 90, 100].map((floor, index, list) => ({ name: index === list.length - 1 ? '100分' : `${floor}–${list[index + 1] - 1}`, count: state.reviews.filter(record => { const score = scoreSource === 'original' ? record.originalScore : scoreSource === 'suggested' ? record.suggestedScore : record.review?.score; return score != null && score >= floor && (index === list.length - 1 || score < list[index + 1]); }).length }));
  return <>
    <div className="cx-kpis"><MetricCard title="有效转人工拦截率" metric={metric.containment} definition="已确认解决、未转人工、72小时未再联系，且无必转人工或安全问题。" action={connect} /><MetricCard title="智能填单字段准确率" metric={metric.formAccuracy} definition="与人工确认字段逐一精确对照。漏填计错；整单另看全部字段一致率。" action={connect} /><MetricCard title="质检判定准确率" metric={metric.qualityAccuracy} definition="同规则版本的独立模型判定，对照人工金标。摘要建议分不参与。" action={connect} /></div>
    <div className="cx-measurement-note"><Info size={17} /><p>线上结果 {metric.sessions} 通 · 已满72小时观察窗 {metric.mature} 通 · 结果字段齐全 {metric.eligible} 通 · 沙箱 {metric.sandbox} 通（排除）。无转人工不等于解决，也不代表因果上的“节省人工”。</p></div>
    <OfflineVision state={state} />
    <Panel className="cx-journey"><PanelHead title="全链路数据覆盖" description="每一格是到达该阶段的会话数，不是逐步相除的转化漏斗。" /><ol>{metric.stages.map((stage, index) => <li key={stage.name}><span>{index + 1}</span><h3>{stage.name}</h3><strong>{metric.sessions ? stage.count : '—'}</strong><small>{metric.sessions ? '通会话' : '待接入事件'}</small></li>)}</ol></Panel>
    <div className="cx-chart-grid"><Panel><PanelHead title="业务效果趋势" description="按会话结束日期（UTC）分组；缺少分母的日期不补0、不连线。" />{state.daily.length ? <div className="cx-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={state.daily}><CartesianGrid strokeDasharray="3 3" stroke="var(--line)" /><XAxis dataKey="day" /><YAxis domain={[0, 100]} unit="%" /><Tooltip /><Legend /><Line dataKey="containment" name="有效拦截" stroke="var(--accent)" connectNulls={false} /><Line dataKey="form" name="填单准确" stroke="var(--success)" connectNulls={false} /><Line dataKey="quality" name="质检准确" stroke="var(--warning)" connectNulls={false} /></LineChart></ResponsiveContainer></div> : <Empty title="还没有线上结果曲线" description="现有历史对话没有72小时重联、最终工单结果和独立质检预测，不能补造。" action={<Button onClick={connect}>查看接入字段</Button>} />}</Panel>
      <Panel><PanelHead title="你的质检数据分布" description="只描述已有分数分布，不是模型准确率。不同分数来源分开看。" action={<select className="select" aria-label="分数来源" value={scoreSource} onChange={event => setScoreSource(event.target.value)}><option value="original">原始分数 · {state.qualityCounts.original}条</option><option value="suggested">规则建议 · {state.qualityCounts.suggested}条</option><option value="confirmed">本次人工复核 · {state.qualityCounts.confirmed}条</option></select>} /><div className="cx-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={histogram}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="count" name="记录数" fill="var(--accent)" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div><a href={`#overview?tab=quality&project=${state.projectId}`} className="cx-panel-link">查看{state.qualityCounts.total}条复核记录与证据<ArrowRight size={14} /></a></Panel></div>
    <ModelHistory state={state} />
    <div className="cx-small-kpis"><MetricCard title="必转人工却被拦截" metric={metric.unsafeInterception} definition="越低越好；分母为结果完整的必转人工会话。" /><MetricCard title="整单完全一致率" metric={metric.formExact} definition="预期与实际字段集合及取值全部一致，才算一单正确。" /><MetricCard title="工具调用成功率" metric={metric.toolSuccess} definition="按每次调用的明确返回状态统计，不代表业务最终完成。" /><MetricCard title="满意度 / DSAT" metric={metric.satisfaction} definition={`满意为4–5分，DSAT为1–2分。DSAT：${display(metric.dsat.value)}；无评价不计满意。`} /></div>
  </>;
}

function ModelHistory({ state }: { state: ExperienceState }) {
  return <ModelPerformance key={state.runId || 'empty'} analysis={state.modelAnalysis} trend={state.trend} runId={state.runId} options={state.runOptions} missing={state.requestedRunMissing} projectId={state.projectId} select={id => navigate({ run: id })} />;
}

function OfflineVision({ state }: { state: ExperienceState }) {
  const run = state.vision;
  return <Panel><PanelHead title="图文有效拦截 · 离线专项" description="历史图文专项尚未绑定项目，独立展示，不合入上方项目线上KPI。实际评审通过才算离线解决。" action={<select className="select" aria-label="图文专项批次" value={run?.id || ''} onChange={event => navigate({ mmrun: event.target.value })}>{!run && <option value="">尚无有效批次</option>}{state.visionOptions.map(item => <option value={item.id} key={item.id}>{visionSources[item.suite]?.name || '未知来源'} · {item.id.slice(-6)}</option>)}</select>} />{state.requestedVisionMissing && <p className="notice amber">指定图文批次不存在，未自动切换成绩。</p>}{run ? <><p className="cx-panel-link">{visionSources[run.suite]?.description || '来源未确认，不外推业务效果'} · {states[run.status] || run.status}</p><div className="table-wrap"><table><thead><tr><th>模型版本</th><th>有效拦截</th><th>必转却被拦截</th><th>视觉正确</th><th>评审覆盖</th><th>执行情况</th></tr></thead><tbody>{run.models.map(model => <tr key={model.id}><td>{model.name}</td>{[model.metrics.effectiveContainment, model.metrics.unsafeInterception, model.metrics.visualAccuracy, model.metrics.reviewCoverage].map((ratio, index) => <td key={index}><strong>{ratio.value == null ? '未测' : display(ratio.value)}</strong><small className="cx-ratio">{ratio.numerator} / {ratio.denominator}</small></td>)}<td>{model.metrics.completed}/{model.metrics.selected} 已完成<br />失败 {model.metrics.failed} · 必转未完成 {model.metrics.mandatoryUnfinished}</td></tr>)}</tbody></table></div><a className="cx-panel-link" href={`#compare?mode=vision&mmrun=${run.id}`}>查看图文、回复、对比及Trace<ArrowRight size={14} /></a></> : <Empty title="还没有图文拦截实测结果" description="连接两个视觉模型，同批案例运行，再由人工或裁判评审；不拿文本意图识别成绩代替。" action={<a className="text-link" href="#compare?mode=vision">准备图文对比</a>} />}</Panel>;
}

function Quality({ state, refresh }: { state: ExperienceState; refresh: () => void }) {
  const [error, setError] = useState('');
  const cancel = async (id: string) => { setError(''); try { await request('cancel', { id }); refresh(); } catch (problem) { setError((problem as Error).message); } };
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('qc') || 'all'); const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<QualityCase | null>(null); const [judgeOpen, setJudgeOpen] = useState(false); const [rulesOpen, setRulesOpen] = useState(false);
  const filtered = state.reviews.filter(record => (!query || `${record.id}${record.opinion}${record.machineExcerpt}`.includes(query)) && (filter !== 'pending' || (record.originalScore == null && record.suggestedScore == null && !record.review)) && (filter !== 'confirmed' || !!record.review) && (!['changed', 'maintained', 'unresolved', 'conflict'].includes(filter) || state.qualityAnalytics.classifications[record.id] === filter));
  return <>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="cx-section-head"><div><h2>质检数据已经入库</h2><p>原分 {state.qualityCounts.original} · 建议 {state.qualityCounts.suggested} · 待补 {state.qualityCounts.pending} · 本次人工确认 {state.qualityCounts.confirmed}</p></div><div className="lab-row-actions"><Button onClick={() => setRulesOpen(true)}>查看沿用规则</Button><Button primary onClick={() => setJudgeOpen(true)} disabled={!selected.length}><ChartLineUp size={16} />裁判重跑 · 已选{selected.length}条</Button></div></div>
    <div className="notice"><ShieldCheck size={18} /><span>当前是复核摘要，不是完整会话。原分、建议分、人工复核、裁判输出四者保留且不相互覆盖；它们不会自动成为独立测试金标。</span></div>
    <QualityOverview analytics={state.qualityAnalytics} select={value => setFilter(value)} selected={filter} />
    <Panel><div className="cx-toolbar"><SearchInput value={query} onChange={setQuery} placeholder="搜索复核意见、摘录或匿名编号" /><select aria-label="复核记录筛选" className="select" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部记录</option><option value="pending">待补证据</option><option value="confirmed">已人工确认</option><option value="changed">明确改判</option><option value="maintained">明确维持</option><option value="unresolved">状态含义待核实</option><option value="conflict">前后标记冲突</option></select><Button onClick={() => setSelected(filtered.map(record => record.id))}>全选当前{filtered.length}条</Button><Button quiet onClick={() => setSelected([])}>清空</Button></div><div className="table-wrap"><table className="cx-review-table"><thead><tr><th>选择</th><th>记录 / 来源</th><th>复核意见</th><th>原分</th><th>建议分</th><th>本次复核</th><th /></tr></thead><tbody>{filtered.map(record => <tr key={record.id}><td><input type="checkbox" aria-label={`选择第${record.sourceRow}行`} checked={selected.includes(record.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, record.id] : previous.filter(id => id !== record.id))} /></td><td><strong>第{record.sourceRow}行 · {record.channel}</strong><code>{record.id}</code><span className="cx-chart-source-status">来源：{record.originalResult || '未记录原判'} → {record.originalStatus || '未记录复核状态'}</span></td><td><p>{record.opinion}</p></td><td>{record.originalScore ?? '—'}</td><td><span className={record.suggestedScore != null ? 'cx-suggested' : ''}>{record.suggestedScore ?? '待确认'}</span></td><td>{record.review ? <Badge tone="blue">{record.review.score}分 · 已确认</Badge> : '未复核'}</td><td><Button onClick={() => setDetail(record)}>查看与复核</Button></td></tr>)}</tbody></table>{!filtered.length && <Empty />}</div></Panel>
    <Panel><PanelHead title="裁判重跑记录" description="模型只读取脱敏机审摘录和规则，不读取本次建议分或人工复核分。没有有效Key时不会产生假结果。" />{state.qualityRuns.length ? state.qualityRuns.map(run => <details className="cx-run" key={run.id}><summary><strong>{run.model}</strong><Badge>{states[run.status] || run.status} · {run.completed}/{run.total}</Badge><DateText value={run.createdAt} /></summary>{run.status === 'running' && <Button onClick={() => void cancel(run.id)}>停止后续调用</Button>}{run.results.map(row => <div className="cx-run-row" key={row.caseId}><code>{row.caseId}</code><strong>{row.status === 'failed' ? '执行失败' : row.score == null ? '证据不足，未给总分' : `辅助建议 ${row.score}分`}</strong><p>{row.reason || row.error}</p><button className="text-link" onClick={() => trace(row.traceId)}>查看Trace</button></div>)}</details>) : <Empty title="尚未调用裁判" description="选择记录后，设定数量和模型；确认外发范围及费用后才会调用。" />}</Panel>
    <Modal open={rulesOpen} onClose={() => setRulesOpen(false)} title="沿用质检规则" description={`${state.rules.version} · 100分起评 · 90分以下不合格`} wide><div className="cx-rules">{state.rules.dimensions.map(dimension => <section key={dimension.id}><h3>{dimension.name}<Badge>{dimension.points ? `扣${dimension.points}分 / 维度` : '只观察，不扣分'}</Badge></h3><p>{dimension.items.join('、')}</p></section>)}</div><p className="notice amber">同一维度无论触发几个项目，仅扣一次。规则只针对人工接入后的对话；热线不适用在线差评留言规则。</p><details className="lab-disclosure"><summary>完整脱敏规则正文与例外场景</summary><p>{state.rules.source}</p><pre className="cx-rule-text">{state.rules.text || '当前环境未导入规则原文'}</pre></details></Modal>
    <QualityReview key={detail?.id || 'closed'} record={detail} rules={state.rules.dimensions} close={() => setDetail(null)} done={() => { setDetail(null); refresh(); }} />
    <JudgeRun open={judgeOpen} close={() => setJudgeOpen(false)} ids={selected} projectId={state.projectId} done={() => { setJudgeOpen(false); refresh(); }} />
  </>;
}

function QualityReview({ record, rules, close, done }: { record: QualityCase | null; rules: Dimension[]; close: () => void; done: () => void }) {
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(Object.fromEntries(rules.map(rule => [rule.id, 'unknown']))); const [reason, setReason] = useState(''); const [reviewer, setReviewer] = useState(''); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const ready = rules.filter(rule => rule.points).every(rule => verdicts[rule.id] !== 'unknown');
  const score = ready ? 100 - rules.filter(rule => verdicts[rule.id] === 'violated').reduce((total, rule) => total + rule.points, 0) : null;
  const save = async () => { if (!record) return; setBusy(true); setError(''); try { await request('review', { id: record.id, revision: record.revision, verdicts, reason, reviewer, confirmed }); done(); } catch (problem) { setError((problem as Error).message); } finally { setBusy(false); } };
  return <Modal open={!!record} onClose={() => !busy && close()} title={`第${record?.sourceRow || ''}行 · 质检证据与复核`} description="只在核实后确认；历史分数不覆盖，保留每次复核版本。" wide>{record && <>
    <div className="cx-evidence-grid"><section><h3>申诉说明</h3><p>{record.appeal}</p><h3>已有人工复核意见</h3><p>{record.opinion}</p></section><section><h3>本次建议依据</h3><p>{record.basis}</p><h3>尚需确认</h3><p>{record.warning}</p></section></div><details className="lab-disclosure"><summary>展开原机审摘录（可能包含错误判定）</summary><p className="cx-preserve">{record.machineExcerpt}</p></details><p className="notice amber">{record.completeness}</p>
    <h3>按一级维度确认</h3><div className="cx-verdicts">{rules.map(rule => <label key={rule.id}><span>{rule.name}<small>{rule.points}分 · 同维度一次</small></span><select aria-label={rule.name} value={verdicts[rule.id]} onChange={event => setVerdicts(previous => ({ ...previous, [rule.id]: event.target.value as Verdict }))}><option value="unknown">证据不足</option><option value="clear">已核实，无保留违规</option><option value="violated">已核实，保留违规</option></select></label>)}</div>
    <div className="cx-calculated">按规则计算：<strong>{score == null ? '证据不全，不给总分' : `${score}分 · ${score >= 90 ? '合格' : '不合格'}`}</strong></div><label className="form-field">复核人（匿名代号）<input value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={60} /></label><label className="form-field">可核查依据及核实范围<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1600} placeholder="说明核实了哪些证据，以及为何保留/撤销计分维度。不要仅写同意。" /></label><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核实适用条件；不把建议分直接当作正式结论。</label>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><Button onClick={close} disabled={busy}>取消</Button><Button primary onClick={() => void save()} disabled={!ready || !confirmed || !reason.trim() || !reviewer.trim() || busy}>{busy ? '保存中…' : '保存人工复核'}</Button></div>
    {record.history.length > 0 && <details className="lab-disclosure"><summary>查看{record.history.length}次历史复核</summary>{record.history.map((review, index) => <div key={index} className="cx-history"><strong>{review.reviewer} · {review.score}分</strong><DateText value={review.at} /><p>{review.reason}</p><button className="text-link" onClick={() => trace(review.traceId)}>复核Trace</button></div>)}</details>}
  </>}</Modal>;
}

function JudgeRun({ open, close, ids, projectId, done }: { open: boolean; close: () => void; ids: string[]; projectId: string; done: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]); const [connectionId, setConnectionId] = useState(''); const [count, setCount] = useState(1); const [consent, setConsent] = useState(false); const [keyOpen, setKeyOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const reload = useCallback(async () => { try { const response = await fetch('/api/support/lab/state'); if (!response.ok) throw new Error('无法读取模型连接'); setConnections((await response.json()).connections); } catch (problem) { setError((problem as Error).message); } }, []);
  useEffect(() => { if (open) { void reload(); setCount(Math.min(5, ids.length)); setConsent(false); setError(''); } }, [open, reload, ids.length]);
  const connection = connections.find(item => item.id === connectionId);
  const submit = async () => { setBusy(true); setError(''); try { await request('judge', { projectId, caseIds: ids, count, connectionId, consent }); done(); } catch (problem) { setError((problem as Error).message); } finally { setBusy(false); } };
  return <><Modal open={open && !keyOpen} onClose={() => !busy && close()} title="按数量重跑质检复核" description="仅发送选中记录的脱敏机审摘录与完整规则。不发送人工分、建议分或身份编号。"><label className="form-field">运行数量（已选{ids.length}条）<input type="number" min={1} max={ids.length} value={count} onChange={event => setCount(Number(event.target.value))} /></label><label className="form-field">裁判模型连接<select value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">请选择模型</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.judgeModel}{item.tested && item.configured ? '' : ' · 待连接'}</option>)}</select></label><Button onClick={() => setKeyOpen(true)}>添加连接 / 输入API Key</Button><p className="notice">裁判是复核助手，不是金标。无法从摘要确认的维度返回“证据不足”，不会强行给满分。</p><label className="checkbox-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />同意将上述脱敏材料发送给所选服务，并承担调用费用。</label>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><Button onClick={close} disabled={busy}>取消</Button><Button primary disabled={busy || !consent || !connection?.configured || !connection.tested || !Number.isInteger(count) || count < 1 || count > ids.length} onClick={() => void submit()}>{busy ? '启动中…' : '开始裁判重跑'}</Button></div></Modal><ConnectionModal open={keyOpen} close={() => setKeyOpen(false)} connection={connection && !connection.configured ? connection : null} changed={reload} /></>;
}


function OutcomeImport({ open, close, projectId, ruleVersion, done }: { open: boolean; close: () => void; projectId: string; ruleVersion: string; done: () => void }) {
  const [content, setContent] = useState(''); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const example = JSON.stringify({ records: [{ id: 'ANON_SESSION_ID', environment: 'sandbox', source: '填写来源系统，不写凭证', evidence: '填写结果依据和核实方式', startedAt: '带时区的开始时间', closedAt: '带时区的结束时间', observedUntil: '带时区的观察截止时间', resolved: null, recontact: null, handoff: null, mustHandoff: null, unsafe: null, answered: null, ticketResolved: null, rating: null, traceId: null, expectedIntent: null, predictedIntent: null, tools: [], form: null, quality: null }] }, null, 2);
  useEffect(() => { if (open) { setConfirmed(false); setError(''); } }, [open]);
  const submit = async () => { setBusy(true); setError(''); try { const value = JSON.parse(content); await request('outcomes', { projectId, records: value.records, confirmed }); done(); } catch (problem) { setError(problem instanceof SyntaxError ? 'JSON格式不正确，请检查内容。' : (problem as Error).message); } finally { setBusy(false); } };
  return <Modal open={open} onClose={() => !busy && close()} title="接入业务结果" description="本机批量接口已可用；这里只接收脱敏结果，不会连接或修改真实工单系统。" wide><div className="notice"><Info size={18} /><span>一条记录对应一通完整会话。请明确production或sandbox；后者只保存、不进入线上指标。相同编号幂等导入，冲突不覆盖。</span></div><details className="lab-disclosure"><summary>查看字段模板与指标条件</summary><pre className="cx-json">{example}</pre><p>有效拦截要求结束后观察满72小时，并且结果字段均有明确值。null不按false处理。满意为4–5分，DSAT为1–2分，不凭情绪关键词推测。</p><p>填单对象：expected和predicted是匿名字段到文本值的映射，goldConfirmed必须为true。字段精确相等才计正确，漏填计错。</p><p>质检对象：expected与predicted为是否合格的布尔值；goldConfirmed和independent必须为true，ruleVersion为{ruleVersion}。只接受独立模型预测对照人工金标，不接受本次摘要建议分。</p><p>可先通过现有Trace接入接口导入执行轨迹，再填写traceId；不存在的Trace会被拒绝。</p><code>POST /api/support/experience/outcomes</code></details><label className="form-field">业务结果JSON<textarea className="cx-json-input" value={content} onChange={event => setContent(event.target.value)} maxLength={220000} placeholder="粘贴 { &quot;records&quot;: [...] }。模板占位内容不是有效数据，不会自动生成演示成绩。" /></label><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已确认数据来源、生产/沙箱环境和授权，内容已脱敏。</label>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><Button onClick={close} disabled={busy}>取消</Button><Button primary onClick={() => void submit()} disabled={!confirmed || !content.trim() || busy}>{busy ? '校验入库中…' : '校验并导入'}</Button></div></Modal>;
}
