import test from 'node:test';
import assert from 'node:assert/strict';
import { objectCamera, objectLayout, objectNameLines, objectZoom } from '../src/ontologyObjectLayout.ts';
import type { GraphNode, GraphEdge } from '../src/ontologyGraph.ts';

const nodes: GraphNode[] = [
  { id: 'alias-one', label: '主机', kind: 'alias', provenance: 'example' },
  { id: 'alias-two', label: '机子', kind: 'alias', provenance: 'example' },
  { id: 'alias-three', label: '机器', kind: 'alias', provenance: 'example' },
  { id: 'equipment', label: '整机', kind: 'entity', classId: 'device', provenance: 'example' },
  { id: 'model-a', label: 'A-100', kind: 'entity', classId: 'model', provenance: 'example' },
  { id: 'code-a', label: 'E102', kind: 'entity', classId: 'code', provenance: 'example' },
  { id: 'mainboard', label: '主控板', kind: 'entity', classId: 'component', provenance: 'example' },
  { id: 'rule', label: '不可直接换件', kind: 'rule', provenance: 'schema' },
  { id: 'handoff', label: '专业复核', kind: 'entity', classId: 'action', provenance: 'example' },
  { id: 'ticket', label: '示例工单', kind: 'entity', classId: 'ticket', provenance: 'example' },
];
const pairs = [['alias-one', 'equipment'], ['alias-two', 'equipment'], ['alias-three', 'equipment'], ['equipment', 'model-a'], ['model-a', 'code-a'], ['code-a', 'mainboard'], ['mainboard', 'rule'], ['mainboard', 'handoff'], ['handoff', 'ticket'], ['mainboard', 'equipment']];
const edges: GraphEdge[] = pairs.map(([source, target], index) => ({ id: `edge-${index}`, source, target, label: '示例关系', type: 'related', provenance: 'example' }));

test('object layout keeps every typed relationship without inventing edges', () => {
  const before = JSON.stringify({ nodes, edges });
  const layout = objectLayout(nodes, edges);
  assert.equal(layout.cards.length, nodes.length);
  assert.deepEqual(layout.links.map(link => link.edge.id), edges.map(edge => edge.id));
  assert.equal(layout.lanes.length, 5);
  assert.equal(JSON.stringify({ nodes, edges }), before);
});
test('object cards never overlap and connector routing avoids unrelated cards', () => {
  const layout = objectLayout(nodes, edges);
  for (const card of layout.cards) {
    assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.width <= layout.width && card.y + card.height <= layout.height);
    for (const other of layout.cards.filter(other => other.id !== card.id)) {
      assert.ok(card.x + card.width <= other.x || other.x + other.width <= card.x || card.y + card.height <= other.y || other.y + other.height <= card.y);
    }
  }
  for (const link of layout.links) {
    for (let index = 1; index < link.points.length; index++) {
      const start = link.points[index - 1], end = link.points[index];
      assert.ok(start.x === end.x || start.y === end.y);
      for (const card of layout.cards.filter(card => ![link.edge.source, link.edge.target].includes(card.id))) {
        const crosses = start.x === end.x
          ? start.x > card.x && start.x < card.x + card.width && Math.max(start.y, end.y) > card.y && Math.min(start.y, end.y) < card.y + card.height
          : start.y > card.y && start.y < card.y + card.height && Math.max(start.x, end.x) > card.x && Math.min(start.x, end.x) < card.x + card.width;
        assert.equal(crosses, false, `${link.edge.id} crosses ${card.id}`);
      }
    }
  }
});
test('default camera keeps names above twelve pixels rather than squeezing to 8%', () => {
  const layout = objectLayout(nodes, edges);
  for (const [width, height] of [[320, 360], [620, 480], [1050, 570], [1500, 900]]) {
    const camera = objectCamera(layout, width, height);
    assert.ok(camera.scale * 16 >= 12);
    assert.ok(Object.values(camera).every(Number.isFinite));
    assert.ok(objectCamera(layout, width, height, true).scale <= camera.scale);
  }
});
test('zoom retains its pointer anchor and bounds', () => {
  const camera = { x: 40, y: 60, scale: 0.9 }, point = { x: 510, y: 300 };
  const zoomed = objectZoom(camera, 1.3, point);
  assert.ok(Math.abs((point.x - zoomed.x) / zoomed.scale - (point.x - camera.x) / camera.scale) < 0.0001);
  assert.equal(objectZoom(camera, 100, point).scale, 2);
  assert.equal(objectZoom(camera, 0, point).scale, 0.15);
});
test('fault code and model remain intact while long Chinese names wrap', () => {
  assert.deepEqual(objectNameLines('E102 · A-100'), ['E102 · A-100']);
  assert.deepEqual(objectNameLines('E102 · A-200'), ['E102 · A-200']);
  assert.equal(objectNameLines('候选部件不等于维修结论').join(''), '候选部件不等于维修结论');
  assert.ok(objectNameLines('这是一个用于检查超长节点名称不会溢出边框的虚构示例名称').length <= 2);
});
test('drag override remains local to rendering and reset restores deterministic positions', () => {
  const layout = objectLayout(nodes, edges), moved = objectLayout(nodes, edges, new Map([['equipment', { x: 333, y: 444 }]]));
  assert.equal(moved.cards.find(card => card.id === 'equipment')?.x, 333);
  assert.deepEqual(layout, objectLayout(nodes, edges));
  assert.equal(objectLayout([], []).cards.length, 0);
  assert.equal(objectLayout(nodes, [...edges, { ...edges[0], id: 'missing', target: 'missing' }]).links.length, edges.length);
});
