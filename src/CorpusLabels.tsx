import { Badge } from './ui';
import './corpus.css';

export type AnnotationSet = { id: string; state: string; cancelled: boolean; groundTruth: boolean; results: { field: string; type: string; values: (string | string[])[] }[] };
export type LabelSummary = { values: Record<string, string[]>; conflicts: string[] };
export type Corpus = { id: string; name: string; nature: string; importedAt: string; scanStatus: string; totals: { sessions: number; messages: number; gapSessions: number; invalidSessions: number; conflictSessions: number; imagesWithheld: number; videosWithheld: number }; intentDistribution: Record<string, number> };
export const intentNames: Record<string, string> = { info_query: '信息查询', feature_inquiry: '功能咨询', fault_repair: '故障维修', dispatch_request: '派单服务', policy_inquiry: '政策咨询', other: '其他问题', irrelevant: '无关问题', complaint: '投诉反馈', unclear: '意图待澄清' };
const fieldNames: Record<string, string> = { is_invalid: '是否无效对话', invalid_reason: '无效原因', direct_handoff: '直接转人工', handoff_reason: '转人工原因', product_line: '产品类别（匿名）', intent: '客户意图', intent_other: '意图补充', emotion: '客户情绪', fault_domain: '故障域', kb_expectation: '知识覆盖', kb_entry: '原知识条目', kb_gap_desc: '知识缺口说明', knowledge_category: '知识分类', fault_phenomenon: '故障现象', expected_system: '关联系统（匿名）', expected_system_other: '系统补充', type: '业务类型', sn_code: '设备编号（已移除）', remark: '标注备注' };
const valueNames: Record<string, string> = { ...intentNames, has_answer: '原标注：已有答案', gap: '原标注：知识缺口' };

export function CorpusLabels({ sets, summary, provenance }: { sets: AnnotationSet[]; summary: LabelSummary; provenance?: { file: string; row: number; imagesWithheld: number; videosWithheld: number } }) {
  return <section className="corpus-labels" aria-label="原始业务标注">
    <div className="corpus-labels-head"><div><h3>原始业务标注</h3><p>来自这段历史对话的人工标注，不是模型预测或评测得分。</p></div><Badge tone={summary.conflicts.length ? 'amber' : 'blue'}>{sets.length} 份标注{summary.conflicts.length ? ' · 存在分歧' : ''}</Badge></div>
    <dl className="corpus-key-labels">{['intent', 'emotion', 'fault_domain', 'kb_expectation', 'is_invalid', 'direct_handoff'].filter(field => summary.values[field]?.length).map(field => <div key={field}><dt>{fieldNames[field]}</dt><dd>{summary.values[field].map(value => valueNames[value] || value).join(' / ')}</dd></div>)}</dl>
    {summary.conflicts.length > 0 && <p className="corpus-warning">标注分歧：{summary.conflicts.map(field => fieldNames[field] || field).join('、')}。保留各份意见，未擅自合并为标准答案。</p>}
    {summary.values.kb_gap_desc?.length > 0 && <div className="corpus-gap"><strong>知识缺口原文</strong>{summary.values.kb_gap_desc.map((value, index) => <p key={index}>{value}</p>)}</div>}
    <details className="corpus-all-labels"><summary>展开全部标注字段、草稿与取消状态</summary>{sets.map(annotation => <section key={annotation.id}><h4>{annotation.state === 'draft' ? '草稿' : '提交标注'} · {annotation.id}{annotation.cancelled ? ' · 已取消（不计入汇总）' : ''}{annotation.groundTruth ? ' · 原来源标为基准' : ''}</h4>{annotation.results.length ? <dl>{annotation.results.map((result, index) => <div key={`${result.field}-${index}`}><dt>{fieldNames[result.field] || result.field}<small>{result.type}</small></dt><dd>{result.values.length ? result.values.map(value => Array.isArray(value) ? value.join(' / ') : valueNames[value] || value).join('；') : '（原标注为空）'}</dd></div>)}</dl> : <p>这份标注没有填写结果。</p>}</section>)}</details>
    <p className="corpus-provenance">{provenance && <>来源定位：{provenance.file} · 第 {provenance.row} 条记录。图片 {provenance.imagesWithheld} 张、视频 {provenance.videosWithheld} 段未导入。</>} 历史资料无运行 Trace；保留脱敏后的完整消息序列，不补造操作轨迹。</p>
  </section>;
}
