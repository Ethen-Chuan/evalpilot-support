const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require(project + '/node_modules/esbuild');
const regions = require(project + '/backend/qwen_regions.json');

async function check() {
  const built = await esbuild.build({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {ConnectionModal} from './src/ModelConnection'; createRoot(document.getElementById('root')).render(<ConnectionModal open={true} close={() => {}} connection={null} changed={async () => {}} harnessOnly={true} useConnection={id => { window.selectedConnection = id; }} />);", resolveDir: project, loader: 'tsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  for (const endpoint of [regions[1].endpoint, 'https://workspace-test.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1']) {
    const errors = [];
    const requests = [];
    const consoleProxy = new VirtualConsole();
    consoleProxy.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4291/#simulator', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
    const window = dom.window;
    const document = window.document;
    const services = [{ id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', harness: true, discovery: false }, { id: 'qwen', name: '通义千问', endpoint: regions[0].endpoint, regions, harness: true, discovery: false }, { id: 'openai', name: 'OpenAI', harness: false }];
    let tests = 0;
    window.fetch = async (input, options = {}) => {
      const target = new URL(input, window.location.href);
      assert.equal(target.origin, window.location.origin);
      requests.push({ path: target.pathname, method: options.method || 'GET' });
      if (target.pathname.endsWith('/services')) return Response.json(services);
      if (target.pathname.endsWith('/connections')) {
        const body = JSON.parse(options.body);
        assert.equal(body.provider, 'qwen');
        assert.equal(body.endpoint, endpoint);
        assert.equal(body.apiKey, 'fixture-only-not-secret');
        assert.equal(body.confirmed, true);
        assert.equal(body.candidateModel, 'qwen-fixture');
        return Response.json({ id: 'qwen-fixture-connection' });
      }
      if (target.pathname.endsWith('/connections/test')) {
        assert.deepEqual(JSON.parse(options.body), { id: 'qwen-fixture-connection', confirmed: true });
        if (++tests === 1) return Response.json({ error: '百炼 HTTP 401：请核对 Key 与地域或业务空间是否匹配' }, { status: 400 });
        return Response.json({ tested: true });
      }
      throw new Error('Unexpected endpoint');
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(built.outputFiles[0].text);
    const wait = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Qwen UI expectation timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
    const button = title => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === title);
    const fill = (element, value) => { const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    try {
      await wait(() => document.querySelectorAll('[aria-label="模型服务"] option').length === 2);
      fill(document.querySelector('[aria-label="模型服务"]'), 'qwen');
      await wait(() => document.querySelector('[aria-label="百炼地域"]'));
      fill(document.querySelector('[aria-label="API Key"]'), 'fixture-only-not-secret');
      document.querySelector('.lab-check input').click();
      const workspace = endpoint.includes('.maas.aliyuncs.com');
      fill(document.querySelector('[aria-label="百炼地域"]'), workspace ? '__workspace__' : endpoint);
      if (workspace) {
        await wait(() => document.querySelector('[aria-label="百炼业务空间地址"]'));
        fill(document.querySelector('[aria-label="百炼业务空间地址"]'), endpoint);
      }
      await wait(() => document.querySelector('.connection-destination').textContent.includes(endpoint));
      assert.equal(document.querySelector('[aria-label="API Key"]').value, '');
      assert.equal(document.querySelector('.lab-check input').checked, false);
      assert.equal(button('保存内存配置').disabled, true);
      assert.equal(requests.filter(item => item.method === 'POST').length, 0);
      fill(document.querySelector('[aria-label="API Key"]'), '  fixture-only-not-secret  ');
      fill(document.querySelector('[aria-label="候选模型名称"]'), 'qwen-fixture');
      document.querySelector('.lab-check input').click();
      await wait(() => !button('保存内存配置').disabled);
      button('保存内存配置').click();
      await wait(() => button('测试文字连接'));
      assert.equal(document.querySelector('[aria-label="API Key"]').value, '');
      assert.equal(button('测试文字连接').disabled, true);
      assert.equal(button('完成并选用此模型').disabled, true);
      document.querySelector('.lab-connection-test input').click();
      await wait(() => !button('测试文字连接').disabled);
      button('测试文字连接').click();
      await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('HTTP 401'));
      assert.equal(button('完成并选用此模型').disabled, true);
      assert.equal(tests, 1);
      document.querySelector('.lab-connection-test input').click();
      await wait(() => !button('测试文字连接').disabled);
      button('测试文字连接').click();
      await wait(() => !button('完成并选用此模型').disabled);
      button('完成并选用此模型').click();
      assert.equal(window.selectedConnection, 'qwen-fixture-connection');
      assert.equal(requests.filter(item => item.method === 'POST').length, 3);
      assert.ok(!document.body.textContent.includes('fixture-only-not-secret'));
      assert.equal(window.localStorage.length, 0);
      assert.equal(window.sessionStorage.length, 0);
      assert.deepEqual(errors, []);
    } finally { window.close(); }
  }
  console.log('PASS: Qwen visible in Harness modal; regional/workspace destinations, key clearing, explicit consent, safe failures and model selection; mocked transport only');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
