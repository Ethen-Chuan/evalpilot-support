import { ArrowRight } from '@phosphor-icons/react';
import type { GraphNode, OntologyGraph } from './ontologyGraph';

export function OntologyNodeLogic({ node, graph, select }: { node: GraphNode; graph: OntologyGraph; select: (identifier: string) => void }) {
  const indexed = new Map(graph.nodes.map(item => [item.id, item]));
  const canonicalId = node.kind === 'alias' ? graph.edges.find(edge => edge.source === node.id && edge.type === 'alias_of')?.target : node.id;
  const canonical = canonicalId ? indexed.get(canonicalId) : undefined;
  const related = graph.edges.filter(edge => edge.source === canonicalId);
  const type = related.find(edge => edge.type === 'instance_of');
  const aliases = graph.edges.filter(edge => edge.target === canonicalId && edge.type === 'alias_of').map(edge => indexed.get(edge.source)!);
  const aliasExplanation = node.kind === 'alias' && canonical;
  const relationNames: Record<string, string> = { has_model: '示例可选型号，并非已识别型号', scoped_to: '只有在这个型号范围内才适用', candidate_component: '候选关联，不是故障确认', has_component: '组成关系，不代表部件已经损坏', needs_review: '应交专业人员复核，不是已经执行', governed_by: '受到这条规则约束', records_in: '服务记录的示例归属，并未创建工单', next_step: '需要补充核实的信息' };
  return <section className="ontology-node-logic" aria-label="节点的语义关系">
    <h3>{aliasExplanation ? '这个叫法不是孤立节点' : '这条业务链怎么读'}</h3>
    {aliasExplanation && <p>“{node.label}”是客户的说法，词典将它归到“{canonical.label}”。后续沿用规范词的关系，不为每个叫法建立一套故障知识。</p>}
    {canonical && <div className="ontology-canonical-path">{aliasExplanation && <><span>{node.label}</span><span className="ontology-path-predicate">规范叫法<ArrowRight size={14} /></span></>}<button onClick={() => select(canonical.id)}>{canonical.label}</button>{type && <><span className="ontology-path-predicate">属于概念<ArrowRight size={14} /></span><button onClick={() => select(type.target)}>{indexed.get(type.target)?.label}</button></>}</div>}
    {!!aliases.length && <><p>这些叫法都指向同一个规范词：</p><div className="ontology-sibling-aliases">{aliases.map(alias => <button key={alias.id} onClick={() => select(alias.id)} aria-label={`查看同义叫法：${alias.label}`}>{alias.label}</button>)}</div></>}
    <ul>{related.filter(edge => relationNames[edge.type]).map(edge => <li key={edge.id}><button onClick={() => select(edge.target)}><strong>{canonical?.label} → {indexed.get(edge.target)?.label}</strong><span>{edge.label}：{relationNames[edge.type]}</span></button></li>)}</ul>
    <p className="ontology-logic-boundary">这是人工编写的词典与关系示例。术语归一不代表确认同一台设备，候选部件不代表诊断成立。</p>
  </section>;
}
