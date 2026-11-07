const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const dependency = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependency('jsdom');

async function check() {
  const base = process.env.EVAL_ONTOLOGY_BASE || 'http://127.0.0.1:4294';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Only the local workspace may be tested');
  const built = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-docs', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-docs' })); build.onLoad({ filter: /.*/, namespace: 'raw-docs' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [], requests = [];
  const proxy = new VirtualConsole();
  proxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/#ontology?mode=example', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
  const window = dom.window, document = window.document;
  const delay = duration => new Promise(resolve => setTimeout(resolve, duration));
  let catalog, graph, lastResult, lastSuite, failCatalog = true, failRun = false, failSuite = false, slowRun = false, slowSuite = false;
  window.AbortController = global.AbortController;
  window.AbortSignal = global.AbortSignal;
  window.fetch = async (input, options) => {
    const target = new URL(input, base);
    const method = options?.method || 'GET';
    assert.equal(target.origin, base);
    assert.ok(method === 'GET' || (method === 'POST' && ['/api/support/ontology/business/run', '/api/support/ontology/business/verify'].includes(target.pathname)), 'No model calls or data mutations');
    if (target.pathname.endsWith('/run')) {
      const body = JSON.parse(options.body);
      assert.ok(catalog.cases.some(scenario => scenario.input.text === body.text), 'Only known synthetic cases may be sent');
    }
    if (target.pathname.endsWith('/verify')) assert.deepEqual(JSON.parse(options.body), { confirmSynthetic: true });
    requests.push({ path: target.pathname, method, signal: options?.signal });
    if (target.pathname.endsWith('/business/catalog') && failCatalog) { failCatalog = false; return new Response(JSON.stringify({ protocol: 'old-server' })); }
    if (target.pathname.endsWith('/business/run') && failRun) { failRun = false; return new Response(JSON.stringify({ error: '合成任务失败' }), { status: 503 }); }
    if (target.pathname.endsWith('/business/verify') && failSuite) { failSuite = false; return new Response(JSON.stringify({ error: '合成验收失败' }), { status: 503 }); }
    const response = await fetch(target, options);
    const value = await response.clone().json();
    if (target.pathname.endsWith('/business/catalog')) catalog = value;
    if (target.pathname.endsWith('/ontology/graph')) graph = value;
    if (target.pathname.endsWith('/business/run')) { lastResult = value; if (slowRun) await delay(650); }
    if (target.pathname.endsWith('/business/verify')) { lastSuite = value; if (slowSuite) await delay(650); }
    return response;
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, setTransform() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillRect() {}, strokeRect() {}, arc() {}, fillText() {}, measureText(text) { return { width: [...text].length * 12 }; } });
  const wait = async predicate => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { assert.deepEqual(errors, []); if (predicate()) return; await delay(40); } throw new Error('Timed out: ' + predicate.toString()); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  const click = async (name, root = document) => { await wait(() => button(name, root)); const element = button(name, root); assert.equal(element.disabled, false, name); element.click(); await delay(70); };
  const field = label => document.querySelector(`[aria-label="${label}"]`);
  const fill = async (element, value) => { const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await delay(70); };
  const select = async identifier => fill(field('选择业务演示场景'), identifier);
  const run = async () => { await click('运行这条客服任务'); await wait(() => document.querySelector('.ob-outcome')); };
  const counts = () => document.querySelector('canvas,.ontology-object-svg')?.getAttribute('aria-label').match(/当前 (\d+) 个节点、(\d+) 条关系/).slice(1).map(Number);
  const step = async index => { document.querySelectorAll('.ob-step-list>button')[index].click(); await delay(60); };
  try {
    window.eval(built.outputFiles[0].text);
    await wait(() => document.querySelector('.ob-state[role=alert]'));
    assert.match(document.querySelector('.ob-state').textContent, /新版服务/);
    await click('重试加载');
    await wait(() => document.querySelector('.ob-task-form'));
    assert.equal(button('客服决策演示').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('canvas'), null);
    assert.equal(document.querySelector('.ob-outcome'), null);
    assert.equal(document.querySelector('.ob-suite-result'), null);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    await run();
    assert.equal(lastResult.query.allowed, false);
    assert.equal(lastResult.query.tool, 'skipped');
    assert.deepEqual(lastResult.comparison.selected, []);
    assert.equal(lastResult.steps.find(item => item.id === 'lookup').status, 'skipped');
    assert.equal(document.querySelectorAll('.ob-step-list>button').length, 6);
    assert.match(document.querySelector('.ob-outcome').textContent, /0 条知识被实际引用/);
    await click('补充 A-100 并继续'); await wait(() => document.querySelector('.ob-source-documents'));
    assert.equal(lastResult.query.tool, 'lookup_fault_knowledge');
    assert.deepEqual(lastResult.outcome.candidateIds, ['mainboard']);
    assert.equal(field('客户补充的型号').value, 'model-a');
    assert.match(document.querySelector('.ob-source-documents').textContent, /DEMO-FAULT-A/);
    const savedId = lastResult.id;
    const lookup = lastResult.steps.find(item => item.id === 'lookup');
    await click('在图谱中核对这一步'); await wait(() => counts());
    assert.deepEqual(counts(), [lookup.nodeIds.length, lookup.edgeIds.length]);
    assert.equal(document.querySelector('.ontology-guide'), null);
    assert.equal(document.querySelector('.ontology-semantic'), null);
    assert.equal(document.querySelector('.ontology-business-holder').hidden, true);
    assert.ok(lookup.edgeIds.every(identifier => graph.edges.some(edge => edge.id === identifier && lookup.nodeIds.includes(edge.source) && lookup.nodeIds.includes(edge.target))));
    await click('节点详情');
    await click('全屏展示'); assert.equal(document.querySelector('.ontology-explorer').dataset.fullscreen, 'page');
    await click('编辑问题与建议'); await wait(() => !document.querySelector('.ontology-business-holder').hidden);
    assert.equal(document.body.style.overflow, '');
    assert.match(document.querySelector('.ob-run-foot').textContent, new RegExp(savedId));
    await click('查看完整决策依据'); await wait(() => counts());
    assert.deepEqual(counts(), [lastResult.graph.activeNodeIds.length, lastResult.graph.activeEdgeIds.length]);
    assert.ok(!lastResult.graph.activeNodeIds.includes('ticket-example'));
    await click('客服决策演示');
    await step(4);
    assert.match(document.querySelector('.ob-draft').textContent, /未创建工单/);
    assert.match(document.querySelector('.ob-draft').textContent, /DEMO-FAULT-A@/);
    await step(5); assert.equal(document.querySelectorAll('.ob-checks>div').length, 4);
    await select('alias-startup');
    assert.equal(document.querySelector('.ob-outcome'), null);
    await click('本体定义与图谱');
    assert.equal(document.querySelector('.ontology-resolution-summary'), null);
    await click('客服决策演示'); await run();
    assert.equal(lastResult.comparison.literal.length, 0);
    assert.equal(lastResult.comparison.normalized.length, 1);
    assert.equal(lastResult.comparison.selected[0].id, 'DEMO-STARTUP');
    assert.equal(document.querySelectorAll('.ob-comparison-grid article').length, 3);
    await step(0);
    assert.match(document.querySelector('.ob-mappings').textContent, /开不了机/);
    assert.match(document.querySelector('.ob-mappings').textContent, /启动异常/);
    const normalize = lastResult.steps[0];
    await click('在图谱中核对这一步'); await wait(() => counts());
    assert.deepEqual(counts(), [normalize.nodeIds.length, normalize.edgeIds.length]);
    assert.ok(normalize.edgeIds.length >= 2);
    await click('客服决策演示');
    for (const identifier of ['alias-variant', 'canonical-control', 'model-b', 'unsafe-replace', 'model-conflict', 'unknown-model', 'unknown-code', 'symptom-boundary']) {
      await select(identifier); await run();
      const expected = catalog.cases.find(item => item.id === identifier).expected;
      assert.deepEqual(lastResult.comparison.selected.map(item => item.id).sort(), expected.documents);
      assert.deepEqual(lastResult.outcome.candidateIds, expected.candidates);
      assert.equal(lastResult.outcome.nextAction, expected.nextAction);
      assert.equal(lastResult.outcome.actionBlocked, expected.actionBlocked);
      assert.equal(lastResult.query.tool, expected.tool);
      if (identifier === 'canonical-control') assert.deepEqual(lastResult.comparison.literal.map(item => item.id), lastResult.comparison.normalized.map(item => item.id));
      if (identifier === 'model-b') assert.ok(lastResult.comparison.excluded.some(item => item.id === 'DEMO-FAULT-A'));
      if (identifier === 'unsafe-replace') assert.match(document.querySelector('.ob-action-block').textContent, /已拦截/);
      if (identifier === 'model-conflict') assert.match(document.querySelector('.ob-outcome').textContent, /不一致/);
    }
    await select('alias-startup'); failRun = true;
    await click('运行这条客服任务'); await wait(() => document.querySelector('.ob-error'));
    assert.equal(document.querySelector('.ob-outcome'), null);
    await run();
    slowRun = true;
    await click('运行这条客服任务'); await select('unknown-code'); await delay(750);
    assert.equal(document.querySelector('.ob-outcome'), null);
    assert.ok(requests.filter(request => request.path.endsWith('/business/run')).at(-1).signal.aborted);
    slowRun = false;
    failSuite = true;
    await click('运行 12 条固定验收'); await wait(() => document.querySelector('.ob-acceptance [role=alert]'));
    assert.equal(document.querySelector('.ob-suite-result'), null);
    await click('运行 12 条固定验收'); await wait(() => document.querySelector('.ob-suite-result'));
    assert.equal(lastSuite.passed, 12); assert.equal(lastSuite.total, 12);
    assert.equal(document.querySelectorAll('.ob-suite-result details').length, 12);
    assert.equal(document.querySelectorAll('.ob-suite-detail li').length, 36);
    assert.match(document.querySelector('.ob-suite-result').textContent, /不证明生产准确率/);
    await click('带入这个场景', document.querySelector('.ob-suite-detail'));
    assert.equal(field('选择业务演示场景').value, 'alias-startup');
    assert.match(document.querySelector('.ob-method').textContent, /不代表 RAG 或大模型/);
    slowRun = true; slowSuite = true;
    await click('运行这条客服任务'); await click('运行 12 条固定验收');
    window.location.hash = '#ontology';
    await wait(() => !document.querySelector('.ontology-business'));
    await delay(750);
    assert.ok(requests.filter(request => request.path.endsWith('/business/run')).at(-1).signal.aborted);
    assert.ok(requests.filter(request => request.path.endsWith('/business/verify')).at(-1).signal.aborted);
    assert.equal(document.querySelector('.ob-outcome'), null);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, acceptance: { passed: lastSuite.passed, total: lastSuite.total }, traceSteps: 6, checks: ['old service detection and retry', 'task-first entry with no prefilled results', 'clarification gates actual lookup', 'follow-up unlocks scoped documents', 'six-step evidence and draft', 'exact per-step/full graph edges', 'fullscreen exit returns to same task', 'input change invalidates graph evidence', 'alias and canonical controls', 'model scope and conflicts', 'unknown coverage', 'repair prohibition', 'task and suite failure retry', 'stale responses and unmount abort', 'fixed expectations displayed'], requests: requests.length, externalCalls: false, dataWrites: false, visualVerification: false }));
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
