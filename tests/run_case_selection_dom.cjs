const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require(project + '/node_modules/esbuild');

async function check() {
  const built = await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Theme} from '@radix-ui/themes'; import {RunModal} from './src/RunModal'; const root = createRoot(document.getElementById('root')); window.renderModal = props => root.render(<Theme><RunModal {...props}/></Theme>);`, resolveDir: project, loader: 'tsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  const consoleProxy = new VirtualConsole();
  consoleProxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4295/#benchmark', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
  const window = dom.window;
  const document = window.document;
  const cases = Array.from({ length: 25 }, (_, index) => ({ id: `fixture-case-${index}`, sessionId: `fixture-chat-${index}`, title: `案例 ${index}`, question: `测试设备 ${index} 无法开机，应该如何排查？`, intent: 'repair', action: 'clarify', contextLimited: false }));
  const version = { id: 'fixture-version', name: '隔离测试模型', kind: 'external', provider: 'fixture', model: 'fixture-model', connectionId: 'fixture-connection' };
  const state = { versions: [version, { ...version, id: 'fixture-second', name: '第二个隔离模型' }], connections: [{ id: 'fixture-connection', endpoint: 'https://example.invalid', tested: true, name: '隔离服务', judgeModel: 'fixture-judge' }], intents: { repair: '故障报修' }, actions: { clarify: '澄清' } };
  let currentCases = cases;
  let caseError = false;
  let delayCases = false;
  let releaseCases;
  let releaseRun;
  let closed = 0;
  let completed = 0;
  let randomSeed = 73;
  window.Math.random = () => { randomSeed = (randomSeed * 16807) % 2147483647; return randomSeed / 2147483647; };
  window.fetch = async (input, options) => {
    const target = new URL(input, window.location.href);
    assert.equal(target.origin, window.location.origin);
    requests.push({ path: target.pathname, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
    if (target.pathname.endsWith('/cases')) {
      const response = new Response(JSON.stringify(caseError ? { error: '隔离测试：案例读取失败' } : currentCases), { status: caseError ? 503 : 200 });
      return delayCases ? new Promise(resolve => { releaseCases = () => resolve(response); }) : response;
    }
    assert.equal(target.pathname, '/api/support/lab/runs');
    return new Promise(resolve => { releaseRun = failed => resolve(new Response(JSON.stringify(failed ? { error: '隔离测试：启动失败' } : { id: 'fixture-run' }), { status: failed ? 503 : 200 })); });
  };
  window.eval(built.outputFiles[0].text);
  const wait = async predicate => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error(`Timed out: ${predicate}`); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const field = label => document.querySelector(`[aria-label="${label}"]`);
  const button = name => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name);
  const preview = () => [...document.querySelectorAll('[data-case-id]')].map(element => element.dataset.caseId);
  const consent = () => document.querySelector('.lab-consent input');
  const fill = async (element, value) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(); };
  const click = async element => { assert.ok(element); assert.equal(element.matches(':disabled'), false); element.click(); await tick(); };
  const chooseMode = async mode => click(document.querySelector(`input[value="${mode}"]`));
  const base = { open: true, close: () => { closed += 1; }, bundle: { id: 'fixture-bundle', splits: { test: 25 } }, state, parent: null, submitted: async () => { completed += 1; } };
  let props = base;
  const render = async overrides => { props = { ...props, ...overrides }; window.renderModal(props); await tick(); };
  const reopen = async overrides => { await render({ open: false }); await render({ ...base, ...overrides, open: true }); };
  try {
    await render({});
    await wait(() => preview().length === 10);
    assert.equal(document.querySelector('input[value=random]').checked, true);
    assert.equal(button('开始评测').disabled, true);
    const first = preview();
    assert.equal(new Set(first).size, 10);
    assert.notDeepEqual(first, cases.slice(0, 10).map(item => item.id));
    await click(document.querySelector('.lab-version-choices input'));
    await click(consent());
    assert.equal(button('开始评测').disabled, false);
    await render({ state: { ...state, versions: [...state.versions] } });
    assert.deepEqual(preview(), first);
    assert.equal(consent().checked, true);
    await fill(field('随机抽取数量'), '3');
    assert.equal(consent().checked, false);
    assert.equal(preview().length, 3);
    const previous = preview();
    await click(button('换一批'));
    assert.notDeepEqual(preview(), previous);
    assert.equal(requests.some(item => item.method === 'POST'), false);
    for (const value of ['', '0', '-1', '1.5', '26', '201']) {
      await fill(field('随机抽取数量'), value);
      assert.equal(button('开始评测').disabled, true);
      assert.deepEqual(preview(), []);
    }
    await fill(field('随机抽取数量'), '25');
    assert.equal(button('换一批').disabled, true);
    assert.ok(document.body.textContent.includes('已选全部可用案例'));
    await fill(field('随机抽取数量'), '3');
    const frozen = preview();
    await click(consent());
    await click(button('开始评测'));
    assert.deepEqual(requests.at(-1).body.caseIds, frozen);
    assert.equal('count' in requests.at(-1).body, false);
    assert.equal(field('随机抽取数量').matches(':disabled'), true);
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    field('关闭窗口').click();
    assert.equal(closed, 0);
    assert.equal(requests.filter(item => item.method === 'POST').length, 1);
    releaseRun(false);
    await wait(() => completed === 1);

    await reopen();
    await chooseMode('manual');
    assert.equal(field('随机抽取数量'), null);
    assert.ok(document.body.textContent.includes('已选 0 个案例'));
    await click(field('选择案例 fixture-case-0'));
    await click(button('下一页'));
    await click(field('选择案例 fixture-case-10'));
    await fill(field('搜索测试案例'), 'fixture-chat-24');
    assert.deepEqual(preview(), ['fixture-case-24']);
    await click(field('选择案例 fixture-case-24'));
    await fill(field('搜索测试案例'), '不存在的案例');
    assert.equal(preview().length, 0);
    assert.ok(document.body.textContent.includes('已选 3 个案例'));
    await click(button('清除'));
    await click([...document.querySelectorAll('label')].find(element => element.textContent === '仅看已选').querySelector('input'));
    assert.deepEqual(preview(), ['fixture-case-0', 'fixture-case-10', 'fixture-case-24']);
    await click(document.querySelector('.lab-version-choices input'));
    await click(consent());
    await click(button('开始评测'));
    assert.deepEqual(requests.at(-1).body.caseIds, ['fixture-case-0', 'fixture-case-10', 'fixture-case-24']);
    releaseRun(true);
    await wait(() => document.querySelector('[role=alert]')?.textContent.includes('启动失败'));
    assert.deepEqual(preview(), ['fixture-case-0', 'fixture-case-10', 'fixture-case-24']);
    await click(button('清空已选'));
    assert.equal(button('开始评测').disabled, true);
    assert.equal(consent().checked, false);

    const parent = { id: 'fixture-parent', models: [version], caseIds: ['fixture-case-4', 'fixture-case-8', 'fixture-case-21'], judgeId: null };
    await reopen({ parent });
    assert.deepEqual(preview().sort(), [...parent.caseIds].sort());
    assert.equal(button('换一批').disabled, true);
    await fill(field('随机抽取数量'), '2');
    assert.ok(preview().every(identifier => parent.caseIds.includes(identifier)));
    const parentSelection = preview();
    await render({ parent: { ...parent, caseIds: [...parent.caseIds] } });
    assert.deepEqual(preview(), parentSelection);
    await click(consent());
    await click(button('开始评测'));
    assert.equal(requests.at(-1).body.parentRunId, parent.id);
    assert.deepEqual(requests.at(-1).body.caseIds, parentSelection);
    releaseRun(false);
    await wait(() => completed === 2);
    await reopen({ parent: { ...parent, id: 'missing-parent', caseIds: undefined } });
    assert.ok(document.querySelector('[role=alert]').textContent.includes('尚未读取'));
    assert.equal(button('开始评测').disabled, true);
    await reopen({ parent: { ...parent, id: 'stale-parent', caseIds: ['missing'] } });
    assert.ok(document.querySelector('[role=alert]').textContent.includes('已不可用'));
    assert.equal(button('开始评测').disabled, true);

    currentCases = [];
    await reopen();
    assert.ok(document.body.textContent.includes('暂无可用测试案例'));
    assert.equal(button('开始评测').disabled, true);
    caseError = true;
    await reopen();
    assert.ok(document.querySelector('[role=alert]').textContent.includes('读取失败'));
    currentCases = cases; caseError = false;
    await click(button('重试读取'));
    await wait(() => preview().length === 10);

    delayCases = true;
    await reopen({ bundle: { ...base.bundle, id: 'delayed-bundle' } });
    assert.ok(document.body.textContent.includes('正在读取'));
    const oldRelease = releaseCases;
    delayCases = false; currentCases = [cases[20]];
    await render({ bundle: { ...base.bundle, id: 'newer-bundle' } });
    await wait(() => preview().length === 1);
    oldRelease(); await tick();
    assert.deepEqual(preview(), ['fixture-case-20']);

    currentCases = Array.from({ length: 205 }, (_, index) => ({ ...cases[0], id: `fixture-limit-${index}` }));
    await reopen();
    await fill(field('随机抽取数量'), '201');
    assert.equal(button('开始评测').disabled, true);
    await chooseMode('manual');
    for (let page = 0; page < 20; page += 1) {
      await click(button('选中本页'));
      await click(button('下一页'));
    }
    assert.ok(document.body.textContent.includes('已选 200 个案例'));
    assert.equal(button('选中本页').disabled, true);
    assert.equal(field('选择案例 fixture-limit-200').disabled, true);
    assert.equal(requests.filter(item => item.method === 'POST').length, 3);
    assert.deepEqual(errors, []);
    console.log('PASS: real sampling, preview=payload, manual search/pagination, 200 limit, stable selection, parent-only rerun, consent reset, loading/error/race handling, pending lock; all network responses isolated, no model calls');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
