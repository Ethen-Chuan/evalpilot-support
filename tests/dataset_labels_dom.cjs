const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const dependency = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependency('jsdom');

async function check() {
  const base = 'http://127.0.0.1:4297';
  const built = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-docs', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-docs' })); build.onLoad({ filter: /.*/, namespace: 'raw-docs' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  let slowComplaint = false;
  let failNext = false;
  const proxy = new VirtualConsole();
  proxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/#datasets?project=LABEL-TEST', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
  const window = dom.window;
  window.AbortController = global.AbortController;
  window.AbortSignal = global.AbortSignal;
  window.fetch = async (input, options) => {
    const target = new URL(input, base);
    if (target.origin !== base || (options?.method && options.method !== 'GET')) throw new Error('Only local read-only requests permitted');
    if (target.pathname === '/api/support/sessions') {
      if (failNext) { failNext = false; return new Response(JSON.stringify({ error: '隔离模拟读取失败' }), { status: 503 }); }
      if (slowComplaint && target.searchParams.get('labels')?.includes('complaint')) await new Promise(resolve => setTimeout(resolve, 400));
    }
    return fetch(target, options);
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(built.outputFiles[0].text);
  const document = window.document;
  const wait = async predicate => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out: ' + predicate.toString()); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  const click = async (name, root = document) => { const element = await wait(() => button(name, root)); assert.equal(element.disabled, false, name); element.click(); await new Promise(resolve => setTimeout(resolve, 100)); };
  const card = name => document.querySelector(`[aria-label="${name}分类卡片"]`);
  const field = label => document.querySelector(`[aria-label="${label}"]`);
  const fill = (element, value) => { const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const ready = async count => { await wait(() => document.querySelector('.dataset-labels')?.getAttribute('aria-busy') === 'false' && document.querySelector('.dataset-label-filters strong')?.textContent === String(count)); assert.ok(document.querySelector('.project-case-caption').textContent.includes(`当前 ${count} 个案例`)); };
  try {
    await ready(32);
    assert.equal(document.querySelectorAll('.dataset-label-card').length, 8);
    assert.equal(document.querySelectorAll('.project-case-table tbody tr').length, 20);
    const originalIntent = card('客户意图').textContent;
    await click('下一页案例'); await ready(32);
    assert.equal(document.querySelectorAll('.project-case-table tbody tr').length, 12);
    assert.equal(card('客户意图').textContent, originalIntent);
    assert.equal(card('关联系统').querySelectorAll('.dataset-label-row').length, 3);
    await click('展开其余 4 项', card('关联系统'));
    assert.equal(card('关联系统').querySelectorAll('.dataset-label-row').length, 7);
    await click('收起', card('关联系统'));
    assert.equal(card('关联系统').querySelectorAll('.dataset-label-row').length, 3);
    await click('筛选客户意图：投诉反馈，8段'); await ready(8);
    assert.equal(document.querySelectorAll('.project-case-table tbody tr').length, 8);
    assert.equal(new URLSearchParams(window.location.hash.split('?')[1]).has('page'), false);
    await click('筛选故障域：硬件域，4段'); await ready(4);
    assert.equal(document.querySelectorAll('.dataset-label-filters button[aria-label]').length, 2);
    const preserved = window.location.hash;
    const conversation = document.querySelector('.project-case-open');
    assert.equal(new URLSearchParams(conversation.hash.split('?')[1]).get('returnTo'), preserved);
    conversation.click(); await wait(() => window.location.hash.startsWith('#knowledge'));
    window.history.back(); await wait(() => window.location.hash === preserved); await ready(4);
    await click('移除故障域筛选'); await ready(8);
    await click('清空标签'); await ready(32);
    await click('筛选知识分类未标注，8段'); await ready(8);
    assert.ok(card('知识分类').textContent.includes('暂无该字段标注'));
    await click('清空标签'); await ready(32);
    const regular = [...document.querySelectorAll('.dataset-label-scopes button')].find(element => element.textContent.startsWith('常规会话')); regular.click(); await ready(28);
    assert.equal(card('客户意图').querySelector('[aria-label="筛选客户意图：投诉反馈，8段"]').textContent.includes('28.6%'), true);
    const all = [...document.querySelectorAll('.dataset-label-scopes button')].find(element => element.textContent.startsWith('全部会话')); all.click(); await ready(32);
    fill(field('搜索案例编号或完整对话内容'), 'LABEL-CASE-003'); await ready(1);
    fill(field('搜索案例编号或完整对话内容'), 'does-not-exist'); await ready(0);
    assert.equal(document.querySelectorAll('.dataset-label-row').length, 0);
    assert.equal(document.querySelectorAll('.dataset-label-card').length, 0);
    assert.ok(document.querySelector('.dataset-label-placeholder').textContent.includes('没有符合条件的会话'));
    await click('清空筛选，返回第一页'); await ready(32);
    window.location.hash = 'datasets?project=LABEL-TEST&intent=complaint'; await ready(8);
    assert.equal(field('筛选客户意图').value, 'complaint');
    fill(field('筛选客户意图'), ''); await ready(32);
    slowComplaint = true;
    window.location.hash = 'datasets?project=LABEL-TEST&intent=complaint';
    await new Promise(resolve => setTimeout(resolve, 60));
    window.location.hash = 'datasets?project=LABEL-TEST&intent=fault_repair'; await ready(32);
    await new Promise(resolve => setTimeout(resolve, 600)); await ready(32);
    assert.equal(field('筛选客户意图').value, 'fault_repair');
    failNext = true;
    await click('刷新统计'); await wait(() => document.querySelector('.project-load-error'));
    assert.equal(document.querySelectorAll('.dataset-label-card').length, 0);
    await click('重新读取'); await ready(32);
    await click('收起分类'); assert.equal(document.querySelectorAll('.dataset-label-card').length, 0);
    await click('展开分类'); assert.equal(document.querySelectorAll('.dataset-label-card').length, 8);
    assert.deepEqual(errors, []);
    console.log('PASS: dataset facets pagination, exact label counts, cross-filters, missing labels, scope, search, return navigation, legacy intent, stale response protection, retry and collapse');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
