import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CaretLeft, CaretRight, ChatsCircle, CheckCircle, CircleNotch, Code, FileText, FolderOpen, Info, ShieldCheck, SquaresFour, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, Empty, Modal, Panel, SearchInput, number } from './ui';
import { intentNames } from './CorpusLabels';
import type { Corpus, LabelSummary } from './CorpusLabels';
import type { Dataset } from './supportTypes';
import './dataset-projects.css';

type ProjectTab = 'cases' | 'overview' | 'api';
type ProjectLocation = { project: string; tab: ProjectTab; query: string; status: string; intent: string; page: number };
type CaseRow = { id: string; title: string; datasetId: string; messageCount: number; customerTurns: number; labelSummary?: LabelSummary; archives: { id: string; version: number }[] };
type CaseListing = { sessions: CaseRow[]; total: number; page: number; pageSize: number };
const statuses = [['all', '全部案例'], ['gap', '知识缺口'], ['invalid', '标注无效'], ['label_conflict', '标注分歧'], ['archived', '已存档']];

function readLocation(): ProjectLocation {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const tab = params.get('tab');
  const page = Number(params.get('page'));
  const status = params.get('status') || 'all';
  return { project: params.get('project') || '', tab: tab === 'overview' || tab === 'api' ? tab : 'cases', query: params.get('q') || '', status: statuses.some(([value]) => value === status) ? status : 'all', intent: params.get('intent') || '', page: Number.isInteger(page) && page > 0 ? page : 1 };
}

function projectUrl(project: string, options: Partial<ProjectLocation> = {}) {
  const params = new URLSearchParams({ project });
  if (options.tab && options.tab !== 'cases') params.set('tab', options.tab);
  if (options.query) params.set('q', options.query);
  if (options.status && options.status !== 'all') params.set('status', options.status);
  if (options.intent) params.set('intent', options.intent);
  if (options.page && options.page > 1) params.set('page', String(options.page));
  return `#datasets?${params}`;
}

function conversationUrl(project: string, identifier?: string, context: Partial<ProjectLocation> = {}) {
  const params = new URLSearchParams({ dataset: project, project });
  if (identifier) params.set('session', identifier);
  params.set('returnTo', projectUrl(project, context));
  return `#knowledge?${params}`;
}

function importedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '导入时间未记录' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function DatasetProjects({ corpora, references, preview }: { corpora: Corpus[]; references: Dataset[]; preview: (dataset: Dataset) => void }) {
  const [route, setRoute] = useState(readLocation);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [referenceOpen, setReferenceOpen] = useState(false);
  useEffect(() => {
    const update = () => setRoute(readLocation());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [route.project, route.tab, route.page]);
  const project = corpora.find(corpus => corpus.id === route.project);
  if (route.project) return project
    ? <ProjectDetail key={project.id} project={project} route={route} />
    : <div className="dataset-projects"><a className="project-back" href="#datasets"><ArrowLeft size={16} />返回项目集</a><Empty title="未找到这个项目" description="项目链接可能已失效。返回项目集，选择已导入的真实数据。" action={<a className="project-primary-link" href="#datasets">返回项目集</a>} /></div>;
  const filtered = corpora.filter(corpus => `${corpus.name} ${corpus.id} ${corpus.nature}`.toLowerCase().includes(query.trim().toLowerCase())).sort((left, right) => sort === 'cases' ? right.totals.sessions - left.totals.sessions : sort === 'name' ? left.name.localeCompare(right.name, 'zh-CN') : right.importedAt.localeCompare(left.importedAt));
  return <div className="dataset-projects">
    <div className="page-head project-page-head"><div><h1>项目集</h1><p>按项目管理案例与对话，选择一个项目开始评测。</p></div><span className="project-local-state"><ShieldCheck size={16} />本地数据工作区</span></div>
    <div className="project-guide-entry"><div><strong>第一次使用？先看对话，再跑 10 个案例。</strong><p>已有本地版本可用，不需要密钥或重新训练。</p></div><a className="text-link" href="#guide">跟着步骤体验<ArrowRight size={15} /></a></div>
    <div className="project-toolbar"><div className="project-view-label"><SquaresFour size={18} weight="fill" /><strong>全部项目</strong><span>{corpora.length}</span></div><div className="project-toolbar-controls"><SearchInput value={query} onChange={setQuery} placeholder="搜索项目名称或编号" /><select className="select" aria-label="项目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">最近导入</option><option value="cases">案例数量</option><option value="name">项目名称</option></select></div></div>
    <div className="project-list-caption"><span>{query.trim() ? `找到 ${filtered.length} 个项目` : `${corpora.length} 个真实数据项目`}</span><span>共 {number(corpora.reduce((total, corpus) => total + corpus.totals.sessions, 0))} 个案例 · 不含公开演示集</span></div>
    {filtered.length ? <ul className="project-grid" aria-label="项目列表">{filtered.map(corpus => <li key={corpus.id}><article className="project-card">
      <div className="project-card-top"><span className="project-symbol"><FolderOpen size={23} /></span><Badge tone={corpus.scanStatus === 'passed' ? 'green' : 'amber'}>{corpus.scanStatus === 'passed' ? '已导入 · 已脱敏' : '需检查数据状态'}</Badge></div>
      <h2><a href={projectUrl(corpus.id)}>{corpus.name}</a></h2><p className="project-card-description">{corpus.nature || '完整对话与原始业务标注，按项目查看和管理。'}</p>
      <dl className="project-card-counts"><div><dt>对话案例</dt><dd>{number(corpus.totals.sessions)}</dd></div><div><dt>消息总量</dt><dd>{number(corpus.totals.messages)}</dd></div></dl>
      <div className="project-card-labels"><span><FileText size={13} />真实业务数据</span><a href={projectUrl(corpus.id, { status: 'gap' })}>知识缺口 {number(corpus.totals.gapSessions)} <ArrowRight size={12} /></a></div>
      <footer className="project-card-footer"><time dateTime={corpus.importedAt}>{importedDate(corpus.importedAt)} 导入</time><a className="project-open" href={projectUrl(corpus.id)} aria-label={`进入项目：${corpus.name}`}>进入项目<ArrowRight size={15} /></a></footer>
    </article></li>)}</ul> : <Empty title={query ? '没有匹配的项目' : '还没有导入真实数据项目'} description={query ? '试试项目名称中的关键词，或清空搜索。' : '完成真实业务对话的脱敏与导入后，项目会显示在这里。不会用演示数据代替。'} action={query ? <Button onClick={() => setQuery('')}>清空搜索</Button> : undefined} />}
    <div className="project-library-note"><Info size={15} /><p>卡片数量对应实际导入项目，不按意图或文件重复拆分。同一案例的完整消息保留在项目内。</p></div>
    {references.length > 0 && <details className="lab-disclosure"><summary>公开方法参考（不计入项目评测）</summary><button className="text-link" onClick={() => setReferenceOpen(true)}>查看参考资料（{references.length}）<ArrowRight size={13} /></button></details>}
    <Modal open={referenceOpen} onClose={() => setReferenceOpen(false)} title="公开参考资料" description="与真实业务项目分开管理，不用于冒充业务案例，也不纳入本页项目数量。"><div className="project-reference-list">{references.map(dataset => <section key={dataset.id}><div><h3>{dataset.name}</h3><Badge>{dataset.nature}</Badge></div><p>{dataset.provider} · {dataset.language} · {number(dataset.count)} 条</p><p>{dataset.id === 'bitext' ? '发布方标注为混合合成数据，不是真实生产客户对话。' : '公开英文意图分类集，仅供评测方法参考。'}</p><Button onClick={() => { setReferenceOpen(false); preview(dataset); }}>浏览参考样本</Button></section>)}</div></Modal>
  </div>;
}

function ProjectDetail({ project, route }: { project: Corpus; route: ProjectLocation }) {
  const navigate = (next: Partial<ProjectLocation>) => { location.hash = projectUrl(project.id, { ...route, ...next }); };
  return <div className="dataset-projects project-detail">
    <a className="project-back" href="#datasets"><ArrowLeft size={16} />返回项目集</a>
    <div className="page-head project-detail-head"><div className="project-detail-title"><span className="project-symbol"><FolderOpen size={25} /></span><div><h1>{project.name}</h1><p>{project.nature}</p></div></div><a className="project-primary-link" href={`#benchmark?project=${encodeURIComponent(project.id)}`}>去运行评测<ArrowRight size={15} /></a></div>
    <div className="project-detail-meta"><Badge tone={project.scanStatus === 'passed' ? 'green' : 'amber'}>{project.scanStatus === 'passed' ? '已完成自动脱敏复核' : '需复核'}</Badge><span>{number(project.totals.sessions)} 个案例</span><span>{number(project.totals.messages)} 条消息</span><span>{importedDate(project.importedAt)} 导入</span></div>
    <div className="lab-row-actions"><a className="text-link" href={`#overview?project=${encodeURIComponent(project.id)}`}>结果大盘<ArrowRight size={14} /></a><a className="text-link" href={`#overview?tab=quality&project=${encodeURIComponent(project.id)}`}>质检复核<ArrowRight size={14} /></a></div>
    <nav className="project-tabs" aria-label="项目内容">{([['cases', '案例列表', ChatsCircle], ['overview', '项目概况', FolderOpen], ['api', '数据接口', Code]] as const).map(([tab, name, Icon]) => <a key={tab} href={projectUrl(project.id, { ...route, tab })} aria-current={route.tab === tab ? 'page' : undefined}><Icon size={17} />{name}</a>)}</nav>
    {route.tab === 'cases' ? <ProjectCases key={project.id} project={project} route={route} navigate={navigate} /> : route.tab === 'overview' ? <ProjectOverview project={project} navigate={navigate} /> : <ProjectApi project={project} />}
  </div>;
}

function ProjectCases({ project, route, navigate }: { project: Corpus; route: ProjectLocation; navigate: (next: Partial<ProjectLocation>) => void }) {
  const [query, setQuery] = useState(route.query);
  const [listing, setListing] = useState<CaseListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [finishedQuery, setFinishedQuery] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestQuery = new URLSearchParams({ dataset: project.id, q: route.query, status: route.status, intent: route.intent, page: String(route.page) }).toString();
  const pending = loading || finishedQuery !== requestQuery;
  useEffect(() => { setQuery(route.query); }, [route.query]);
  useEffect(() => {
    if (query === route.query) return;
    const timer = setTimeout(() => { location.hash = projectUrl(project.id, { ...readLocation(), query, page: 1 }); }, 250);
    return () => clearTimeout(timer);
  }, [query, route.query, project.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setListing(null);
    fetch(`/api/support/sessions?${requestQuery}`, { signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '案例列表读取失败');
      if (!controller.signal.aborted) setListing(value);
    }).catch(problem => { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : '案例列表读取失败'); }).finally(() => { if (!controller.signal.aborted) { setFinishedQuery(requestQuery); setLoading(false); } });
    return () => controller.abort();
  }, [requestQuery, revision]);
  const pages = Math.max(1, Math.ceil((listing?.total || 0) / (listing?.pageSize || 20)));
  const clear = () => { setQuery(''); navigate({ query: '', status: 'all', intent: '', page: 1 }); };
  return <Panel className="project-cases">
    <div className="project-case-toolbar"><SearchInput value={query} onChange={setQuery} placeholder="搜索案例编号或完整对话内容" /><div><select className="select" aria-label="筛选案例状态" value={route.status} onChange={event => navigate({ status: event.target.value, page: 1 })}>{statuses.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><select className="select" aria-label="筛选客户意图" value={route.intent} onChange={event => navigate({ intent: event.target.value, page: 1 })}><option value="">全部意图</option>{Object.keys(project.intentDistribution).map(intent => <option value={intent} key={intent}>{intentNames[intent] || intent}</option>)}</select></div></div>
    <div className="project-case-caption" data-query={finishedQuery}><span aria-live="polite">{pending ? '正在读取案例…' : error ? '读取未完成' : `当前 ${number(listing?.total || 0)} 个案例 · 每页 ${listing?.pageSize || 20} 个`}</span><span>一行即一段完整对话，不拆成单条问答</span></div>
    {pending ? <div className="project-loading" role="status"><CircleNotch size={20} className="spin" />正在加载真实对话索引</div> : error ? <div className="project-load-error" role="alert"><WarningCircle size={22} /><p>{error}</p><Button onClick={() => setRevision(value => value + 1)}>重新读取</Button></div> : listing?.sessions.length ? <>
      <div className="table-wrap"><table className="project-case-table"><thead><tr><th scope="col">案例 / 完整对话</th><th scope="col">原始意图标注</th><th scope="col">消息数</th><th scope="col">资料状态</th><th scope="col">操作</th></tr></thead><tbody>{listing.sessions.map(item => {
        const values = item.labelSummary?.values || {};
        return <tr key={item.id}><td><a className="project-case-title" href={conversationUrl(project.id, item.id, route)}>{item.title}</a><code>{item.id}</code></td><td><span className="project-case-intents">{values.intent?.map(intent => intentNames[intent] || intent).join(' / ') || '未标注'}</span></td><td><strong>{number(item.messageCount)}</strong><small>客户发言 {item.customerTurns} 条</small></td><td><div className="project-case-badges">{item.archives.length > 0 && <Badge tone="green">已存档</Badge>}{values.is_invalid?.includes('是') && <Badge tone="amber">标注无效</Badge>}{values.kb_expectation?.includes('gap') && <Badge tone="amber">知识缺口</Badge>}{!!item.labelSummary?.conflicts.length && <Badge tone="amber">标注分歧</Badge>}{!item.archives.length && <Badge>待存档</Badge>}</div></td><td><a className="project-case-open" href={conversationUrl(project.id, item.id, route)} aria-label={`查看完整对话 ${item.id}`}>查看对话<ArrowRight size={14} /></a></td></tr>;
      })}</tbody></table></div>
    </> : <Empty title="没有匹配的案例" description="当前筛选范围内没有数据。可以清空条件，或返回第一页。" action={<Button onClick={clear}>清空筛选，返回第一页</Button>} />}
    {!pending && !error && <div className="pagination"><span>第 {route.page} / {pages} 页{route.page > pages ? ' · 当前页超出范围' : ''}</span><div><button className="icon-button" aria-label="上一页案例" disabled={route.page <= 1} onClick={() => navigate({ page: Math.min(pages, route.page - 1) })}><CaretLeft size={17} /></button><button className="icon-button" aria-label="下一页案例" disabled={route.page >= pages} onClick={() => navigate({ page: route.page + 1 })}><CaretRight size={17} /></button></div></div>}
    <div className="project-evidence-note"><ShieldCheck size={15} /><p>这里展示历史数据和人工标注，不是模型评分。完整对话采用左右气泡展示；被隔离的内容保留占位，图片与视频不外链加载。</p></div>
  </Panel>;
}

function ProjectOverview({ project, navigate }: { project: Corpus; navigate: (next: Partial<ProjectLocation>) => void }) {
  return <div className="project-overview-grid"><Panel className="project-overview-section"><h2>数据概况</h2><dl className="project-facts"><div><dt>项目编号</dt><dd><code>{project.id}</code></dd></div><div><dt>真实历史会话</dt><dd>{number(project.totals.sessions)} 个</dd></div><div><dt>完整消息序列</dt><dd>{number(project.totals.messages)} 条</dd></div><div><dt>导入时间</dt><dd><time dateTime={project.importedAt}>{importedDate(project.importedAt)}</time></dd></div><div><dt>模型评审</dt><dd><a href="#models" className="text-link">查看训练版本与裁判连接</a></dd></div></dl><h3>需人工关注的标注</h3><div className="project-quality-links">{([['gap', '知识缺口', project.totals.gapSessions], ['invalid', '无效对话', project.totals.invalidSessions], ['label_conflict', '标注分歧', project.totals.conflictSessions]] as const).map(([status, name, count]) => <button key={status} onClick={() => navigate({ tab: 'cases', status, intent: '', query: '', page: 1 })}><span>{name}</span><strong>{number(count)}</strong><ArrowRight size={15} /></button>)}</div><p className="project-detail-note">这些分类可能重叠，不能直接相加推导可评测案例数。</p></Panel>
    <Panel className="project-overview-section"><h2>原始客户意图</h2><p className="project-detail-note">沿用来源标注，不作为模型预测或通过率。点击可筛选案例。</p><div className="project-intent-list">{Object.entries(project.intentDistribution).sort((left, right) => right[1] - left[1]).map(([intent, count]) => <button key={intent} onClick={() => navigate({ tab: 'cases', intent, status: 'all', query: '', page: 1 })}><span>{intentNames[intent] || intent}</span><strong>{number(count)}</strong><ArrowRight size={14} /></button>)}</div></Panel>
    <Panel className="project-overview-section project-boundaries"><h2><ShieldCheck size={18} />数据与使用边界</h2><ul><li><CheckCircle size={16} /><span>保留客户、智能客服和人工客服的完整消息顺序、原始标注与可追溯资料版本。</span></li><li><Info size={16} /><span>图片 {number(project.totals.imagesWithheld)} 张、视频 {number(project.totals.videosWithheld)} 段未导入。缺失内容不由模型或页面补造。</span></li><li><Info size={16} /><span>自动规则未发现明确敏感项不代表绝对安全。对外展示前仍需复核业务信息、元数据与授权范围。</span></li><li><Info size={16} /><span>导入不等于训练，也不等于已发布答复知识。历史对话没有可补造的 Agent Trace；外部模型仅在单次任务明确确认后调用。</span></li></ul></Panel>
  </div>;
}

function ProjectApi({ project }: { project: Corpus }) {
  const list = `/api/support/sessions?dataset=${encodeURIComponent(project.id)}&page=1`;
  return <Panel className="project-api"><h2><Code size={19} />真实对话读取接口</h2><p>仅提供本机已导入的脱敏记录；此处不是模型调用或重跑接口。</p><section><Badge>GET</Badge><h3>项目案例列表</h3><code>{list}</code><p>返回案例编号、消息数、原始标签和资料版本。固定分页，每页 20 个；可用 q、status、intent 继续筛选。</p><a className="text-link" href={list} target="_blank" rel="noreferrer">查看本机接口返回<ArrowRight size={14} /></a></section><section><Badge>GET</Badge><h3>一段完整对话</h3><code>/api/support/sessions/&#123;案例编号&#125;</code><p>用列表里的 id 获取 messages，保留 role、content、sequence、原始标注、资料版本与来源定位。消息不会按卡片长度截断。</p></section><div className="notice"><ShieldCheck size={18} /><span>接口仅监听本机，尚无多用户鉴权。不要直接暴露到公网，也不要把访问地址当作生产服务。</span></div></Panel>;
}
