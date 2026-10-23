import assert from 'node:assert/strict';
import test from 'node:test';
import { dialoguePaths, loadDialogueDraft, removeDialogueBranch, sampleDialogueTree, saveDialogueDraft, testAllocation, validateDialogueTree } from '../src/dialogueTestTree.ts';

test('example contains actual branches sharing the start, not independent linear transcripts', () => {
  const tree = sampleDialogueTree('fixture');
  assert.deepEqual(validateDialogueTree(tree, 'fixture'), []);
  const paths = dialoguePaths(tree);
  assert.equal(paths.length, 3);
  assert.equal(new Set(paths.map(path => path.nodes[0].id)).size, 1);
  assert.deepEqual(paths.map(path => path.flow), ['normal', 'exception', 'stress']);
  assert.equal(paths.find(path => path.flow === 'stress')?.nodes.length, 9);
  assert.equal(tree.source, null);
  assert.ok(tree.nodes.every(node => !('answer' in node) && node.check));
});

test('target percentages allocate integers without changing actual available paths', () => {
  const tree = sampleDialogueTree('fixture');
  assert.deepEqual(testAllocation(10, tree.target), { normal: 6, exception: 3, stress: 1 });
  assert.deepEqual(testAllocation(3, tree.target), { normal: 2, exception: 1, stress: 0 });
  assert.equal(dialoguePaths(tree).length, 3);
  for (const count of [1, 7, 11, 200]) assert.equal(Object.values(testAllocation(count, tree.target)!).reduce((sum, value) => sum + value), count);
  for (const count of [0, 201, NaN, 1.5]) assert.equal(testAllocation(count, tree.target), null);
  assert.equal(testAllocation(10, { normal: 50, exception: 30, stress: 10 }), null);
});

test('changing a shared node changes every path, branch-only edits do not cross contexts', () => {
  const tree = sampleDialogueTree('fixture');
  tree.nodes[0].user = '新的共同首问';
  tree.nodes.find(node => node.id === 'correction')!.user = '只改异常分支';
  const paths = dialoguePaths(tree);
  assert.ok(paths.every(path => path.nodes[0].user === '新的共同首问'));
  assert.ok(paths.filter(path => path.flow !== 'exception').every(path => !path.nodes.some(node => node.user === '只改异常分支')));
});

test('delete removes only the selected branch and descendants and protects root', () => {
  const tree = sampleDialogueTree('fixture');
  const deleted = removeDialogueBranch(tree, 'correction');
  assert.ok(!deleted.nodes.some(node => node.id.startsWith('correction')));
  assert.equal(dialoguePaths(deleted).length, 2);
  assert.equal(dialoguePaths(tree).length, 3);
  assert.equal(removeDialogueBranch(tree, 'start'), tree);
});

test('invalid parents, loops, excessive branching and missing checks are blocked', () => {
  const tree = sampleDialogueTree('fixture');
  const broken = structuredClone(tree);
  broken.nodes[1].parentId = 'absent';
  assert.ok(validateDialogueTree(broken, 'fixture').some(message => message.includes('父回合')));
  broken.nodes[1].parentId = 'normal-end';
  assert.ok(validateDialogueTree(broken, 'fixture').some(message => message.includes('循环')));
  broken.nodes[1].parentId = '';
  assert.ok(validateDialogueTree(broken, 'fixture').some(message => message.includes('编号')));
  const crowded = structuredClone(tree);
  crowded.nodes.push({ ...crowded.nodes[1], id: 'fourth' });
  assert.ok(validateDialogueTree(crowded, 'fixture').some(message => message.includes('最多三个')));
  const missing = structuredClone(tree);
  missing.nodes[1].check = '';
  assert.ok(validateDialogueTree(missing, 'fixture').length > 0);
});

test('malformed storage, cross-project drafts and sensitive inputs fail closed', () => {
  assert.ok(validateDialogueTree(null, 'fixture').length > 0);
  assert.ok(validateDialogueTree(sampleDialogueTree('other'), 'fixture').length > 0);
  const tree = sampleDialogueTree('fixture');
  tree.source = { sessionId: 'source', messageId: '', question: '匿名首问' };
  assert.ok(validateDialogueTree(tree, 'fixture').some(message => message.includes('来源引用')));
  tree.source = null;
  tree.nodes[0].user = 'password: ${API_KEY}';
  assert.ok(validateDialogueTree(tree, 'fixture').some(message => message.includes('疑似')));
  assert.throws(() => loadDialogueDraft({ getItem: () => '{bad-json' }, 'fixture'));
  assert.throws(() => loadDialogueDraft({ getItem: () => 'x'.repeat(300001) }, 'fixture'));
});

test('explicit local save creates a real revision and is project-scoped', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) || null, setItem: (key: string, value: string) => { store.set(key, value); } };
  const tree = sampleDialogueTree('fixture');
  assert.equal(loadDialogueDraft(storage, 'fixture'), null);
  const first = saveDialogueDraft(storage, tree);
  assert.equal(first.revision, 1);
  assert.equal(tree.revision, 0);
  assert.equal(store.size, 1);
  assert.equal(loadDialogueDraft(storage, 'other'), null);
  assert.deepEqual(loadDialogueDraft(storage, 'fixture'), first);
  const second = saveDialogueDraft(storage, first);
  assert.equal(second.revision, 2);
  assert.throws(() => saveDialogueDraft({ setItem: () => { throw new Error('storage disabled'); } }, tree));
});
