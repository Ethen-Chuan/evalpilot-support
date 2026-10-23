import { useEffect, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { Badge, Button } from './ui';
import { ConversationPlayback } from './ConversationPlayback';
import type { Case, LabState, Result } from './AgentLab';
import { LabelDiagnostics, ReplyReview, ReviewMethod } from './ReplyReview';

export function ResultEvidence({ row, state, runId, close }: { row: Result; state: LabState; runId?: string; close: () => void }) {
  const [snapshot, setSnapshot] = useState<Case | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setSnapshot(null); setError('');
    fetch(`/api/support/lab/case/${encodeURIComponent(row.caseId)}`).then(async response => {
      const value = await response.json();
      if (!response.ok || value.id !== row.caseId) throw new Error('原始案例读取失败，未显示其他案例内容。');
      if (active) setSnapshot(value);
    }).catch(() => { if (active) setError('无法读取本例输入与人工参考，可重试；模型原有答复与评分保持不变。'); });
    return () => { active = false; };
  }, [row.caseId, retry]);
  return <div className="reply-evidence-workspace">
    <div className="lab-result-meta"><Badge>{state.versions.find(version => version.id === row.versionId)?.name || '本次模型'}</Badge>{row.traceId && <button className="text-link" onClick={() => window.dispatchEvent(new CustomEvent('evalpilot:trace', { detail: row.traceId }))}>查看执行步骤<ArrowRight size={12} /></button>}<a className="text-link" href={`#knowledge?${new URLSearchParams({ session: row.sessionId, ...(runId ? { run: runId } : {}) })}`} onClick={close}>打开整段原始对话<ArrowRight size={13} /></a></div>
    {row.error && <div className="notice error">{row.error}</div>}
    <div className="lab-evidence-grid"><section><h3>当前输入 · 历史前缀</h3>{snapshot?.prefix ? <ConversationPlayback messages={snapshot.prefix} compact selectionMode={false} selected={[]} focusedId={null} query="" onSelect={() => {}} /> : error ? <div role="alert" className="notice error">{error}<Button onClick={() => setRetry(value => value + 1)}>重试案例证据</Button></div> : <p role="status">读取冻结快照…</p>}</section><section><h3>本次模型实际答复</h3><div className="lab-answer">{row.output?.answer || '未记录有效答复'}</div><ReplyReview row={row} sample={snapshot} />{row.sandbox && <details className="reply-sandbox"><summary>本次沙箱处理记录</summary><p>{row.sandbox.result}</p><p>仅本机沙箱建议，不代表已转接、已派单或已解决。</p></details>}</section></div>
    <details className="reply-history"><summary>历史人工下一轮原文 · 仅供参考</summary><p className="lab-reference">{snapshot?.reference?.content || '未加载到原文'}</p><small>原文未输入候选模型；人工回复本身不保证正确。</small></details>
    <LabelDiagnostics row={row} state={state} sample={snapshot} />
    <ReviewMethod />
    <details className="reply-record-ids"><summary>来源编号</summary><code>{row.sessionId}</code><code>{row.caseId}</code></details>
  </div>;
}
