import { useEffect, useState } from 'react';
import { ArrowClockwise, ArrowRight, Headset, Plus, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, PageHead, Panel, PanelHead, SearchInput } from './ui';
import { ConnectionModal } from './ModelConnection';
import type { Connection } from './ModelConnection';
import type { Corpus } from './CorpusLabels';
import type { LabState } from './AgentLab';
import { externalVersions, modelOpsLink, projectOfRun, reviewFlags, runStatistics } from './modelopsData';
import type { OpsRun } from './modelopsData';
import './modelops.css';

type Snapshot = { key: string; state: LabState; project: string; runs: OpsRun[]; run: OpsRun | null; problem: string; at: string };
const readRoute = () => new URLSearchParams(location.hash.split('?')[1] || '');
const ratio = (count: number, total: number) => total ? `${(100 * count / total).toFixed(1)}%` : '未测';
const statusNames: Record<string, string> = { running: '运行中', cancelling: '取消中', cancelled: '已取消', interrupted: '已中断', failed: '运行失败', completed: '执行结束' };

async function read<Value>(path: string, signal: AbortSignal): Promise<Value> {
  const response = await fetch(`/api/support/lab/${path}`, { signal });
  if (!response.ok) throw new Error('记录读取失败，请刷新重试。');
  return response.json();
}

export function ModelOps({ corpora }: { corpora: Corpus[] }) {
  const [route, setRoute] = useState(readRoute);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [lookup, setLookup] = useState('');
  const requestedProject = route.get('project') || '';
  const requestedRun = route.get('run') || '';
  const projectIds = corpora.map(corpus => corpus.id).join('|');
  const key = `${requestedProject}:${requestedRun}:${projectIds}`;
  const current = snapshot?.key === key ? snapshot : null;

  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError('');
    const load = async () => {
      try {
        const state = await read<LabState>('state', controller.signal);
        let project = requestedProject || corpora[0]?.id || '';
        let run: OpsRun | null = null;
        let problem = '';
        if (requestedRun) {
          try {
            run = await read<OpsRun>(`runs/${encodeURIComponent(requestedRun)}`, controller.signal);
            if (run.id !== requestedRun || !Array.isArray(run.results) || !Array.isArray(run.caseIds)) throw new Error('批次内容不完整');
            if (!requestedProject) project = projectOfRun(run, state);
          } catch { problem = '指定批次不存在或暂时无法读取，未替换成其他批次。'; run = null; }
        }
        const knownProject = corpora.some(corpus => corpus.id === project);
        if (project && !knownProject) problem = '当前项目不存在，请重新选择项目。';
        if (run && projectOfRun(run, state) !== project) problem = '该批次不属于当前项目，未混入其他项目的成绩。';
        if (run && !externalVersions(run, state).length) problem = '这是本地基线批次，本页只统计外部模型实测。请在运行评测中查看本地结果。';
        if (problem) run = null;
        const runs = knownProject ? state.runs.filter(item => projectOfRun(item, state) === project && externalVersions(item, state).length) : [];
        if (!requestedRun && !problem && runs[0]) {
          try {
            run = await read<OpsRun>(`runs/${encodeURIComponent(runs[0].id)}`, controller.signal);
            if (run.id !== runs[0].id || projectOfRun(run, state) !== project || !externalVersions(run, state).length || !Array.isArray(run.results) || !Array.isArray(run.caseIds)) throw new Error('批次范围或内容不一致');
          } catch { problem = '本批详情暂时无法读取，未展示旧成绩。'; run = null; }
        }
        if (controller.signal.aborted) return;
        setSnapshot({ key, state, project, runs, run, problem, at: new Date().toISOString() });
        setError('');
      } catch {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setError('无法读取模型与评测记录，已隐藏旧数据。请检查本地服务后刷新。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 8000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, refresh]);

  const project = current?.project || requestedProject;
  const link = (page: string, extra: Record<string, string> = {}) => modelOpsLink(page, project, extra);
  const run = current?.run;
  const options = [...(current?.runs || [])];
  if (run && !options.some(item => item.id === run.id)) options.unshift(run);
  const manage = (value: Connection | null) => { setConnection(value); setConnectionOpen(true); };
  const available = current?.state.connections.filter(value => value.configured && value.tested).length || 0;

  return <div className="modelops">
    <PageHead eyebrow="AFTER-SALES / MODEL OPERATIONS" title="售后客服模型运营" description="模型能否调用、答复是否可靠、问题出在哪里，在这里逐批核对。" actions={<><Button onClick={() => setRefresh(value => value + 1)}><ArrowClockwise size={16} />刷新记录</Button><Button primary disabled={!project || !corpora.some(corpus => corpus.id === project)} onClick={() => { location.hash = link('compare', { mode: 'text', panel: 'setup' }); }}>新建客服评测 <ArrowRight size={16} /></Button></>} />
    <div className="ops-boundary"><Headset size={22} /><div><strong>围绕售后对话，管理真实模型评测</strong><p>读取已保存的模型答复与 Trace，不自动发起付费调用。当前是离线评测工作台，尚未接管线上客服，也未连接真实派单、转人工或维修系统。</p></div><Badge tone="blue">售后客服</Badge></div>
    {error && <div className="ops-alert" role="alert"><WarningCircle size={18} />{error}</div>}
    {!current ? <Empty title={error ? '记录暂不可用' : '正在读取售后评测记录'} description="仅读取当前服务中保存的连接状态和实际执行记录。" /> : <>
      <div className="ops-selection">
        <label>业务项目<select aria-label="运营项目" value={project} onChange={event => { location.hash = modelOpsLink('modelops', event.target.value); }}>
          {!corpora.some(corpus => corpus.id === project) && <option value={project}>{project ? '项目不可用，请重新选择' : '尚未导入项目'}</option>}
          {corpora.map(corpus => <option key={corpus.id} value={corpus.id}>{corpus.name}</option>)}
        </select></label>
        <span>记录更新于 <DateText value={current.at} /> · 每 8 秒刷新，不调用模型</span>
      </div>
      <Panel className="ops-connections"><PanelHead title="模型连接" description={`工作区共用连接 · ${available} 个已配置且通过文字测试。测试状态不等于持续在线保障。`} action={<Button onClick={() => manage(null)}><Plus size={15} />添加模型</Button>} />
        {current.state.connections.length ? <div className="ops-connection-list">{current.state.connections.map(value => <div className="ops-connection" key={value.id}><div><strong>{value.name}</strong><small>{value.provider} · {value.model}</small></div><Badge tone={!value.configured ? 'gray' : value.tested ? 'green' : 'amber'}>{!value.configured ? '需重新输入 Key' : value.tested ? '已通过文字测试' : '待测试'}</Badge><Button quiet onClick={() => manage(value)}>管理连接</Button></div>)}</div> : <Empty title="还没有模型连接" description="在专用窗口输入 API Key，完成测试后再运行客服案例。不用本地模板冒充模型答复。" />}
      </Panel>
      {project && corpora.some(corpus => corpus.id === project) && <>
        <Panel className="ops-batch"><PanelHead title="客服评测记录" description="按实际批次查看；统计只含本批外部候选模型，不含本地基线和连接测试。" />
          <div className="ops-selection"><label>评测批次<select aria-label="运营评测批次" value={run?.id || ''} onChange={event => { location.hash = link('modelops', { run: event.target.value }); }}>
            {!run && <option value="">{current.problem ? '请重新选择批次' : '暂无外部模型评测'}</option>}
            {options.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })} · {item.id} · {statusNames[item.status] || item.status}</option>)}
          </select></label>{run && <Badge tone={run.status === 'running' ? 'blue' : 'gray'}>{statusNames[run.status] || run.status}</Badge>}</div>
          <p className="ops-caption">列表从全工作区最近 30 个文本批次中筛选当前项目，不是全部历史统计；更早记录可按批次编号查找。</p>
          <details className="ops-run-lookup"><summary>查找更早批次</summary><form onSubmit={event => { event.preventDefault(); if (/^EVAL-[A-Za-z0-9-]+$/.test(lookup.trim())) location.hash = link('modelops', { run: lookup.trim() }); }}><label>批次编号<input aria-label="历史批次编号" placeholder="EVAL-…" value={lookup} onChange={event => setLookup(event.target.value)} /></label><Button type="submit" disabled={!/^EVAL-[A-Za-z0-9-]+$/.test(lookup.trim())}>查找记录</Button></form></details>
          {current.problem ? <div className="ops-alert" role="alert">{current.problem}</div> : !run ? <Empty title="当前项目还没有外部模型评测记录" description="选择已连接模型，用同一批售后案例测试。历史本地分类器成绩不会混入这里。" action={<a className="text-link" href={link('compare', { mode: 'text', panel: 'setup' })}>选择模型和客服案例 <ArrowRight size={14} /></a>} /> : null}
        </Panel>
        {run && <RunEvidence key={run.id} run={run} state={current.state} project={project} />}
        <Panel><PanelHead title="业务效果与问题归因" description="运行成功不等于客户问题解决。业务指标与模型调用指标分开看。" /><div className="ops-destinations">
          <a href={link('overview', { tab: 'business' })}><strong>转人工拦截与填单</strong><span>核对真实业务结果与统计分母</span><ArrowRight size={18} /></a>
          <a href={link('overview', { tab: 'quality' })}><strong>质检复核</strong><span>查看分数来源、复核记录与证据</span><ArrowRight size={18} /></a>
          <a href={link('overview', { tab: 'rca' })}><strong>DSAT 与投诉归因</strong><span>区分真实低分评价和投诉线索</span><ArrowRight size={18} /></a>
        </div></Panel>
      </>}
      {!corpora.length && <Empty title="先导入一个售后项目" description="没有客户项目时不填充构造记录，也不显示假的业务效果。" action={<a className="text-link" href="#datasets">打开项目集</a>} />}
    </>}
    <ConnectionModal open={connectionOpen} connection={connection} close={() => { setConnectionOpen(false); setConnection(null); }} changed={async () => { setRefresh(value => value + 1); }} />
  </div>;
}

function RunEvidence({ run, state, project }: { run: OpsRun; state: LabState; project: string }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const stats = runStatistics(run, state);
  const { rows, versions } = stats;
  const filters = [
    { id: 'all', name: '全部记录', accepts: () => true },
    { id: 'failed', name: '执行失败', accepts: (row: typeof rows[number]) => row.status === 'failed' },
    { id: 'judge', name: '裁判异常', accepts: (row: typeof rows[number]) => !!row.judgeError },
    { id: 'review', name: '需核对答复', accepts: (row: typeof rows[number]) => reviewFlags(row).length > 0 },
  ];
  const matching = rows.filter(row => (filters.find(item => item.id === filter) || filters[0]).accepts(row) && `${row.sessionId} ${row.output?.answer || ''} ${versions.find(version => version.id === row.versionId)?.name || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedPage = Math.min(page, Math.max(0, Math.ceil(matching.length / 20) - 1));
  const link = (target: string, extra: Record<string, string> = {}) => modelOpsLink(target, project, { run: run.id, ...extra });
  const selfJudge = !!run.judgeId && versions.some(version => version.connectionId === run.judgeId || (run.judgeConnection && version.provider === run.judgeConnection.provider && version.model === run.judgeConnection.judgeModel));
  const modelName = (id: string) => versions.find(version => version.id === id)?.name || id;

  return <>
    <div className="ops-metrics">
      <Panel><span>返回有效答复</span><strong>{stats.completed}<em> / {stats.planned}</em></strong><small>按案例 × 模型计数 · 不代表已解决</small></Panel>
      <Panel><span>执行失败</span><strong>{stats.failed}</strong><small>{stats.remaining} 次{['running', 'cancelling'].includes(run.status) ? '尚待执行' : '未执行'} · 失败原因见 Trace</small></Panel>
      <Panel><span>模型裁判覆盖</span><strong>{ratio(stats.reviewed, stats.completed)}</strong><small>{stats.reviewed} / {stats.completed} 份有效答复有点评 · 非人工复核率</small></Panel>
      <Panel><span>答复复核提示</span><strong>{stats.flagged}</strong><small>低分、证据不足或参考标签不一致 · 非已确认问题</small></Panel>
    </div>
    <Panel><PanelHead title="本批模型表现" description={`${run.caseIds?.length || 0} 个历史案例 · ${versions.length} 个外部候选版本 · 同一历史前缀的下一轮回复`} action={<a className="text-link" href={link('compare', { mode: 'text', panel: 'results' })}>查看回复对比 <ArrowRight size={14} /></a>} />
      <div className="ops-table"><table><thead><tr><th>客服模型</th><th>执行成功率</th><th>失败 / 未执行</th><th>候选耗时 P95</th><th>已报告 Tokens</th></tr></thead><tbody>{versions.map(version => {
        const metrics = run.metrics?.[version.id];
        const subset = rows.filter(row => row.versionId === version.id);
        const completed = subset.filter(row => row.status === 'completed').length;
        const failed = subset.filter(row => row.status === 'failed').length;
        return <tr key={version.id}><td><strong>{version.name}</strong><small>{version.provider} · {version.model}</small></td><td><strong>{ratio(completed, completed + failed)}</strong><small>{completed} / {completed + failed} 次已执行</small></td><td>{failed} / {Math.max(0, (run.caseIds?.length || 0) - subset.length)}</td><td>{metrics?.p95Ms == null ? '未测' : `${(metrics.p95Ms / 1000).toFixed(2)} 秒`}<small>{completed} 个成功样本</small></td><td>{metrics?.tokenReports ? metrics.providerTokens.toLocaleString('zh-CN') : '未报告'}<small>{metrics?.tokenReports ? `${metrics.tokenReports} / ${subset.length} 份记录有用量回报` : '不将缺失用量记成零成本'}</small></td></tr>;
      })}</tbody></table></div>
      <p className="ops-footnote">耗时包含候选推理与本机处理，不含裁判，也不是首字延迟；Tokens 含候选与裁判已报告用量，不含连接测试，不等于费用。小样本不用于证明模型更优。</p>
      {selfJudge && <p className="ops-footnote ops-caution">本批裁判与候选共用连接或同一模型，可能存在自评偏差；高分不等于可上线，重要案例仍需人工复核。</p>}
    </Panel>
    <Panel><PanelHead title="逐条核对与执行追踪" description="筛选只帮助定位，不自动宣判原因；参考行为来自历史回复推导，不是真实操作金标。" />
      <div className="ops-evidence-toolbar"><div className="ops-filters" role="group" aria-label="运营记录分类">{filters.map(item => <button key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setPage(0); }}>{item.name}<span>{rows.filter(item.accepts).length}</span></button>)}</div><SearchInput value={query} onChange={value => { setQuery(value); setPage(0); }} placeholder="搜索模型、会话编号或答复" /></div>
      {!matching.length ? <Empty title="没有符合当前筛选的执行记录" description={stats.remaining ? '尚未执行的部分没有答复记录；不补造结果。' : '可以切回全部记录核对，不表示全部答复已通过人工验收。'} /> : <div className="ops-evidence-list">{matching.slice(selectedPage * 20, selectedPage * 20 + 20).map(row => <article key={`${row.caseId}:${row.versionId}`} className="ops-evidence">
        <header><strong>{modelName(row.versionId)}</strong><Badge tone={row.status === 'completed' ? 'blue' : 'red'}>{row.status === 'completed' ? '已返回答复' : '执行失败'}</Badge><small>{row.sessionId}</small></header>
        <p className="ops-answer-preview">{row.output?.answer || row.error || '未记录答复'}</p>
        <div className="ops-row">{reviewFlags(row).map(flag => <Badge key={flag} tone="amber">{flag}</Badge>)}{row.judgeError && <Badge tone="red">裁判未完成</Badge>}</div>
        <details><summary>展开本次答复与评审依据</summary><p className="ops-full-answer">{row.output?.answer || row.error || '未记录答复'}</p><p>模型选择：{state.intents[row.output?.intent || ''] || row.output?.intent || '未记录'} · {state.actions[row.output?.action || ''] || row.output?.action || '未记录'}</p>{row.sandbox && <p>本机沙箱：{row.sandbox.result}。不是生产业务执行凭据。</p>}{row.judgment ? <><p>模型裁判：{row.judgment.reason}</p><p>{Object.entries(row.judgment.dimensions).map(([field, value]) => `${({ relevance: '诉求相关性', next_step: '下一步可行性', boundary: '权限与证据边界' } as Record<string, string>)[field] || field}：${value == null ? '证据不足' : `${value}/4`}`).join('；')}</p></> : <p>{row.judgeError || '本条没有裁判点评；不能默认通过。'}</p>}</details>
        <footer><a className="text-link" href={link('knowledge', { session: row.sessionId })}>完整客户对话 <ArrowRight size={13} /></a>{row.traceId ? <a className="text-link" href={link('traces', { trace: row.traceId })}>查看本次 Trace <ArrowRight size={13} /></a> : <span>未记录 Trace</span>}</footer>
      </article>)}</div>}
      {matching.length > 20 && <div className="ops-pagination"><Button disabled={selectedPage === 0} onClick={() => setPage(selectedPage - 1)}>上一页</Button><span>{selectedPage + 1} / {Math.ceil(matching.length / 20)} 页 · {matching.length} 条</span><Button disabled={(selectedPage + 1) * 20 >= matching.length} onClick={() => setPage(selectedPage + 1)}>下一页</Button></div>}
    </Panel>
  </>;
}
