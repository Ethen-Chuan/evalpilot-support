import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Panel, SearchInput } from './ui';
import type { LabState, Result, Run } from './AgentLab';
import { matchesReviewFilter, replyQuality, reviewCounts, reviewFilters } from './replyQuality';
import type { ReviewFilter } from './replyQuality';
import { ReviewMethod } from './ReplyReview';

export function ReplyResults({ state, run, loading, inspect, reviewAgain }: { state: LabState; run: Run | null; loading: boolean; inspect: (row: Result) => void; reviewAgain: () => void }) {
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); setQuery(''); setFilter('all'); }, [run?.id]);
  const results = run?.results || [];
  const counts = reviewCounts(results);
  const caseIds = [...new Set([...(run?.caseIds || []), ...results.map(row => row.caseId)])];
  const caseLabel = (row: Result) => `案例 ${String(caseIds.indexOf(row.caseId) + 1).padStart(3, '0')}`;
  const modelLabel = (row: Result) => run?.models.find(version => version.id === row.versionId)?.name || state.versions.find(version => version.id === row.versionId)?.name || '模型未记录';
  const matching = results.filter(row => matchesReviewFilter(row, filter) && `${row.sessionId} ${row.caseId} ${caseLabel(row)} ${modelLabel(row)} ${row.output?.answer || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totalPages = Math.max(1, Math.ceil(matching.length / 20));
  const currentPage = Math.min(page, totalPages);
  const live = ['running', 'cancelling'].includes(run?.status || '');
  return <Panel className="lab-section reply-results">
    <div className="lab-section-head"><div><h2>逐例答复与评审</h2><p>先看实际答复，再看裁判意见；标签差异收在案例详情中。</p></div>{run && counts.unreviewed > 0 && <Button disabled={live || loading} onClick={reviewAgain}>选择裁判并重跑</Button>}</div>
    <div className="reply-results-tools"><SearchInput value={query} onChange={value => { setQuery(value); setPage(1); }} placeholder="搜索答复、模型或案例编号" /><label>筛选<select aria-label="答复评审筛选" className="select" value={filter} onChange={event => { setFilter(event.target.value as ReviewFilter); setPage(1); }}>{reviewFilters.map(item => <option value={item.key} key={item.key}>{item.label} · {counts[item.key]}</option>)}</select></label></div>
    {loading ? <p role="status" className="lab-no-data">正在读取本批答复与评审…</p> : results.length ? <>
      <p className="reply-results-counts" role="status">{caseIds.length} 个案例 · 已记录 {results.length} 条执行结果 · {results.filter(row => replyQuality(row).reviewed).length} 条有裁判记录{counts.unreviewed > 0 && <span>有 {counts.unreviewed} 条评审未完成，不计作合格或不合格。</span>}</p>
      {matching.length ? <table className="reply-results-table"><thead><tr><th>案例 / 模型</th><th>实际答复</th><th>裁判意见</th><th>执行耗时</th><th>查看</th></tr></thead><tbody>{matching.slice((currentPage - 1) * 20, currentPage * 20).map(row => {
        const review = replyQuality(row);
        return <tr key={row.caseId + ':' + row.versionId} data-review-status={review.status}><td data-label="案例 / 模型"><strong>{caseLabel(row)}</strong><span>{modelLabel(row)}</span></td><td data-label="实际答复"><p className="reply-answer-preview">{row.output?.answer || (row.status === 'failed' ? '执行失败，未生成答复。' : '尚未记录答复。')}</p></td><td data-label="裁判意见"><Badge tone={review.tone}>{review.label}</Badge><small>{review.reviewed ? row.judgment?.reason : review.note}</small></td><td data-label="执行耗时"><span title="候选执行耗时，不包含裁判，不是生产响应 SLA">{row.latencyMs != null && Number.isFinite(row.latencyMs) ? `${(row.latencyMs / 1000).toFixed(2)} s` : '未记录'}</span></td><td data-label="查看"><Button onClick={() => inspect(row)}>查看对话与结果</Button></td></tr>;
      })}</tbody></table> : <Empty title="没有符合筛选条件的结果" description="调整筛选或清除搜索，不需要重新运行模型。" action={<Button onClick={() => { setFilter('all'); setQuery(''); setPage(1); }}>显示全部结果</Button>} />}
      <div className="pagination"><span>{matching.length} 条结果 · 第 {currentPage} / {totalPages} 页</span><div><Button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>
    </> : <Empty title="暂无已记录的模型答复" description="完成案例评测后显示实际答复；未运行裁判的结果会标为未评审。" />}
    <ReviewMethod />
  </Panel>;
}
