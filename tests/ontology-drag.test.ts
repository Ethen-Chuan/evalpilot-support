import test from 'node:test';
import assert from 'node:assert/strict';
import { followDragPoint, networkDragOffsets, networkDragPlan } from '../src/ontologyDrag.ts';
import type { GraphEdge, GraphNode } from '../src/ontologyGraph';

const nodes: GraphNode[] = [
  { id: 'class:cause', kind: 'class', classId: 'cause', label: '候选根因', provenance: 'schema' },
  { id: 'firmware', kind: 'entity', classId: 'cause', label: '软件异常', provenance: 'example' },
  { id: 'hardware', kind: 'entity', classId: 'cause', label: '硬件故障', provenance: 'example' },
  { id: 'loose', kind: 'entity', classId: 'cause', label: '连接松动', provenance: 'example' },
  { id: 'alias:firmware', kind: 'alias', classId: 'cause', label: '软件出错', provenance: 'example' },
  { id: 'class:component', kind: 'class', classId: 'component', label: '部件', provenance: 'schema' },
  { id: 'board', kind: 'entity', classId: 'component', label: '主板', provenance: 'example' },
  { id: 'alias:board', kind: 'alias', classId: 'component', label: '控制板', provenance: 'example' },
  { id: 'alias:board2', kind: 'alias', classId: 'component', label: '主控板', provenance: 'example' },
  { id: 'model-a', kind: 'entity', classId: 'model', label: 'A型', provenance: 'example' },
  { id: 'rule:major', kind: 'rule', label: '必须复核', provenance: 'schema' },
  { id: 'onsite', kind: 'entity', classId: 'action', label: '现场复核', provenance: 'example' },
];
const relation = (source: string, target: string, type: string): GraphEdge => ({ id: [source, type, target].join(':'), source, target, type, label: type, provenance: 'example' });
const edges: GraphEdge[] = [
  ...['firmware', 'hardware', 'loose'].map(identifier => relation(identifier, 'class:cause', 'instance_of')),
  relation('alias:firmware', 'firmware', 'alias_of'),
  relation('board', 'class:component', 'instance_of'),
  relation('alias:board', 'board', 'alias_of'),
  relation('alias:board2', 'board', 'alias_of'),
  relation('hardware', 'board', 'affects'),
  relation('model-a', 'board', 'entity_scope'),
  relation('hardware', 'rule:major', 'triggers_rule'),
  relation('rule:major', 'onsite', 'requires_action'),
];
const ids = (root: string) => networkDragPlan(nodes, edges, root).members.map(member => member.id).sort();

test('a concept pulls its three roots and aliases, not the entire connected business network', () => {
  assert.deepEqual(ids('class:cause'), ['class:cause', 'firmware', 'hardware', 'loose', 'alias:firmware'].sort());
});
test('entities pull direct business neighbors, rules and aliases but leave shared upper classes and model scope in place', () => {
  assert.deepEqual(ids('board'), ['board', 'hardware', 'alias:board', 'alias:board2'].sort());
  assert.deepEqual(ids('hardware'), ['hardware', 'board', 'rule:major', 'alias:board', 'alias:board2'].sort());
});
test('starting at an alias keeps its canonical entity and sibling aliases together', () => {
  assert.deepEqual(ids('alias:board'), ['board', 'hardware', 'alias:board', 'alias:board2'].sort());
  const plan = networkDragPlan(nodes, edges, 'alias:board');
  assert.equal(plan.members.find(member => member.id === 'board')?.parent, 'alias:board');
});
test('a model can pull applicable entities and a rule can pull its trigger and action', () => {
  assert.deepEqual(ids('model-a'), ['model-a', 'board', 'alias:board', 'alias:board2'].sort());
  assert.deepEqual(ids('rule:major'), ['rule:major', 'hardware', 'onsite'].sort());
});
test('single-node override and missing roots are explicit', () => {
  assert.deepEqual(networkDragPlan(nodes, edges, 'board', 'single').members, [{ id: 'board', parent: null }]);
  assert.equal(networkDragPlan(nodes, edges, 'board', 'single').edges.size, 0);
  assert.equal(networkDragPlan(nodes, edges, 'missing').members.length, 0);
});
test('filtered-out elements never reappear during dragging and no input facts are mutated', () => {
  const original = JSON.stringify({ nodes, edges });
  const plan = networkDragPlan(nodes.filter(node => node.id !== 'hardware' && node.kind !== 'alias'), edges, 'class:cause');
  assert.deepEqual(plan.members.map(member => member.id).sort(), ['class:cause', 'firmware', 'loose']);
  assert.equal(plan.edges.size, 2);
  assert.equal(JSON.stringify({ nodes, edges }), original);
});
test('duplicate links, self links and business cycles do not duplicate members or recurse', () => {
  const cyclic = [...edges, ...edges, relation('board', 'board', 'affects'), relation('board', 'hardware', 'affects')];
  assert.deepEqual(networkDragPlan(nodes, cyclic, 'board').members.map(member => member.id).sort(), ids('board'));
});
test('branch packing remains finite, separates coincident elements and keeps the dragged anchor at zero across zooms', () => {
  const positions = new Map(nodes.map(node => [node.id, { x: 8, y: 8 }]));
  const before = JSON.stringify([...positions]);
  for (const scale of [0.1, 0.35, 1, 2, 5]) {
    for (const root of ['class:cause', 'board', 'alias:board']) {
      const plan = networkDragPlan(nodes, edges, root);
      const offsets = networkDragOffsets(plan, nodes, positions, scale, { x: 1000, y: 680 });
      assert.deepEqual(offsets.get(root), { x: 0, y: 0 });
      assert.ok([...offsets.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
      for (const left of plan.members) for (const right of plan.members) {
        if (left.id === right.id) continue;
        const first = offsets.get(left.id)!, second = offsets.get(right.id)!;
        assert.ok(Math.hypot(first.x - second.x, first.y - second.y) * scale >= 29.8);
      }
    }
  }
  assert.equal(JSON.stringify([...positions]), before);
});
test('packing handles an empty graph, lone node and a larger multi-ring class', () => {
  assert.deepEqual(networkDragOffsets(networkDragPlan([], [], 'missing'), [], new Map(), 1, { x: 360, y: 480 }).get('missing'), { x: 0, y: 0 });
  const root = nodes[0];
  const family = [root, ...Array.from({ length: 28 }, (unusedValue, index) => ({ ...nodes[1], id: `child-${index}` }))];
  const links = family.slice(1).map(node => relation(node.id, root.id, 'instance_of'));
  const offsets = networkDragOffsets(networkDragPlan(family, links, root.id), family, new Map(), 0.6, { x: 1000, y: 680 });
  assert.equal(offsets.size, family.length);
  assert.ok([...offsets.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});
test('motion follows over multiple frames without overshoot and respects reduced motion', () => {
  const start = { x: 0, y: 100 }, target = { x: 200, y: -100 };
  const first = followDragPoint(start, target, 16);
  assert.ok(first.x > 0 && first.x < target.x && first.y < start.y && first.y > target.y);
  let position = first;
  for (let frame = 0; frame < 30; frame += 1) position = followDragPoint(position, target, 16);
  assert.ok(Math.hypot(position.x - target.x, position.y - target.y) < 0.06);
  assert.deepEqual(followDragPoint(start, target, 0), start);
  assert.deepEqual(followDragPoint(start, target, 16, true), target);
  assert.deepEqual(followDragPoint(start, target, 3200), followDragPoint(start, target, 64));
  const twice = followDragPoint(followDragPoint(start, target, 8), target, 8);
  assert.ok(Math.hypot(first.x - twice.x, first.y - twice.y) < 1e-10);
});
