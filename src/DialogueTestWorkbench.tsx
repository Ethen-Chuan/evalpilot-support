import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CaretDown, ChatCircleText, FloppyDisk, PencilSimple, Plus, ShieldCheck, Trash } from '@phosphor-icons/react';
import { Badge, Button, Empty, Modal, SearchInput } from './ui';
import { IntentExplorer } from './IntentExplorer';
import type { ExperienceState } from './ExperienceDashboard';
import { dialoguePaths, flowNames, flowTypes, loadDialogueDraft, removeDialogueBranch, sampleDialogueTree, saveDialogueDraft, testAllocation, validateDialogueTree } from './dialogueTestTree';
import type { DialogueTestNode, DialogueTestTree } from './dialogueTestTree';
import './dialogue-test-tree.css';

export function DialogueTestWorkbench({ state, offline = false }: { state: ExperienceState; offline?: boolean }) {
  const [tree, setTree] = useState(() => sampleDialogueTree(state.projectId));
  const [pathId, setPathId] = useState('normal-end');
  const [edited, setEdited] = useState<DialogueTestNode | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [consent, setConsent] = useState(false);
  const [sources, setSources] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  useEffect(() => {
    try { const stored = loadDialogueDraft(localStorage, state.projectId); if (stored) { setTree(stored); setMessage('已恢复此浏览器保存的草稿。'); } }
    catch { setStorageBlocked(true); setError('本机草稿无法安全读取；未覆盖原内容。当前只显示示例，保存已禁用。'); }
  }, [state.projectId]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  const paths = dialoguePaths(tree);
  const rootId = tree.nodes.find(node => node.parentId === null)?.id;
  const current = paths.find(path => path.id === pathId) || paths[0];
  const allocation = testAllocation(tree.plannedCount, tree.target);
  const counts = Object.fromEntries(flowTypes.map(flow => [flow, paths.filter(path => path.flow === flow).length]));
  const change = (value: DialogueTestTree) => { setTree(value); setDirty(true); setConsent(false); setError(''); setMessage(''); };
  const save = () => {
    if (!consent || storageBlocked) return;
    try { const saved = saveDialogueDraft(localStorage, tree); setTree(saved); setDirty(false); setConsent(false); setMessage(`草稿 v${saved.revision} 已保存在此浏览器；未调用模型、未生成评测分数。`); setError(''); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '保存失败，请检查浏览器存储权限。'); }
  };
  const selectBranch = (id: string) => { const next = paths.find(path => path.nodes.some(node => node.id === id)); if (next) setPathId(next.id); };
  const editNode = (node: DialogueTestNode, create = false) => {
    setAdding(create); setDeleting(false);
    setEdited(create ? { id: crypto.randomUUID(), parentId: node.id, branch: '新的分支', user: '', check: '', flow: node.flow } : { ...node });
  };
  const applyEdit = () => {
    if (!edited) return;
    const next = { ...tree, nodes: adding ? [...tree.nodes, edited] : tree.nodes.map(node => node.id === edited.id ? edited : node) };
    const issues = validateDialogueTree(next, state.projectId);
    if (issues.length) { setError(issues.join(' ')); return; }
    change(next); const nextPath = dialoguePaths(next).find(path => path.nodes.some(node => node.id === edited.id)); if (nextPath) setPathId(nextPath.id); setEdited(null);
  };
  const useSource = (source: NonNullable<DialogueTestTree['source']>) => {
    const next = { ...sampleDialogueTree(state.projectId), revision: tree.revision, updatedAt: tree.updatedAt, name: '真实首问衍生 · 待设计分支', source, nodes: [{ id: 'start', parentId: null, branch: '来源首问', user: source.question, check: '请根据此问题填写可核查的预期处理行为；不是历史标准答案。', flow: 'normal' as const }] };
    change(next); setPathId('start'); setSources(false); setMessage('已保留真实首问的消息引用。后续分支需自行设计，不复制人工答案冒充模型输出。');
  };

  return <section className="dialogue-test-workbench">
    <header className="dt-heading"><div><h2>多轮对话测试树</h2><p>一次共同起点，走不同分支；检查模型能否跟上用户改口、纠错与连续追问。</p></div><Badge tone="amber">测试设计 · 尚未执行</Badge></header>
    <div className="dt-scenario"><label className="form-field">测试场景<input aria-label="测试场景名称" value={tree.name} maxLength={80} onChange={event => change({ ...tree, name: event.target.value })} /></label>{!offline && <Button onClick={() => setSources(true)}><ChatCircleText size={15} />从真实对话起步</Button>}</div>
    <div className="dt-source-note">{tree.source ? <><Badge tone="blue">来源可追溯</Badge><span>起点参考真实消息{tree.nodes.find(node => node.parentId === null)?.user !== tree.source.question ? '（当前文案已改编）' : ''}；后续分支为设计用例，未在历史对话中发生。</span><a className="text-link" href={`#knowledge?session=${encodeURIComponent(tree.source.sessionId)}&project=${encodeURIComponent(state.projectId)}`}>核对原对话<ArrowRight size={13} /></a></> : <><Badge>自建示例</Badge><span>用于说明分支结构，不是真实客户记录，也不是模型实际回答。</span></>}</div>
    <details className="dt-allocation"><summary><span>测试配比<span>目标 {flowTypes.map(flow => `${flowNames[flow]} ${tree.target[flow]}%`).join(' / ')} · 已设计 {paths.length} 条路径</span></span><CaretDown size={16} /></summary><div className="dt-allocation-body"><label className="form-field">计划测试路径数<input aria-label="计划测试路径数" type="number" min={1} max={200} value={tree.plannedCount} onChange={event => change({ ...tree, plannedCount: Number(event.target.value) })} /></label><div className="dt-ratio-grid">{flowTypes.map(flow => <section key={flow} className={`dt-flow-${flow}`}><label>{flowNames[flow]}目标占比<input aria-label={`${flowNames[flow]}目标占比`} type="number" min={0} max={100} value={tree.target[flow]} onChange={event => change({ ...tree, target: { ...tree.target, [flow]: Number(event.target.value) } })} /><span>%</span></label><p>计划 {allocation?.[flow] ?? '—'} 条 · 已设计 {counts[flow]} 条</p><small>实际结构占比 {paths.length ? (counts[flow] / paths.length * 100).toFixed(1) : '0'}%{allocation && counts[flow] < allocation[flow] ? ` · 还需补充 ${allocation[flow] - counts[flow]} 条` : ''}</small></section>)}</div><p className="dt-note">60/30/10 是参考配比，可按业务调整，不是行业硬标准或真实覆盖率。按最大余数分配整数条数；重复运行同一路径不会增加独立案例数。</p>{!allocation && <p role="alert" className="notice error">占比必须合计 100%，计划数量需为 1–200 的整数。</p>}</div></details>
    <div className="dt-workspace">
      <aside className="dt-path-library"><header><h3>选择测试路径</h3><span>{paths.length} 条 · 共享起点</span></header>{flowTypes.map(flow => <section className={`dt-path-group dt-flow-${flow}`} key={flow}><h4>{flowNames[flow]}<span>{counts[flow]}</span></h4>{paths.filter(path => path.flow === flow).map(path => <button key={path.id} aria-pressed={current?.id === path.id} onClick={() => { setPathId(path.id); setEdited(null); }}><strong>{path.nodes.length > 1 ? path.nodes.find(node => node.parentId === rootId)?.branch || path.nodes.at(-1)?.branch : '共同起点 · 待添加分支'}</strong><span>{path.nodes.at(-1)?.branch} · {path.nodes.length} 个用户回合</span><small>{path.nodes.length * 2} 条计划消息 · 未运行</small></button>)}{!counts[flow] && <p>尚未设计此类路径</p>}</section>)}<p className="dt-note">每条路径独立保留上下文。走到分叉点时，在右侧选择另一种用户走法。</p></aside>
      <section className="dt-path-preview" aria-label="对话路径预览"><header><div><h3>{current ? flowNames[current.flow] : '路径预览'}</h3><p>用户消息 + 模型待答位 + 本轮检查点</p></div><Badge>{current?.nodes.length || 0} 轮</Badge></header><div className="dt-turns">{current?.nodes.map((node, index) => {
        const children = tree.nodes.filter(item => item.parentId === node.id);
        const nextId = current.nodes[index + 1]?.id;
        return <article className="dt-turn" key={node.id}><header><strong>第 {index + 1} 轮</strong><span>{index === 0 ? '共享起点' : node.branch}</span><button onClick={() => editNode(node)} aria-label={`编辑第 ${index + 1} 轮`}><PencilSimple size={14} />编辑</button></header><div className="dt-user-message"><span>用户</span><p>{node.user}</p></div><div className="dt-agent-slot"><span>客服模型</span><p>待真实运行，不预填模型答复</p></div><div className="dt-checkpoint"><strong>本轮检查点</strong><p>{node.check}</p></div><div className="dt-branch-options">{children.length > 1 && <span>接下来，用户可能…</span>}{children.map(child => <button key={child.id} aria-pressed={nextId === child.id} onClick={() => selectBranch(child.id)}>{child.branch}<ArrowRight size={12} /></button>)}<button className="dt-add-branch" disabled={children.length >= 3 || tree.nodes.length >= 60 || index >= 19} onClick={() => editNode(node, true)} aria-label={`在第 ${index + 1} 轮后增加分支`}><Plus size={13} />{children.length ? '增加另一种走法' : '增加后续回合'}</button></div></article>;
      })}</div></section>
    </div>
    <section className="dt-save-bar"><div><strong>{dirty ? '有未保存的修改' : tree.updatedAt ? `此浏览器草稿 v${tree.revision}` : '示例尚未保存'}</strong><label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />已检查姓名、联系方式、账号等内容，只将匿名测试设计保存在此浏览器。</label></div><Button primary disabled={!consent || storageBlocked} onClick={save}><FloppyDisk size={15} />保存测试设计</Button></section>
    {error && !edited && <p role="alert" className="notice error">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
    <div className="dt-boundary"><ShieldCheck size={17} /><p><strong>设计不等于评测。</strong>当前支持分支编辑、路径预览和本机草稿保存；尚未连接多轮模型执行器，不产生通过率、拦截率或 Trace。现有单轮模型评测保持独立。浏览器清理数据会删除草稿，草稿不自动同步到服务器。</p>{!offline && <a className="text-link" href={`#benchmark?mode=text&project=${encodeURIComponent(state.projectId)}`}>已有单轮评测<ArrowRight size={13} /></a>}</div>
    {!offline && <details className="dt-source-categories" onToggle={event => setLabelsOpen(event.currentTarget.open)}><summary>查找真实语料：来源意图分类<small>这是分类目录，不是对话测试树</small><CaretDown size={15} /></summary>{labelsOpen && <IntentExplorer state={state} />}</details>}
    <details className="dt-reset"><summary>恢复示例</summary><p>仅替换正在编辑的内容，不删除服务器上的历史对话或评测。</p>{resetting ? <><Button onClick={() => { change({ ...sampleDialogueTree(state.projectId), revision: tree.revision, updatedAt: tree.updatedAt }); setPathId('normal-end'); setResetting(false); }}>确认替换当前草稿</Button><Button onClick={() => setResetting(false)}>取消</Button></> : <Button onClick={() => setResetting(true)}>恢复自建分支示例</Button>}</details>
    <Modal open={!!edited} onClose={() => { setEdited(null); setError(''); }} title={adding ? '增加用户分支' : '编辑用户回合'} description="只编辑测试输入和检查点，不编写模型实际回答。共享节点的修改对所有经过它的路径生效。">{edited && <form className="dt-node-form" onSubmit={event => { event.preventDefault(); applyEdit(); }}><label className="form-field">分支名称<input aria-label="分支名称" value={edited.branch} required maxLength={50} onChange={event => setEdited({ ...edited, branch: event.target.value })} /></label><label className="form-field">测试类型<select aria-label="分支测试类型" value={edited.flow} onChange={event => setEdited({ ...edited, flow: event.target.value as DialogueTestNode['flow'] })}>{flowTypes.map(flow => <option value={flow} key={flow}>{flowNames[flow]}</option>)}</select></label><label className="form-field">用户会怎么说<textarea aria-label="分支用户消息" value={edited.user} rows={3} required maxLength={2000} onChange={event => setEdited({ ...edited, user: event.target.value })} /></label><label className="form-field">检查模型有没有做到<textarea aria-label="分支检查点" value={edited.check} rows={3} required maxLength={1000} onChange={event => setEdited({ ...edited, check: event.target.value })} /></label><p className="dt-note">路径经过压力流节点即归为压力流；否则经过异常流节点归为异常流。正常流程可以顺序继续，不强制每轮分叉。</p>{error && <p role="alert" className="notice error">{error}</p>}<div className="modal-actions">{!adding && edited.parentId && <Button onClick={() => setDeleting(true)}><Trash size={14} />删除此分支</Button>}<Button onClick={() => setEdited(null)}>取消</Button><Button primary type="submit">应用到测试树</Button></div>{deleting && <div role="alert" className="notice error"><span>会同时删除这个回合的所有后续分支。</span><Button onClick={() => { change(removeDialogueBranch(tree, edited.id)); setEdited(null); setDeleting(false); }}>确认删除分支及后续</Button></div>}</form>}</Modal>
    {!offline && <DialogueSourcePicker open={sources} close={() => setSources(false)} projectId={state.projectId} useSource={useSource} />}
  </section>;
}

function DialogueSourcePicker({ open, close, projectId, useSource }: { open: boolean; close: () => void; projectId: string; useSource: (source: NonNullable<DialogueTestTree['source']>) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<{ total: number; sessions: { id: string; title: string; preview: string }[] } | null>(null);
  const [selected, setSelected] = useState<NonNullable<DialogueTestTree['source']> | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const sourceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false);
    if (open) { setQuery(''); setPage(1); setSelected(null); setError(''); }
    return () => { sourceRequest.current?.abort(); sourceRequest.current = null; };
  }, [open, projectId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setListing(null); setError('');
    const timer = setTimeout(() => { void fetch(`/api/support/sessions?${new URLSearchParams({ dataset: projectId, q: query, page: String(page) })}`).then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || '来源读取失败'); if (active) setListing(value); }).catch(problem => { if (active) setError(problem.message); }); }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [open, projectId, query, page]);
  const select = async (id: string) => {
    sourceRequest.current?.abort();
    const request = new AbortController();
    sourceRequest.current = request;
    setPending(true); setSelected(null); setError('');
    try {
      const response = await fetch(`/api/support/sessions/${encodeURIComponent(id)}`, { signal: request.signal });
      const value = await response.json();
      if (!response.ok || value.datasetId !== projectId) throw new Error('来源会话不属于当前项目或读取失败。');
      const first = value.messages?.find((item: { role: string; content: string }) => item.role === 'user' && item.content?.trim());
      if (!first || typeof first.id !== 'string' || !first.id.trim() || first.content.length > 2000) throw new Error('没有可用首问及消息编号，或消息超过 2000 字；不会截断成虚假上下文。');
      if (sourceRequest.current === request && !request.signal.aborted) setSelected({ sessionId: id, messageId: first.id, question: first.content });
    } catch (problem) { if (sourceRequest.current === request && !request.signal.aborted) setError(problem instanceof Error ? problem.message : '无法读取原对话'); }
    finally { if (sourceRequest.current === request) { setPending(false); sourceRequest.current = null; } }
  };
  return <Modal open={open} onClose={close} title="选择真实对话起点" description="只引用当前项目的一条真实用户首问。不会把历史人工回复写成模型输出，也不会自动拼接不同客户的对话。"><SearchInput value={query} onChange={value => { setQuery(value); setPage(1); setSelected(null); }} placeholder="搜索当前项目的对话" />{error && <p role="alert" className="notice error">{error}</p>}<div className="dt-source-list">{listing?.sessions.map(item => <button disabled={pending} aria-pressed={selected?.sessionId === item.id} key={item.id} onClick={() => void select(item.id)}><strong>{item.title}</strong><span>{item.preview}</span></button>)}{!listing && !error ? <p>正在读取来源…</p> : listing && !listing.sessions.length && !error && <Empty title="当前项目没有匹配会话" />}</div><div className="pagination"><span>{listing?.total ?? '—'} 段 · 第 {page} 页</span><Button disabled={page <= 1 || pending} onClick={() => setPage(page - 1)}>上一页</Button><Button disabled={!listing || page * 20 >= listing.total || pending} onClick={() => setPage(page + 1)}>下一页</Button></div>{selected && <div className="dt-source-confirm"><strong>引用的真实首问</strong><p>{selected.question}</p><small>确认后替换当前未保存的设计，仅保留这条真实起点；其他分支由你编写，并明确标为衍生用例。</small><Button primary onClick={() => useSource(selected)}>以此首问新建测试树</Button></div>}</Modal>;
}
