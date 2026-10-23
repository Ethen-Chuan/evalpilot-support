const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require(project + '/node_modules/esbuild');

async function check() {
  const built = await esbuild.build({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {ConnectionModal} from './src/ModelConnection'; createRoot(document.getElementById('root')).render(React.createElement(ConnectionModal, {open:true, close:()=>{}, connection:null, changed:async()=>{}, requiredCapability:'vision', useConnection:id=>{window.selectedConnection=id}}));", resolveDir: project }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  let visionPasses = false;
  const proxy = new VirtualConsole();
  proxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4295/#benchmark?mode=vision', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
  const window = dom.window;
  const document = window.document;
  window.fetch = async (input, options) => {
    const target = new URL(input, window.location.href);
    assert.equal(target.origin, window.location.origin);
    const body = options?.body ? JSON.parse(options.body) : null;
    requests.push({ path: target.pathname, body });
    let payload;
    let status = 200;
    if (target.pathname.endsWith('/services')) payload = [
      { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', discovery: true, note: '' },
      { id: 'deepseek', name: 'DeepSeek · 云端 API', endpoint: 'https://api.deepseek.com', discovery: true, note: 'Flash 接口' },
      { id: 'deepseek_vl2', name: 'DeepSeek-VL2 · 私有部署', endpoint: 'http://127.0.0.1:8000/v1', discovery: true, note: '隔离构造，不访问真实模型', local: true },
    ];
    else if (target.pathname.endsWith('/connections/models') || target.pathname.endsWith('/connections')) {
      assert.equal(body.provider, 'deepseek_vl2');
      assert.equal(body.endpoint, 'http://127.0.0.1:8123/v1');
      assert.equal(body.apiKey, '');
      assert.equal(body.confirmed, true);
      payload = target.pathname.endsWith('/models') ? { provider: body.provider, models: ['deepseek-ai/deepseek-vl2-tiny'], partial: false, inferenceTested: false } : { id: 'local-fixture' };
    } else if (target.pathname.endsWith('/test-vision')) {
      assert.deepEqual(body, { id: 'local-fixture', confirmed: true });
      payload = visionPasses ? { tested: true, visionTested: true } : { error: '隔离测试：没有读对图片' };
      status = visionPasses ? 200 : 400;
    } else if (target.pathname.endsWith('/test')) payload = { tested: true, visionTested: false };
    else throw new Error('Unexpected request');
    return new Response(JSON.stringify(payload), { status });
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.eval(built.outputFiles[0].text);
  const wait = async predicate => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out: ' + predicate.toString()); };
  const button = name => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name);
  const field = name => document.querySelector(`[aria-label="${name}"]`);
  const preset = name => [...document.querySelectorAll('.connection-presets button')].find(element => element.querySelector('strong').textContent === name);
  const fill = (element, value) => { const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const testConsent = () => document.querySelector('.lab-connection-test input[type=checkbox]');
  try {
    await wait(() => preset('DeepSeek Flash') && !preset('DeepSeek Flash').disabled);
    preset('DeepSeek Flash').click();
    await wait(() => field('候选模型名称').value === 'deepseek-flash');
    assert.equal(field('模型服务').value, 'deepseek');
    assert.equal(field('API Key').required, true);
    fill(field('API Key'), 'fixture-cloud-not-a-credential');
    document.querySelector('input[type=checkbox]').click();
    await wait(() => !button('保存内存配置').disabled);
    preset('DeepSeek-VL2').click();
    await wait(() => field('本机服务地址'));
    assert.equal(field('API Key').value, '');
    assert.equal(field('API Key').required, false);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);
    assert.equal(field('候选模型名称').tagName, 'SELECT');
    assert.equal(field('候选模型名称').options.length, 5);
    assert.ok(document.body.textContent.includes('不代表本机已安装'));
    assert.ok(!requests.some(request => request.body));
    fill(field('本机服务地址'), 'http://untrusted.invalid/v1');
    document.querySelector('input[type=checkbox]').click();
    await wait(() => button('保存内存配置').disabled);
    fill(field('本机服务地址'), 'http://127.0.0.1:8123/v1');
    fill(field('候选模型名称'), 'deepseek-ai/deepseek-vl2-tiny');
    await wait(() => !document.querySelector('input[type=checkbox]').checked);
    document.querySelector('input[type=checkbox]').click();
    await wait(() => !button('读取已部署模型').disabled);
    button('读取已部署模型').click();
    await wait(() => document.body.textContent.includes('读取到 1 个模型'));
    assert.equal(field('候选模型名称').value, 'deepseek-ai/deepseek-vl2-tiny');
    button('保存内存配置').click();
    await wait(() => testConsent());
    assert.equal(field('本机服务地址').disabled, true);
    assert.equal(button('完成并选用此模型').disabled, true);
    assert.equal(button('测试图像读取').disabled, true);
    testConsent().click();
    await wait(() => !button('测试文字连接').disabled);
    button('测试文字连接').click();
    await wait(() => document.body.textContent.includes('文字与 JSON 测试通过'));
    assert.equal(button('完成并选用此模型').disabled, true);
    assert.equal(testConsent().checked, false);
    testConsent().click();
    await wait(() => !button('测试图像读取').disabled);
    button('测试图像读取').click();
    await wait(() => document.body.textContent.includes('没有读对图片'));
    assert.equal(button('完成并选用此模型').disabled, true);
    visionPasses = true;
    testConsent().click();
    await wait(() => !button('测试图像读取').disabled);
    button('测试图像读取').click();
    await wait(() => !button('完成并选用此模型').disabled);
    button('完成并选用此模型').click();
    assert.equal(window.selectedConnection, 'local-fixture');
    assert.ok(!JSON.stringify(requests).includes('fixture-cloud-not-a-credential'));
    for (const storage of [window.localStorage, window.sessionStorage]) assert.ok(!JSON.stringify(Object.entries(storage)).includes('credential'));
    assert.equal(requests.filter(request => request.body).length, 5);
    assert.deepEqual(errors, []);
    console.log('PASS: Flash and VL2 presets, no key reuse, local endpoint/optional auth, live model list, explicit consent, failed/text-only vision gate, successful selection; isolated synthetic responses only');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
