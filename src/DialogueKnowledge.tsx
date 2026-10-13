import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowSquareOut, BookOpen, CaretDown, Check, CheckCircle, ChatsCircle, Clock, DownloadSimple, FileText, FloppyDisk, CornersOut, Info, MagnifyingGlass, PencilSimple, Plus, ShieldCheck, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Modal, Panel, SearchInput } from './ui';
import './dialogues.css';
import { runFromHash } from './labNavigation';
import { CorpusLabels, intentNames } from './CorpusLabels';
import type { AnnotationSet, LabelSummary, Corpus } from './CorpusLabels';
import { ConversationPlayback } from './ConversationPlayback';
import type { ConversationMessage } from './ConversationPlayback';

type Message = ConversationMessage;
type Signal = { kind: string; title: string; description: string; messageIds: string[] };
type ArchiveInfo = { id: string; title: string; version: number; hash: string; messageCount: number; createdAt: string };
type Session = { datasetId?: string; annotationSets?: AnnotationSet[]; labelSummary?: LabelSummary; provenance?: { file: string; row: number; imagesWithheld: number; videosWithheld: number }; id: string; title: string; origin: string; sourceLabel: string; createdAt: string; updatedAt: string; hash: string; completeness: string; messages: Message[]; archives: ArchiveInfo[]; analysis: { method: string; messageCount: number; customerTurns: number; replyCount: number; humanReplies: number; traceCount: number; openingRequest: string | null; lastReply: string | null; outcome: string; topics: { label: string; messageId: string; intent: string }[]; signals: Signal[]; sources: { id: string; title: string; version: number; messageIds: string[] }[] } };
type SessionRow = Omit<Session, 'messages' | 'analysis' | 'completeness'> & { messageCount: number; customerTurns: number; signalCount: number; preview: string };
type Listing = { corpora: Corpus[]; sessions: SessionRow[]; total: number; page: number; pageSize: number; stats: { sessions: number; messages: number; archived: number; drafts: number } };
type Archive = ArchiveInfo & { sessionId: string; snapshot: Session };
type Draft = { id: string; title: string; question: string; content: string; keywords: string[]; status: string; version: number; sessionId: string; archiveId: string; archiveVersion: number; sourceHash: string; messageIds: string[]; updatedAt: string; knowledgeId: string | null };
type DraftInput = { archive: Archive; evidence: Message[] };
const roleNames: Record<string, string> = { user: '客户', assistant: '智能客服', human: '人工客服', tool: '工具', system: '系统' };

function projectReturnFromHash() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const target = params.get('returnTo');
  const project = params.get('project');
  if (!target?.startsWith('#datasets?') || !project || params.get('dataset') !== project) return null;
  return new URLSearchParams(target.slice('#datasets?'.length)).get('project') === project ? target : null;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/support${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成，请重试');
  return value;
}

export function DialogueKnowledge({ policies, notify, changed, resume }: { policies: ReactNode; notify: (message: string) => void; changed: () => Promise<void>; resume: (sessionId: string) => void }) {
  const hash = new URLSearchParams(location.hash.split('?')[1] || '');
  const [tab, setTab] = useState(hash.get('tab') || 'dialogues');
  const [sessionId, setSessionId] = useState<string | null>(hash.get('session'));
  const [archiveId, setArchiveId] = useState<string | null>(hash.get('archive'));
  const [listing, setListing] = useState<Listing | null>(null);
  const [current, setCurrent] = useState<Session | null>(null);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState(hash.get('q') || '');
  const [status, setStatus] = useState(hash.get('status') || 'all');
  const [dataset, setDataset] = useState(hash.get('dataset') || '');
  const [intent, setIntent] = useState(hash.get('intent') || '');
  const [projectReturn, setProjectReturn] = useState(projectReturnFromHash);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [readingFocus, setReadingFocus] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [draftInput, setDraftInput] = useState<DraftInput | null>(null);
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  const session = archive?.snapshot || current;
  const archiveCurrent = !!current?.archives.some(item => item.hash === current.hash);
  const changedHere = useCallback(async () => { setRevision(value => value + 1); await changed(); }, [changed]);
  useEffect(() => {
    const updateHash = () => {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      setTab(params.get('tab') || 'dialogues');
      setSessionId(params.get('session'));
      setArchiveId(params.get('archive'));
      setDataset(params.get('dataset') || '');
      setStatus(params.get('status') || 'all');
      setIntent(params.get('intent') || '');
      setQuery(params.get('q') || '');
      setProjectReturn(projectReturnFromHash());
    };
    window.addEventListener('hashchange', updateHash);
    return () => window.removeEventListener('hashchange', updateHash);
  }, []);
  const choose = (identifier: string | null, nextArchive: string | null = null, nextTab = 'dialogues') => {
    setSessionId(identifier); setArchiveId(nextArchive); setTab(nextTab);
    const params = new URLSearchParams();
    if (runFromHash()) params.set('run', runFromHash());
    if (identifier) params.set('session', identifier);
    if (nextArchive) params.set('archive', nextArchive);
    if (nextTab !== 'dialogues') params.set('tab', nextTab);
    if (dataset) params.set('dataset', dataset);
    if (status !== 'all') params.set('status', status);
    if (intent) params.set('intent', intent);
    if (query) params.set('q', query);
    if (projectReturn) { params.set('project', dataset); params.set('returnTo', projectReturn); }
    location.hash = `knowledge${params.size ? `?${params}` : ''}`;
  };
  useEffect(() => { setPage(1); }, [query, status, dataset, intent]);
  useEffect(() => {
    if (!sessionId && tab === 'dialogues' && listing?.sessions.length && !query && status === 'all') {
      const identifier = listing.sessions[0].id;
      setSessionId(identifier);
      const params = new URLSearchParams({ session: identifier });
      if (dataset) params.set('dataset', dataset);
      if (intent) params.set('intent', intent);
      if (projectReturn) { params.set('project', dataset); params.set('returnTo', projectReturn); }
      location.hash = `knowledge?${params}`;
    }
  }, [listing?.sessions[0]?.id, sessionId, tab, query, status, dataset, intent]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await request<Listing>(`/sessions?${new URLSearchParams({ q: query, status, dataset, intent, page: String(page) })}`);
        const pendingDrafts = await request<Draft[]>('/knowledge-drafts');
        if (active) { setListing(value); setDrafts(pendingDrafts); setError(''); }
      } catch (problem) { if (active) setError(problem instanceof Error ? problem.message : '会话列表读取失败'); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [query, status, page, revision, dataset, intent]);
  useEffect(() => {
    setCurrent(null); setArchive(null); setSelected([]); setSelectionMode(false); setSearch(''); setFocusMessage(null); setDetailError('');
  }, [sessionId, archiveId]);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const load = async () => {
      try {
        const value = await request<Session>(`/sessions/${sessionId}`);
        const saved = archiveId ? await request<Archive>(`/dialogue-archives/${archiveId}`) : null;
        if (saved && saved.sessionId !== sessionId) throw new Error('该资料版本不属于当前会话');
        if (active) { setCurrent(value); setArchive(saved); setDetailError(''); }
      } catch (problem) { if (active) setDetailError(problem instanceof Error ? problem.message : '完整对话读取失败'); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [sessionId, archiveId, revision]);
  const jump = (identifier: string) => {
    setFocusMessage(identifier);
    document.getElementById(`dialogue-message-${identifier}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const saveArchive = async () => {
    if (!current) return;
    setPending(true);
    try {
      const saved = await request<Archive>(`/sessions/${current.id}/archive`, { hash: current.hash });
      await changedHere();
      notify(`完整对话已保存为资料 v${saved.version}：${saved.messageCount} 条消息，原文未截断。`);
      choose(current.id, saved.id);
    } catch (problem) { notify(problem instanceof Error ? problem.message : '保存失败'); }
    finally { setPending(false); }
  };
  const prepareDraft = async () => {
    if (!session || !selected.length) return;
    const evidence = session.messages.filter(message => selected.includes(message.id));
    if (!evidence.some(message => message.role === 'user') || !evidence.some(message => ['assistant', 'human'].includes(message.role))) {
      notify('请至少选择一条客户问题和一条客服答复；可以跨多轮选择。'); return;
    }
    setPending(true);
    try {
      const saved = archive || await request<Archive>(`/sessions/${session.id}/archive`, { hash: session.hash });
      setDraftInput({ archive: saved, evidence });
      await changedHere();
    } catch (problem) { notify(problem instanceof Error ? problem.message : '读取对话依据失败'); }
    finally { setPending(false); }
  };
  return <div className="dialogue-knowledge">
    {projectReturn && <a className="project-return-link" href={projectReturn}><ArrowLeft size={15} />返回项目案例</a>}
    <div className="page-head"><div><span className="eyebrow">CONVERSATION KNOWLEDGE BASE</span><h1>对话知识库</h1><p>保留整段上下文与每轮证据，先沉淀原始资料，再审核可复用的答复知识。</p></div><div className="page-actions"><Button primary onClick={() => setImportOpen(true)}><UploadSimple size={16} />导入完整对话</Button></div></div>
    <div className="knowledge-tabs" role="tablist" aria-label="知识库内容"><button role="tab" aria-selected={tab === 'dialogues'} onClick={() => choose(sessionId, archiveId)}><ChatsCircle size={18} />对话资料<span>{listing?.stats.sessions || 0}</span></button><button role="tab" aria-selected={tab === 'drafts'} onClick={() => choose(sessionId, archiveId, 'drafts')}><PencilSimple size={18} />知识草稿<span>{drafts.filter(draft => draft.status === 'draft').length}</span></button><button role="tab" aria-selected={tab === 'policies'} onClick={() => choose(sessionId, archiveId, 'policies')}><BookOpen size={18} />答复知识</button></div>
    {error && <div className="notice error" role="alert">{error}。当前列表可能不是最新数据。</div>}
    {tab === 'policies' ? policies : tab === 'drafts' ? <Panel className="draft-library"><div className="draft-library-head"><div><h2>从完整对话到可复用知识</h2><p>草稿保留原会话版本和逐条依据，审核前不参与客服答复。</p></div><Badge>{drafts.length} 条记录</Badge></div>{drafts.length ? <div className="table-wrap"><table><thead><tr><th>知识标题 / 原会话</th><th>来源版本</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{drafts.map(draft => <tr key={draft.id}><td><strong>{draft.title}</strong><small>{draft.question}</small></td><td>v{draft.archiveVersion} · {draft.messageIds.length} 条依据</td><td><Badge tone={draft.status === 'approved' ? 'green' : 'amber'}>{draft.status === 'approved' ? '已人工确认发布' : '待审核'}</Badge></td><td><DateText value={draft.updatedAt} /></td><td><div className="row-actions"><Button onClick={() => setEditingDraft(draft)}>{draft.status === 'draft' ? '复核与编辑' : '查看审核记录'}</Button><button className="text-link" onClick={() => choose(draft.sessionId, draft.archiveId)}>查看整段原文 <ArrowSquareOut size={14} /></button></div></td></tr>)}</tbody></table></div> : <Empty title="尚无知识草稿" description="先打开完整会话，勾选客户问题与客服答复，再整理知识草稿。原始对话会完整保留。" />}</Panel> : <>
      <div className="dialogue-summary"><span><ChatsCircle size={16} /><strong>{listing?.stats.sessions || 0}</strong> 段会话</span><span><FileText size={16} /><strong>{listing?.stats.messages || 0}</strong> 条完整消息</span><span><BookOpen size={16} /><strong>{listing?.stats.archived || 0}</strong> 段已存知识资料</span><small>会话记录 ≠ 已审核的标准答案</small></div>
      {!!listing?.corpora?.length && <div className="corpus-library-bar"><div><strong>真实业务语料</strong><span>{listing.corpora.reduce((sum, item) => sum + item.totals.sessions, 0).toLocaleString()} 段已脱敏会话 · 完整原文与标注已存档</span></div><label>数据来源<select className="select" aria-label="数据来源" value={dataset} onChange={event => { const value = event.target.value; setDataset(value); setIntent(''); setStatus('all'); setListing(null); setSessionId(null); setArchiveId(null); location.hash = value ? `knowledge?dataset=${encodeURIComponent(value)}` : 'knowledge'; }}><option value="">全部来源</option>{listing.corpora.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>标注意图<select className="select" aria-label="标注意图" value={intent} onChange={event => { setIntent(event.target.value); setSessionId(null); setArchiveId(null); setListing(null); }}><option value="">全部意图</option>{Object.entries(intentNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><small>列表匹配 {listing.total.toLocaleString()} 段 · 资料不自动参与答复或更新模型</small></div>}
      <div className={`dialogue-workbench ${session ? 'has-session' : ''} ${readingFocus && session ? 'reading-focus' : ''}`}>
        <Panel className="dialogue-library"><div className="dialogue-library-tools"><h2>完整会话</h2><SearchInput value={query} onChange={value => { setQuery(value); setSessionId(null); setArchiveId(null); setListing(null); }} placeholder="搜索整段原文" /><select className="select" aria-label="会话筛选" value={status} onChange={event => { setStatus(event.target.value); setSessionId(null); setArchiveId(null); setListing(null); }}><option value="all">全部会话</option><option value="archived">已存知识资料</option><option value="unarchived">尚未存档</option><option value="attention">有待复核信号</option><option value="imported">用户导入</option><option value="gap">原标注：知识缺口</option><option value="invalid">原标注：无效对话</option><option value="label_conflict">标注存在分歧</option></select></div><div className="dialogue-session-list">{listing?.sessions.length ? listing.sessions.map(item => <button key={item.id} className={`dialogue-session ${item.id === sessionId ? 'selected' : ''}`} onClick={() => choose(item.id)}><div><span>{item.datasetId ? '真实语料 · 脱敏' : item.origin === 'local_test' ? '本机试用' : '用户导入'}</span><DateText value={item.updatedAt} /></div><h3>{item.title}</h3><p>{item.preview}</p><footer><span>{item.customerTurns} 轮客户发言 · {item.messageCount} 条消息</span>{item.archives.length > 0 && <BookOpen size={13} aria-label="已存知识资料" />}</footer>{item.signalCount > 0 && <small className="dialogue-signal-count">{item.signalCount} 项待复核信号</small>}</button>) : <Empty title={listing ? '暂无匹配会话' : '正在读取'} description="可导入已有的匿名完整对话，或调整当前筛选条件。" />}</div><div className="dialogue-list-pagination"><Button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page} / {Math.max(1, Math.ceil((listing?.total || 0) / 20))}</span><Button disabled={!listing || page * 20 >= listing.total} onClick={() => setPage(page + 1)}>下一页</Button></div></Panel>
        {!sessionId ? <Panel className="dialogue-start"><ChatsCircle size={42} weight="duotone" /><h2>选择一段对话，展开全部上下文</h2><p>不是把聊天拆成知识卡片。这里可以逐条阅读客户与客服发言、追溯每轮操作，并保留完整原文作为知识资料。</p><div><span>01 阅读整段</span><ArrowRight size={15} /><span>02 保存资料</span><ArrowRight size={15} /><span>03 整理并审核</span></div><Button onClick={() => setImportOpen(true)}><UploadSimple size={16} />导入已有对话</Button></Panel> : detailError ? <Panel className="dialogue-start"><WarningCircle size={32} /><h2>无法读取完整对话</h2><p role="alert">{detailError}。为避免把旧记录误作完整内容，已暂停展示。</p><Button onClick={() => setRevision(value => value + 1)}>重试</Button></Panel> : !session ? <Panel className="dialogue-start"><Empty title="正在读取完整会话" /></Panel> : <>
          <Panel className="dialogue-reader"><div className="dialogue-reader-head"><div className="dialogue-reader-meta"><Badge tone={archive ? 'blue' : 'gray'}>{archive ? `知识资料 · v${archive.version}` : '原始会话记录'}</Badge><span>{session.datasetId ? '真实历史语料 · 脱敏后导入' : session.origin === 'local_test' ? '本机匿名试用' : '导入来源未核验'}</span></div><h2>{session.title}</h2><div className="dialogue-identifiers"><code>{session.id}</code><span>{session.messages.length} 条消息 · {session.analysis.customerTurns} 轮客户发言</span></div><div className="dialogue-reader-actions"><Button primary onClick={() => void saveArchive()} disabled={pending || archiveCurrent}><FloppyDisk size={15} />{archiveCurrent ? '当前版本已存档' : current?.archives.length ? '保存新增对话版本' : '整段存入知识库'}</Button><a className="text-link" href={archive ? `/api/support/dialogue-archives/${archive.id}/export.md` : `/api/support/sessions/${session.id}/export.md`} download><DownloadSimple size={15} />全文导出</a></div>{!!current?.archives.length && <label className="dialogue-version">资料版本<select className="select" aria-label="对话资料版本" value={archiveId || ''} onChange={event => choose(sessionId, event.target.value || null)}><option value="">最新完整会话（未冻结）</option>{current.archives.map(item => <option key={item.id} value={item.id}>v{item.version} · {item.messageCount} 条消息</option>)}</select></label>}</div>
          {!!session.annotationSets?.length && session.labelSummary && <details className="chat-label-drawer" key={`${session.id}-${archiveId || 'latest'}`}><summary><BookOpen size={15} /><strong>原始业务标注</strong><Badge>{session.annotationSets.length} 份</Badge>{session.labelSummary.conflicts.length > 0 && <Badge tone="amber">存在分歧</Badge>}{session.labelSummary.values.kb_expectation?.includes('gap') && <Badge tone="amber">知识缺口</Badge>}<span>点击查看</span><CaretDown size={14} /></summary><CorpusLabels sets={session.annotationSets} summary={session.labelSummary} provenance={session.provenance} /></details>}
          <div className="chat-reader-toolbar"><strong><ChatsCircle size={17} />聊天回放</strong><div><button aria-pressed={selectionMode} onClick={() => { setSelectionMode(value => !value); if (selectionMode) setSelected([]); }}><PencilSimple size={14} />{selectionMode ? '退出选择' : '选择知识依据'}</button><button aria-pressed={readingFocus} onClick={() => setReadingFocus(value => !value)}><CornersOut size={14} />{readingFocus ? '退出专注阅读' : '专注阅读'}</button></div></div>
          <div className="dialogue-reading-tools chat-search-tools"><SearchInput value={search} onChange={setSearch} placeholder="在整段中定位，不隐藏上下文" /><span>{search ? `${session.messages.filter(message => message.content.toLocaleLowerCase().includes(search.toLocaleLowerCase())).length} 条命中` : '按原顺序 · 不截断正文'}</span>{search && <button className="text-link" onClick={() => { const matches = session.messages.filter(message => message.content.toLocaleLowerCase().includes(search.toLocaleLowerCase())); const index = matches.findIndex(message => message.id === focusMessage); if (matches.length) jump(matches[(index + 1) % matches.length].id); }}>定位下一处</button>}<button className="text-link" onClick={() => setCompact(value => !value)}>{compact ? '展开全文连续阅读' : '切换为紧凑滚动'}</button></div>
          {selectionMode && <div className="dialogue-selection"><label><input type="checkbox" checked={selected.length === session.messages.length} onChange={event => setSelected(event.target.checked ? session.messages.map(message => message.id) : [])} />全选依据</label><span>已选 {selected.length} 条</span><Button disabled={pending || selected.length < 2} onClick={() => void prepareDraft()}><PencilSimple size={14} />整理知识草稿</Button></div>}
          <ConversationPlayback messages={session.messages} compact={compact} selectionMode={selectionMode} selected={selected} focusedId={focusMessage} query={search} onSelect={(identifier, checked) => setSelected(previous => checked ? [...new Set([...previous, identifier])] : previous.filter(value => value !== identifier))} />
          <div className="dialogue-scope"><ShieldCheck size={14} /><span>{session.completeness}</span></div></Panel>
          <aside className="dialogue-analysis"><Panel><div className="dialogue-analysis-head"><MagnifyingGlass size={19} /><h2>整段对话分析</h2></div><div className="dialogue-analysis-body"><p className="analysis-method">{session.analysis.method}</p><div className="dialogue-analysis-numbers"><div><strong>{session.analysis.customerTurns}</strong><span>客户发言</span></div><div><strong>{session.analysis.replyCount}</strong><span>客服答复</span></div><div><strong>{session.analysis.traceCount}</strong><span>关联 Trace</span></div></div><div className="dialogue-outcome"><WarningCircle size={16} /><span>{session.analysis.outcome}</span></div><h3>话题路径</h3>{session.analysis.topics.length ? <div className="dialogue-topics">{session.analysis.topics.map((topic, index) => <button key={`${topic.messageId}-${index}`} onClick={() => jump(topic.messageId)}><span>{index + 1}</span>{topic.label}<ArrowRight size={12} /></button>)}</div> : <p className="dialogue-muted">{session.annotationSets ? '原标注是会话级标签，见上方业务标注；没有把它冒充逐轮意图预测。' : '导入原文没有意图标签，未编造自动主题分析。'}</p>}<h3>上下文问题线索 <span>{session.analysis.signals.length}</span></h3>{session.analysis.signals.length ? <div className="dialogue-findings">{session.analysis.signals.map((signal, index) => <button key={`${signal.kind}-${index}`} onClick={() => jump(signal.messageIds.at(-1)!)}><strong><WarningCircle size={14} />{signal.title}</strong><p>{signal.description}</p><span>定位原文 {signal.messageIds.map(identifier => `#${session.messages.find(message => message.id === identifier)?.sequence}`).join('、')} <ArrowRight size={12} /></span></button>)}</div> : <p className="dialogue-muted">规则未识别出明确线索，不代表这段对话没有问题。</p>}<h3>引用的知识版本</h3>{session.analysis.sources.length ? session.analysis.sources.map(source => <button className="dialogue-source" key={`${source.id}-${source.version}`} onClick={() => jump(source.messageIds[0])}><BookOpen size={14} /><span>{source.title}<small>{source.id} · v{source.version}</small></span></button>) : <p className="dialogue-muted">没有已记录的知识引用。</p>}<details className="dialogue-proof"><summary>查看完整性指纹</summary><code>{session.hash}</code><p>用于核对资料版本，不代表业务内容真实或已审核。</p></details></div></Panel></aside>
        </>}
      </div>
    </>}
    <ImportDialogue open={importOpen} close={() => setImportOpen(false)} imported={async imported => { await changedHere(); setImportOpen(false); choose(imported.id); notify(`已导入 ${imported.messages.length} 条完整消息。请阅读原文后保存为知识资料。`); }} />
    {(draftInput || editingDraft) && <DraftEditor input={draftInput} draft={editingDraft} close={() => { setDraftInput(null); setEditingDraft(null); }} saved={async draft => { await changedHere(); setDraftInput(null); setEditingDraft(null); choose(draft.sessionId, draft.archiveId, 'drafts'); notify(draft.status === 'approved' ? '知识已人工确认发布，原对话与审核依据仍完整保留。' : '草稿已保存，尚未用于客服答复。'); }} />}
  </div>;
}

function ImportDialogue({ open, close, imported }: { open: boolean; close: () => void; imported: (session: Session) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [sourceLabel, setSourceLabel] = useState('用户提供的匿名客服对话');
  const [format, setFormat] = useState('text');
  const [content, setContent] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setError(''); setAuthorized(false); } }, [open]);
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(json|txt)$/i.test(file.name) || file.size > 200000) { setError('仅支持 200 KB 以内的 UTF-8 .json / .txt；不支持的文件不会上传。'); return; }
    try { const value = await file.text(); if (value.includes('\uFFFD') || value.includes('\u0000')) throw new Error('请转换为有效 UTF-8 文本，原文件未上传。'); setContent(value); setFormat(file.name.endsWith('.json') ? 'json' : 'text'); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : '文件读取失败'); }
  };
  const submit = async () => {
    setPending(true); setError('');
    try {
      let messages: unknown;
      if (format === 'json') { const parsed = JSON.parse(content); messages = Array.isArray(parsed) ? parsed : parsed.messages; if (!Array.isArray(messages)) throw new Error('JSON 需要消息数组，或带 messages 数组的对象。'); }
      const payload = { title, sourceLabel, authorized, ...(format === 'json' ? { messages } : { transcript: content }) };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 250000) throw new Error('序列化内容超过请求大小限制，请分卷导入；不会静默截断。');
      await imported(await request<Session>('/sessions/import', payload));
      setContent(''); setTitle('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : '导入失败'); }
    finally { setPending(false); }
  };
  return <Modal open={open} onClose={() => !pending && close()} title="导入完整客服对话" description="保留角色、顺序、全部正文与可选时间。通过本机隐私门禁后才持久化；导入记录不会自动成为标准答案。" wide><div className="dialogue-import-form"><div className="dialogue-field-row"><label className="form-field">对话标题<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="例如：退款进度沟通复盘" /></label><label className="form-field">来源说明（不要填写客户身份）<input value={sourceLabel} maxLength={120} onChange={event => setSourceLabel(event.target.value)} /></label></div><div className="dialogue-import-toolbar"><select className="select" aria-label="对话导入格式" value={format} onChange={event => setFormat(event.target.value)}><option value="text">带角色标签的文本</option><option value="json">JSON 消息数组</option></select><input ref={fileRef} type="file" accept=".json,.txt" hidden onChange={event => void readFile(event.target.files?.[0])} /><Button onClick={() => fileRef.current?.click()}><UploadSimple size={15} />选择本地文本文件</Button><span>2–200 条消息 · 不截断导入</span></div><label className="form-field">完整对话原文<textarea className="dialogue-import-text" aria-label="完整对话原文" value={content} onChange={event => setContent(event.target.value)} placeholder={format === 'text' ? '客户：粘贴第一条客户发言\n客服：粘贴客服答复\n客户：后续追问\n人工客服：人工回复\n（多行正文直接换行，无需合并）' : '[\n  {"role":"user","content":"客户问题"},\n  {"role":"assistant","content":"客服答复"}\n]\n可选 at 为含时区 ISO 时间；支持 human、tool、system 角色。'} /></label><div className="notice"><ShieldCheck size={18} /><span>请先替换姓名、联系方式、订单号及内部业务信息。只接受文本，不上传附件、图片或文件名；扫描器不可用时拒绝保存。</span></div><label className="dialogue-confirm"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} />我有权处理这些内容，已人工脱敏并确认提供了本次需要分析的完整对话。</label>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><Button onClick={close} disabled={pending}>取消</Button><Button primary disabled={pending || !authorized || !title.trim() || !content.trim()} onClick={() => void submit()}>{pending ? '隐私检查并导入…' : '检查并导入完整对话'}</Button></div></div></Modal>;
}

function DraftEditor({ input, draft, close, saved }: { input: DraftInput | null; draft: Draft | null; close: () => void; saved: (draft: Draft) => Promise<void> }) {
  const [title, setTitle] = useState(draft?.title || input?.archive.title || '');
  const [question, setQuestion] = useState(draft?.question || input?.evidence.filter(message => message.role === 'user').map(message => message.content).join('\n\n') || '');
  const [content, setContent] = useState(draft?.content || input?.evidence.filter(message => ['assistant', 'human'].includes(message.role)).map(message => message.content).join('\n\n') || '');
  const [keywords, setKeywords] = useState(draft?.keywords.join('，') || '');
  const [evidence, setEvidence] = useState<Message[]>(input?.evidence || []);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [evidenceError, setEvidenceError] = useState('');
  const readOnly = draft?.status === 'approved';
  useEffect(() => {
    if (!draft) return;
    let active = true;
    request<Archive>(`/dialogue-archives/${draft.archiveId}`).then(archive => { if (active) setEvidence(archive.snapshot.messages.filter(message => draft.messageIds.includes(message.id))); }).catch(() => { if (active) setEvidenceError('无法读取原文依据，禁止发布。'); });
    return () => { active = false; };
  }, [draft]);
  const submit = async (approve = false) => {
    setPending(true); setError('');
    try {
      const payload = { title, question, content, keywords: keywords.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean), version: draft?.version, approve, reviewed, archiveId: input?.archive.id, messageIds: input?.evidence.map(message => message.id) };
      await saved(await request<Draft>(draft ? `/knowledge-drafts/${draft.id}` : '/knowledge-drafts', payload));
    } catch (problem) { setError(problem instanceof Error ? problem.message : '保存失败'); }
    finally { setPending(false); }
  };
  return <Modal open onClose={() => !pending && close()} title={readOnly ? '已审核知识与原文依据' : draft ? '复核对话知识草稿' : '从选中原文整理知识草稿'} description="原文不是标准答案。请结合整段上下文纠正答复；保存草稿不会改变原始对话。" wide><div className="dialogue-draft-form"><div className="draft-provenance"><BookOpen size={17} /><span>对话资料 v{draft?.archiveVersion || input?.archive.version} · {evidence.length} 条逐字依据 · 原始整段已保存</span>{readOnly && <Badge tone="green">已人工确认发布</Badge>}</div><details className="draft-evidence" open><summary>对照原文依据</summary>{evidence.map(message => <div key={message.id}><strong>#{message.sequence} {roleNames[message.role]}</strong><p>{message.content}</p></div>)}</details>{evidenceError && <div className="form-error" role="alert">{evidenceError}</div>}<label className="form-field">知识标题<input value={title} disabled={readOnly} maxLength={120} onChange={event => setTitle(event.target.value)} /></label><label className="form-field">适用问题与前提<textarea value={question} disabled={readOnly} onChange={event => setQuestion(event.target.value)} /></label><label className="form-field">整理后的标准答复（请纠正错误，不要直接相信原回答）<textarea className="draft-answer" value={content} disabled={readOnly} onChange={event => setContent(event.target.value)} /></label>{(content.length > 4000 || question.length > 4000) && <div className="form-error">选中原文已完整保留；请人工整理为各 4,000 字符以内的知识，不会自动截断。</div>}<label className="form-field">答复匹配词（逗号分隔，发布时必填）<input value={keywords} disabled={readOnly} onChange={event => setKeywords(event.target.value)} placeholder="例如：退款进度，退款到账" /></label><div className="notice"><Info size={17} /><span>这里是人工整理，不是 LLM 自动提炼。原对话资料只用于分析；审核发布仅影响旧版词条匹配，不会自动更新当前行为模型或评测分数。审核者身份尚无登录认证。</span></div>{draft && !readOnly && <label className="dialogue-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />我已阅读整段上下文，核实适用条件与业务政策，确认此答复可以复用。</label>}{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><Button onClick={close} disabled={pending}>关闭</Button>{!readOnly && <Button onClick={() => void submit()} disabled={pending || !evidence.length || !!evidenceError || content.length > 4000 || question.length > 4000}>{pending ? '处理中…' : '保存草稿'}</Button>}{draft && !readOnly && <Button primary disabled={pending || !reviewed || !keywords.trim() || !evidence.length || !!evidenceError || content.length > 4000 || question.length > 4000} onClick={() => void submit(true)}><Check size={15} />审核并发布到答复知识</Button>}</div></div></Modal>;
}
