import { adjacency, neighbors } from './ontologyGraph.ts';
import type { GraphEdge, GraphNode } from './ontologyGraph';

export type NetworkLayer = 'structure' | 'alias' | 'business' | 'constraint';
export type NetworkScope = 'all' | 'explore' | 'local';
export type NetworkGraph = { nodes: GraphNode[]; edges: GraphEdge[] };
export const networkLayers: { id: NetworkLayer; label: string; color: string }[] = [
  { id: 'structure', label: '概念与机型', color: '#89aadd' },
  { id: 'alias', label: '同义叫法', color: '#c2abe4' },
  { id: 'business', label: '业务关系', color: '#77cbb5' },
  { id: 'constraint', label: '约束规则', color: '#e4ad79' },
];
export const networkKindNames: Record<string, string> = { class: '概念', entity: '标准实体', alias: '同义叫法', rule: '执行约束' };

export function networkLayer(edge: Pick<GraphEdge, 'type' | 'ruleId'>): NetworkLayer {
  if (edge.type === 'alias_of') return 'alias';
  if (['instance_of', 'entity_scope'].includes(edge.type)) return 'structure';
  if (edge.ruleId || ['requires_action', 'forbids_action', 'excludes_part'].includes(edge.type)) return 'constraint';
  return 'business';
}

export function networkEdgeStyle(edge: Pick<GraphEdge, 'type' | 'ruleId' | 'enabled' | 'disputed'>) {
  const layer = networkLayer(edge);
  const forbidden = ['forbids_action', 'excludes_part'].includes(edge.type);
  const candidate = edge.disputed || ['possible_cause', 'candidate_component'].includes(edge.type);
  return {
    color: edge.enabled === false ? '#71808d' : forbidden ? '#e79286' : candidate ? '#d3bb84' : networkLayers.find(item => item.id === layer)!.color,
    dash: edge.enabled === false ? [2, 5] : forbidden ? [3, 4] : candidate ? [6, 4] : layer === 'structure' ? [2, 4] : [],
    forbidden,
    candidate,
    layer,
  };
}

export function scopedNetwork(graph: NetworkGraph, model: string, layers: Set<NetworkLayer>): NetworkGraph {
  const nodes = graph.nodes.filter(node => (!model || (node.kind === 'entity' && node.classId === 'model' ? node.id === model : !node.modelIds?.length || node.modelIds.includes(model))) && (node.kind !== 'class' || layers.has('structure')) && (node.kind !== 'alias' || layers.has('alias')) && (node.kind !== 'rule' || layers.has('constraint')));
  const identifiers = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => identifiers.has(edge.source) && identifiers.has(edge.target) && (!model || !edge.modelIds?.length || edge.modelIds.includes(model)) && layers.has(networkLayer(edge)));
  return { nodes, edges };
}

export function networkView(graph: NetworkGraph, scope: NetworkScope, selected: string, expanded: Set<string>, depth = 1): NetworkGraph {
  if (scope === 'all') return graph;
  const index = adjacency(graph.edges);
  const identifiers = scope === 'local' ? neighbors(index, selected, depth) : new Set([...expanded].flatMap(identifier => [...neighbors(index, identifier)]));
  const nodes = graph.nodes.filter(node => identifiers.has(node.id));
  const visible = new Set(nodes.map(node => node.id));
  return { nodes, edges: graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)) };
}

export function networkEdgeOffsets(edges: GraphEdge[]) {
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.source, edge.target].sort());
    groups.set(key, [...groups.get(key) || [], edge]);
  }
  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((left, right) => left.id.localeCompare(right.id)).forEach((edge, index) => {
      offsets.set(edge.id, (index - (group.length - 1) / 2) * 36 * (edge.source < edge.target ? 1 : -1));
    });
  }
  return offsets;
}

export function networkHomes(nodes: GraphNode[], edges: GraphEdge[]) {
  const knownClasses = ['model', 'component', 'spare', 'action', 'severity', 'symptom', 'cause'];
  const classes = [...knownClasses, ...new Set(nodes.map(node => node.classId || '').filter(identifier => identifier && !knownClasses.includes(identifier)))];
  const homes = new Map<string, { x: number; y: number }>();
  for (const [index, classId] of classes.entries()) {
    const angle = index / classes.length * Math.PI * 2 - Math.PI / 2;
    const center = { x: Math.cos(angle) * 360, y: Math.sin(angle) * 310 };
    homes.set('class:' + classId, center);
    const members = nodes.filter(node => node.kind === 'entity' && node.classId === classId).sort((left, right) => left.id.localeCompare(right.id));
    members.forEach((node, position) => {
      const rotation = position / Math.max(1, members.length) * Math.PI * 2 + angle;
      const radius = 78 + Math.sqrt(members.length) * 16;
      homes.set(node.id, { x: center.x + Math.cos(rotation) * radius, y: center.y + Math.sin(rotation) * radius });
    });
  }
  for (const node of nodes) {
    if (homes.has(node.id)) continue;
    const related = edges.filter(edge => edge.source === node.id || edge.target === node.id);
    const canonical = related.find(edge => edge.type === 'alias_of' && edge.source === node.id);
    const anchor = canonical ? homes.get(canonical.target) : homes.get('class:' + node.classId);
    const point = anchor || { x: 0, y: 0 };
    const siblings = nodes.filter(item => item.kind === node.kind && item.classId === node.classId);
    const angle = Math.max(0, siblings.findIndex(item => item.id === node.id)) * 2.399963;
    const radius = node.kind === 'alias' ? 45 : 105;
    homes.set(node.id, { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius });
  }
  return homes;
}
