import { useEffect, useState } from 'react';
import { ArrowRight, ChatCircleText, CheckCircle, FileText, MagnifyingGlass } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Modal, Panel, PanelHead, SearchInput } from './ui';
import { Donut, chartPercent } from './ExperienceCharts';
import type { ExperienceState } from './ExperienceDashboard';
import './rca.css';

type Ratio = { value: number | null; numerator: number; denominator: number };
type Scope = 'dsat' | 'signals';
type Check = { verdict: 'unknown' | 'supported' | 'excluded'; note: string };
export type Cause = { id: string; name: string; owner: string; evidence: string; fix: string };
type Revision = { primary: string | null; contributors: string[]; status: string; updatedAt: string; reviewer?: string; evidence?: string; counterfactual?: string; action?: string; owner?: string; verification?: string; checks?: Record<string, Check>; reviewTraceId?: string };
export type Rca = Revision & { id: string; projectId: string; title: string; sourceType: string; sourceId: string; sourceEvidence: string; traceId: string | null; revision: number; history: Revision[]; scope: Scope; rating: number | null; sourceAvailable: boolean; coverage: Record<string, boolean>; messageCount: number; sourceRow: number | null; sourceWarning: string; sourceSequence?: number };
type Summary = { total: number; confirmed: number; verified: number; confirmationRate: Ratio; verificationRate: Ratio; statuses: { id: string; count: number }[]; causes: ({ id: string; name: string; count: number } & Ratio)[]; coverage: Record<string, Ratio> };
export type RcaAnalytics = Record<Scope, Summary>;
type Detail = { record: Rca; method: string; warnings: string[]; messages: { id: string; sequence: number; role: string; content: string; at: string | null }[]; evidence: { id: string; label: string; text: string }[] };
const statuses: Record<string, string> = { triage: '待归因', confirmed: '归因已确认', fixing: '修复中', verified: '人工回归已验收' };
const sourceNames: Record<string, string> = { reported_dsat: '低分评价', review_signal: '质检复核线索', conversation_signal: '投诉标注对话' };
const roles: Record<string, string> = { user: '用户', human: '人工客服', assistant: '机器人', system: '系统' };
const statusColors: Record<string, string> = { triage: 'var(--chart-gray)', confirmed: 'var(--chart-blue)', fixing: 'var(--chart-orange)', verified: 'var(--chart-teal)' };
const boundaries: Record<string, string> = {
  policy: '没有适用规则或规则本身不可执行，才考虑策略问题；已有正确规则但知识传错，应查知识。',
  knowledge: '核对实际检索命中的内容及版本，不把“回答不对”直接等同于知识库错误。',
  understanding: '对照用户真实诉求、应识别意图和模型实际输出；仅有用户投诉不足以判定理解失败。',
  engineering: '检查消息收发、上下文、超时与转接事件。没有日志不代表工程正常。',
  tool: '检查是否调用、参数、返回及兜底。未调用可能来自策略或理解，不能只因结果失败就归到工具。',
  human: '只评价人工接入后的可控行为；先核实当时可用规则、权限、交接与操作条件，不能把系统故障归责客服。',
};
const openTrace = (id: string) => { location.hash = `traces?trace=${encodeURIComponent(id)}&return=${encodeURIComponent(location.hash.slice(1))}`; };
async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/experience/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '操作未完成');
  return payload;
}

export function RootCauses({ state, refresh, connect }: { state: ExperienceState; refresh: () => void; connect: () => void }) {
  const [scope, setScope] = useState<Scope>(state.rcaAnalytics.dsat.total ? 'dsat' : 'signals');
  const [status, setStatus] = useState('all');
  const [cause, setCause] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const summary = state.rcaAnalytics[scope];
  const allRows = state.rca.filter(item => item.scope === scope);
  const rows = allRows.filter(item => (status === 'all' || item.status === status) && (cause === 'all' || item.primary === cause) && `${item.title} ${item.id} ${item.sourceEvidence} ${item.owner || ''}`.toLowerCase().includes(search.toLowerCase()));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 10)));
  const slices = summary.statuses.map(item => ({ ...item, name: statuses[item.id], color: statusColors[item.id] }));
  const scopedName = scope === 'dsat' ? 'DSAT' : '线索';
  const filterStatus = (value: string) => { setStatus(value); setPage(1); };
  return <div className="rca-workbench">
    <div className="cx-section-head"><div><h2>定位问题，不凭差评定责</h2><p>看原始证据 → 排查六类原因 → 明确改进 → 回归验收</p></div><Badge tone="blue">本机证据工作台</Badge></div>
    <div className="rca-scope" aria-label="归因数据来源">
      <div>{(['signals', 'dsat'] as Scope[]).map(value => <button key={value} aria-pressed={scope === value} onClick={() => { setScope(value); setStatus('all'); setCause('all'); setSearch(''); setPage(1); }}>{value === 'signals' ? '投诉 / 复核线索' : '有评价的 DSAT'}<b>{state.rcaAnalytics[value].total}</b></button>)}</div>
      <span>真实评价 DSAT 率 <strong>{chartPercent(state.metrics.dsat.value)}</strong> · {state.metrics.dsat.numerator}/{state.metrics.dsat.denominator} 通已评价生产会话</span>
    </div>
    <p className="rca-scope-note">{scope === 'signals' ? '以下来自已有正式资料，没有原始低分评价，不进入DSAT率或DSAT主因分布。投诉标签只负责找到线索，不负责判定原因。' : '只统计明确为生产环境且评价1–2分的会话；无评价和3分中立不计DSAT。来源由接入方声明。'}</p>
    <div className="rca-metrics">
      <section><span>{scopedName}调查对象</span><strong>{summary.total}<small>条</small></strong><p>{scope === 'signals' ? `${allRows.filter(item => item.sourceType === 'conversation_signal').length}段投诉对话 · ${allRows.filter(item => item.sourceType === 'review_signal').length}条复核线索` : '相同来源编号不重复计数'}</p></section>
      <section><span>等待定位</span><strong>{summary.statuses.find(item => item.id === 'triage')?.count || 0}<small>条</small></strong><p>候选原因不算已确认</p></section>
      <section><span>{scopedName}归因确认率</span><strong>{chartPercent(summary.confirmationRate.value)}</strong><p>{summary.confirmed}/{summary.total} 条已确认主因</p></section>
      <section><span>已归因问题的验收率</span><strong>{chartPercent(summary.verificationRate.value)}</strong><p>{summary.verified}/{summary.confirmed} 条人工回归已验收</p></section>
    </div>
    {summary.total ? <div className="rca-summary-grid">
      <Panel className="rca-progress"><PanelHead title={`${scopedName}处理进度`} description="点击环图或图例，定位下面的待办。" /><div className="rca-progress-body"><Donut slices={slices} value={String(summary.total)} label={`${scopedName}总数`} size={180} onSelect={filterStatus} /><div className="cx-chart-legend">{slices.map(item => <button key={item.id} aria-pressed={status === item.id} disabled={!item.count} onClick={() => filterStatus(item.id)}><i style={{ background: item.color }} /><span>{statuses[item.id]}</span><b>{item.count}</b><strong>{chartPercent(item.count / summary.total * 100)}</strong></button>)}</div></div></Panel>
      <Panel className="rca-evidence-coverage"><PanelHead title="证据接入情况" description="有材料不代表已经核实；缺少材料不按“正常”处理。" /><div>{[['conversation', '已导入对话文本'], ['rating', '来源低分评价'], ['trace', '关联运行 Trace']].map(([key, label]) => <section key={key}><div><span>{label}</span><b>{summary.coverage[key].numerator}/{summary.total}</b></div><div className="rca-meter"><span style={{ width: `${summary.coverage[key].value || 0}%` }} /></div></section>)}</div><p>优先打开一条记录核对现有材料；对话中的图片、受限正文仍可能缺失。<button className="text-link" onClick={connect}>补充真实业务结果<ArrowRight size={13} /></button></p></Panel>
    </div> : <Panel><Empty title={scope === 'dsat' ? '还没有原始低分评价' : '当前项目没有投诉或复核线索'} description={scope === 'dsat' ? '可以先分析已有线索；接入真实评价后，会自动创建DSAT待办，不需要重建项目。' : '仅提取已有投诉标签和已登记复核线索，不根据关键词制造差评。'} action={<Button primary onClick={connect}>接入真实业务结果</Button>} /></Panel>}
    {summary.confirmed > 0 && <Panel className="rca-confirmed-causes"><PanelHead title={`${scopedName} · 已确认主因分布`} description={`分母为${summary.confirmed}条已确认记录；一个主因计一次，促成因素不重复加入。`} /><div className="rca-cause-counts">{summary.causes.map(item => <button key={item.id} disabled={!item.count} aria-pressed={cause === item.id} onClick={() => { setCause(cause === item.id ? 'all' : item.id); setStatus('all'); setPage(1); }}><span>{item.name}</span><strong>{chartPercent(item.value)}</strong><small>{item.count}/{summary.confirmed}条</small></button>)}</div></Panel>}
    <Panel className="rca-queue"><PanelHead title="调查与改进清单" description="先看证据，再决定原因；内容不足时可以只保存调查草稿。" action={<Badge>{rows.length}条匹配</Badge>} />
      <div className="rca-filters"><SearchInput value={search} onChange={value => { setSearch(value); setPage(1); }} placeholder="搜索问题、编号或负责人" /><select className="select" aria-label="归因状态" value={status} onChange={event => filterStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select className="select" aria-label="归因原因筛选" value={cause} onChange={event => { setCause(event.target.value); setPage(1); }}><option value="all">全部原因</option>{state.causes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="cx-rca-list">{rows.slice((currentPage - 1) * 10, currentPage * 10).map(item => <article key={item.id}><div className="rca-row-main"><div className="rca-row-meta"><Badge tone={item.scope === 'dsat' ? 'blue' : 'amber'}>{sourceNames[item.sourceType] || '待核实来源'}{item.sourceRow ? ` · 第${item.sourceRow}行` : ''}</Badge><Badge tone={item.status === 'verified' ? 'green' : 'gray'}>{statuses[item.status]}</Badge></div><h3>{item.title}</h3><p className="rca-row-excerpt">{item.sourceSequence ? `用户 · 第${item.sourceSequence}条：` : ''}{item.sourceEvidence || '请打开来源核实'}</p><div className="rca-row-foot"><span>{item.messageCount ? `${item.messageCount}条对话消息可读` : '摘要 / 结果记录'}</span><span>{item.primary ? `${item.status === 'triage' ? '候选' : '主因'}：${state.causes.find(entry => entry.id === item.primary)?.name}` : '主因待核实'}</span><span>负责人：{item.owner || '待分配'}</span></div></div><Button primary onClick={() => setSelected(item.id)}>查看与归因<ArrowRight size={15} /></Button></article>)}</div>
      {!rows.length && summary.total > 0 && <Empty title="没有匹配的调查记录" action={<Button onClick={() => { setSearch(''); setStatus('all'); setCause('all'); }}>清除筛选</Button>} />}
      {rows.length > 10 && <nav className="rca-pagination" aria-label="归因清单分页"><Button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>第 {currentPage}/{Math.ceil(rows.length / 10)} 页 · 共{rows.length}条</span><Button disabled={currentPage * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></nav>}
    </Panel>
    {selected && <RcaDialog key={selected} identifier={selected} projectId={state.projectId} causes={state.causes} close={() => setSelected(null)} done={() => { setSelected(null); refresh(); }} />}
  </div>;
}

function RcaDialog({ identifier, projectId, causes, close, done }: { identifier: string; projectId: string; causes: Cause[]; close: () => void; done: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; setError(''); void request<Detail>(`rca-detail?${new URLSearchParams({ project: projectId, id: identifier })}`).then(value => { if (active) setDetail(value); }).catch(problem => { if (active) setError((problem as Error).message); }); return () => { active = false; }; }, [identifier, projectId, revision]);
  return <Modal open onClose={() => !busy && close()} title="DSAT归因与行动" description="来源记录、候选原因与人工结论分开保留；本页不调用外部模型。" wide>{error ? <div className="notice error" role="alert">{error}<Button onClick={() => setRevision(value => value + 1)}>重新读取</Button></div> : detail ? <RcaEditor detail={detail} causes={causes} close={close} done={done} onBusy={setBusy} /> : <p className="rca-loading">正在读取来源证据与全部对话…</p>}</Modal>;
}

function RcaEditor({ detail, causes, close, done, onBusy }: { detail: Detail; causes: Cause[]; close: () => void; done: () => void; onBusy: (busy: boolean) => void }) {
  const record = detail.record;
  const [step, setStep] = useState('source');
  const [primary, setPrimary] = useState(record.primary || '');
  const [contributors, setContributors] = useState(record.contributors || []);
  const [status, setStatus] = useState(record.status);
  const [checks, setChecks] = useState<Record<string, Check>>(Object.fromEntries(causes.map(cause => [cause.id, record.checks?.[cause.id] || { verdict: 'unknown', note: '' }])));
  const [evidence, setEvidence] = useState(record.evidence || '');
  const [counterfactual, setCounterfactual] = useState(record.counterfactual || '');
  const [action, setAction] = useState(record.action || '');
  const [owner, setOwner] = useState(record.owner || '');
  const [reviewer, setReviewer] = useState(record.reviewer || '');
  const [verification, setVerification] = useState(record.verification || '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const supported = !!primary && [primary, ...contributors].every(key => checks[key]?.verdict === 'supported' && checks[key].note.trim());
  const checksValid = Object.values(checks).every(check => check.verdict === 'unknown' || check.note.trim());
  const ready = status === 'triage' ? checksValid : checksValid && supported && record.sourceAvailable && [evidence, counterfactual, action, owner, reviewer].every(value => value.trim()) && confirmed && (status !== 'verified' || verification.trim());
  const save = async (draft = false) => { setBusy(true); onBusy(true); setError(''); try { await request('rca', { id: record.id, projectId: record.projectId, revision: record.revision, primary, contributors, status: draft ? 'triage' : status, checks, evidence, counterfactual, action, owner, reviewer, verification, confirmed }); done(); } catch (problem) { setError((problem as Error).message); } finally { setBusy(false); onBusy(false); } };
  const cite = (label: string, text: string) => { const quote = `[${record.sourceId} · ${label}] ${text}`; if (evidence.includes(quote)) { setNotice('这条证据已经引用。'); return; } if (evidence.length + quote.length + 1 > 2000) { setNotice('定位证据最多2000字，请先在「归因与行动」整理已有引用。'); return; } setEvidence(previous => previous ? `${previous}\n${quote}` : quote); setNotice('已加入「归因与行动」中的定位证据，请补充判断和排除依据。'); };
  return <div className="rca-editor">
    <div className="rca-case-title"><Badge tone={record.scope === 'dsat' ? 'blue' : 'amber'}>{sourceNames[record.sourceType]}</Badge><h3>{record.title}</h3><small>版本 {record.revision} · {record.id}</small></div>
    <nav className="rca-steps" aria-label="归因操作步骤">{[['source', '来源与证据', ChatCircleText], ['checks', '逐项排查', MagnifyingGlass], ['action', '归因与行动', CheckCircle]].map(([key, label, Icon], index) => { const StepIcon = Icon as typeof FileText; return <button key={String(key)} aria-pressed={step === key} onClick={() => setStep(String(key))}><StepIcon size={17} /><span>{index + 1}. {String(label)}</span></button>; })}</nav>
    {notice && <p className="notice" role="status">{notice}</p>}
    <section hidden={step !== 'source'} className="rca-source-panel">
      {detail.warnings.map(warning => <p className="notice amber" key={warning}>{warning}</p>)}
      <div className="rca-source-links">{record.coverage.conversation && <a className="text-link" href={`#knowledge?session=${encodeURIComponent(record.sourceId)}`}>在知识库打开完整对话<ArrowRight size={13} /></a>}{record.traceId && record.coverage.trace && <Button onClick={() => openTrace(record.traceId!)}>来源运行Trace</Button>}{!record.coverage.trace && <span>未关联运行Trace，不能判定工程或工具正常</span>}</div>
      <div className="rca-source-evidence">{detail.evidence.map(item => <section key={item.id}><header><h4>{item.label}</h4><button className="text-link" onClick={() => cite(item.label, item.text)}>引用这段</button></header><p>{item.text}</p></section>)}</div>
      {detail.messages.length > 0 && <><div className="rca-chat-heading"><strong>来源对话 · 全部 {detail.messages.length} 条消息</strong><span>保持原始顺序；无时间不编造时间</span></div><div className="rca-chat" aria-label="来源完整对话">{detail.messages.map((message, index) => <article key={message.id || index} className={`rca-message ${message.role === 'user' ? 'user' : 'service'}`}><span>{roles[message.role] || '来源角色未识别'} · 第{message.sequence || index + 1}条{message.at ? ` · ${message.at}` : ''}</span><p>{message.content}</p><button className="text-link" onClick={() => cite(`第${message.sequence || index + 1}条 ${roles[message.role] || message.role}`, message.content)}>引用第{message.sequence || index + 1}条</button></article>)}</div></>}
      {!detail.evidence.length && !detail.messages.length && <p className="cx-source-evidence">{record.sourceEvidence}</p>}
      <div className="rca-step-next"><span>{detail.method}</span><Button primary onClick={() => setStep('checks')}>下一步：逐项排查<ArrowRight size={14} /></Button></div>
    </section>
    <section hidden={step !== 'checks'}>
      <p className="rca-helper">先查工程和工具，再核对策略、知识、理解及人工行为。顺序不是定责规则；有支持或排除判断时必须记录依据。未核实项可以保留。</p>
      <div className="rca-checks">{['engineering', 'tool', 'policy', 'knowledge', 'understanding', 'human'].map(key => { const cause = causes.find(item => item.id === key)!; return <section key={key}><header><h4>{cause.name}</h4><Badge>{cause.owner}</Badge></header><p>{boundaries[key]}</p><small>需核对：{cause.evidence}</small><label className="form-field">{cause.name} · 排查结论<select aria-label={`${cause.name}排查结论`} value={checks[key].verdict} onChange={event => setChecks(previous => ({ ...previous, [key]: { ...previous[key], verdict: event.target.value as Check['verdict'] } }))}><option value="unknown">待核实 / 证据不足</option><option value="supported">有证据支持</option><option value="excluded">已核实排除</option></select></label><label className="form-field">{cause.name} · 证据依据<textarea value={checks[key].note} onChange={event => setChecks(previous => ({ ...previous, [key]: { ...previous[key], note: event.target.value } }))} maxLength={1000} placeholder="填写原文轮次、规则版本或匿名日志编号，并说明为何支持或排除；尚缺什么也可先记录。" /></label></section>; })}</div>
      <div className="rca-step-next"><span>{Object.values(checks).filter(check => check.verdict !== 'unknown').length}/6 项已登记核实判断，不代表已确认主因</span><Button primary onClick={() => setStep('action')}>下一步：归因与行动<ArrowRight size={14} /></Button></div>
    </section>
    <section hidden={step !== 'action'}>
      <div className="cx-evidence-grid"><label className="form-field">主因（待归因阶段仅为候选）<select value={primary} onChange={event => { setPrimary(event.target.value); setContributors(previous => previous.filter(value => value !== event.target.value)); if (!owner) setOwner(causes.find(cause => cause.id === event.target.value)?.owner || ''); }}><option value="">暂不判断</option>{causes.map(cause => <option value={cause.id} key={cause.id}>{cause.name}</option>)}</select></label><label className="form-field">处理状态<select value={status} onChange={event => setStatus(event.target.value)}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key} disabled={key === 'verified' && !['fixing', 'verified'].includes(record.status)}>{label}</option>)}</select></label></div>
      {primary && <p className="notice">改进参考：{causes.find(cause => cause.id === primary)?.fix}。{checks[primary].verdict !== 'supported' && '当前主因还没有支持证据，只能作为候选保存。'}</p>}
      <div className="rca-contributors"><span>促成因素（可多选，不重复统计）</span>{causes.filter(cause => cause.id !== primary).map(cause => <label className="checkbox-label" key={cause.id}><input type="checkbox" checked={contributors.includes(cause.id)} onChange={event => setContributors(previous => event.target.checked ? [...previous, cause.id] : previous.filter(value => value !== cause.id))} />{cause.name}</label>)}</div>
      <label className="form-field">定位证据与排除依据<textarea value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={2000} placeholder="可在来源页点击引用；请补充定位原因及排除其他解释的依据。" /></label>
      <label className="form-field">反事实检查<textarea value={counterfactual} onChange={event => setCounterfactual(event.target.value)} maxLength={1000} placeholder="如果只修复这个原因，问题还会出现吗？如何验证？" /></label>
      <label className="form-field">改进动作与验收标准<textarea value={action} onChange={event => setAction(event.target.value)} maxLength={1000} placeholder="改哪里、用哪些案例回归、达到什么结果；不要仅填写加强培训。" /></label>
      <div className="cx-evidence-grid"><label className="form-field">负责人（团队或匿名代号）<input value={owner} onChange={event => setOwner(event.target.value)} maxLength={60} /></label><label className="form-field">归因复核人（匿名代号）<input value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={60} /></label></div>
      {status === 'verified' && <label className="form-field">实际回归证据<textarea value={verification} onChange={event => setVerification(event.target.value)} maxLength={1200} placeholder="真实回归编号、案例范围和结果；此处为人工验收，不是系统自动证明修复。" /></label>}
      {status !== 'triage' && <><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核实主因与促成因素的支持证据；这是人工结论，不是系统自动定责。</label>{!ready && <p className="rca-helper">确认前需要：支持主因/促成因素的逐项证据、定位依据、反事实、动作、负责人、复核人和人工确认；验收还需实际回归记录。</p>}</>}
    </section>
    {record.history.length > 0 && <details className="rca-history"><summary>变更历史 · {record.history.length}次（原始资料不覆盖）</summary>{record.history.map((item, index) => <section key={index}><header><strong>{statuses[item.status]} · {causes.find(cause => cause.id === item.primary)?.name || '未确定主因'}</strong><DateText value={item.updatedAt} /></header><p>复核人：{item.reviewer || '草稿未署名'} · 负责人：{item.owner || '未分配'}</p><p>定位依据：{item.evidence || '尚未登记'}</p><p>反事实：{item.counterfactual || '尚未登记'}</p><p>动作：{item.action || '尚未登记'}</p>{item.verification && <p>回归：{item.verification}</p>}{item.reviewTraceId && <button className="text-link" onClick={() => openTrace(item.reviewTraceId!)}>查看本次归因Trace</button>}</section>)}</details>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions rca-editor-actions"><Button disabled={busy} onClick={close}>关闭</Button>{record.status === 'triage' && <Button disabled={busy || !checksValid} onClick={() => void save(true)}>保存调查草稿</Button>}{step === 'action' && <Button primary disabled={busy || !ready} onClick={() => void save()}>{busy ? '保存中…' : '保存归因与行动'}</Button>}</div>
  </div>;
}
