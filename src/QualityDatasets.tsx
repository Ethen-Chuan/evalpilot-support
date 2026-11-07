import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CaretLeft, CaretRight, ClipboardText, ShieldCheck } from '@phosphor-icons/react';
import { Badge, Button, Empty, Panel, number } from './ui';
import './quality-datasets.css';

export type QualityCorpus = { id: string; name: string; channel: 'hotline' | 'online'; nature: string; boundary: string; scanStatus: string; importedAt: string; totals: { records: number; scoredRecords: number; transcriptRecords: number; qualified: number; unqualified: number; qualificationMissing: number; withheldLines: number } };
type QualityRow = { id: string; row: number; goldScore: number | null; qualified: boolean | null; hasTranscript: boolean };
type QualityRecord = { id: string; datasetId: string; transcript: string | null; labels: { goldScore: number | null; qualified: boolean | null; dimensions: Record<string, string[]>; reason: string | null }; provenance: { file: string; sheet: string; row: number }; privacy: { withheldLines: number; originalLines: number } };
const dimensions = [['dim_observe', '流程规范'], ['dim_solution', '问题解决'], ['dim_risk', '风险提醒'], ['dim_attitude', '服务态度'], ['dim_closure', '服务闭环'], ['dim_wording', '礼貌用语'], ['dim_proactive', '主动服务']];
const qualification = (value: boolean | null) => value === null ? '未填写' : value ? '合格' : '不合格';

export function QualityDatasetCards({ projects }: { projects: QualityCorpus[] }) {
  if (!projects.length) return null;
  return <section className="quality-projects" aria-label="质检数据集">
    <header><h2><ClipboardText size={19} />质检数据集 <span>{projects.length}</span></h2><p>原表评分与问题标签独立管理，不混入意图分类，也不冒充模型实测得分。</p></header>
    <ul className="project-grid">{projects.map(project => <li key={project.id}><article className="project-card">
      <div className="project-card-top"><span className="project-symbol"><ClipboardText size={23} /></span><Badge tone="green">私有来源 · 已脱敏</Badge></div>
      <h2><a href={`#datasets?project=${project.id}`}>{project.name}</a></h2><p className="project-card-description">{project.channel === 'hotline' ? '人工评分与质检意见。原表未提供录音或对话正文。' : '脱敏对话文本、人工评分与质检问题标签。'}</p>
      <dl className="project-card-counts"><div><dt>质检记录</dt><dd>{number(project.totals.records)}</dd></div><div><dt>附带文本</dt><dd>{number(project.totals.transcriptRecords)}</dd></div></dl>
      <div className="project-card-labels"><span>7 项源表问题标签</span><span>空值保留，不自动补分</span></div>
      <footer className="project-card-footer"><span><ShieldCheck size={13} />启动时核验与恢复</span><a className="project-open" href={`#datasets?project=${project.id}`} aria-label={`查看质检项目：${project.name}`}>查看质检数据<ArrowRight size={15} /></a></footer>
    </article></li>)}</ul>
  </section>;
}

export function QualityProject({ project }: { project: QualityCorpus }) {
  const readRoute = () => { const params = new URLSearchParams(location.hash.split('?')[1] || ''); const page = Number(params.get('page')); return { selected: params.get('case') || '', page: Number.isInteger(page) && page > 0 ? page : 1 }; };
  const [route, setRoute] = useState(readRoute);
  const [listing, setListing] = useState<{ records: QualityRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [record, setRecord] = useState<QualityRecord | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { const changed = () => setRoute(readRoute()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setListing(null); setError('');
    fetch('/api/support/quality/records?' + new URLSearchParams({ project: project.id, page: String(route.page) }), { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || '质检记录读取失败'); if (!controller.signal.aborted) setListing(result); }).catch(problem => { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : '质检记录读取失败'); });
    return () => controller.abort();
  }, [project.id, route.page, retry]);
  useEffect(() => {
    const controller = new AbortController();
    setRecord(null); setDetailError('');
    if (route.selected) fetch(`/api/support/quality/records/${encodeURIComponent(route.selected)}?project=${encodeURIComponent(project.id)}`, { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok || result.datasetId !== project.id) throw new Error(result.error || '质检记录来源不匹配'); if (!controller.signal.aborted) setRecord(result); }).catch(problem => { if (!controller.signal.aborted) setDetailError(problem instanceof Error ? problem.message : '质检详情读取失败'); });
    return () => controller.abort();
  }, [project.id, route.selected, retry]);
  const navigate = (page: number, selected = '') => { location.hash = 'datasets?' + new URLSearchParams({ project: project.id, page: String(page), ...(selected ? { case: selected } : {}) }); };
  return <div className="dataset-projects quality-detail">
    <a className="project-back" href="#datasets"><ArrowLeft size={16} />返回项目集</a>
    <div className="page-head"><div><h1>{project.name}</h1><p>{project.nature}</p></div><Badge tone="green">已完成自动脱敏复核</Badge></div>
    <div className="quality-totals">{[['质检记录', project.totals.records], ['有人工总分', project.totals.scoredRecords], ['附带对话文本', project.totals.transcriptRecords], ['合格标注未填', project.totals.qualificationMissing]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{number(Number(value))}</strong></div>)}</div>
    <p className="quality-boundary">{project.boundary}</p>
    <div className="quality-case-layout">
      <Panel className="quality-case-list"><header><h2>来源记录</h2><span>点击一条查看标注与证据</span></header>
        {error ? <Empty title="暂时无法读取" description={error} action={<Button onClick={() => setRetry(value => value + 1)}>重新读取</Button>} /> : !listing ? <p role="status" className="quality-loading">正在读取质检记录…</p> : <>
          <div className="quality-table-scroll"><table><thead><tr><th>案例</th><th>人工总分</th><th>来源合格标注</th></tr></thead><tbody>{listing.records.map(item => <tr key={item.id} className={route.selected === item.id ? 'selected' : ''}><td><button onClick={() => navigate(route.page, item.id)} aria-label={`查看质检记录：第 ${item.row} 行`}>源表第 {item.row} 行<ArrowRight size={13} /></button></td><td>{item.goldScore ?? '未填写'}</td><td><Badge tone={item.qualified === null ? 'gray' : item.qualified ? 'green' : 'amber'}>{qualification(item.qualified)}</Badge></td></tr>)}</tbody></table></div>
          <footer><Button disabled={route.page === 1} onClick={() => navigate(route.page - 1)}><CaretLeft size={14} />上一页</Button><span>{route.page} / {Math.max(1, Math.ceil(listing.total / listing.pageSize))}</span><Button disabled={route.page * listing.pageSize >= listing.total} onClick={() => navigate(route.page + 1)}>下一页<CaretRight size={14} /></Button></footer>
        </>}
      </Panel>
      <Panel className="quality-record-detail">
        {detailError ? <Empty title="详情未能读取" description={detailError} action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} /> : !record ? <Empty title={route.selected ? '正在读取所选记录' : '选择一条质检记录'} description="查看源表总分、合格标注、七项问题标签及可用证据。这里不会自动评分。" /> : <>
          <header><div><h2>源表第 {record.provenance.row} 行</h2><p>{record.provenance.file} · {record.provenance.sheet}</p></div><span className="quality-score">{record.labels.goldScore ?? '未填写'}<small>源表人工总分</small></span></header>
          <p className="quality-label-note">源表合格标注：<strong>{qualification(record.labels.qualified)}</strong>。不根据总分反推合格阈值，不把源表标签当成模型输出。</p>
          <h3>七项质检问题标签</h3><dl className="quality-dimensions">{dimensions.map(([field, name]) => <div key={field}><dt>{name}<code>{field}</code></dt><dd>{record.labels.dimensions[field]?.length ? record.labels.dimensions[field].join('、') : <span>源表未填写，不推断为通过</span>}</dd></div>)}</dl>
          <h3>质检意见</h3><p className="quality-reason">{record.labels.reason || '源表未填写意见。'}</p>
          <h3>{record.transcript ? '对话文本 · 脱敏副本' : '原始证据未提供'}</h3>{record.transcript ? <><p className="quality-label-note">原文本行序保留，时间和身份信息已处理；{record.privacy.withheldLines} 行正文被隔离，不据此推断完整服务过程。</p><pre className="quality-transcript">{record.transcript}</pre></> : <p className="quality-missing-evidence">这份热线表没有录音或对话正文。当前只能核对原表标注，不能重放会话、独立验证得分或生成真实执行 Trace。</p>}
        </>}
      </Panel>
    </div>
  </div>;
}
