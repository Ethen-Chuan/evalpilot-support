import test from 'node:test';
import assert from 'node:assert/strict';
import { networkEdgeOffsets, networkEdgeStyle, networkHomes, networkLayer, networkLayers, networkView, scopedNetwork } from '../src/ontologyNetwork.ts';
import type { GraphEdge, GraphNode } from '../src/ontologyGraph';

const nodes: GraphNode[] = [
  { id: 'class:component', kind: 'class', classId: 'component', label: '部件', provenance: 'schema' },
  { id: 'board', kind: 'entity', classId: 'component', modelIds: ['model-a'], label: '主板', provenance: 'example' },
  { id: 'alias:board', kind: 'alias', classId: 'component', modelIds: ['model-a'], label: '控制板', provenance: 'example' },
  { id: 'black', kind: 'entity', classId: 'symptom', label: '黑屏', provenance: 'example' },
  { id: 'onsite', kind: 'entity', classId: 'action', label: '现场复核', provenance: 'example' },
  { id: 'model-a', kind: 'entity', classId: 'model', label: 'A型', provenance: 'example' },
  { id: 'model-b', kind: 'entity', classId: 'model', label: 'B型', provenance: 'example' },
  { id: 'rule:major', kind: 'rule', classId: 'severity', ruleId: 'major', label: '必须复核', provenance: 'schema' },
];
const edges: GraphEdge[] = [
  { id: 'alias', source: 'alias:board', target: 'board', type: 'alias_of', label: '规范叫法', provenance: 'example' },
  { id: 'class', source: 'board', target: 'class:component', type: 'instance_of', label: '属于概念', provenance: 'schema' },
  { id: 'scope', source: 'model-a', target: 'board', type: 'entity_scope', modelIds: ['model-a'], label: '适用机型', provenance: 'schema' },
  { id: 'candidate', source: 'black', target: 'board', type: 'possible_cause', modelIds: ['model-a'], label: '仅为候选', provenance: 'example' },
  { id: 'allowed', source: 'black', target: 'onsite', type: 'allows_action', modelIds: ['model-a'], label: '允许', provenance: 'example' },
  { id: 'forbidden', source: 'black', target: 'onsite', type: 'forbids_action', modelIds: ['model-b'], label: '禁止', provenance: 'example' },
  { id: 'required', source: 'rule:major', target: 'onsite', ruleId: 'major', type: 'requires_action', label: '必须', provenance: 'schema' },
];
const graph = { nodes, edges };
const layers = () => new Set(networkLayers.map(layer => layer.id));

test('the unfiltered network uses every original node and edge without invented links', () => {
  const original = JSON.stringify(graph);
  const result = networkView(scopedNetwork(graph, '', layers()), 'all', '', new Set());
  assert.deepEqual(result, graph);
  assert.equal(JSON.stringify(graph), original);
});
test('model scope excludes inapplicable entities, their aliases, other models and disallowed edge scopes', () => {
  const result = scopedNetwork(graph, 'model-b', layers());
  assert.ok(!result.nodes.some(node => ['board', 'alias:board', 'model-a'].includes(node.id)));
  assert.ok(result.edges.some(edge => edge.id === 'forbidden'));
  assert.ok(!result.edges.some(edge => ['allowed', 'candidate', 'scope'].includes(edge.id)));
  const identifiers = new Set(result.nodes.map(node => node.id));
  assert.ok(result.edges.every(edge => identifiers.has(edge.source) && identifiers.has(edge.target)));
});
test('graph layers distinguish equivalence, membership, candidates and enforcement', () => {
  assert.equal(networkLayer(edges[0]), 'alias');
  assert.equal(networkLayer(edges[1]), 'structure');
  assert.equal(networkLayer(edges[3]), 'business');
  assert.equal(networkLayer(edges[5]), 'constraint');
  const visible = layers(); visible.delete('alias'); visible.delete('constraint');
  const result = scopedNetwork(graph, '', visible);
  assert.ok(result.nodes.every(node => !['alias', 'rule'].includes(node.kind)));
  assert.ok(result.edges.every(edge => !['alias', 'constraint'].includes(networkLayer(edge))));
});
test('progressive expansion adds only actual immediate neighbors and keeps previous branches', () => {
  const roots = new Set(['alias:board']);
  const first = networkView(graph, 'explore', 'alias:board', roots);
  assert.deepEqual(first.nodes.map(node => node.id), ['board', 'alias:board']);
  roots.add('board');
  const next = networkView(graph, 'explore', 'board', roots);
  assert.ok(next.nodes.length > first.nodes.length);
  assert.ok(first.nodes.every(node => next.nodes.includes(node)));
  assert.ok(next.edges.every(edge => edges.includes(edge)));
  assert.ok(!next.nodes.some(node => node.id === 'rule:major'));
});
test('local depth is bounded and empty selection is an honest empty graph', () => {
  const first = networkView(graph, 'local', 'black', new Set(), 1);
  const second = networkView(graph, 'local', 'black', new Set(), 2);
  assert.ok(!first.nodes.some(node => node.id === 'alias:board'));
  assert.ok(second.nodes.some(node => node.id === 'alias:board'));
  assert.deepEqual(networkView(graph, 'local', '', new Set()), { nodes: [], edges: [] });
});
test('candidates, forbidden and disabled rules have distinct line semantics', () => {
  assert.equal(networkEdgeStyle(edges[3]).candidate, true);
  assert.equal(networkEdgeStyle(edges[5]).forbidden, true);
  assert.notDeepEqual(networkEdgeStyle(edges[3]).dash, networkEdgeStyle(edges[5]).dash);
  assert.notEqual(networkEdgeStyle(edges[4]).color, networkEdgeStyle(edges[5]).color);
  assert.equal(networkEdgeStyle({ ...edges[6], enabled: false }).color, '#71808d');
});
test('parallel and reverse links use separate curves with stable offsets', () => {
  const reversed = { ...edges[4], id: 'reversed', source: 'onsite', target: 'black' };
  const input = [edges[4], edges[5], reversed];
  const offsets = networkEdgeOffsets(input);
  const worldOffsets = input.map(edge => offsets.get(edge.id)! * (edge.source < edge.target ? 1 : -1));
  assert.equal(new Set(worldOffsets).size, input.length);
  assert.deepEqual([...networkEdgeOffsets([...input].reverse())].sort(), [...offsets].sort());
});
test('layout homes are finite and put aliases around their actual canonical entity', () => {
  const homes = networkHomes(nodes, edges);
  assert.ok(nodes.every(node => Number.isFinite(homes.get(node.id)?.x) && Number.isFinite(homes.get(node.id)?.y)));
  const canonical = homes.get('board')!, alias = homes.get('alias:board')!;
  assert.ok(Math.abs(Math.hypot(canonical.x - alias.x, canonical.y - alias.y) - 45) < 0.0001);
  assert.deepEqual(networkHomes([], []), new Map(['model', 'component', 'spare', 'action', 'severity', 'symptom', 'cause'].map((identifier, index) => { const angle = index / 7 * Math.PI * 2 - Math.PI / 2; return ['class:' + identifier, { x: Math.cos(angle) * 360, y: Math.sin(angle) * 310 }]; })));
});
