import { useState } from 'react';
import { BookOpen, CheckCircle, ListChecks, ShieldCheck, Warning } from '@phosphor-icons/react';
import { Badge, Button, Empty } from './ui';
import { plainLanguage } from './simulatorPresentation';

export type RubricDimension = { id: string; title: string; weight: number; owner: 'machine' | 'human'; anchors: string[]; proof: string; level?: number | null; points?: number | null; evidence?: string };
export type RubricDefinition = { version: string; dimensions: RubricDimension[]; redlines: string[]; formula: string; acceptance: string; calibration: string; aggregation: string };
export type RubricScore = { version: string; dimensions: RubricDimension[]; automaticPoints: number; automaticPossible: number; pendingWeight: number; coverage: number; finalScore: number | null; scoreRange: number[]; redlines: string[]; verdict: string; review: unknown; scope: string };
export type KnowledgeState = { activeId: string; activeHash: string; documents: { id: string; version: string; title: string; source: string; aliases: string[]; policy: string; effectiveFrom: string; expiresAt: string | null }[]; releases: { id: string; previousId: string | null }[]; scope: string };
export type AttemptSummary = { id: string; sessionId: string; status: string; traceId: string; lastStep: string; eventCount: number; error?: string };
type ReviewTurn = { id: string; output: { answer: string }; evaluation: { rubric?: RubricScore }; publication?: { status: string; reasons: string[]; evidence: { code: string; reference: string; source: string; text: string }[] }; proposal?: unknown };
const verdicts: Record<string, string> = { BLOCK: '不合规答复已拦截', PENDING_REVIEW: '质量待人工评分', PASS: '质量验收通过', FAIL: '质量验收未通过' };

export function RubricSummary({ rubric, onOpen }: { rubric: RubricScore; onOpen?: () => void }) {
  return <section className="sim-rubric-summary" aria-label="本轮量化评分">
    <div><span>自动检查</span><strong>{rubric.automaticPoints}<small> / {rubric.automaticPossible}</small></strong></div>
    <div><span>最终质量分</span><strong>{rubric.finalScore === null ? '待评' : rubric.finalScore}<small>{rubric.finalScore === null ? '人工20分未评' : ' / 100'}</small></strong></div>
    <p><Badge tone={rubric.verdict === 'PASS' ? 'green' : rubric.redlines.length ? 'red' : 'amber'}>{verdicts[rubric.verdict] || rubric.verdict}</Badge>{rubric.redlines.length ? '红线不能用总分抵消' : '规则通过不等于客户问题解决'}</p>
    {onOpen && <Button onClick={onOpen}><ListChecks size={15} />查看分档与人工评分</Button>}
  </section>;
}

export function RubricWorkbench({ definition, turn, busy, readOnly = false, onReview }: { definition: RubricDefinition; turn?: ReviewTurn; busy: boolean; readOnly?: boolean; onReview: (body: Record<string, unknown>) => Promise<void> }) {
  const [levels, setLevels] = useState<Record<string, string>>({ resolution: '', communication: '' });
  const [quotes, setQuotes] = useState<Record<string, string>>({ resolution: '', communication: '' });
  const [reasons, setReasons] = useState<Record<string, string>>({ resolution: '', communication: '' });
  const [redline, setRedline] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const rubric = turn?.evaluation.rubric;
  const humanDimensions = definition.dimensions.filter(item => item.owner === 'human');
  const ready = !!turn && confirmed && humanDimensions.every(item => levels[item.id] !== '' && quotes[item.id].trim().length >= 4 && reasons[item.id].trim().length >= 8);
  return <section className="sim-governance sim-rubric-workbench">
    <header><div><small>答复质量评分标准</small><h2>不是凭感觉打分，每一档都要有依据。</h2><p>6 个维度 · 每维0–4档，按具体表现评分 · 100 分制 · 一票否决与质量分分开</p></div><Badge tone="blue">自动80分 + 人工20分</Badge></header>
    <div className="sim-rubric-layout"><div>
      <div className="sim-rule-note"><strong>计算和验收规则</strong><p>{plainLanguage(definition.formula || '')}</p><p>{plainLanguage(definition.acceptance || '')}</p></div>
      <div className="sim-rubric-dimensions">{definition.dimensions.map(item => <details key={item.id} className="sim-rubric-dimension" open={item.id === 'evidence'}><summary><span><strong>{item.title}</strong><small>{item.owner === 'machine' ? '自动检查' : '人工评分'} · 需要对应证据</small></span><b>{item.weight}<small>分</small></b></summary><ol start={0}>{item.anchors.map((anchor, index) => <li key={anchor}><b>{index}档</b><span>{plainLanguage(anchor)}</span><small>{item.weight * index / 4}分</small></li>)}</ol><p><BookOpen size={14} />证据：{plainLanguage(item.proof || '')}</p></details>)}</div>
      <div className="sim-rule-note redline"><h3><ShieldCheck size={18} />这些问题不能被高分掩盖</h3><ul>{definition.redlines.map(item => <li key={item}>{plainLanguage(item)}</li>)}</ul><p>例如：虚构已经退款、冒险指导拆机，或没有依据却承诺免费，都不能因为其他项目得分高而判为合格。</p></div>
      <details className="sim-methodology"><summary>评分校准与批量统计口径</summary><p>{plainLanguage(definition.calibration || '')}</p><p>{plainLanguage(definition.aggregation || '')}</p></details>
    </div><aside className="sim-rubric-current">
      <h3>当前选中回合</h3>{rubric && turn ? <>
        <RubricSummary rubric={rubric} />
        <div className="sim-dimension-scores">{rubric.dimensions.map(item => <div key={item.id}><span>{item.title}<small>{item.level == null ? '待人工判断' : `${item.level}档 · ${plainLanguage(item.anchors[item.level])}`}</small><small>证据：{plainLanguage(item.evidence || '')}</small></span><b>{item.points ?? '—'}<small>/{item.weight}</small></b></div>)}</div>
        <details className="sim-review-answer"><summary>查看本轮实际展示的答复</summary><p>{turn.output.answer}</p></details>
        {!!rubric.redlines.length && <div className="sim-notice error"><Warning size={18} /><span>本轮候选答复有严重问题。即使人工给满分，也不能改判通过；安全提示不会替有问题的答复拿分。</span></div>}
        {!rubric.review && readOnly ? <div className="sim-rule-note">旧版本记录仅供查看，不改写历史评分。请新建会话后评分。</div> : !rubric.review ? <form className="sim-human-review" onSubmit={event => { event.preventDefault(); if (ready) void onReview({ turnId: turn.id, levels: Object.fromEntries(Object.entries(levels).map(([key, value]) => [key, Number(value)])), evidence: Object.fromEntries(humanDimensions.map(item => [item.id, { quote: quotes[item.id], reason: reasons[item.id] }])), redline, confirmed }); }}>
          <h3>完成有依据的人工评分</h3>{humanDimensions.map(item => <fieldset key={item.id}><legend>{item.title} · {item.weight}分</legend><label>表现档位<select aria-label={`${item.title}档位`} value={levels[item.id]} onChange={event => setLevels({ ...levels, [item.id]: event.target.value })}><option value="">请选择，不默认满分</option>{item.anchors.map((anchor, index) => <option key={anchor} value={index}>{index}档 · {plainLanguage(anchor)}</option>)}</select></label><label>引用答复中的原句<input aria-label={`${item.title}引用`} value={quotes[item.id]} maxLength={240} onChange={event => setQuotes({ ...quotes, [item.id]: event.target.value })} placeholder="至少4字，必须真实出现在本轮答复" /></label><label>为何符合这一档<textarea aria-label={`${item.title}理由`} value={reasons[item.id]} maxLength={500} onChange={event => setReasons({ ...reasons, [item.id]: event.target.value })} placeholder="至少8字，解释判断而非只写“很好”" /></label></fieldset>)}
          <label className="sim-check-label"><input type="checkbox" checked={redline} onChange={event => setRedline(event.target.checked)} />发现实质安全或事实错误，人工追加红线</label>
          <label className="sim-check-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对上下文与引用，确认保存这次评分</label>
          <Button primary disabled={busy || !ready} type="submit">提交人工评分</Button><p>记录为本机操作者，不冒充已认证的专家或双人审核。</p>
        </form> : <div className="sim-rule-note"><CheckCircle size={18} /><strong>人工评分已保存</strong>{rubric.dimensions.filter(item => item.owner === 'human').map(item => <p key={item.id}>{item.title}：{plainLanguage(item.evidence || '')}</p>)}</div>}
      </> : <Empty title="先运行一轮会话" description="旧版记录保留原始成绩，不自动换算。新回合运行后，在这里逐项核对与评分。" />}
    </aside></div>
  </section>;
}
