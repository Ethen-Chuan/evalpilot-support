export type GraphNode = { id: string; label: string; kind: string; provenance: string; description?: string; classId?: string; field?: string; value?: string; aliases?: string[]; href?: string; count?: number; sessionId?: string; messageCount?: number; conflicts?: string[]; cluster?: string; enabled?: boolean; modelIds?: string[]; ruleId?: string };
export type GraphEdge = { id: string; source: string; target: string; type: string; label: string; provenance: string; evidence?: string; count?: number; disputed?: boolean; modelIds?: string[]; enabled?: boolean; ruleId?: string };
export type OntologyGraph = { protocol: string; schemaVersion: string; workspaceRevision?: string; mode: 'corpus' | 'example'; project: string; projects: { id: string; name: string }[]; nodes: GraphNode[]; edges: GraphEdge[]; coverage: { totalCases: number; loadedCases: number; complete: boolean; limit?: number; conflictCases: number }; revision: string; generatedAt: string; boundary: string };
export type Resolution = { mappings: { terms: string[]; canonical: string; nodeId: string; classId: string; basis: string }[]; checks: { id: string; status: string; title: string; reason: string }[]; activeNodeIds: string[]; activeEdgeIds: string[]; status: string; unknownCodes: string[]; externalCalls: boolean; boundary: string };
export type GraphScope = 'explore' | 'overview' | 'all' | 'local' | 'resolution';
export type ExpansionState = { roots: string[]; branches: Map<string, string[]> };
export type ExampleTopic = 'aliases' | 'models' | 'safety';
export const expansionBatchSize = 24;
export const kindNames: Record<string, string> = { project: '项目', class: '概念', label: '人工标签', case: '对话案例', entity: '示例实体', alias: '同义叫法', rule: '业务约束' };
export const kindColors: Record<string, string> = { project: '#e5bc71', class: '#80a8ed', label: '#76c8ac', case: '#7c929e', entity: '#76c8ac', alias: '#b5a2d4', rule: '#dfa07c' };
export const provenanceNames: Record<string, string> = { schema: '本体定义', example: '虚构教学示例', imported: '脱敏历史语料', human_annotation: '原始人工标注' };

export function adjacency(edges: GraphEdge[]) {
  const index = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!index.has(edge.source)) index.set(edge.source, new Set());
    if (!index.has(edge.target)) index.set(edge.target, new Set());
    index.get(edge.source)!.add(edge.target);
    index.get(edge.target)!.add(edge.source);
  }
  return index;
}

export function neighbors(index: Map<string, Set<string>>, selected: string, depth = 1) {
  const reached = new Set<string>(selected ? [selected] : []);
  let frontier = selected ? [selected] : [];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const identifier of frontier) for (const neighbor of index.get(identifier) || []) if (!reached.has(neighbor)) { reached.add(neighbor); next.push(neighbor); }
    frontier = next;
  }
  return reached;
}

export function expansionRoots(nodes: GraphNode[]): ExpansionState {
  const projects = nodes.filter(node => node.kind === 'project');
  const roots = projects.length ? projects : nodes.filter(node => node.kind === 'class');
  return { roots: (roots.length ? roots : nodes.slice(0, 1)).map(node => node.id), branches: new Map() };
}

export function exampleExploration(graph: Pick<OntologyGraph, 'nodes' | 'edges'>, topic: ExampleTopic = 'aliases'): ExpansionState {
  const aliases = graph.nodes.filter(node => node.kind === 'alias' && ['主机', '机子', '机器'].includes(node.label)).map(node => node.id);
  const desired = topic === 'aliases' ? [...aliases, 'equipment', 'model-a', 'code-a', 'mainboard', 'rule:candidate-only', 'handoff', 'ticket-example'] : topic === 'models' ? ['equipment', 'model-a', 'model-b', 'code-a', 'code-b', 'mainboard', 'power', 'rule:model-scope'] : ['code-a', 'mainboard', 'rule:candidate-only', 'handoff', 'ticket-example'];
  const identifiers = new Set(graph.nodes.filter(node => desired.includes(node.id)).map(node => node.id));
  const root = topic === 'aliases' ? aliases[0] : topic === 'models' ? 'equipment' : 'code-a';
  if (!identifiers.has(root)) return expansionRoots(graph.nodes);
  const index = adjacency(graph.edges.filter(edge => identifiers.has(edge.source) && identifiers.has(edge.target)));
  const reached = new Set([root]), queue = [root], branches = new Map<string, string[]>();
  for (let position = 0; position < queue.length; position++) {
    const children = [...(index.get(queue[position]) || [])].filter(identifier => !reached.has(identifier));
    children.forEach(identifier => { reached.add(identifier); queue.push(identifier); });
    if (children.length) branches.set(queue[position], children);
  }
  return { roots: [root], branches };
}

export const semanticLanes = ['客户的叫法', '统一业务概念', '型号与故障码', '候选与约束', '处理与记录'];

export function semanticPositions(nodes: GraphNode[]) {
  const groups = semanticLanes.map(() => [] as GraphNode[]);
  const category: Record<string, number> = { device: 1, model: 2, code: 2, component: 3, symptom: 3, action: 4, ticket: 4 };
  for (const node of nodes) {
    const lane = node.kind === 'alias' ? 0 : node.kind === 'rule' ? 3 : category[node.classId || node.id.replace('class:', '')] ?? 1;
    groups[lane].push(node);
  }
  const result = new Map<string, { x: number; y: number }>();
  const order: Record<string, number> = { model: 0, code: 1, component: 0, symptom: 1, action: 0, ticket: 1 };
  groups.forEach((group, lane) => group.sort((left, right) => Number(left.kind === 'class') - Number(right.kind === 'class') || Number(left.kind === 'rule') - Number(right.kind === 'rule') || (order[left.classId || ''] || 0) - (order[right.classId || ''] || 0)).forEach((node, position) => result.set(node.id, { x: lane * 280, y: position * 160 })));
  return result;
}

export function expandedIdentifiers(state: ExpansionState) {
  const reached = new Set(state.roots), queue = [...state.roots];
  for (let position = 0; position < queue.length; position++) {
    for (const identifier of state.branches.get(queue[position]) || []) {
      if (!reached.has(identifier)) { reached.add(identifier); queue.push(identifier); }
    }
  }
  return reached;
}

export function expansionCandidates(index: Map<string, Set<string>>, state: ExpansionState, selected: string) {
  const attached = new Set(state.branches.get(selected));
  return [...(index.get(selected) || [])].filter(identifier => identifier !== selected && !attached.has(identifier));
}

export function expandNode(state: ExpansionState, selected: string, index: Map<string, Set<string>>, nodes: Map<string, GraphNode>, limit = expansionBatchSize): ExpansionState {
  if (!nodes.has(selected) || limit <= 0) return state;
  const candidates = expansionCandidates(index, state, selected).filter(identifier => nodes.has(identifier));
  const concepts = candidates.filter(identifier => nodes.get(identifier)?.kind !== 'case');
  const next = (concepts.length ? concepts : candidates).slice(0, Math.min(expansionBatchSize, Math.floor(limit)));
  const roots = expandedIdentifiers(state).has(selected) ? state.roots : [...state.roots, selected];
  if (!next.length && roots === state.roots) return state;
  const branches = new Map(state.branches);
  if (next.length) branches.set(selected, [...(branches.get(selected) || []), ...next]);
  return { roots, branches };
}

export function collapseNode(state: ExpansionState, selected: string): ExpansionState {
  const branches = new Map(state.branches);
  branches.delete(selected);
  const reached = expandedIdentifiers({ roots: state.roots, branches });
  return { roots: state.roots, branches: new Map([...branches].filter(([identifier]) => reached.has(identifier))) };
}

export function visibleGraph(graph: Pick<OntologyGraph, 'nodes' | 'edges'>, scope: GraphScope, selected: string, depth: number, expanded: Set<string>, hidden: Set<string>, relation: string, resolution?: Pick<Resolution, 'activeNodeIds' | 'activeEdgeIds'> | null, exploration?: ExpansionState) {
  const resolvedNodes = new Set(resolution?.activeNodeIds), resolvedEdges = new Set(resolution?.activeEdgeIds);
  const edges = graph.edges.filter(edge => (!relation || edge.type === relation) && (scope !== 'resolution' || resolvedEdges.has(edge.id)));
  const neighborhood = scope === 'local' ? neighbors(adjacency(edges), selected, depth) : null;
  const explored = scope === 'explore' ? expandedIdentifiers(exploration || expansionRoots(graph.nodes)) : null;
  const nodes = graph.nodes.filter(node => !hidden.has(node.kind) && (explored ? explored.has(node.id) : scope === 'resolution' ? resolvedNodes.has(node.id) : neighborhood ? neighborhood.has(node.id) : scope === 'all' || node.kind !== 'case' || expanded.has(node.id) || node.id === selected));
  const identifiers = new Set(nodes.map(node => node.id));
  return { nodes, edges: edges.filter(edge => identifiers.has(edge.source) && identifiers.has(edge.target)) };
}

export function searchNodes(nodes: GraphNode[], query: string) {
  const text = query.trim().toLocaleLowerCase();
  return nodes.filter(node => text ? [node.label, node.id, node.sessionId || '', ...(node.aliases || [])].some(value => value.toLocaleLowerCase().includes(text)) : node.kind !== 'case');
}

export type Camera = { x: number; y: number; scale: number };
export function zoomCamera(camera: Camera, factor: number, point: { x: number; y: number }): Camera {
  const scale = Math.max(0.08, Math.min(5, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: point.x - (point.x - camera.x) * ratio, y: point.y - (point.y - camera.y) * ratio };
}

export function fitCamera(points: { x?: number; y?: number }[], width: number, height: number): Camera {
  if (!points.length) return { x: width / 2, y: height / 2, scale: 1 };
  const horizontal = points.map(point => point.x || 0), vertical = points.map(point => point.y || 0);
  const left = Math.min(...horizontal), right = Math.max(...horizontal), top = Math.min(...vertical), bottom = Math.max(...vertical);
  const scale = Math.max(0.08, Math.min(1.7, (width - 160) / Math.max(right - left, 1), (height - 140) / Math.max(bottom - top, 1)));
  return { scale, x: width / 2 - (left + right) / 2 * scale, y: height / 2 - (top + bottom) / 2 * scale };
}

export type LabelBox = { left: number; top: number; width: number; height: number };
export function reserveLabel(box: LabelBox, occupied: LabelBox[], width: number, height: number) {
  if (box.left < 8 || box.top < 8 || box.left + box.width > width - 8 || box.top + box.height > height - 8 || occupied.some(other => box.left < other.left + other.width + 5 && box.left + box.width + 5 > other.left && box.top < other.top + other.height + 3 && box.top + box.height + 3 > other.top)) return false;
  occupied.push(box);
  return true;
}
