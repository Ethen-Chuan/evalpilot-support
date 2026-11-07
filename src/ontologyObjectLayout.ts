import { semanticLanes } from './ontologyGraph.ts';
import type { Camera, GraphEdge, GraphNode } from './ontologyGraph';

export type ObjectPoint = { x: number; y: number };
export type ObjectCard = GraphNode & ObjectPoint & { width: number; height: number; lane: number };
export type ObjectLink = { edge: GraphEdge; points: ObjectPoint[]; path: string };
export type ObjectLayout = { cards: ObjectCard[]; links: ObjectLink[]; lanes: { title: string; x: number; y: number }[]; width: number; height: number };
export const objectCardSize = { width: 170, height: 84 };

export function objectNameLines(label: string, budget = 9) {
  const lines: string[] = [];
  let line = '', used = 0;
  for (const character of label) {
    const units = /[\u0000-\u00ff]/.test(character) ? 0.55 : 1;
    if (used + units > budget) { lines.push(line.trim()); line = ''; used = 0; }
    line += character; used += units;
  }
  if (line) lines.push(line.trim());
  return lines.length > 2 ? [lines[0], lines[1].slice(0, -1) + '…'] : lines;
}

function laneFor(node: GraphNode, domain: boolean) {
  const lanes: Record<string, number> = domain ? { model: 1, symptom: 1, cause: 2, component: 3, spare: 4, action: 5, severity: 6 } : { device: 1, model: 2, code: 2, component: 3, symptom: 3, action: 4, ticket: 4 };
  return node.kind === 'alias' ? 0 : node.kind === 'rule' ? 3 : lanes[node.classId || node.id.replace('class:', '')] ?? 1;
}

export function roundedObjectPath(points: ObjectPoint[]) {
  if (!points.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], point = points[index], next = points[index + 1];
    const incoming = Math.hypot(point.x - previous.x, point.y - previous.y);
    const outgoing = Math.hypot(next.x - point.x, next.y - point.y);
    if (!incoming || !outgoing) continue;
    const radius = Math.min(12, incoming / 2, outgoing / 2);
    path += ` L ${point.x + (previous.x - point.x) * radius / incoming} ${point.y + (previous.y - point.y) * radius / incoming}`;
    path += ` Q ${point.x} ${point.y} ${point.x + (next.x - point.x) * radius / outgoing} ${point.y + (next.y - point.y) * radius / outgoing}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

export function objectLayout(nodes: GraphNode[], edges: GraphEdge[], overrides = new Map<string, ObjectPoint>()): ObjectLayout {
  const domain = nodes.some(node => ['cause', 'spare', 'severity'].includes(node.classId || ''));
  const laneTitles = domain ? ['客户的叫法', '机型与现象', '候选根因', '候选部件', '可核对备件', '专业复核动作', '风险等级'] : semanticLanes;
  const groups = laneTitles.map(() => [] as GraphNode[]);
  nodes.forEach(node => groups[laneFor(node, domain)].push(node));
  const order: Record<string, number> = { model: 0, code: 1, component: 0, symptom: 1, action: 0, ticket: 1 };
  groups.forEach(group => group.sort((left, right) => Number(left.kind === 'class') - Number(right.kind === 'class') || Number(left.kind === 'rule') - Number(right.kind === 'rule') || (order[left.classId || ''] || 0) - (order[right.classId || ''] || 0) || left.label.localeCompare(right.label, 'zh-CN')));
  const modelOrder = new Map(groups[2].filter(node => node.classId === 'model' && node.kind !== 'class').map((node, index) => [node.id, index * 2]));
  const scopedOrder = new Map(edges.filter(edge => edge.type === 'scoped_to' && modelOrder.has(edge.target)).map(edge => [edge.source, modelOrder.get(edge.target)! + 1]));
  const semanticOrder = (node: GraphNode) => modelOrder.get(node.id) ?? scopedOrder.get(node.id) ?? 100;
  groups[2].sort((left, right) => semanticOrder(left) - semanticOrder(right));
  const candidateOrder = new Map(edges.filter(edge => edge.type === 'candidate_component').map(edge => [edge.target, scopedOrder.get(edge.source) ?? 100]));
  groups[3].sort((left, right) => (candidateOrder.get(left.id) ?? 100) - (candidateOrder.get(right.id) ?? 100));
  const active = groups.map((group, lane) => ({ group, lane })).filter(item => item.group.length);
  const rowCount = Math.max(1, ...groups.map(group => group.length));
  const top = 84, rowGap = 112, columnGap = 250;
  const cards: ObjectCard[] = [];
  active.forEach(({ group, lane }, column) => group.forEach((node, row) => {
    cards.push({ ...node, ...objectCardSize, lane, x: 48 + column * columnGap, y: top + ((rowCount - group.length) / 2 + row) * rowGap, ...overrides.get(node.id) });
  }));
  const indexed = new Map(cards.map(card => [card.id, card]));
  const links = edges.flatMap((edge, index) => {
    const source = indexed.get(edge.source), target = indexed.get(edge.target);
    if (!source || !target) return [];
    const forward = source.x < target.x;
    const offset = 18 + index % 4 * 8;
    let points: ObjectPoint[];
    if (source.x === target.x) {
      const channel = source.x + source.width + offset;
      points = [{ x: source.x + source.width, y: source.y + 42 }, { x: channel, y: source.y + 42 }, { x: channel, y: target.y + 42 }, { x: target.x + target.width, y: target.y + 42 }];
    } else {
      const start = { x: source.x + (forward ? source.width : 0), y: source.y + 42 };
      const end = { x: target.x + (forward ? 0 : target.width), y: target.y + 42 };
      if (Math.abs(target.x - source.x) <= columnGap + 1) {
        const channel = (start.x + end.x) / 2 + (index % 3 - 1) * 8;
        points = [start, { x: channel, y: start.y }, { x: channel, y: end.y }, end];
      } else {
        const track = 60 - index % 5 * 7;
        const direction = forward ? 1 : -1;
        points = [start, { x: start.x + direction * offset, y: start.y }, { x: start.x + direction * offset, y: track }, { x: end.x - direction * offset, y: track }, { x: end.x - direction * offset, y: end.y }, end];
      }
    }
    return [{ edge, points, path: roundedObjectPath(points) }];
  });
  return { cards, links, lanes: active.map(({ lane }, column) => ({ title: laneTitles[lane], x: 48 + column * columnGap, y: 16 })), width: Math.max(300, ...cards.map(card => card.x + card.width + 52)), height: Math.max(300, ...cards.map(card => card.y + card.height + 60)) };
}

export function objectCamera(layout: Pick<ObjectLayout, 'width' | 'height'>, width: number, height: number, overview = false): Camera {
  const fitted = Math.min((Math.max(width, 200) - 36) / layout.width, (Math.max(height, 200) - 112) / layout.height, 1.1);
  const scale = Math.max(overview ? 0.15 : 0.78, fitted);
  return { scale, x: Math.max(18, (width - layout.width * scale) / 2), y: Math.max(width < 640 ? 100 : 58, (height - layout.height * scale) / 2) };
}

export function objectZoom(camera: Camera, factor: number, point: ObjectPoint): Camera {
  const scale = Math.max(0.15, Math.min(2, camera.scale * factor));
  return { scale, x: point.x - (point.x - camera.x) * scale / camera.scale, y: point.y - (point.y - camera.y) * scale / camera.scale };
}
