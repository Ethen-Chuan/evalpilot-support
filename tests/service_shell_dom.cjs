const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const { JSDOM, VirtualConsole } = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'))('jsdom');

async function main() {
  const base = process.env.EVAL_SERVICE_BASE;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const bundle = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-documents', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-documents' })); build.onLoad({ filter: /.*/, namespace: 'raw-documents' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const consoleProxy = new VirtualConsole(); consoleProxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
  const window = dom.window, document = window.document;
  window.structuredClone = global.structuredClone;
  window.AbortController = global.AbortController;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.fetch = (input, options) => { const target = new URL(input, base); assert.equal(target.origin, base); assert.equal(options?.method || 'GET', 'GET'); return fetch(target, options); };
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const wait = async predicate => { const deadline = Date.now() + 25000; while (Date.now() < deadline) { assert.deepEqual(errors, []); if (predicate()) return; await delay(45); } throw new Error('Timed out ' + predicate); };
  const button = label => [...document.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent.trim() === label);
  const visited = [];
  try {
    window.eval(bundle.outputFiles[0].text);
    if (process.env.EVAL_SERVICE_LEGACY === '1') {
      await wait(() => document.querySelector('.svc-loading')?.textContent.includes('升级前的后台'));
      assert.equal(document.querySelector('.svc-editor'), null);
      assert.ok(button('重新连接'));
      console.log('PASS: stale service backend shows a recovery explanation, not broken controls or a rendering crash; read only');
      return;
    }
    await wait(() => document.querySelector('.svc-mission'));
    assert.equal(document.querySelector('.workbench-shell').dataset.page, 'service');
    assert.equal(document.querySelectorAll('[aria-label="主导航"] button').length, 10);
    assert.equal(document.querySelectorAll('.nav-section-label').length, 3);
    assert.ok(document.querySelector('a[href="/product-prd.html"]'));
    window.location.hash = '#services?id=screen-care';
    await wait(() => document.querySelector('[aria-label="自助入口文案"]'));
    const entry = document.querySelector('[aria-label="自助入口文案"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(entry, '未保存的临时演示入口');
    entry.dispatchEvent(new window.Event('input', { bubbles: true })); await delay(60);
    window.location.hash = '#ontology';
    await wait(() => document.querySelector('[aria-label="领域本体管理工作台"]'));
    window.location.hash = '#services?id=screen-care';
    await wait(() => document.querySelector('[aria-label="自助入口文案"]')?.value === '未保存的临时演示入口');
    button('放弃修改').click(); await delay(60);
    assert.equal(window.sessionStorage.getItem('evalpilot.service.draft.screen-care'), null);
    button('切换深色模式').click(); await delay(60);
    assert.equal(document.documentElement.dataset.mode, 'dark');
    button('切换浅色模式').click(); await delay(60);
    for (const [route, selector] of [['services', '.svc-editor'], ['releases', '.svc-release-list'], ['improve', '.svc-metrics'], ['simulator', '.simulator'], ['datasets', '.project-asset-metrics'], ['ontology', '[aria-label="领域本体管理工作台"]'], ['benchmark', '.agent-lab'], ['overview', '.cx-dashboard'], ['modelops', '.modelops'], ['playground', '.agent-lab'], ['models', '.agent-lab'], ['knowledge', '.dialogue-knowledge'], ['compare', '.agent-lab'], ['traces', '.trace-category-tabs'], ['settings', '.settings-layout'], ['guide', '.guide-header']]) {
      window.location.hash = '#' + route;
      await wait(() => document.querySelector('.workbench-shell')?.dataset.page === route && document.querySelector(selector));
      assert.ok(!document.querySelector('.fatal-error'));
      if (route === 'datasets') assert.equal(Number(document.querySelectorAll('.project-asset-metrics dd')[1].textContent.replaceAll(',', '')), (await (await fetch(base + '/api/support/state')).json()).corpora.reduce((total, corpus) => total + corpus.totals.sessions, 0));
      if (route === 'ontology') assert.ok(document.querySelector('.workbench-shell').classList.contains('compact-navigation'));
      visited.push(route);
    }
    assert.match(document.querySelector('.quick-start').textContent, /新版：从服务设计到验收发布/);
    console.log(JSON.stringify({ passed: true, visited, defaultHome: 'service', datasetCountsMatchApi: true, themePreserved: true, externalCalls: false, writes: false, browserVisualVerification: false }));
  } finally { dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
