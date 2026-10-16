import { useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Empty, Panel, PanelHead } from './ui';
import type { LearningState } from './ConversationLearning';
import './experience-charts.css';

type Ratio = { value: number | null; numerator: number; denominator: number };
export type QualityAnalytics = { total: number; changed: number; maintained: number; unresolved: number; conflict: number; changedRate: Ratio; coverage: Ratio; localCompletion: Ratio; classifications: Record<string, string>; slices: (Ratio & { id: string; name: string; count: number })[]; scope: string };
export type ModelAnalysis = { runId: string; total: number; models: { id: string; name: string; provider: string; correct: number; completed: number; failed: number; missing: number; conflict: number; accuracy: Ratio }[]; cumulative: { seen: number; models: Record<string, Ratio> }[]; scope: string };
type Trend = { runId: string; at: string; model: string; modelId: string; intent: number | null; correct: number; count: number; total: number };
type Slice = { id: string; name: string; count: number; color: string };
const colors = { blue: 'var(--chart-blue)', teal: 'var(--chart-teal)', orange: 'var(--chart-orange)', gray: 'var(--chart-gray)', coral: 'var(--chart-coral)' };
export const chartPercent = (value: number | null | undefined) => value == null ? '暂无' : `${value.toFixed(1)}%`;

export function Donut({ slices, value, label, size = 208, onSelect }: { slices: Slice[]; value: string; label: string; size?: number; onSelect?: (id: string) => void }) {
  const parts = slices.filter(slice => slice.count > 0);
  const total = parts.reduce((sum, slice) => sum + slice.count, 0);
  return <div className="cx-donut" style={{ width: size, height: size }} role="img" aria-label={`${label} ${value}；${slices.map(slice => `${slice.name}${slice.count}`).join('，')}`}>
    <PieChart width={size} height={size}><Pie data={parts.length ? parts : [{ id: 'empty', name: '暂无样本', count: 1, color: colors.gray }]} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius={size * .34} outerRadius={size * .46} startAngle={90} endAngle={-270} paddingAngle={parts.length > 1 ? 2 : 0} cornerRadius={3} stroke="none" isAnimationActive={false} onClick={(_, index) => { if (parts[index]) onSelect?.(parts[index].id); }}>{(parts.length ? parts : [{ id: 'empty', color: colors.gray }]).map(slice => <Cell key={slice.id} fill={slice.color} cursor={onSelect ? 'pointer' : 'default'} />)}</Pie>{total > 0 && <Tooltip contentStyle={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }} formatter={value => [`${value}条 · ${chartPercent(Number(value) / total * 100)}`, '']} />}</PieChart>
    <div className="cx-donut-center"><strong>{value}</strong><span>{label}</span></div>
  </div>;
}

export function QualityOverview({ analytics, select, selected = 'all' }: { analytics: QualityAnalytics; select: (filter: string) => void; selected?: string }) {
  const slices = analytics.slices.map(slice => ({ ...slice, color: ({ changed: colors.blue, maintained: colors.teal, unresolved: colors.gray, conflict: colors.orange } as Record<string, string>)[slice.id] }));
  return <Panel className="cx-quality-chart"><PanelHead title="质检复核 · 比例与证据" description="整环代表全部导入复核记录；点击图例，核对对应原始记录。" action={<Badge>{analytics.total}条来源记录</Badge>} />
    <div className="cx-quality-chart-body"><Donut slices={slices} value={chartPercent(analytics.coverage.value)} label="可核对覆盖率" onSelect={select} /><div className="cx-chart-legend">{slices.map(slice => <button key={slice.id} disabled={!slice.count} aria-pressed={selected === slice.id} onClick={() => select(slice.id)}><i style={{ background: slice.color }} /><span>{slice.name}</span><b>{slice.count}<small>条</small></b><strong>{chartPercent(slice.value)}</strong><ArrowRight size={14} /></button>)}</div></div>
    <div className="cx-quality-rates"><div><span>可核对样本的改判率</span><strong>{chartPercent(analytics.changedRate.value)}</strong><small>{analytics.changedRate.numerator} / {analytics.changedRate.denominator}条可核对结论</small></div><div><span>本平台人工复核完成率</span><strong>{chartPercent(analytics.localCompletion.value)}</strong><small>{analytics.localCompletion.numerator} / {analytics.localCompletion.denominator}条已人工确认</small></div></div>
    <p className="cx-chart-note">待核实 {analytics.unresolved + analytics.conflict} 条不算“维持原判”。{analytics.conflict > 0 && `其中${analytics.conflict}条前后标记冲突。`}以上是复核样本统计，不是模型质检准确率。</p>
  </Panel>;
}

export function FieldDonuts({ run, select }: { run: LearningState['run']; select: (field: string) => void }) {
  const fields = [['intent', '客户意图'], ['product_line', '产品类别'], ['fault_domain', '故障域']];
  return <Panel className="cx-field-chart"><PanelHead title="基础填单 · 三项字段表现" description="每个环单独统计一个字段，蓝色为正确，橙色为不一致，灰色为未输出。" />{run?.completed ? <div className="cx-field-donuts">{fields.map(([field, title]) => { const metric = run.metrics.fields[field]; const mismatch = metric.denominator - metric.numerator - metric.unavailable; const slices = [{ id: 'correct', name: '正确', count: metric.numerator, color: colors.blue }, { id: 'mismatch', name: '不一致', count: mismatch, color: colors.orange }, { id: 'missing', name: '未输出', count: metric.unavailable, color: colors.gray }]; return <section key={field}><h3>{title}</h3><Donut slices={slices} value={chartPercent(metric.value)} label="字段准确率" size={164} /><p><strong>{metric.numerator}</strong> / {metric.denominator} 个字段正确</p><small>Macro F1 {chartPercent(metric.macroF1)}</small><ul>{slices.map(slice => <li key={slice.id}><i style={{ background: slice.color }} /><span>{slice.name}</span><b>{slice.count}</b></li>)}</ul><button className="text-link" onClick={() => select(field)}>核对这个字段<ArrowRight size={14} /></button></section>; })}</div> : <Empty title="还没有字段实测结果" description="先运行正式对话回放，不使用预填比例。" />}</Panel>;
}

export function ModelPerformance({ analysis, trend, runId, options, missing, projectId, select }: { analysis: ModelAnalysis | null; trend: Trend[]; runId: string | null; options: { id: string; count: number }[]; missing: boolean; projectId: string; select: (id: string) => void }) {
  const [mode, setMode] = useState('cumulative');
  const historyModels = [...new Map(trend.map(point => [point.modelId, point.model])).entries()];
  const history: Record<string, string | number | null>[] = [];
  for (const point of trend) { let row = history.find(item => item.id === point.runId); if (!row) { row = { id: point.runId, name: point.runId.slice(-6) }; history.push(row); } row[point.modelId] = point.intent; }
  const historyAvailable = history.length > 1;
  const showHistory = mode === 'history' && historyAvailable;
  const series = showHistory ? historyModels : (analysis?.models || []).map(model => [model.id, model.name]);
  const palette = [colors.blue, colors.teal, colors.orange, colors.coral];
  const cumulative = (analysis?.cumulative || []).map(point => Object.fromEntries([['seen', point.seen], ...Object.entries(point.models).map(([id, metric]) => [id, metric.value])]));
  const hasMeasuredPoints = showHistory ? trend.some(point => point.intent != null) : analysis?.models.some(model => model.accuracy.value != null);
  const difference = analysis?.models.length === 2 && analysis.models.every(model => model.accuracy.value != null) ? analysis.models[1].accuracy.value! - analysis.models[0].accuracy.value! : null;
  return <Panel className="cx-model-performance"><PanelHead title="模型对比 · 同一批真实案例" description="先看本批模型差异，再看每个累计样本点的表现。不会用一个批次伪造时间趋势。" action={<select className="select" aria-label="趋势参考批次" value={runId || ''} onChange={event => select(event.target.value)}>{!runId && <option value="">请选择有效批次</option>}{options.map(run => <option value={run.id} key={run.id}>{run.count}例 · {run.id.slice(-6)}</option>)}</select>} />{missing && <p className="notice amber">指定批次不存在或不属于当前项目，没有替换成其他成绩。</p>}
    {analysis && analysis.total > 0 ? <>
      <div className="cx-model-scorecards">{analysis.models.map((model, index) => <section key={model.id} style={{ borderTopColor: palette[index % palette.length] }}><span><i style={{ background: palette[index % palette.length] }} />{model.name}</span><strong>{chartPercent(model.accuracy.value)}</strong><p>{model.correct}/{model.accuracy.denominator}例意图正确</p><small>有效输出 {model.completed} · 失败 {model.failed} · 缺失 {model.missing} · 冲突 {model.conflict}</small></section>)}</div>
      {analysis.models.length === 2 && <p className="cx-model-delta">本批差异 <strong>{difference == null ? '暂无可比较结果' : `${difference > 0 ? '+' : ''}${difference.toFixed(1)} 个百分点`}</strong><span>第二个模型减第一个；仅描述当前样本，不等于已证明版本提升。</span></p>}
      <div className="cx-chart-switch"><div><button aria-pressed={!showHistory} onClick={() => setMode('cumulative')}>本批累计表现</button><button aria-pressed={showHistory} disabled={!historyAvailable} onClick={() => setMode('history')}>同条件历史 · {history.length}批</button></div><span>{showHistory ? '横轴：实际批次' : '横轴：原批次案例顺序的累计数量'}</span></div>
      {hasMeasuredPoints ? <div className="cx-model-line" role="img" aria-label={showHistory ? '相同案例条件下的历史批次准确率' : `本批${analysis.total}例逐条累计准确率，不是时间趋势`}><ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 280 }}><LineChart data={showHistory ? history : cumulative} margin={{ top: 16, right: 26, left: 4, bottom: 12 }}><CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--line)" /><XAxis dataKey={showHistory ? 'name' : 'seen'} type={showHistory ? 'category' : 'number'} domain={showHistory ? undefined : ['dataMin', 'dataMax']} allowDecimals={false} tickLine={false} axisLine={false} tickMargin={12} /><YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" width={52} tickLine={false} axisLine={false} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }} labelFormatter={label => showHistory ? `批次 ${label}` : `累计前 ${label} 个案例`} formatter={value => chartPercent(Number(value))} />{series.map(([id, name], index) => <Line key={id} type="linear" dataKey={id} name={name} stroke={palette[index % palette.length]} strokeWidth={2.4} strokeDasharray={index % 2 ? '6 3' : undefined} dot={showHistory || analysis.total <= 5 ? { r: 3.5 } : false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div> : <Empty title="暂无有效输出，无法绘制曲线" description="失败与缺失保留在分母中；没有可核对的模型输出时，不绘制虚假的零分曲线。请检查逐例结果与Trace。" />}
      <div className="cx-line-legend">{series.map(([id, name], index) => <span key={id}><i style={{ background: palette[index % palette.length] }} />{name}{index % 2 ? ' · 虚线' : ' · 实线'}</span>)}</div>
      <p className="cx-chart-note">{showHistory ? '仅连接案例、划分、协议及裁判一致的实际完成批次。' : `从已有逐例记录累计计算，不重新训练；曲线变化来自样本构成，不是模型持续学习。${!historyAvailable ? '当前只有1个同条件批次，因此不画历史趋势。' : ''}`}所有选定案例进入分母，失败与缺失不算正确。</p>
      <details className="cx-chart-data"><summary>查看图表数据与分母</summary><div className="table-wrap"><table><thead><tr><th>{showHistory ? '批次' : '累计案例'}</th>{series.map(([id, name]) => <th key={id}>{name}</th>)}</tr></thead><tbody>{showHistory ? history.map(point => <tr key={String(point.id)}><td>{point.name}</td>{series.map(([id]) => { const metric = trend.find(entry => entry.runId === point.id && entry.modelId === id); return <td key={id}>{metric ? `${chartPercent(metric.intent)} · ${metric.correct}/${metric.total}` : '此批无该模型结果'}</td>; })}</tr>) : analysis.cumulative.map(point => <tr key={point.seen}><td>{point.seen}</td>{series.map(([id]) => <td key={id}>{chartPercent(point.models[id]?.value)} · {point.models[id]?.numerator}/{point.models[id]?.denominator}</td>)}</tr>)}</tbody></table></div></details>
      <div className="cx-panel-links"><a className="text-link" href={`#compare?mode=text&run=${runId}`}>横向/纵向逐例对比<ArrowRight size={14} /></a><a className="text-link" href="#compare?mode=vision">图文模型对比<ArrowRight size={14} /></a><a className="text-link" href={`#overview?tab=intents&project=${projectId}`}>查看意图树<ArrowRight size={14} /></a></div>
    </> : <Empty title="暂无可比较的完成批次" action={<a className="text-link" href={`#benchmark?project=${projectId}`}>去运行评测</a>} />}
  </Panel>;
}
