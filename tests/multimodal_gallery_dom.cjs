const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const dependency = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependency('jsdom');

async function run() {
  const readonly = process.env.EVAL_READONLY === '1';
  const base = process.env.EVAL_BROWSER_BASE;
  if (!base) throw new Error('Specify a local service');
  if (!readonly && base !== 'http://127.0.0.1:4292') throw new Error('Mutations require the isolated gallery fixture');
  const built = await esbuild.build({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {MultimodalLab} from './src/MultimodalLab'; createRoot(document.getElementById('root')).render(React.createElement(MultimodalLab));", resolveDir: project }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  const consoleProxy = new VirtualConsole();
  consoleProxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/#compare?mode=vision', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
  const window = dom.window;
  window.fetch = (input, options) => {
    const url = new URL(input, base);
    if (url.origin !== base || (readonly && options?.method === 'POST')) throw new Error('Unauthorized test request');
    requests.push({ path: url.pathname, method: options?.method || 'GET' });
    return fetch(url, options);
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(built.outputFiles[0].text);
  const document = window.document;
  const wait = async predicate => { const deadline = Date.now() + 60000; while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error('Timed out: ' + predicate.toString()); };
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  const click = async (name, root = document) => { const element = await wait(() => button(name, root)); assert.equal(element.disabled, false, name); element.click(); await new Promise(resolve => setTimeout(resolve, 80)); };
  const dialog = () => document.querySelector('[role=dialog]');
  const fill = (element, value) => { assert.ok(element); const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  try {
    await wait(() => document.querySelector('.mm-source-context'));
    assert.equal(document.querySelector('[aria-label="案例来源"]').value, 'public');
    if (!readonly) {
      assert.equal(document.querySelectorAll('.mm-case').length, 0);
      await click('准备公开照片案例');
      assert.ok(dialog().textContent.includes('并非您提供的真实工单'));
      await click('确认准备公开照片', dialog());
      await wait(() => !dialog());
    }
    await wait(() => document.querySelectorAll('.mm-case img').length === 4);
    assert.ok(document.querySelector('.mm-source-context').textContent.includes('非真实客户工单'));
    assert.ok(document.querySelector('.mm-gallery-tools').textContent.includes('24 个案例 · 4 个图片组'));
    assert.equal(new Set([...document.querySelectorAll('.mm-case')].map(element => element.dataset.imageGroup)).size, 4);
    assert.equal(button('下一页图片'), undefined);
    for (const image of document.querySelectorAll('.mm-case img')) {
      const response = await fetch(new URL(image.getAttribute('src'), base));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const content = Buffer.from(await response.arrayBuffer());
      assert.equal(content.subarray(1, 4).toString(), 'PNG');
      image.dispatchEvent(new window.Event('load'));
    }
    assert.equal(document.querySelectorAll('.mm-results').length, 1);
    assert.ok(document.querySelector('.mm-results .mm-step').textContent.startsWith('03'));
    await click(document.querySelector('.mm-photo-button').getAttribute('aria-label'));
    await wait(() => dialog()?.querySelector('.mm-material img'));
    assert.ok(dialog().textContent.includes('CC BY 4.0'));
    assert.ok(dialog().textContent.includes('官方数据集独立照片'));
    assert.equal(dialog().querySelectorAll('a[target="_blank"]').length, 2);
    assert.equal(dialog().querySelector('[aria-label="同类案例"]').options.length, 7);
    fill(dialog().querySelector('[aria-label="同类案例"]'), 'MMPUBLIC-2');
    await wait(() => dialog()?.textContent.includes('低分辨率局部'));
    dialog().querySelector('[aria-label="选择当前预览案例"]').click();
    await click('关闭窗口', dialog());
    assert.ok(document.querySelector('.mm-case-copy').textContent.includes('已选 1 例'));
    fill(document.querySelector('[aria-label="选择图片组数"]'), '2');
    await click('每组选择一例');
    await wait(() => document.querySelectorAll('.mm-case input:checked').length === 2);
    fill(document.querySelector('[aria-label="选择图片组数"]'), '999');
    assert.equal(button('每组选择一例').disabled, true);
    fill(document.querySelector('[aria-label="选择图片组数"]'), '2');
    fill(document.querySelector('[aria-label="案例来源"]'), 'real');
    await wait(() => document.querySelectorAll('.mm-case').length === 0);
    assert.ok(document.body.textContent.includes('真实工单图片尚未导入'));
    assert.equal(button('每组选择一例').disabled, true);
    await click('查看已有公开照片');
    await wait(() => document.querySelectorAll('.mm-case').length === 4);
    assert.equal(document.querySelectorAll('.mm-case input:checked').length, 0);
    fill(document.querySelector('[aria-label="选择图片组数"]'), '2');
    await click('每组选择一例');
    if (readonly) {
      assert.equal(button('开始同批图文评测').disabled, true);
    } else {
      const baseline = document.querySelector('[aria-label="基线模型"]');
      fill(baseline, baseline.options[1].value);
      const candidate = document.querySelector('[aria-label="候选模型"]');
      fill(candidate, candidate.options[1].value);
      const judge = document.querySelector('[aria-label="同一裁判（两个模型共用）"]');
      fill(judge, judge.options[1].value);
      assert.equal(button('开始同批图文评测').disabled, true);
      document.querySelector('.mm-consent input[type=checkbox]').click();
      await click('开始同批图文评测');
      await wait(() => document.querySelector('.mm-results').textContent.includes('执行结束'));
      const state = await (await fetch(base + '/api/support/lab/multimodal/state')).json();
      assert.equal(state.runs[0].suite, 'public');
      assert.equal(state.runs[0].total, 4);
      assert.equal(state.runs[0].completed, 4);
      const details = await (await fetch(base + '/api/support/lab/multimodal/runs/' + state.runs[0].id)).json();
      assert.equal(details.cases.length, 2);
      assert.equal(details.results.filter(row => row.status === 'completed').length, 4);
      assert.ok(details.results.every(row => row.traceId));
      assert.ok(details.cases.every(item => item.provenance.license === 'CC BY 4.0'));
      await click('选数量重跑本批');
      assert.equal(document.querySelector('[aria-label="案例来源"]').disabled, true);
      assert.equal(document.querySelectorAll('.mm-case input:checked').length, 2);
      await click('退出重跑');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, readonly, cases: 24, checks: ['available source default', 'actual PNG thumbnail responses', 'full image and attribution preview', 'count selection', 'real/public separation', 'invalid quantity', 'correct results scroll target', readonly ? 'no model calls or mutations' : 'isolated two-case model/judge stubs, frozen photos and Trace, rerun'], layoutVerified: false, requests: requests.length }));
  } finally {
    window.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
