import { useEffect, useState } from 'react';
import { ArrowSquareOut, Bug, DownloadSimple, GitBranch, Info, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Panel, SearchInput } from './ui';
import { TraceDetail, TraceStatus } from './TraceDetail';
import { traceElapsed as elapsed, traceLabels as labels } from './tracePresentation';
import type { TraceRecord as Trace } from './tracePresentation';

type Listing = { traces: Trace[]; total: number; page: number; pageSize: number; sources: string[]; matchedTotal: number; categories: { id: string; name: string; count: number }[]; stats: { total: number; errors: number; blocked: number; quality: number } };
const sourceNames: Record<string, string> = { 'support.chat': '客服会话', 'support.evaluation': '公开文本评测', 'support.uat': '中文业务回归', 'experience.learning': '对话字段模型训练', 'aftersales.train': '客服行为模型训练', 'experience.replay': '填单与转人工评测', 'aftersales.replay': '客服行为回合评测', 'aftersales.vision': '图文客服评测', 'quality.review': '人工质检复核保存', 'quality.judge': '模型质检裁判', 'experience.rca.review': 'DSAT归因保存', 'aftersales.chat': '客服模型试聊' };
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
  useEffect(() => { setTrace(null); setError(''); }, [traceId]);
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
    {!traceId && <div className="page-head"><div><span className="eyebrow">AGENT OBSERVABILITY</span><h1>Agent 执行追踪</h1><p>按业务分类查找记录，打开一条即可查看答复、步骤与证据。</p></div><a className="download-link" href="/api/support/trace-guide" download><DownloadSimple size={15} />Agent 接入说明</a></div>}
    {error && <div className="notice error" role="alert"><WarningCircle size={18} />{error}。不以缓存数据冒充当前轨迹。</div>}
    {!traceId ? <>
      <div className="notice"><Info size={18} /><span><strong>这里的耗时是什么？</strong> 是一次已埋点执行的起止时间差，1,000 ms = 1秒。包含范围内的模型、工具与等待，不是历史客服会话时长，也不是人工处理时长；父子步骤不能相加。先选业务分类，再比较同类耗时。</span></div>
      <nav className="trace-category-tabs" aria-label="Trace业务分类"><button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部业务<b>{listing?.matchedTotal || 0}</b></button>{listing?.categories.map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)} disabled={!item.count && category !== item.id}>{item.name}<b>{item.count}</b></button>)}</nav>
      <div className="metrics-grid trace-metrics">{[{ title: '当前筛选执行', value: listing?.stats.total || 0, icon: GitBranch }, { title: '执行异常 / 中断', value: listing?.stats.errors || 0, icon: WarningCircle }, { title: '输入被拦截', value: listing?.stats.blocked || 0, icon: ShieldCheck }, { title: '质量待关注', value: listing?.stats.quality || 0, icon: Bug }].map(item => <Panel key={item.title} className="metric-card"><div className="metric-label">{item.title}<item.icon size={18} /></div><div className="metric-value">{item.value}<span>条</span></div><div className="metric-note">{item.title === '质量待关注' ? '知识未命中 / 测试错误 / 负反馈' : '随业务分类及筛选条件更新'}</div></Panel>)}</div>
      <Panel><div className="trace-filters"><SearchInput value={query} onChange={setQuery} placeholder="搜索问题 / Trace / 会话 / 实验编号" /><select className="select" aria-label="Trace 状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="quality">有质量问题</option>{Object.entries(labels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><select className="select" aria-label="Trace 来源" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部来源</option>{listing?.sources.map(value => <option key={value} value={value}>{sourceNames[value] || value}</option>)}</select><select className="select" aria-label="Trace 耗时筛选" value={minimum} onChange={event => setMinimum(event.target.value)}><option value="0">全部耗时</option><option value="100">≥ 100 ms</option><option value="1000">≥ 1 s</option><option value="5000">≥ 5 s</option></select></div>
      {listing?.traces.length ? <div className="table-wrap"><table className="trace-table"><thead><tr><th>执行 / 输入摘要</th><th>状态</th><th>本次执行耗时</th><th>步骤</th><th>来源</th><th>开始时间</th><th /></tr></thead><tbody>{listing.traces.map(item => <tr key={item.id}><td><button className="trace-cell" onClick={() => choose(item.id)}><strong>{item.name}</strong><Badge tone="blue">{item.categoryName}</Badge><p>{item.batchId ? `批次 ${item.batchId}` : item.preview}</p><code>{item.id.slice(0, 16)}…</code></button></td><td><TraceStatus status={item.status} />{item.hasQualityIssue && <small className="trace-quality">质量待关注</small>}</td><td className="trace-duration" title={item.durationScope}>{elapsed(item.durationMs)}</td><td>{item.spanCount}</td><td><span className="trace-source-label">{item.sourceName || sourceNames[item.source] || item.source}</span><small>{item.origin === 'local_instrumented' ? '本机埋点' : '外部 Agent 自报'}</small></td><td className="trace-date"><DateText value={item.startedAt} /></td><td><button className="icon-button" aria-label={`查看 Trace ${item.id}`} onClick={() => choose(item.id)}><ArrowSquareOut size={17} /></button></td></tr>)}</tbody></table></div> : <Empty title={listing ? '没有符合条件的执行记录' : '正在读取执行轨迹'} description="在客服试用台发送问题或运行评测，即可自动产生真实轨迹。历史无埋点记录不会被伪造补齐。" />}
      <div className="pagination"><span>共 {listing?.total || 0} 条 · 第 {listing?.page || page} 页</span><div><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button disabled={!listing || page * listing.pageSize >= listing.total} onClick={() => setPage(page + 1)}>下一页</Button></div></div></Panel>
      <div className="notice"><Info size={18} /><span>客服会话、公开数据评测与中文回归均自动埋点。其他 Python Agent 可用交付的 SDK 上报，但会标记为“外部自报”，不会冒充本机观测；不存模型隐藏思维链。</span></div>
    </> : trace?.id === traceId && !error ? <TraceDetail key={trace.id} trace={trace} choose={choose} run={run} conversation={conversation} createAction={() => void createAction()} pending={pending} /> : !error && <Empty title="正在读取完整执行轨迹" description="从本机数据库读取已保存的步骤与证据。" />}
  </>;
}
