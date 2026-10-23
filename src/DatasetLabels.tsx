import { useState } from 'react';
import { ArrowClockwise, ArrowDown, BookOpen, CaretDown, CaretUp, ChartBar, ChatsCircle, Check, ClipboardText, Cube, FunnelSimple, Info, Smiley, Stack, Tag, Wrench, X } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { intentNames } from './CorpusLabels';
import { Badge, Button, number } from './ui';
import './dataset-labels.css';

export type LabelFilters = Record<string, string | null>;
export type LabelDimension = { field: string; name: string; total: number; covered: number; missing: number; coverage: number | null; multiValueSessions: number; conflictSessions: number; values: { value: string; count: number; ratio: number | null }[] };
export type LabelFacets = { total: number; projectTotal: number; scope: string; filters: LabelFilters; scopes: { id: string; name: string; count: number }[]; dimensions: LabelDimension[]; policy: string };
export const labelFields: Record<string, string> = { intent: '客户意图', emotion: '用户情绪', product_line: '产品类别', fault_domain: '故障域', type: '工单类型', kb_expectation: '知识覆盖', expected_system: '关联系统', knowledge_category: '知识分类' };
const valueNames: Record<string, Record<string, string>> = { intent: intentNames, kb_expectation: { has_answer: '知识库有答案', irrelevant: '与知识库无关', gap: '知识库缺口' } };
const percentage = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const fieldIcons: Record<string, typeof ChartBar> = { intent: ChatsCircle, emotion: Smiley, product_line: Cube, fault_domain: Wrench, type: ClipboardText, kb_expectation: BookOpen, expected_system: Stack, knowledge_category: Tag };
const previewCount = 3;

export function labelName(field: string, value: string | null) {
  if (value === null) return '未标注';
  if (['product_line', 'expected_system'].includes(field) && value.startsWith('类别-')) return `${field === 'product_line' ? '匿名产品' : '匿名系统'} · ${value.slice(3, 11)}`;
  return valueNames[field]?.[value] || value;
}

export function readLabelFilters(params: URLSearchParams): LabelFilters {
  let labels: LabelFilters = {};
  try {
    const parsed: unknown = JSON.parse(params.get('labels') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) labels = Object.fromEntries(Object.entries(parsed).filter(([field, value]) => Object.hasOwn(labelFields, field) && (value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 240))));
  } catch { }
  const intent = params.get('intent');
  if (intent && !('intent' in labels)) labels.intent = intent;
  return labels;
}

function labelColor(field: string, value: string) {
  if (field === 'emotion') return /投诉/.test(value) ? 'var(--label-red)' : /不满/.test(value) ? 'var(--label-amber)' : 'var(--label-green)';
  if (field === 'kb_expectation') return value === 'gap' ? 'var(--label-amber)' : value === 'has_answer' ? 'var(--label-green)' : 'var(--label-gray)';
  return 'var(--label-primary)';
}

export function DatasetLabels({ facets, pending, error, scope, filters, chooseScope, choose, remove, clear, refresh }: { facets: LabelFacets | null; pending: boolean; error: string; scope: string; filters: LabelFilters; chooseScope: (scope: string) => void; choose: (field: string, value: string | null) => void; remove: (field: string) => void; clear: () => void; refresh: () => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const showCases = () => document.querySelector('.project-cases')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  return <section className="dataset-labels" aria-label="会话分类标注分布" aria-busy={pending}>
    <header className="dataset-labels-heading"><div><h2>会话数据画像 <Badge>原始人工标签</Badge></h2><p>从客户诉求到知识覆盖，点击标签查看对应的完整对话。</p></div><div className="dataset-labels-actions"><Button quiet disabled={pending} onClick={refresh} title="重新统计当前项目"><ArrowClockwise size={15} />刷新统计</Button><Button quiet aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? <CaretDown size={15} /> : <CaretUp size={15} />}{collapsed ? '展开分类' : '收起分类'}</Button></div></header>
    <div className="dataset-label-scopes" role="group" aria-label="统计会话范围">{(facets?.scopes || [{ id: 'all', name: '全部会话' }, { id: 'regular', name: '常规会话' }, { id: 'invalid', name: '无效会话' }, { id: 'handoff', name: '直接转人工' }, { id: 'unclassified', name: '范围待确认' }]).map(item => <button key={item.id} disabled={pending} aria-pressed={scope === item.id} onClick={() => chooseScope(item.id)}>{item.name}{'count' in item && <span>{number(item.count)}</span>}</button>)}</div>
    <div className="dataset-label-filters"><span className="dataset-label-total"><FunnelSimple size={15} />{pending ? '正在统计…' : error ? '统计未完成' : <>当前会话 <strong>{number(facets?.total || 0)}</strong><small>段 · 统一统计分母</small></>}</span>{Object.entries(filters).map(([field, value]) => <button key={field} disabled={pending} aria-label={`移除${labelFields[field]}筛选`} onClick={() => remove(field)}><span>{labelFields[field]}：{labelName(field, value)}</span><X size={12} /></button>)}{Object.keys(filters).length > 0 && <button disabled={pending} className="dataset-label-clear" onClick={clear}>清空标签</button>}<button className="dataset-label-jump" disabled={pending || !!error} onClick={showCases}>查看匹配对话<ArrowDown size={14} /></button></div>
    {!collapsed && <>{pending ? <div role="status" className="dataset-label-loading"><span className="dataset-label-loading-text">正在读取当前范围内的全部会话标签…</span><div className="dataset-label-grid" aria-hidden="true">{Object.keys(labelFields).map(field => <div className="dataset-label-skeleton" key={field}><span /><span /><i /><i /><i /></div>)}</div></div> : error ? <div className="dataset-label-placeholder" role="alert"><Info size={24} /><strong>分类统计暂未完成</strong><span>请重试读取；上一次筛选的数字已隐藏。</span><Button onClick={refresh}>重试统计</Button></div> : facets && (facets.total === 0 ? <div className="dataset-label-placeholder"><FunnelSimple size={26} /><strong>没有符合条件的会话</strong><span>调整会话范围、标签或下方搜索条件后再试。</span></div> : <div className="dataset-label-grid">{facets.dimensions.map(dimension => {
      const visible = expanded[dimension.field] ? dimension.values : dimension.values.slice(0, previewCount);
      const Icon = fieldIcons[dimension.field] || ChartBar;
      const selected = dimension.field in filters;
      return <section key={dimension.field} className={`dataset-label-card${selected ? ' is-filtered' : ''}`} style={{ '--label-number-width': `${dimension.values.reduce((longest, item) => Math.max(longest, number(item.count).length + 1), 7)}ch` } as CSSProperties} aria-label={`${dimension.name}分类卡片`}>
        <header><div className="dataset-label-title"><span className="dataset-label-icon"><Icon size={17} /></span><h3>{dimension.name}</h3></div><span className="dataset-label-category-count">{selected && <Check size={12} />}{dimension.values.length} 类</span></header>
        <div className="dataset-label-coverage"><span>已标注 <strong>{number(dimension.covered)}</strong> 段</span><span title={`覆盖率 = ${dimension.covered} / ${dimension.total} 段会话`}>覆盖率 <strong>{percentage(dimension.coverage)}</strong></span></div>
        <div className="dataset-label-values">{visible.length ? visible.map(item => <button key={item.value} className="dataset-label-row" aria-pressed={filters[dimension.field] === item.value} aria-label={`筛选${dimension.name}：${labelName(dimension.field, item.value)}，${item.count}段`} onClick={() => filters[dimension.field] === item.value ? remove(dimension.field) : choose(dimension.field, item.value)} title={`${item.value} · ${item.count} / ${dimension.total} 段（${percentage(item.ratio)}）`}><span className="dataset-label-name">{filters[dimension.field] === item.value && <Check size={13} />}<span>{labelName(dimension.field, item.value)}</span></span><strong className="dataset-label-count">{number(item.count)}</strong><span className="dataset-label-track" aria-hidden="true"><i style={{ width: `${(item.ratio ?? 0) * 100}%`, '--label-color': labelColor(dimension.field, item.value) } as CSSProperties} /></span><span className="dataset-label-percentage">{percentage(item.ratio)}</span></button>) : <p className="dataset-label-no-values">当前范围暂无该字段标注</p>}</div>
        {dimension.values.length > previewCount && <button className="dataset-label-expand" aria-expanded={!!expanded[dimension.field]} onClick={() => setExpanded(current => ({ ...current, [dimension.field]: !current[dimension.field] }))}>{expanded[dimension.field] ? '收起' : `展开其余 ${dimension.values.length - previewCount} 项`}{expanded[dimension.field] ? <CaretUp size={12} /> : <CaretDown size={12} />}</button>}
        <footer><button disabled={!dimension.missing} aria-pressed={dimension.field in filters && filters[dimension.field] === null} aria-label={`筛选${dimension.name}未标注，${dimension.missing}段`} onClick={() => dimension.field in filters && filters[dimension.field] === null ? remove(dimension.field) : choose(dimension.field, null)}>未标注 <strong>{number(dimension.missing)}</strong>{dimension.missing > 0 && <ArrowDown size={11} />}</button><span title={`多值会话 ${dimension.multiValueSessions} 段；原标注分歧 ${dimension.conflictSessions} 段`}>{dimension.conflictSessions ? `分歧 ${number(dimension.conflictSessions)} 段` : dimension.multiValueSessions ? `多值 ${number(dimension.multiValueSessions)} 段` : '按会话去重'}</span></footer>
      </section>;
    })}</div>)}</>}
    <div className="dataset-label-footnote"><span><Info size={14} />占比以当前会话为分母；多值标签可能重叠。</span><details className="dataset-label-rules"><summary>统计口径与隐私说明</summary><p>分母跟随搜索、范围和标签筛选，与下方列表总数一致；条形长度表示占全部当前会话的比例，比例合计不一定为100%。「常规会话」要求来源明确标注为非无效、非直接转人工；无效优先归入无效，其次直接转人工，其他缺失范围标记的会话归入待确认。范围按钮数量是项目全部会话数量，不随其他筛选改变。标签卡片只统计当前筛选结果，多份有效提交按会话取标签并集，草稿与已取消标注不计。默认显示数量最多的三项，可展开其余标签。这里只整理已有人工标签，未标注不会推断补齐。匿名产品和系统简称不会恢复原名称；完整匿名标识可悬停查看。</p></details></div>
  </section>;
}
