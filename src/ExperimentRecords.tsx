import { useEffect, useState } from 'react';
import { Archive, ArrowClockwise, ArrowCounterClockwise, ClockCounterClockwise, PencilSimple, Star } from '@phosphor-icons/react';
import { Badge, Button, Empty, Modal, SearchInput, Status } from './ui';
import './experiment-records.css';

export type ExperimentMetadata = { name: string; customName: string; note: string; favorite: boolean; archived: boolean; revision: number; updatedAt: string | null };
export type ExperimentRecord = { id: string; createdAt: string; status: string; total: number; completed: number; trainCount: number; trainingPercent?: number; metadata: ExperimentMetadata };
type Update = { id: string; metadata: ExperimentMetadata };
type Listing = { records: ExperimentRecord[]; total: number; page: number; pages: number; counts: { all: number; active: number; favorites: number; archived: number } };
const scopes = [{ id: 'active', label: '近期使用' }, { id: 'favorites', label: '已收藏' }, { id: 'archived', label: '已归档' }] as const;
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
async function request<Value>(path: string, body?: unknown, signal?: AbortSignal): Promise<Value> {
  const response = await fetch(`/api/support/experience/${path}`, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '实验记录读取失败，请重试');
  return result;
}

export function CurrentExperiment({ run, count, projectId, select, updated, children }: { run: ExperimentRecord | null; count: number; projectId: string; select: (id: string) => void; updated: (items: Update[]) => void; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <section className="experiment-current" aria-label="当前实验" data-experiment-id={run?.id || ''}>
      <div className="experiment-current-icon"><ClockCounterClockwise size={23} /></div>
      <div className="experiment-current-info"><div><span className="experiment-eyebrow">当前实验</span>{run && <><Status status={run.status} />{run.metadata.favorite && <Badge tone="amber">已收藏</Badge>}{run.metadata.archived && <Badge>已归档 · 仍可查看</Badge>}</>}</div>
        <h3>{run ? run.metadata.name : count ? '没有未归档实验' : '尚未开始实验'}</h3>
        <p>{run ? `${timestamp(run.createdAt)} · 训练 ${run.trainCount.toLocaleString()}条 · 测试 ${run.total}例` : count ? '在实验记录中查看或恢复历史结果，也可开始新实验。' : '完成一次学习回放后，可在这里查找和管理。'}</p>
        {run?.metadata.note && <p className="experiment-current-note">{run.metadata.note}</p>}
      </div>
      <div className="experiment-current-actions">{children}<Button onClick={() => setOpen(true)}><ClockCounterClockwise size={16} />实验记录{count > 0 ? ` · ${count}` : ''}</Button></div>
    </section>
    {open && <ExperimentManager projectId={projectId} currentId={run?.id || ''} close={() => setOpen(false)} select={id => { setOpen(false); select(id); }} updated={updated} />}
  </>;
}

function ExperimentManager({ projectId, currentId, close, select, updated }: { projectId: string; currentId: string; close: () => void; select: (id: string) => void; updated: (items: Update[]) => void }) {
  const [scope, setScope] = useState<'active' | 'favorites' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [training, setTraining] = useState('all');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<ExperimentRecord | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<ExperimentRecord[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setSelected([]);
    const timer = setTimeout(async () => {
      try {
        const result = await request<Listing>(`experiments?${new URLSearchParams({ project: projectId, scope, q: search, status, training, page: String(page) })}`, undefined, controller.signal);
        if (!controller.signal.aborted) setData(result);
      } catch (problem) { if (!controller.signal.aborted) { setData(null); setError((problem as Error).message); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, scope, search, status, training, page, revision]);
  const refresh = () => { setError(''); setRevision(value => value + 1); };
  const resetSelection = () => { setPage(1); setSelected([]); setError(''); setNotice(''); };
  const mutate = async (action: () => Promise<Update[]>, message: string) => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await action(); updated(result); setEditing(null); setPending([]); setSelected([]); setNotice(message); setRevision(value => value + 1); }
    catch (problem) { setError((problem as Error).message); setRevision(value => value + 1); }
    finally { setBusy(false); }
  };
  const favorite = (record: ExperimentRecord) => mutate(async () => [await request<Update>('experiment-update', { projectId, id: record.id, revision: record.metadata.revision, favorite: !record.metadata.favorite })], record.metadata.favorite ? '已取消收藏' : '已收藏，可在「已收藏」中快速找到');
  const save = () => editing && mutate(async () => [await request<Update>('experiment-update', { projectId, id: editing.id, revision: editing.metadata.revision, name, note })], '名称与备注已保存');
  const archive = () => mutate(async () => (await request<{ records: Update[] }>('experiment-archive', { projectId, records: pending.map(record => ({ id: record.id, revision: record.metadata.revision })), archived: scope !== 'archived', confirmed: true })).records, scope === 'archived' ? '已恢复，记录回到「近期使用」' : '已归档，历史成绩和 Trace 均已保留');
  const rows = data?.records || [];
  const selectable = rows.filter(record => record.status !== 'running');
  const locked = busy || !!editing || pending.length > 0;
  const checkedAll = selectable.length > 0 && selectable.every(record => selected.includes(record.id));
  return <Modal open onClose={() => !busy && close()} title="实验记录" description="按项目管理学习回放。找记录、留备注、收起旧实验，不改动历史成绩。" wide>
    <div className="experiment-manager">
      <div className="experiment-scopes" aria-label="实验记录分类">{scopes.map(item => <button key={item.id} disabled={locked} aria-pressed={scope === item.id} onClick={() => { setScope(item.id); resetSelection(); }}>{item.label}<span>{data?.counts[item.id] ?? '—'}</span></button>)}</div>
      <fieldset className="experiment-filters" disabled={locked}><SearchInput value={search} onChange={value => { setSearch(value.slice(0, 200)); resetSelection(); }} placeholder="搜索实验名称、备注或编号" /><select aria-label="实验状态" value={status} onChange={event => { setStatus(event.target.value); resetSelection(); }}><option value="all">所有状态</option><option value="completed">已完成</option><option value="running">运行中</option><option value="failed">运行失败</option><option value="cancelled">已取消</option><option value="interrupted">已中断</option></select><select aria-label="实验训练数据量" value={training} onChange={event => { setTraining(event.target.value); resetSelection(); }}><option value="all">所有训练量</option><option value="25">25% · 小样本</option><option value="60">60% · 扩充</option><option value="100">100% · 全量</option></select></fieldset>
      {error && <div className="notice error" role="alert">{error} <button className="text-link" disabled={busy} onClick={refresh}>刷新记录</button></div>}
      {notice && <p className="experiment-notice" role="status">{notice}</p>}
      {editing && <form className="experiment-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <h3>编辑实验信息</h3><p>例如「全量训练 · 演示基线」。留空名称将恢复自动命名；不要填写客户隐私或密钥。</p>
        <label>实验名称<input autoFocus maxLength={80} value={name} placeholder={editing.metadata.name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>实验备注<textarea maxLength={500} rows={3} value={note} disabled={busy} placeholder="记录这次改了什么、下一步要验证什么" onChange={event => setNote(event.target.value)} /></label>
        <div className="experiment-editor-actions"><span>{note.length}/500字 · 仅保存在本机</span><Button disabled={busy} onClick={() => setEditing(null)}>取消编辑</Button><Button primary type="submit" disabled={busy}>{busy ? '保存中…' : '保存信息'}</Button></div>
      </form>}
      {pending.length > 0 && <section className="experiment-confirm" aria-label="确认整理实验"><h3>{scope === 'archived' ? '恢复' : '归档'}这{pending.length}条实验？</h3><p>{scope === 'archived' ? '恢复后会重新显示在「近期使用」中。' : '只从常用列表中收起。结果、曲线、原始对话和 Trace 不会删除；可在「已归档」随时恢复。'}{pending.some(record => record.id === currentId) && ' 当前打开的成绩仍会保留，不自动切换其他实验。'}</p><div className="experiment-editor-actions"><Button disabled={busy} onClick={() => setPending([])}>暂不整理</Button><Button primary disabled={busy} onClick={() => void archive()}>{busy ? '处理中…' : scope === 'archived' ? '确认恢复' : '确认归档'}</Button></div></section>}
      <div className="experiment-list-toolbar"><label><input type="checkbox" aria-label="选择本页可整理实验" checked={checkedAll} disabled={locked || loading || !selectable.length} onChange={() => setSelected(checkedAll ? [] : selectable.map(record => record.id))} />本页全选</label><span>{selected.length ? `已选 ${selected.length} 条` : `匹配 ${data?.total ?? 0} 条 · 最新在前`}</span>{selected.length > 0 && <Button disabled={locked || loading} onClick={() => setPending(rows.filter(record => selected.includes(record.id)))}>{scope === 'archived' ? '恢复所选' : '归档所选'} · {selected.length}</Button>}<button className="icon-button experiment-refresh" aria-label="刷新实验记录" title="刷新实验记录" disabled={locked || loading} onClick={refresh}><ArrowClockwise size={17} /></button></div>
      <div className="experiment-list" aria-label="实验记录列表" aria-busy={loading}>
        {loading ? <p className="experiment-loading" role="status">正在查找实验…</p> : rows.map(record => <article key={record.id} className={`experiment-row ${record.id === currentId ? 'is-current' : ''}`} data-record-id={record.id}>
          <input type="checkbox" aria-label={`选择实验 ${record.id}`} disabled={locked || record.status === 'running'} checked={selected.includes(record.id)} onChange={event => setSelected(value => event.target.checked ? [...value, record.id] : value.filter(id => id !== record.id))} />
          <div className="experiment-row-body"><div className="experiment-row-heading"><button className="experiment-open" disabled={locked} title={record.metadata.name} onClick={() => select(record.id)}>{record.metadata.name}</button><Status status={record.status} />{record.id === currentId && <Badge tone="blue">当前</Badge>}</div><p>{timestamp(record.createdAt)}<span>训练 {record.trainCount.toLocaleString()}条（{record.trainingPercent ?? 100}%）· 测试 {record.total}例</span></p>{record.metadata.note && <p className="experiment-row-note">{record.metadata.note}</p>}<code>{record.id}</code></div>
          <div className="experiment-row-actions"><button className="icon-button" title={record.metadata.favorite ? '取消收藏' : '收藏实验'} aria-label={record.metadata.favorite ? '取消收藏' : '收藏实验'} aria-pressed={record.metadata.favorite} disabled={locked} onClick={() => void favorite(record)}><Star size={18} weight={record.metadata.favorite ? 'fill' : 'regular'} /></button><button className="icon-button" title="编辑名称与备注" aria-label="编辑名称与备注" disabled={locked} onClick={() => { setEditing(record); setName(record.metadata.customName); setNote(record.metadata.note); setNotice(''); setError(''); }}><PencilSimple size={18} /></button><button className="icon-button" title={record.status === 'running' ? '运行中不可归档' : scope === 'archived' ? '恢复实验' : '归档实验'} aria-label={scope === 'archived' ? '恢复实验' : '归档实验'} disabled={locked || record.status === 'running'} onClick={() => setPending([record])}>{scope === 'archived' ? <ArrowCounterClockwise size={18} /> : <Archive size={18} />}</button></div>
        </article>)}
        {!loading && data && !rows.length && <Empty title={search || status !== 'all' || training !== 'all' ? '没有匹配的实验' : scope === 'favorites' ? '还没有收藏' : scope === 'archived' ? '没有归档记录' : '还没有常用实验'} description={scope === 'favorites' ? '在近期使用里点星标，把演示基线和重要结果收在这里。' : '调整筛选，或切换其他分类；归档不会删除历史结果。'} />}
      </div>
      <footer className="experiment-pagination"><span>共 {data?.counts.all ?? 0} 条记录 · 每页10条</span><Button disabled={locked || loading || !data || data.page <= 1} onClick={() => setPage((data?.page || 1) - 1)}>上一页</Button><span>{data?.page || 1} / {data?.pages || 1}</span><Button disabled={locked || loading || !data || data.page >= data.pages} onClick={() => setPage((data?.page || 1) + 1)}>下一页</Button></footer>
    </div>
  </Modal>;
}
