const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require(project + '/node_modules/esbuild');

async function check() {
  const built = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-docs', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-docs' })); build.onLoad({ filter: /.*/, namespace: 'raw-docs' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  const consoleProxy = new VirtualConsole();
  consoleProxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4295/?view=fixture#models?project=fixture&connect=1', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
  const window = dom.window;
  const document = window.document;
  window.fetch = async (input, options) => {
    const target = new URL(input, window.location.href);
    assert.equal(target.origin, window.location.origin);
    requests.push({ path: target.pathname, method: options?.method || 'GET' });
    const state = { runs: [], datasets: [], corpora: [], knowledge: [], training: [], bundles: [], versions: [], connections: [] };
    let payload = state;
    if (target.pathname.endsWith('/services')) payload = [{ id: 'openai', name: '隔离测试服务', endpoint: 'https://example.invalid', discovery: false, note: '构造测试，不访问供应商' }];
    if (target.pathname.endsWith('/connections')) {
      const body = JSON.parse(options.body);
      assert.equal(body.apiKey, 'fixture-input-not-a-credential');
      assert.equal(body.confirmed, true);
      assert.equal(body.candidateModel, 'fixture-model');
      payload = { id: 'fixture-connection' };
    }
    if (target.pathname.endsWith('/connections/test')) {
      assert.deepEqual(JSON.parse(options.body), { id: 'fixture-connection', confirmed: true });
      payload = { tested: true };
    }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(built.outputFiles[0].text);
  const wait = async predicate => { const end = Date.now() + 10000; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('UI expectation timed out'); };
  const dialog = () => document.querySelector('[role=dialog]');
  const button = name => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  const fill = (element, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); };
  try {
    await wait(() => dialog()?.textContent.includes('接入真实模型'));
    assert.equal(window.location.hash, '#models?project=fixture');
    assert.equal(window.location.search, '?view=fixture');
    assert.equal(dialog().querySelector('[aria-label="API Key"]').type, 'password');
    assert.equal(dialog().querySelector('[aria-label="API Key"]').autocomplete, 'off');
    assert.ok(button('保存内存配置').disabled);
    assert.ok(!requests.some(item => item.method === 'POST'));
    fill(dialog().querySelector('[aria-label="API Key"]'), 'fixture-input-not-a-credential');
    fill(dialog().querySelector('[aria-label="候选模型名称"]'), 'fixture-model');
    await wait(() => dialog().querySelector('[aria-label="候选模型名称"]').value === 'fixture-model');
    assert.ok(button('保存内存配置').disabled);
    dialog().querySelector('input[type=checkbox]').click();
    await wait(() => !button('保存内存配置').disabled);
    button('保存内存配置').click();
    await wait(() => button('测试文字连接'));
    assert.equal(dialog().querySelector('[aria-label="API Key"]').value, '');
    assert.equal(button('测试文字连接').disabled, true);
    assert.ok(!dialog().textContent.includes('fixture-input-not-a-credential'));
    dialog().querySelector('.lab-connection-test input[type=checkbox]').click();
    await wait(() => !button('测试文字连接').disabled);
    button('测试文字连接').click();
    await wait(() => dialog()?.textContent.includes('去选择模型和案例'));
    assert.equal(button('测试文字连接').disabled, true);
    assert.equal(dialog().querySelector('a.text-link').hash, '#compare?mode=text&panel=setup');
    button('关闭').click();
    await wait(() => !dialog());
    await new Promise(resolve => setTimeout(resolve, 3700));
    assert.equal(dialog(), null);
    button('连接模型 / API Key').click();
    await wait(() => dialog());
    assert.equal(dialog().querySelector('[aria-label="API Key"]').value, '');
    fill(dialog().querySelector('[aria-label="API Key"]'), 'fixture-input-not-a-credential');
    button('关闭').click();
    await wait(() => !dialog());
    window.location.hash = '#models?project=fixture-two&connect=1';
    await wait(() => dialog() && window.location.hash === '#models?project=fixture-two');
    assert.equal(dialog().querySelector('[aria-label="API Key"]').value, '');
    for (const storage of [window.localStorage, window.sessionStorage]) assert.ok(!JSON.stringify(Object.entries(storage)).includes('fixture-input-not-a-credential'));
    assert.equal(requests.filter(item => item.method === 'POST').length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: one-shot popup, preserved project, password field, explicit save/test consent, no automatic inference, cleared secret, header reopen, evaluation link; isolated responses only');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
