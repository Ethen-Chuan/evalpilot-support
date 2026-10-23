import { Badge } from './ui';
import type { Case, LabState, Result } from './AgentLab';
import { diagnosticMatch, replyQuality, reviewDimensions } from './replyQuality';
import './reply-quality.css';

export function ReviewMethod() {
  return <details className="reply-review-method"><summary>这些评审意见怎么看？</summary><p>只展示本次已保存的模型裁判结果，不用标签匹配代替答复质量。0 分明显不合格、1 分较大问题、2 分部分可用、3 分基本合理、4 分充分且有依据；缺证据不记为 0 分。</p><p>任一维度 0–2 分提示「建议复核」；全部为 3–4 分显示「裁判认为基本合理」。这是复核分流规则，不是正式质检合格标准。转人工是否恰当尚无独立评分，权限边界评分也不等于完整安全质检；真实拦截率仍需线上转接和解决记录。</p></details>;
}

export function ReplyReview({ row, sample }: { row: Result; sample?: Case | null }) {
  const review = replyQuality(row);
  const evidence = new Map([...(sample?.prefix || []), ...(sample?.reference ? [sample.reference] : [])].map(message => [message.id, { content: message.content, role: message.role === 'user' ? '用户原话' : '历史客服原话' }]));
  if (row.output?.answer) evidence.set('candidate', { content: row.output.answer, role: '本次模型答复' });
  return <section className="reply-review" aria-label="答复质量评审">
    <header><strong>模型裁判意见</strong><Badge tone={review.tone}>{review.label}</Badge></header>
    <p className="reply-review-note">{review.note}</p>
    {review.reviewed && row.judgment && <><dl className="reply-review-scores">{reviewDimensions.map(dimension => <div key={dimension.key}><dt title={dimension.description}>{dimension.label}</dt><dd>{row.judgment!.dimensions[dimension.key] === null ? '证据不足' : `${row.judgment!.dimensions[dimension.key]} / 4`}</dd></div>)}</dl><p className="reply-review-reason">{row.judgment.reason}</p><details className="reply-review-evidence"><summary>查看裁判引用的原话 · {new Set(row.judgment.evidenceIds).size} 条</summary>{[...new Set(row.judgment.evidenceIds)].map(identifier => <article key={identifier}><strong>{evidence.get(identifier)?.role || '引用消息'}</strong><code>{identifier}</code><p>{evidence.get(identifier)?.content || '当前未加载到这条原文；请核对完整案例证据，不补造引用。'}</p></article>)}</details></>}
    {row.judgeError && <p className="reply-review-note">{row.judgeError}</p>}
  </section>;
}

export function LabelDiagnostics({ row, state, sample }: { row: Result; state: Pick<LabState, 'intents' | 'actions'>; sample?: Case | null }) {
  return <details className="reply-diagnostics"><summary>标签诊断 · 仅用于排查差异</summary><p>一致不等于答得好，不同也不等于答错；这些字段不参与上方的质量结论。</p><div className="reply-diagnostic-grid">{[
    { title: '问题分类', expected: state.intents[row.expectedIntent] || row.expectedIntent, actual: state.intents[row.output?.intent || ''] || row.output?.intent, match: row.intentMatch, source: '参考来自整段历史会话的人工意图标注；当前输入只是其中的历史前缀，可能存在信息差。' },
    { title: '下一步动作类别', expected: state.actions[row.expectedAction] || row.expectedAction, actual: state.actions[row.output?.action || ''] || row.output?.action, match: row.actionMatch, source: '参考由关键词规则从人工下一轮回复推断，尚未经逐条复核；模型类别是它自行声明的动作，不是已执行操作。' },
  ].map(item => <section key={item.title}><h4>{item.title}<span>{diagnosticMatch(item.match)}</span></h4><dl><div><dt>历史参考</dt><dd>{item.expected || '未记录'}</dd></div><div><dt>模型输出</dt><dd>{item.actual || '未记录'}</dd></div></dl><p>{item.source}</p></section>)}</div><h4>行为弱标签取自这条人工原文</h4><p className="reply-diagnostic-source">{sample?.reference?.content || '当前未加载原文，请打开完整案例证据核对。'}</p><p>例如规则可能将“请提供型号”归为补充信息。同一回复可能包含多种动作，当前规则按优先顺序只取一类，所以不能作为标准操作答案。</p></details>;
}
