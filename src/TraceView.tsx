import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowSquareOut, Bug, CheckCircle, CircleNotch, DownloadSimple, Fingerprint, GitBranch, Info, MagnifyingGlass, Plus, ShieldCheck, Timer, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Panel, PanelHead, SearchInput } from './ui';

type Span = {
  id: string; parentId: string | null; name: string; kind: string; status: string;
  startMs: number; durationMs: number | null; input: unknown; output: unknown;
  attributes: Record<string, unknown>; events: { name: string; offsetMs: number; attributes: unknown }[];
  error: { type: string; message: string; frames?: { file: string; line: number; function: string }[] } | null;
};
type Annotation = { name: string; at: string; attributes: Record<string, unknown> };
type Trace = {
  id: string; name: string; source: string; origin: string; execution: string; status: string;
  sessionId: string | null; conversationId: string | null; runId: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  input: unknown; output: unknown; attributes: Record<string, unknown>;
  issues: { kind: string; code: string; message: string; spanId: string }[];
  annotations: Annotation[]; spans: Span[]; spanCount: number; errorCount: number;
  preview: string; hasQualityIssue: boolean; redaction: string;
  category: string; categoryName: string; sourceName: string; batchId: string | null; durationScope: string;
};
type Listing = { traces: Trace[]; total: number; page: number; pageSize: number; sources: string[]; matchedTotal: number; categories: { id: string; name: string; count: number }[]; stats: { total: number; errors: number; blocked: number; quality: number } };
const labels: Record<string, string> = { running: '执行中', ok: '执行成功', error: '执行异常', blocked: '输入拦截', cancelled: '已取消', interrupted: '服务中断' };
const kinds: Record<string, string> = { agent: 'Agent 执行', guardrail: '安全检查', memory: '上下文', retrieval: '检索', model: '模型', tool: '工具', routing: '决策路由', evaluation: '评测', storage: '存储', internal: '内部操作' };
const sourceNames: Record<string, string> = { 'support.chat': '客服会话', 'support.evaluation': '公开文本评测', 'support.uat': '中文业务回归', 'experience.learning': '对话字段模型训练', 'aftersales.train': '客服行为模型训练', 'experience.replay': '填单与转人工评测', 'aftersales.replay': '客服行为回合评测', 'aftersales.vision': '图文客服评测', 'quality.review': '人工质检复核保存', 'quality.judge': '模型质检裁判', 'experience.rca.review': 'DSAT归因保存', 'aftersales.chat': '客服模型试聊' };
const elapsed = (duration: number | null | undefined) => duration == null ? '未记录结束耗时' : duration < 1000 ? `${duration.toFixed(1)} ms` : `${(duration / 1000).toFixed(2)} s`;

function TraceStatus({ status }: { status: string }) { return <Badge tone={status === 'ok' ? 'green' : status === 'error' || status === 'interrupted' ? 'red' : status === 'blocked' || status === 'running' ? 'amber' : 'gray'}>{status === 'running' ? <CircleNotch className="spin" size={12} /> : status === 'ok' ? <CheckCircle size={12} /> : <WarningCircle size={12} />}{labels[status] || status}</Badge>; }
function JsonBox({ value }: { value: unknown }) { return value == null ? <div className="trace-no-data">此步骤未记录该字段</div> : <pre className="trace-json">{JSON.stringify(value, null, 2)}</pre>; }

export function TraceView({ traceId, choose, run, conversation, notify, changed }: { traceId: string | null; choose: (id: string | null) => void; run: (id: string) => void; conversation: (id: string) => void; notify: (message: string) => void; changed: () => Promise<void> }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [category, setCategory] = useState('all');
  const [minimum, setMinimum] = useState('0');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [spanId, setSpanId] = useState<string | null>(null);
  const [tab, setTab] = useState('io');
  const [pending, setPending] = useState(false);
  useEffect(() => { setPage(1); }, [query, status, source, minimum, category]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const endpoint = traceId ? `/api/support/traces/${traceId}` : `/api/support/traces?${new URLSearchParams({ q: query, status, source, category, minMs: minimum, page: String(page) })}`;
      try {
        const response = await fetch(endpoint);
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Trace 读取失败');
        if (active) { if (traceId) setTrace(value); else setListing(value); setError(''); }
      } catch (problem) { if (active) setError(problem instanceof Error ? problem.message : '无法读取 Trace'); }
    };
    const delay = setTimeout(() => void load(), 150);
    const timer = setInterval(() => void load(), 1800);
    return () => { active = false; clearTimeout(delay); clearInterval(timer); };
  }, [traceId, query, status, source, minimum, category, page]);
  useEffect(() => { setSpanId(null); setTrace(null); setError(''); setTab('io'); }, [traceId]);
  const selected = trace?.spans.find(span => span.id === spanId) || trace?.spans.find(span => ['error', 'blocked', 'interrupted'].includes(span.status) && span.parentId) || trace?.spans[0];
  const depths = useMemo(() => {
    const indexed = new Map(trace?.spans.map(span => [span.id, span]) || []);
    return new Map((trace?.spans || []).map(span => {
      let parent = span.parentId;
      let depth = 0;
      const seen = new Set<string>();
      while (parent && indexed.has(parent) && !seen.has(parent)) { depth++; seen.add(parent); parent = indexed.get(parent)!.parentId; }
      return [span.id, depth];
    }));
  }, [trace?.spans]);
  const createAction = async () => {
    if (!trace?.conversationId) return;
    setPending(true);
    try {
      const response = await fetch('/api/support/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '客服执行问题排查', messageId: trace.conversationId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await changed();
      notify(`已关联优化任务 ${result.id}，可从问题追溯到本次执行。`);
    } catch (problem) { notify(problem instanceof Error ? problem.message : '创建失败'); }
    finally { setPending(false); }
  };
  return <>
    <div className="page-head"><div><span className="eyebrow">AGENT OBSERVABILITY</span><h1>{traceId ? '执行详情与问题定位' : 'Agent 执行追踪'}</h1><p>查看已埋点操作的调用关系、输入输出、耗时和错误；执行成功与业务正确分别观察。</p></div><div className="page-actions"><a className="download-link" href="/api/support/trace-guide" download><DownloadSimple size={15} />Agent 接入说明</a>{traceId && <Button onClick={() => choose(null)}><ArrowLeft size={16} />全部 Trace</Button>}</div></div>
    {error && <div className="notice error" role="alert"><WarningCircle size={18} />{error}。不以缓存数据冒充当前轨迹。</div>}
    {!traceId ? <>
      <div className="notice"><Info size={18} /><span><strong>这里的耗时是什么？</strong> 是一次已埋点执行的起止时间差，1,000 ms = 1秒。包含范围内的模型、工具与等待，不是历史客服会话时长，也不是人工处理时长；父子步骤不能相加。先选业务分类，再比较同类耗时。</span></div>
      <nav className="trace-category-tabs" aria-label="Trace业务分类"><button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部业务<b>{listing?.matchedTotal || 0}</b></button>{listing?.categories.map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)} disabled={!item.count && category !== item.id}>{item.name}<b>{item.count}</b></button>)}</nav>
      <div className="metrics-grid trace-metrics">{[{ title: '当前筛选执行', value: listing?.stats.total || 0, icon: GitBranch }, { title: '执行异常 / 中断', value: listing?.stats.errors || 0, icon: WarningCircle }, { title: '输入被拦截', value: listing?.stats.blocked || 0, icon: ShieldCheck }, { title: '质量待关注', value: listing?.stats.quality || 0, icon: Bug }].map(item => <Panel key={item.title} className="metric-card"><div className="metric-label">{item.title}<item.icon size={18} /></div><div className="metric-value">{item.value}<span>条</span></div><div className="metric-note">{item.title === '质量待关注' ? '知识未命中 / 测试错误 / 负反馈' : '随业务分类及筛选条件更新'}</div></Panel>)}</div>
      <Panel><div className="trace-filters"><SearchInput value={query} onChange={setQuery} placeholder="搜索问题 / Trace / 会话 / 实验编号" /><select className="select" aria-label="Trace 状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="quality">有质量问题</option>{Object.entries(labels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><select className="select" aria-label="Trace 来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option>{listing?.sources.map(value => <option key={value} value={value}>{sourceNames[value] || value}</option>)}</select><select className="select" aria-label="Trace 耗时筛选" value={minimum} onChange={event => setMinimum(event.target.value)}><option value="0">全部耗时</option><option value="100">≥ 100 ms</option><option value="1000">≥ 1 s</option><option value="5000">≥ 5 s</option></select></div>
      {listing?.traces.length ? <div className="table-wrap"><table className="trace-table"><thead><tr><th>执行 / 输入摘要</th><th>状态</th><th>本次执行耗时</th><th>步骤</th><th>来源</th><th>开始时间</th><th /></tr></thead><tbody>{listing.traces.map(item => <tr key={item.id}><td><button className="trace-cell" onClick={() => choose(item.id)}><strong>{item.name}</strong><Badge tone="blue">{item.categoryName}</Badge><p>{item.batchId ? `批次 ${item.batchId}` : item.preview}</p><code>{item.id.slice(0, 16)}…</code></button></td><td><TraceStatus status={item.status} />{item.hasQualityIssue && <small className="trace-quality">质量待关注</small>}</td><td className="trace-duration" title={item.durationScope}>{elapsed(item.durationMs)}</td><td>{item.spanCount}</td><td><span className="trace-source-label">{item.sourceName || sourceNames[item.source] || item.source}</span><small>{item.origin === 'local_instrumented' ? '本机埋点' : '外部 Agent 自报'}</small></td><td className="trace-date"><DateText value={item.startedAt} /></td><td><button className="icon-button" aria-label={`查看 Trace ${item.id}`} onClick={() => choose(item.id)}><ArrowSquareOut size={17} /></button></td></tr>)}</tbody></table></div> : <Empty title={listing ? '没有符合条件的执行记录' : '正在读取执行轨迹'} description="在客服试用台发送问题或运行评测，即可自动产生真实轨迹。历史无埋点记录不会被伪造补齐。" />}
      <div className="pagination"><span>共 {listing?.total || 0} 条 · 第 {listing?.page || page} 页</span><div><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button disabled={!listing || page * listing.pageSize >= listing.total} onClick={() => setPage(page + 1)}>下一页</Button></div></div></Panel>
      <div className="notice"><Info size={18} /><span>客服会话、公开数据评测与中文回归均自动埋点。其他 Python Agent 可用交付的 SDK 上报，但会标记为“外部自报”，不会冒充本机观测；不存模型隐藏思维链。</span></div>
    </> : trace?.id === traceId && !error ? <>
      <div className="trace-detail-toolbar"><TraceStatus status={trace.status} /><code>{trace.id}</code><span><Timer size={14} />{elapsed(trace.durationMs)}</span><Badge>{trace.origin === 'local_instrumented' ? '本机实际埋点' : '外部 Agent 自报'}</Badge><a className="download-link" href={`/api/support/traces/${trace.id}/export.json`} download><DownloadSimple size={15} />导出脱敏 JSON</a></div>
      <div className="notice"><Info size={18} /><span><strong>{trace.categoryName} · {trace.sourceName}</strong><br />{trace.durationScope}{trace.batchId && ` 批次：${trace.batchId}`}</span></div><div className="trace-links">{trace.sessionId && <span>会话 <code>{trace.sessionId}</code></span>}{trace.runId && <button onClick={() => run(trace.runId!)}>查看关联评测 <ArrowSquareOut size={13} /></button>}{trace.conversationId && <><button onClick={() => conversation(trace.sessionId!)}>查看完整对话 <ArrowSquareOut size={13} /></button><button onClick={() => void createAction()} disabled={pending}><Plus size={13} />建立排查任务</button></>}</div>
      {trace.issues.length > 0 && <div className="trace-issues">{trace.issues.map((issue, index) => <button key={`${issue.code}-${index}`} onClick={() => { setSpanId(issue.spanId); setTab('io'); }}><WarningCircle size={16} /><span><strong>{issue.kind === 'quality' ? '质量信号' : issue.kind === 'safety' ? '安全边界' : '执行状态'}</strong>{issue.message}</span><ArrowRight size={15} /></button>)}</div>}
      <div className="trace-workspace"><Panel className="trace-waterfall"><PanelHead title="执行树与时间轴" description="子步骤缩进展示调用关系；耗时包括子步骤，不能相加计算总耗时。" /><div className="waterfall-scale"><span>步骤</span><div><span>0 ms</span><span>{elapsed(trace.durationMs)}</span></div><span>耗时</span></div><div className="span-list">{trace.spans.map(item => <button key={item.id} className={`span-row ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => { setSpanId(item.id); setTab(item.error ? 'error' : 'io'); }}><span className="span-title" style={{ paddingLeft: Math.min(depths.get(item.id) || 0, 5) * 14 }}><i className={`span-dot ${item.status}`} /><span>{item.name}<small>{kinds[item.kind] || item.kind}</small></span></span><span className="span-track"><i className={item.status} style={{ marginLeft: `${Math.min(99, item.startMs / Math.max(1, trace.durationMs || 1) * 100)}%`, width: `${Math.max(.6, Math.min(100, (item.durationMs || 0) / Math.max(1, trace.durationMs || 1) * 100))}%` }} /></span><span className="span-time">{elapsed(item.durationMs)}</span></button>)}</div></Panel>
      <Panel className="span-inspector">{selected && <><div className="span-inspector-head"><Badge>{kinds[selected.kind] || selected.kind}</Badge><TraceStatus status={selected.status} /><h2>{selected.name}</h2><div><span>起点 +{selected.startMs.toFixed(2)} ms</span><span>耗时 {elapsed(selected.durationMs)}</span></div><code>{selected.id}</code></div><div className="span-tabs">{[['io', '输入 / 输出'], ['attributes', '执行属性'], ['events', `事件 ${selected.events?.length || 0}`], ...(selected.error ? [['error', '异常定位']] : [])].map(([value, title]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{title}</button>)}</div><div className="span-payload">{tab === 'io' && <><h3>输入 · 记录前脱敏</h3><JsonBox value={selected.input} /><h3>输出 · 实际返回</h3><JsonBox value={selected.output} /></>}{tab === 'attributes' && <><h3>模型 / 工具 / 版本属性</h3><JsonBox value={selected.attributes} /><h3>父步骤</h3>{selected.parentId ? <button className="text-link" onClick={() => setSpanId(selected.parentId)}>{selected.parentId}<ArrowRight size={13} /></button> : <p className="trace-no-data">当前为根执行</p>}</>}{tab === 'events' && <JsonBox value={selected.events?.length ? selected.events : null} />}{tab === 'error' && <><div className="notice error"><WarningCircle size={18} /><span>{selected.error?.type} · {selected.error?.message}</span></div><h3>代码定位 · 不包含局部变量</h3>{selected.error?.frames?.map((frame, index) => <div className="trace-error-frame" key={index}><code>{frame.file}:{frame.line}</code><span>{frame.function}</span></div>)}{!selected.error?.frames?.length && <p className="trace-no-data">上报方未提供代码定位，未编造堆栈。</p>}</>}</div></>}</Panel></div>
      <div className="trace-bottom-grid"><Panel><PanelHead title="整条执行的输入与最终输出" /><div className="span-payload"><h3>输入</h3><JsonBox value={trace.input} /><h3>最终输出</h3><JsonBox value={trace.output} /></div></Panel><Panel><PanelHead title="关联事件与版本证据" /><div className="span-payload"><h3>运行属性</h3><JsonBox value={trace.attributes} /><h3>用户反馈与优化任务</h3>{trace.annotations.length ? trace.annotations.map((annotation, index) => <div className="trace-annotation" key={index}><strong>{annotation.name}</strong><small><DateText value={annotation.at} /></small><JsonBox value={annotation.attributes} /></div>) : <p className="trace-no-data">尚无后续反馈或任务关联。</p>}</div></Panel></div>
      <div className="notice"><ShieldCheck size={18} /><span>{trace.redaction}。Trace 中的“转人工”是决策建议，只有实际调用才会生成工具步骤；这里没有虚构订单、退款或坐席执行。</span></div>
    </> : !error && <Empty title="正在读取完整执行轨迹" description="从本机数据库读取已保存的步骤与证据。" />}
  </>;
}
