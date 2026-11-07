import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacency, collapseNode, exampleExploration, expandNode, expandedIdentifiers, expansionBatchSize, expansionRoots, fitCamera, neighbors, reserveLabel, searchNodes, semanticPositions, visibleGraph, zoomCamera } from '../src/ontologyGraph.ts';
import type { GraphEdge, GraphNode } from '../src/ontologyGraph.ts';

const nodes: GraphNode[] = [
  { id: 'project', label: '项目', kind: 'project', provenance: 'imported' },
  { id: 'concept', label: '故障', kind: 'class', provenance: 'schema' },
  { id: 'entity', label: '整机', aliases: ['主机'], kind: 'entity', provenance: 'example' },
  { id: 'case-one', label: '案例 0001', kind: 'case', provenance: 'imported' },
  { id: 'case-two', label: '案例 0002', kind: 'case', provenance: 'imported' },
];
const edges: GraphEdge[] = [
  { id: 'one', source: 'project', target: 'concept', type: 'class', label: '维度', provenance: 'schema' },
  { id: 'two', source: 'entity', target: 'concept', type: 'instance', label: '属于', provenance: 'schema' },
  { id: 'three', source: 'case-one', target: 'entity', type: 'label', label: '标注', provenance: 'human_annotation' },
  { id: 'four', source: 'case-two', target: 'entity', type: 'label', label: '标注', provenance: 'human_annotation' },
];

test('overview aggregates while all mode includes every loaded case', () => {
  assert.equal(visibleGraph({ nodes, edges }, 'overview', '', 1, new Set(), new Set(), '').nodes.length, 3);
  assert.equal(visibleGraph({ nodes, edges }, 'all', '', 1, new Set(), new Set(), '').nodes.length, 5);
  assert.equal(visibleGraph({ nodes, edges }, 'overview', '', 1, new Set(['case-one']), new Set(), '').nodes.length, 4);
});
test('local graph follows actual relationships and depth without dangling edges', () => {
  const local = visibleGraph({ nodes, edges }, 'local', 'concept', 1, new Set(), new Set(), '');
  assert.deepEqual(local.nodes.map(node => node.id), ['project', 'concept', 'entity']);
  assert.equal(neighbors(adjacency(edges), 'concept', 2).size, 5);
  assert.equal(local.edges.length, 2);
});
test('kind and relation filters do not modify source data', () => {
  const before = JSON.stringify({ nodes, edges });
  const filtered = visibleGraph({ nodes, edges }, 'all', '', 1, new Set(), new Set(['case']), 'instance');
  assert.equal(filtered.edges.length, 1);
  assert.equal(JSON.stringify({ nodes, edges }), before);
});
test('search supports aliases and explicit case identifiers', () => {
  assert.equal(searchNodes(nodes, '主机')[0].id, 'entity');
  assert.equal(searchNodes(nodes, 'case-two')[0].label, '案例 0002');
  assert.equal(searchNodes(nodes, '').length, 3);
  assert.equal(searchNodes(nodes, 'missing').length, 0);
});
test('zoom retains pointer anchor and has explicit bounds', () => {
  const camera = { x: 100, y: 50, scale: 1 }, pointer = { x: 200, y: 100 };
  const zoomed = zoomCamera(camera, 2, pointer);
  assert.equal((pointer.x - zoomed.x) / zoomed.scale, (pointer.x - camera.x) / camera.scale);
  assert.equal(zoomCamera(camera, 100, pointer).scale, 5);
  assert.equal(zoomCamera(camera, 0, pointer).scale, 0.08);
});
test('fit is finite for empty, single and large graphs', () => {
  for (const points of [[], [{ x: 0, y: 0 }], Array.from({ length: 10000 }, (_, index) => ({ x: index, y: -index }))]) {
    const camera = fitCamera(points, 800, 600);
    assert.ok(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.scale));
  }
});
test('labels outside the viewport and overlapping labels are rejected', () => {
  const occupied = [];
  assert.equal(reserveLabel({ left: 20, top: 20, width: 80, height: 20 }, occupied, 500, 300), true);
  assert.equal(reserveLabel({ left: 30, top: 25, width: 80, height: 20 }, occupied, 500, 300), false);
  assert.equal(reserveLabel({ left: 490, top: 80, width: 80, height: 20 }, occupied, 500, 300), false);
  assert.equal(reserveLabel({ left: 200, top: 120, width: 80, height: 20 }, occupied, 500, 300), true);
});

test('resolution scope keeps only explicit nodes and exact returned relation IDs', () => {
  const resolution = { activeNodeIds: ['project', 'concept', 'entity', 'missing'], activeEdgeIds: ['two', 'four', 'missing'] };
  const filtered = visibleGraph({ nodes, edges }, 'resolution', '', 1, new Set(), new Set(), '', resolution);
  assert.deepEqual(filtered.nodes.map(node => node.id), ['project', 'concept', 'entity']);
  assert.deepEqual(filtered.edges.map(edge => edge.id), ['two']);
  assert.equal(visibleGraph({ nodes, edges }, 'resolution', '', 1, new Set(), new Set(), '').nodes.length, 0);
});

test('resolution scope respects filters without inventing edges or modifying evidence', () => {
  const resolution = { activeNodeIds: ['project', 'concept', 'entity'], activeEdgeIds: ['one', 'two'] };
  const before = JSON.stringify({ nodes, edges, resolution });
  const filtered = visibleGraph({ nodes, edges }, 'resolution', '', 1, new Set(), new Set(['project']), 'instance', resolution);
  assert.deepEqual(filtered.nodes.map(node => node.id), ['concept', 'entity']);
  assert.deepEqual(filtered.edges.map(edge => edge.id), ['two']);
  assert.equal(JSON.stringify({ nodes, edges, resolution }), before);
});

test('click expansion retains previous levels and uses only actual neighbor relations', () => {
  const indexed = new Map(nodes.map(node => [node.id, node])), index = adjacency(edges);
  let state = expansionRoots(nodes);
  assert.deepEqual([...expandedIdentifiers(state)], ['project']);
  state = expandNode(state, 'project', index, indexed);
  assert.deepEqual([...expandedIdentifiers(state)], ['project', 'concept']);
  state = expandNode(state, 'concept', index, indexed);
  assert.ok(expandedIdentifiers(state).has('entity'));
  state = expandNode(state, 'entity', index, indexed);
  state = expandNode(state, 'entity', index, indexed);
  const view = visibleGraph({ nodes, edges }, 'explore', '', 1, new Set(), new Set(), '', null, state);
  assert.equal(view.nodes.length, 5);
  assert.deepEqual(view.edges, edges);
  const collapsed = collapseNode(state, 'concept');
  assert.deepEqual([...expandedIdentifiers(collapsed)], ['project', 'concept']);
  assert.equal(collapsed.branches.has('entity'), false);
});

test('cycles terminate and collapse preserves nodes reached through other branches', () => {
  const state = { roots: ['project'], branches: new Map([['project', ['concept', 'entity']], ['concept', ['entity', 'case-one']], ['entity', ['concept', 'case-one']], ['case-one', ['case-two']]]) };
  assert.equal(expandedIdentifiers(state).size, 5);
  const collapsed = collapseNode(state, 'concept');
  assert.equal(expandedIdentifiers(collapsed).size, 5);
  assert.equal(expandedIdentifiers(collapseNode(collapsed, 'entity')).size, 3);
  assert.equal(state.branches.get('concept')?.length, 2);
});

test('large degrees expand in bounded batches, preferring schema over thousands of cases', () => {
  const large = [...nodes, ...Array.from({ length: 150 }, (_, position) => ({ id: 'bulk-' + position, label: 'Fixture', kind: 'case', provenance: 'imported' }))];
  const index = new Map([['project', new Set([...large.filter(node => node.kind === 'case').map(node => node.id), 'concept'])]]);
  const indexed = new Map(large.map(node => [node.id, node]));
  let state = expandNode(expansionRoots(large), 'project', index, indexed);
  assert.deepEqual(state.branches.get('project'), ['concept']);
  state = expandNode(state, 'project', index, indexed, 10000);
  assert.equal(state.branches.get('project')?.length, expansionBatchSize + 1);
  assert.equal(expandNode(state, 'missing', index, indexed), state);
});

test('filters hide nodes without destroying expansion or introducing edges', () => {
  const state = { roots: nodes.map(node => node.id), branches: new Map<string, string[]>() };
  const filtered = visibleGraph({ nodes, edges }, 'explore', '', 1, new Set(), new Set(['case']), 'instance', null, state);
  assert.deepEqual(filtered.edges.map(edge => edge.id), ['two']);
  assert.equal(expandedIdentifiers(state).size, 5);
});

test('search can start a disconnected branch and reset returns to a clean root', () => {
  const state = expandNode(expansionRoots(nodes), 'case-one', adjacency(edges), new Map(nodes.map(node => [node.id, node])));
  assert.ok(state.roots.includes('case-one'));
  assert.ok(expandedIdentifiers(state).has('entity'));
  assert.deepEqual([...expandedIdentifiers(expansionRoots(nodes))], ['project']);
});

test('guided examples are connected slices of real schema, never invented paths', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../backend/ontology_schema.json', import.meta.url), 'utf8'));
  const fixtureNodes: GraphNode[] = schema.entities.map((entity: { id: string; label: string; class: string }) => ({ id: entity.id, label: entity.label, kind: 'entity', classId: entity.class, provenance: 'example' }));
  const fixtureEdges: GraphEdge[] = schema.relations.map((edge: GraphEdge, position: number) => ({ ...edge, id: String(position), provenance: 'example' }));
  for (const label of ['主机', '机子', '机器']) { fixtureNodes.push({ id: label, label, kind: 'alias', provenance: 'example' }); fixtureEdges.push({ id: label, source: label, target: 'equipment', type: 'alias_of', label: '规范叫法', provenance: 'example' }); }
  fixtureNodes.push(...schema.rules.map((rule: { id: string; label: string }) => ({ ...rule, id: 'rule:' + rule.id, kind: 'rule', provenance: 'schema' })));
  for (const topic of ['aliases', 'models', 'safety'] as const) {
    const state = exampleExploration({ nodes: fixtureNodes, edges: fixtureEdges }, topic);
    const view = visibleGraph({ nodes: fixtureNodes, edges: fixtureEdges }, 'explore', '', 1, new Set(), new Set(), '', null, state);
    assert.equal(neighbors(adjacency(view.edges), state.roots[0], view.nodes.length).size, view.nodes.length);
    assert.ok(view.nodes.length > 4);
    if (topic === 'aliases') assert.ok(view.nodes.some(node => node.id === 'ticket-example'));
    if (topic === 'models') assert.ok(view.nodes.some(node => node.id === 'power'));
    const positions = semanticPositions(view.nodes);
    assert.equal(new Set([...positions.values()].map(point => `${point.x},${point.y}`)).size, view.nodes.length);
  }
});
