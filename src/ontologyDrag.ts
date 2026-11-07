import type { GraphEdge, GraphNode } from './ontologyGraph';

export type NetworkDragMode = 'branch' | 'single';
export type DragPoint = { x: number; y: number };
export type DragMember = { id: string; parent: string | null };
export type NetworkDragPlan = { root: string; members: DragMember[]; edges: Set<string> };

export function networkDragPlan(nodes: GraphNode[], edges: GraphEdge[], root: string, mode: NetworkDragMode = 'branch'): NetworkDragPlan {
  const indexed = new Map(nodes.map(node => [node.id, node]));
  const selected = indexed.get(root);
  if (!selected) return { root, members: [], edges: new Set() };
  const parents = new Map<string, string | null>([[root, null]]);
  const include = (identifier: string, parent: string) => {
    if (indexed.has(identifier) && !parents.has(identifier)) parents.set(identifier, parent);
  };
  if (mode === 'branch') {
    const canonical = selected.kind === 'alias' ? edges.find(edge => edge.type === 'alias_of' && edge.source === root && indexed.has(edge.target))?.target : undefined;
    if (canonical) include(canonical, root);
    const anchor = canonical || root;
    for (const edge of edges) {
      if (edge.source !== anchor && edge.target !== anchor) continue;
      const other = edge.source === anchor ? edge.target : edge.source;
      const node = indexed.get(other);
      if (!node || node.kind === 'class') continue;
      if (selected.kind === 'class' && edge.type !== 'instance_of') continue;
      if (edge.type === 'entity_scope' && indexed.get(anchor)?.classId !== 'model') continue;
      include(other, anchor);
    }
    for (const edge of edges) if (edge.type === 'alias_of' && parents.has(edge.target)) include(edge.source, edge.target);
  }
  return {
    root,
    members: [...parents].map(([id, parent]) => ({ id, parent })),
    edges: new Set(edges.filter(edge => parents.has(edge.source) && parents.has(edge.target)).map(edge => edge.id)),
  };
}

export function networkDragOffsets(plan: NetworkDragPlan, nodes: GraphNode[], positions: Map<string, DragPoint>, scale: number, viewport: DragPoint) {
  const indexed = new Map(nodes.map(node => [node.id, node]));
  const origin = positions.get(plan.root) || { x: 0, y: 0 };
  const factor = Math.max(0.1, Math.min(5, scale));
  const radius = Math.max(58, Math.min(120, Math.min(viewport.x, viewport.y) * 0.22));
  const offsets = new Map<string, DragPoint>([[plan.root, { x: 0, y: 0 }]]);
  const parents = [...new Set(plan.members.map(member => member.parent).filter((parent): parent is string => !!parent))];
  for (const parent of parents) {
    const anchor = offsets.get(parent) || { x: 0, y: 0 };
    const family = plan.members.filter(member => member.parent === parent);
    const categories = [family.filter(member => indexed.get(member.id)?.kind !== 'alias'), family.filter(member => indexed.get(member.id)?.kind === 'alias')];
    for (const [category, siblings] of categories.entries()) {
      const parentPosition = positions.get(parent) || origin;
      const angle = (identifier: string) => {
        const point = positions.get(identifier) || parentPosition;
        return Math.atan2(point.y - parentPosition.y, point.x - parentPosition.x);
      };
      siblings.sort((left, right) => angle(left.id) - angle(right.id) || left.id.localeCompare(right.id));
      const start = siblings.length ? angle(siblings[0].id) : 0;
      siblings.forEach((member, index) => {
        const ring = Math.floor(index / 8), ringSize = Math.min(8, siblings.length - ring * 8);
        const rotation = start + (index % 8) / Math.max(1, ringSize) * Math.PI * 2;
        const distance = (category === 1 || indexed.get(parent)?.kind === 'alias' ? 38 + ring * 32 : radius + ring * 66) / factor;
        offsets.set(member.id, { x: anchor.x + Math.cos(rotation) * distance, y: anchor.y + Math.sin(rotation) * distance });
      });
    }
  }
  const members = plan.members.filter(member => member.id !== plan.root);
  const minimum = 30 / factor;
  for (const [index, member] of members.entries()) if (!offsets.has(member.id)) offsets.set(member.id, { x: Math.cos(index * 2.399963) * radius / factor, y: Math.sin(index * 2.399963) * radius / factor });
  for (let iteration = 0; iteration < 18; iteration += 1) {
    for (let leftIndex = 0; leftIndex < plan.members.length; leftIndex += 1) {
      const left = plan.members[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < plan.members.length; rightIndex += 1) {
        const right = plan.members[rightIndex], leftPoint = offsets.get(left.id)!, rightPoint = offsets.get(right.id)!;
        const horizontal = rightPoint.x - leftPoint.x, vertical = rightPoint.y - leftPoint.y;
        const length = Math.hypot(horizontal, vertical);
        if (length >= minimum) continue;
        const angle = length > 0.01 ? Math.atan2(vertical, horizontal) : (rightIndex + 1) * 2.399963;
        const push = (minimum - length) * (left.id === plan.root ? 1 : 0.5);
        rightPoint.x += Math.cos(angle) * push; rightPoint.y += Math.sin(angle) * push;
        if (left.id !== plan.root) { leftPoint.x -= Math.cos(angle) * push; leftPoint.y -= Math.sin(angle) * push; }
      }
    }
  }
  return offsets;
}

export function followDragPoint(position: DragPoint, target: DragPoint, milliseconds: number, immediate = false): DragPoint {
  const blend = immediate ? 1 : 1 - Math.exp(-Math.max(0, Math.min(64, milliseconds)) / 58);
  return { x: position.x + (target.x - position.x) * blend, y: position.y + (target.y - position.y) * blend };
}
