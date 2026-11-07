const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require('esbuild');
const project = path.resolve(__dirname, '..');
const origin = process.env.SIMULATOR_URL || 'http://127.0.0.1:4287';

async function check() {
  const built = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-docs', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-docs' })); build.onLoad({ filter: /.*/, namespace: 'raw-docs' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  const consoleProxy = new VirtualConsole();
  consoleProxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: origin + '/#simulator', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy });
  const window = dom.window;
  const document = window.document;
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (input, options) => {
    const target = new URL(input, window.location.href);
    assert.equal(target.origin, origin);
    requests.push({ path: target.pathname, method: options?.method || 'GET' });
    return fetch(target.href, options);
  };
  window.eval(built.outputFiles[0].text);
  const wait = async predicate => {
    const deadline = Date.now() + 120000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('DOM timeout: ' + document.body.textContent.slice(-1800)); await new Promise(resolve => setTimeout(resolve, 60)); }
  };
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === label || element.getAttribute('aria-label') === label);
  const click = async label => { await wait(() => button(label) && !button(label).disabled); button(label).click(); };
  const fill = (element, value) => { const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const confirm = text => { const label = [...document.querySelectorAll('label')].find(element => element.textContent.includes(text)); assert.ok(label, text); label.querySelector('input[type="checkbox"]').click(); };
  try {
    if (process.env.SIMULATOR_LEGACY_TEST === '1') {
      await wait(() => document.querySelector('.sim-loading [role="alert"]'));
      assert.ok(document.querySelector('.sim-loading').textContent.includes('旧版后台'));
      assert.ok(requests.every(item => item.method === 'GET'));
      assert.deepEqual(errors, []);
      console.log('PASS: legacy backend displays an upgrade notice without rendering broken controls or sending writes');
      return;
    }
    await wait(() => document.querySelectorAll('.sim-scenario').length >= 5);
    assert.ok(document.querySelector('.sim-mode-label').textContent.includes('离线演示'));
    if (process.env.SIMULATOR_SMOKE_ONLY === '1') {
      await click('评分标准');
      await wait(() => document.querySelector('.sim-rubric-workbench'));
      assert.equal(document.querySelectorAll('.sim-rubric-dimension').length, 6);
      assert.equal(document.querySelector('.sim-experience-workbench'), null);
      assert.deepEqual([...document.querySelectorAll('.sim-tabs button')].map(item => item.textContent.replace(/\d+/g, '').trim()), ['会话模拟', '答复对照', '复测案例', '评分标准']);
      assert.ok(requests.every(item => item.method === 'GET'));
      assert.deepEqual(errors, []);
      console.log('PASS: final frontend loads existing records and six-dimension rubric; retired features absent; no writes or model calls');
      return;
    }
    await click('用这句话开始');
    await wait(() => document.querySelector('.sim-verdict.pass'));
    assert.ok(document.querySelector('.sim-assistant-message').textContent.includes('已经尝试过'));
    assert.ok(document.querySelector('.sim-publication.released'));
    await click('评分标准');
    await wait(() => document.querySelector('.sim-rubric-workbench'));
    assert.equal(document.querySelectorAll('.sim-rubric-dimension').length, 6);
    assert.ok(document.querySelector('.sim-rubric-summary').textContent.includes('待评'));
    assert.equal(button('提交人工评分').disabled, true);
    for (const [title, level] of [['下一步的可执行性', '4'], ['表达与用户体验', '3']]) {
      fill(document.querySelector(`[aria-label="${title}档位"]`), level);
      fill(document.querySelector(`[aria-label="${title}引用"]`), '请确认屏幕自身菜单能否打开');
      fill(document.querySelector(`[aria-label="${title}理由"]`), '答复明确说明核实步骤和安全边界，能支持本轮用户继续行动');
    }
    confirm('我已核对上下文与引用');
    await click('提交人工评分');
    await wait(() => document.querySelector('.sim-rubric-summary')?.textContent.includes('98.75'));
    assert.ok(document.querySelector('.sim-rubric-current').textContent.includes('人工评分已保存'));
    await click('会话模拟');
    await click('处理过程');
    await wait(() => document.querySelectorAll('.sim-event.tool').length === 3);
    assert.ok(document.querySelector('.sim-trace-link').hash.startsWith('#traces?trace='));
    assert.equal(document.querySelector('.sim-trace pre'), null);
    assert.ok(document.querySelector('.sim-event.tool .sim-event-details').textContent.includes('历史消息'));
    await click('规则检查');
    fill(document.querySelector('[aria-label="客户消息"]'), '我想找人工继续处理。');
    await click('发送客户消息');
    await wait(() => document.querySelectorAll('.sim-turn').length === 2 && !document.querySelector('.sim-thinking'));
    await click('客户上下文');
    await wait(() => document.querySelector('.sim-draft'));
    assert.ok(document.querySelector('.sim-draft').textContent.includes('未接通真人'));
    await click('规则检查');
    await click('对比两种示例答复');
    await wait(() => document.querySelector('.sim-compare-grid'));
    assert.ok(document.querySelector('.sim-comparison').textContent.includes('用户输入一致'));
    assert.ok(document.querySelector('.sim-compare-grid .baseline .fail'));
    assert.equal(document.querySelectorAll('.sim-compare-grid .guarded .fail').length, 0);
    await click('查看问题答复并保存');
    await click('保存为复测案例');
    await wait(() => document.querySelector('[role="status"]')?.textContent.includes('已保存为复测案例'));
    const regressionTab = [...document.querySelectorAll('.sim-tabs button')].find(element => element.textContent.includes('复测案例'));
    regressionTab.click();
    await wait(() => document.querySelector('.sim-regression-list article'));
    await click('再次测试');
    await wait(() => document.querySelector('.sim-verdict.pass') && document.querySelector('[role="status"]')?.textContent.includes('复测完成'));
    window.location.hash = '#benchmark';
    await wait(() => document.querySelector('.sim-eval-records'));
    const regressionLink = document.querySelector('.sim-eval-records > a');
    assert.ok(regressionLink.textContent.includes('规则检查通过'));
    window.location.hash = regressionLink.hash;
    await wait(() => document.querySelector('.sim-regression-list'));
    await click('查看会话');
    await wait(() => document.querySelector('.sim-verdict.pass'));
    await click('新建会话');
    await wait(() => document.querySelector('.sim-chat-intro'));
    assert.deepEqual([...document.querySelector('[aria-label="运行方式"]').options].map(item => item.value), ['demo']);
    await click('模型设置');
    await wait(() => document.querySelector('[role="dialog"] [aria-label="模型服务"] option[value="qwen"]'));
    assert.deepEqual([...document.querySelectorAll('[role="dialog"] [aria-label="模型服务"] option')].map(option => option.value), ['deepseek', 'qwen']);
    assert.equal(document.querySelector('[aria-label="API Key"]').type, 'password');
    assert.ok(!requests.some(item => item.path.endsWith('/connections/test')));
    await click('关闭');
    assert.equal(button('经验发布'), undefined);
    assert.equal(document.querySelector('.sim-harness-button'), null);
    window.location.hash = '#simulator?tab=experience';
    await wait(() => document.querySelector('.sim-chat-intro'));
    assert.equal(document.querySelector('.sim-experience-workbench'), null);
    assert.ok(!document.querySelector('.simulator').textContent.includes('断言'));
    assert.ok(!requests.some(item => item.path.includes('/experience/') || item.path.includes('/connections/test')));
    assert.deepEqual(errors, []);
    console.log('PASS: isolated real API + real DLP + real DSH; interview flow, six-dimensional scoring, cited human review, plain-language evidence, comparison, saving and retest; advanced features removed; no paid calls');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
