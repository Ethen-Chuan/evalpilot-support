import { useEffect, useState } from 'react';
import { ArrowClockwise, CaretLeft, CaretRight, ChatCircleText, GitBranch, Robot, User } from '@phosphor-icons/react';
import { Badge, Button, Panel, SearchInput } from './ui';
import { ConversationPlayback } from './ConversationPlayback';
import type { ConversationMessage } from './ConversationPlayback';
import type { Case, LabState, Result, Run, Version } from './AgentLab';
import './case-comparison.css';
import { ReplyReview, LabelDiagnostics } from './ReplyReview';

type Side = { run: Run; version: Version };
type CaseItem = { id: string; sessionId: string; title: string; question: string; statuses: string[]; different: boolean };
type Evidence = { models: Version[]; runIds: string[]; runStatuses: string[]; cases: CaseItem[]; selected: Case; results: (Result | null)[]; caseHash: string };
export type ComparisonPreset = { caseId: string; modelKeys: string[]; sourceRunId: string; judgeId: string | null };

export function CaseConversation({ sample }: { sample: Case }) {
  const messages = (sample.prefix || []).map((message, index) => ({ ...message, sequence: message.sequence || index + 1, metadata: message.metadata || {} })) as ConversationMessage[];
  const question = [...messages].reverse().find(message => message.role === 'user');
  return <div className="case-shared-context">
    <div className="case-question"><div className="case-speaker"><User size={17} /><span>客户 · 同一案例</span></div><div className="case-question-bubble">{question?.content || '该记录未提供客户问题，请查看完整上下文。'}</div></div>
    <details className="case-context-detail" key={sample.id}><summary>查看共同输入 · {messages.length} 条历史消息</summary><p>两边读取相同的历史前缀；原人工目标回复和后续消息不提供给候选模型。</p><ConversationPlayback messages={messages} compact selectionMode={false} selected={[]} focusedId={null} query="" onSelect={() => {}} /></details>
    {sample.contextLimited && <p className="case-limit">此案例含脱敏占位或未导入媒体；当前是文本回放，无法据此验证图片理解。</p>}
  </div>;
}

function ModelReply({ version, row, runStatus, label, state, sample, inspect }: { version: Version; row: Result | null; runStatus: string; label: string; state: LabState; sample: Case; inspect: (row: Result) => void }) {
  const completed = row?.status === 'completed';
  const waiting = !row && ['running', 'cancelling'].includes(runStatus);
  const status = completed ? '已回复' : row?.status === 'failed' ? '执行失败' : waiting ? '等待执行' : '未执行';
  return <article className="case-model-reply" aria-label={`模型 ${label} 的回复与处理`}>
    <header><div className="case-model-identity"><span className="text-model-letter">{label}</span><div><h3>{version.name}</h3><small>{version.kind === 'local' || version.provider === 'local' ? '本地行为模型 · 模板答复' : `${version.provider} · ${version.model || '外部模型'}`}</small></div></div><Badge tone={row?.status === 'failed' ? 'red' : 'gray'}>{status}</Badge></header>
    <div className="case-reply-content">
      <div className="case-speaker"><Robot size={17} /><span>客服回复</span>{row?.latencyMs != null && <small title="候选执行墙钟耗时，不含裁判，不是生产 SLA">{row.latencyMs.toFixed(0)} ms</small>}</div>
      <div className={`case-answer ${completed ? '' : 'case-answer-empty'}`}>{completed ? row.output?.answer || '本条未记录答复文本' : row?.error || (waiting ? '正在等待此模型的执行结果，完成后自动显示。' : '本次没有完成此模型调用，不补造回复。')}</div>
      {completed && <dl className="case-handling"><div><dt>理解的诉求</dt><dd>{state.intents[row.output?.intent || ''] || row.output?.intent || '未记录'}</dd></div><div><dt>选择的处理动作</dt><dd>{state.actions[row.output?.action || ''] || row.output?.action || '未记录'}</dd></div><div><dt>本次执行记录</dt><dd>{row.sandbox?.result || '未记录执行结果'}{row.sandbox?.draftId && <small>草稿编号：{row.sandbox.draftId}</small>}</dd></div></dl>}
      <p className="case-execution-boundary">{row?.sandbox ? '仅本地沙箱操作；没有接通真实坐席、派单或维修系统，不代表问题已解决。' : '没有生产系统执行凭据，不能视为已转人工、已派单或已解决。'}</p>
      {row && <><ReplyReview row={row} sample={sample} /><LabelDiagnostics row={row} state={state} sample={sample} /></>}
    </div>
    <footer>{row?.traceId && <button className="text-link" onClick={() => window.dispatchEvent(new CustomEvent('evalpilot:trace', { detail: row.traceId }))}><GitBranch size={15} />查看执行 Trace</button>}{row && <button className="text-link" onClick={() => inspect(row)}>核对原始证据</button>}</footer>
  </article>;
}

export function CaseComparison({ left, right, state, inspect, rerun }: { left: Side; right: Side; state: LabState; inspect: (row: Result) => void; rerun: (preset: ComparisonPreset) => void }) {
  const [caseId, setCaseId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [loaded, setLoaded] = useState<{ key: string; value: Evidence } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const key = `${left.run.id}:${left.version.id}:${right.run.id}:${right.version.id}:${caseId}`;
  const evidence = loaded?.key === key ? loaded.value : null;
  useEffect(() => {
    let active = true;
    setError('');
    fetch('/api/support/lab/compare/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sides: [left, right].map(side => ({ runId: side.run.id, versionId: side.version.id })), ...(caseId ? { caseId } : {}) }) })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || '案例证据读取失败'); return value as Evidence; })
      .then(value => { if (active) setLoaded({ key, value }); })
      .catch(problem => { if (active) { setLoaded(null); setError(problem instanceof Error ? problem.message : '案例证据读取失败'); } });
    return () => { active = false; };
  }, [key, left.run.completed, right.run.completed, left.run.status, right.run.status, retry]);
  const available = evidence?.cases || [];
  const matching = available.filter(item => (filter === 'all' || filter === 'different' && item.different || filter === 'failed' && item.statuses.some(status => status !== 'completed')) && `${item.question} ${item.title} ${item.sessionId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedId = evidence?.selected.id;
  const position = matching.findIndex(item => item.id === selectedId);
  useEffect(() => { if (evidence && position < 0 && matching.length) setCaseId(matching[0].id); }, [evidence, position, matching[0]?.id]);
  return <section className="case-arena" aria-label="同一案例双模型对话">
    <div className="case-arena-toolbar"><h2><ChatCircleText size={19} />逐例对话</h2><span>同一个问题，两种处理</span>{evidence && <Button onClick={() => rerun({ caseId: evidence.selected.id, modelKeys: evidence.models.map(version => version.connectionId || version.id), sourceRunId: evidence.runIds[0], judgeId: left.run.judgeId })}><ArrowClockwise size={15} />重跑此案例</Button>}</div>
    {error ? <div className="notice error" role="alert">{error}<Button onClick={() => setRetry(value => value + 1)}>重试案例读取</Button></div> : !evidence ? <Panel className="case-evidence-loading"><p role="status">正在读取同一案例的输入、回复和处理记录…</p></Panel> : <>
      <div className="case-browser"><SearchInput value={query} onChange={setQuery} placeholder="搜索客户问题或案例编号" /><select className="select" aria-label="案例结果筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部案例 · {available.length}</option><option value="different">回复或动作不同</option><option value="failed">失败或未完成</option></select><div className="case-paging"><Button disabled={position <= 0} onClick={() => setCaseId(matching[position - 1].id)} title="上一个案例"><CaretLeft size={15} /></Button><span>{position < 0 ? 0 : position + 1} / {matching.length}</span><Button disabled={position < 0 || position >= matching.length - 1} onClick={() => setCaseId(matching[position + 1].id)} title="下一个案例"><CaretRight size={15} /></Button></div></div>
      {!matching.length ? <p className="case-no-match">没有匹配的案例。清除搜索或改为「全部案例」即可继续查看。</p> : <>
        <label className="case-selector">当前案例<select className="select" aria-label="查看对话案例" value={position < 0 ? '' : selectedId} onChange={event => setCaseId(event.target.value)}>{position < 0 && <option value="">正在切换…</option>}{matching.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.question || item.title} · {item.sessionId}</option>)}</select></label>
        {position >= 0 && <><CaseConversation sample={evidence.selected} /><div className="case-reply-pair">{evidence.models.map((version, index) => <ModelReply key={`${index}:${version.id}:${selectedId}`} version={version} row={evidence.results[index]} runStatus={evidence.runStatuses[index]} label={index === 0 ? 'A' : 'B'} state={state} sample={evidence.selected} inspect={inspect} />)}</div><details className="case-human-reference" key={selectedId}><summary>历史人工客服如何回复（仅供复核，未输入候选模型）</summary><div>{evidence.selected.reference?.content || '未提供人工参考'}</div><p>人工回复不天然正确，也不能证明问题已解决。</p><a className="text-link" href={`#knowledge?session=${encodeURIComponent(evidence.selected.sessionId)}&run=${encodeURIComponent(evidence.runIds[0])}`}>查看整段原始对话</a></details></>}
      </>}
    </>}
  </section>;
}
