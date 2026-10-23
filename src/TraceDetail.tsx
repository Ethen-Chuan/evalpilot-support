import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CaretDown, CheckCircle, CircleNotch, DownloadSimple, Plus, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText } from './ui';
import { intentNames } from './CorpusLabels';
import { traceBar, traceCandidateModels, traceElapsed, traceKinds, traceLabels, traceReturnUrl, traceSpanDepths, traceValueSummary } from './tracePresentation';
import type { TraceRecord } from './tracePresentation';
import './trace-detail.css';

export function TraceStatus({ status }: { status: string }) {
  return <Badge tone={status === 'ok' ? 'green' : status === 'error' || status === 'interrupted' ? 'red' : status === 'blocked' || status === 'running' ? 'amber' : 'gray'}>{status === 'running' ? <CircleNotch className="spin" size={12} /> : status === 'ok' ? <CheckCircle size={12} /> : <WarningCircle size={12} />}{traceLabels[status] || status}</Badge>;
}

function JsonBox({ value }: { value: unknown }) {
  return value == null ? <p className="trace-no-data">未记录该字段</p> : <pre className="trace-json">{JSON.stringify(value, null, 2)}</pre>;
}

function ReadablePayload({ value, kind }: { value: unknown; kind: string }) {
  const summary = traceValueSummary(value, intentNames);
  return <>
    {summary.text && <div className="trace-readable-answer">{summary.text}</div>}
    {summary.facts.length > 0 && <dl className="trace-facts">{summary.facts.map(fact => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    {!summary.text && !summary.facts.length && <p className="trace-no-data">{summary.hasValue ? '已记录结构化数据，可在技术详情中查看。' : '该步骤尚未记录输出，不推断为已完成。'}</p>}
    {summary.hasLabels && <p className="trace-inline-note">标签一致不代表答复正确；行为弱标签来自人工话术推导，不是实际操作日志。</p>}
    {kind === 'model' && !summary.text && <p className="trace-inline-note">该调用步骤仅记录模型与用量。查看整体执行，可阅读本次最终答复。</p>}
  </>;
}

export function TraceDetail({ trace, choose, run, conversation, createAction, pending }: { trace: TraceRecord; choose: (id: string | null) => void; run: (id: string) => void; conversation: (id: string) => void; createAction: () => void; pending: boolean }) {
  const [spanId, setSpanId] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const [filter, setFilter] = useState('all');
  const selected = trace.spans.find(span => span.id === spanId) || trace.spans.find(span => ['error', 'blocked', 'interrupted'].includes(span.status) && span.parentId) || trace.spans[0];
  const depths = useMemo(() => traceSpanDepths(trace.spans), [trace.spans]);
  const models = traceCandidateModels(trace.spans);
  const back = traceReturnUrl(location.hash, trace.runId);
  const visibleSpans = trace.spans.filter(span => filter === 'all' || (filter === 'issues' ? ['error', 'blocked', 'interrupted'].includes(span.status) : span.kind === filter));
  const selectSpan = (identifier: string) => { setSpanId(identifier); setTechnical(false); };

  return <article className="trace-detail">
    <nav className="trace-breadcrumbs" aria-label="本次执行导航">
      <button onClick={() => choose(null)}>执行记录</button><span>/</span>
      {back ? <a href={back}><ArrowLeft size={13} />{back.startsWith('#overview') ? '返回结果大盘' : '返回本批评测'}</a> : trace.runId ? <button onClick={() => run(trace.runId!)}>关联评测</button> : <span>单次执行</span>}
      {trace.sessionId && <button className="trace-conversation-link" onClick={() => conversation(trace.sessionId!)}>查看原始完整对话<ArrowRight size={14} /></button>}
    </nav>
    <header className="trace-detail-heading"><div><h1>{trace.name}</h1><p>{trace.categoryName || '执行追踪'} · {trace.sourceName || trace.source} · <DateText value={trace.startedAt} /></p></div><TraceStatus status={trace.status} /></header>
    <div className="trace-summary-line"><span>总耗时 <strong>{traceElapsed(trace.durationMs)}</strong></span><span>已记录步骤 <strong>{trace.spans.length}</strong></span>{models.length > 0 && <span>候选模型 <strong>{models.join(' / ')}</strong></span>}<small>执行成功 ≠ 业务正确</small></div>
    {trace.issues.length > 0 && <div className="trace-issues">{trace.issues.map((issue, index) => <button key={`${issue.code}-${index}`} onClick={() => { setFilter('all'); selectSpan(issue.spanId); }}><WarningCircle size={16} /><span><strong>{issue.kind === 'quality' ? '质量信号' : issue.kind === 'safety' ? '安全边界' : '执行状态'}</strong>{issue.message}</span><ArrowRight size={15} /></button>)}</div>}
    <section className="trace-console" aria-label="执行分析工作区">
      <div className="trace-step-pane">
        <header className="trace-step-heading"><h2>处理步骤</h2><span>点击查看结果</span></header>
        {trace.spans.length > 10 && <div className="trace-step-filters" aria-label="步骤分类">{[['all', '全部'], ['model', '模型'], ['tool', '工具'], ['issues', '异常']].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>}
        <div className="trace-step-scale"><span>步骤 / 类型</span><span>时间位置</span><span>耗时</span></div>
        <div className="trace-step-list" role="group" aria-label="选择执行步骤">{visibleSpans.length ? visibleSpans.map(span => {
          const bar = traceBar(span, trace.durationMs);
          return <button key={span.id} className={`trace-step-row ${selected?.id === span.id ? 'selected' : ''}`} aria-pressed={selected?.id === span.id} onClick={() => selectSpan(span.id)}>
            <span className="trace-step-name" style={{ paddingLeft: (depths.get(span.id) || 0) * 10 }}><i className={`span-dot ${span.status}`} /><span><strong>{span.parentId ? span.name : '整体执行'}</strong><small>{traceKinds[span.kind] || span.kind} · {traceLabels[span.status] || span.status}</small></span></span>
            <span className="trace-step-track" aria-hidden="true">{bar && <i className={span.status} style={{ left: `${bar.start}%`, width: `${bar.width}%` }} />}</span><span className="trace-step-time">{traceElapsed(span.durationMs)}</span>
          </button>;
        }) : <p className="trace-no-data">此分类没有已记录步骤。</p>}</div>
        <p className="trace-step-caption">条形表示时间位置；父步骤包含子步骤，耗时不可直接相加。</p>
      </div>
      <section className="trace-result-pane" aria-label="所选步骤结果">
        {selected ? <>
          <header className="trace-result-heading"><div><h2>{selected.parentId ? selected.name : '本次执行结果'}</h2><span>{selected.parentId ? `起点 +${traceElapsed(selected.startMs)} · ${traceElapsed(selected.durationMs)}` : '实际记录的答复与处理结果，不补造内容'}</span></div><div className="trace-view-switch" role="group" aria-label="结果查看方式"><button aria-pressed={!technical} onClick={() => setTechnical(false)}>结果摘要</button><button aria-pressed={technical} onClick={() => setTechnical(true)}>技术详情</button></div></header>
          <div className="trace-result-scroll" key={selected.id}>
            {selected.error && <div role="alert" className="trace-step-error"><WarningCircle size={17} /><div><strong>{selected.error.type}</strong><p>{selected.error.message}</p></div></div>}
            {!technical ? <><ReadablePayload value={selected.output} kind={selected.kind} />{selected.input != null && <details className="trace-input-disclosure"><summary>本步骤输入<CaretDown size={14} /></summary><JsonBox value={selected.input} /></details>}</> : <div className="trace-technical"><h3>输入 · 记录前脱敏</h3><JsonBox value={selected.input} /><h3>输出 · 实际返回</h3><JsonBox value={selected.output} /><h3>执行属性</h3><JsonBox value={selected.attributes} />{selected.parentId && <button className="text-link" onClick={() => { setFilter('all'); selectSpan(selected.parentId!); }}>查看父步骤<ArrowRight size={13} /></button>}<h3>步骤编号</h3><code>{selected.id}</code>{selected.events?.length > 0 && <><h3>事件 · {selected.events.length}</h3><JsonBox value={selected.events} /></>}{selected.error && <><h3>异常代码位置</h3>{selected.error.frames?.length ? selected.error.frames.map((frame, index) => <div className="trace-error-frame" key={index}><code>{frame.file}:{frame.line}</code><span>{frame.function}</span></div>) : <p className="trace-no-data">未记录代码位置，不编造堆栈。</p>}</>}</div>}
          </div>
        </> : <p className="trace-no-data">尚无已记录步骤。</p>}
      </section>
    </section>
    <details className="trace-record-details"><summary><span>记录信息与导出<small>编号、版本、关联事件</small></span><CaretDown size={15} /></summary><div className="trace-record-body"><dl className="trace-record-facts"><div><dt>Trace</dt><dd><code>{trace.id}</code></dd></div>{trace.runId && <div><dt>评测批次</dt><dd><code>{trace.runId}</code></dd></div>}{trace.sessionId && <div><dt>来源会话</dt><dd><code>{trace.sessionId}</code></dd></div>}<div><dt>记录来源</dt><dd>{trace.origin === 'local_instrumented' ? '本机实际埋点' : '外部 Agent 自报'}</dd></div><div><dt>耗时范围</dt><dd>{trace.durationScope}</dd></div></dl><h3>版本与运行属性</h3><JsonBox value={trace.attributes} />{trace.annotations.length > 0 && <><h3>关联事件</h3>{trace.annotations.map((annotation, index) => <div className="trace-annotation" key={index}><strong>{annotation.name}</strong><small><DateText value={annotation.at} /></small><JsonBox value={annotation.attributes} /></div>)}</>}<p className="trace-inline-note">{trace.redaction}；对外分享前仍需人工复核。</p><div className="trace-record-actions"><a className="download-link" href={`/api/support/traces/${encodeURIComponent(trace.id)}/export.json`} download><DownloadSimple size={15} />导出脱敏 JSON</a>{trace.conversationId && <Button onClick={createAction} disabled={pending}><Plus size={14} />建立排查任务</Button>}</div></div></details>
    <p className="trace-footnote"><ShieldCheck size={14} />{trace.source.startsWith('aftersales.') ? '当前售后评测中的业务动作仅为沙箱建议，不代表真实退款、派单或转人工已完成。' : '仅展示已记录的操作。步骤执行状态不代替业务结果或用户满意度。'}</p>
  </article>;
}
