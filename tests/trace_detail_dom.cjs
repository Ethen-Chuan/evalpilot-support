const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const dependencies = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependencies('jsdom');
const esbuild = require(project + '/node_modules/esbuild');

async function check() {
  const built = await esbuild.build({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {TraceView} from './src/TraceView'; createRoot(document.getElementById('root')).render(React.createElement(TraceView, {traceId:'trace-fixture', choose:id=>{window.chosen=id}, run:id=>{window.run=id}, conversation:id=>{window.conversation=id}, notify:()=>{}, changed:async()=>{}}));", resolveDir: project }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [];
  const requests = [];
  const proxy = new VirtualConsole();
  proxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4295/#traces?trace=trace-fixture&run=EVAL-TEST', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
  const window = dom.window;
  const document = window.document;
  const base = { parentId: 'root', status: 'ok', startMs: 10, durationMs: 20, attributes: {}, input: null, output: null, events: [], error: null };
  const trace = { id: 'trace-fixture', name: '售后客服回合重跑', source: 'aftersales.replay', origin: 'local_instrumented', status: 'ok', sessionId: 'session-fixture', conversationId: null, runId: 'EVAL-TEST', startedAt: '2026-10-22T01:00:00Z', durationMs: 12750, attributes: { protocol: 'synthetic-protocol' }, issues: [], annotations: [], categoryName: '文本评测', sourceName: '客服行为回合评测', durationScope: '记录的执行时间，不是历史会话时长', redaction: '测试构造', spans: [
    { ...base, id: 'root', parentId: null, name: '整体执行', kind: 'agent', durationMs: 12750, input: { caseId: 'case-fixture' }, output: { output: { answer: '构造答复：请补充设备现象。<img src=x onerror=alert(1)>', intent: 'fault_repair', action: 'clarify' }, intentMatch: true, actionMatch: false, judgeCompleted: false } },
    { ...base, id: 'guard', name: '外发内容隐私复扫', kind: 'guardrail', output: { allowed: true } },
    { ...base, id: 'model', name: '调用候选模型', kind: 'model', input: { role: 'candidate' }, output: { model: 'model-fixture', usage: { prompt_tokens: 5, completion_tokens: 10 } }, startMs: 200, durationMs: 12300, events: [{ name: 'fixture-event', offsetMs: 5, attributes: {} }] },
    { ...base, id: 'tool', name: '执行本机沙箱下一步', kind: 'tool', input: { action: 'clarify' }, output: { productionExecuted: false, environment: 'sandbox', result: '构造沙箱：仅整理下一步建议' } },
    { ...base, id: 'evaluation', name: '对照来源标签', kind: 'evaluation', output: { intentMatch: true, actionMatch: false } },
  ] };
  let refresh;
  let failed = false;
  window.setInterval = callback => { refresh = callback; return 1; };
  window.clearInterval = () => {};
  window.fetch = async (input, options) => {
    const target = new URL(input, window.location.href);
    assert.equal(target.origin, window.location.origin);
    assert.equal(options?.method || 'GET', 'GET');
    assert.equal(target.pathname, '/api/support/traces/trace-fixture');
    requests.push(target.pathname);
    return new Response(JSON.stringify(failed ? { error: '隔离读取失败' } : trace), { status: failed ? 503 : 200 });
  };
  window.eval(built.outputFiles[0].text);
  const wait = async predicate => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Timed out: ' + predicate.toString()); };
  const button = name => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name);
  const step = name => [...document.querySelectorAll('.trace-step-row')].find(element => element.querySelector('strong').textContent === name);
  try {
    await wait(() => document.querySelector('.trace-readable-answer'));
    assert.equal(document.querySelector('.trace-readable-answer').textContent, trace.spans[0].output.output.answer);
    assert.equal(document.querySelectorAll('.trace-readable-answer img').length, 0);
    assert.equal(document.querySelectorAll('.trace-console').length, 1);
    assert.equal(document.querySelectorAll('.trace-bottom-grid,.trace-workspace').length, 0);
    assert.equal(document.querySelectorAll('.trace-step-row').length, 5);
    assert.equal(document.querySelectorAll('.trace-step-filters').length, 0);
    assert.ok(document.querySelector('.trace-summary-line').textContent.includes('model-fixture'));
    assert.equal(document.querySelector('.trace-record-details').open, false);
    assert.equal(document.querySelector('.trace-input-disclosure').open, false);
    assert.equal(document.querySelector('.trace-breadcrumbs a').getAttribute('href'), '#benchmark?run=EVAL-TEST');
    button('查看原始完整对话').click();
    assert.equal(window.conversation, 'session-fixture');
    assert.equal(button('建立排查任务'), undefined);
    step('调用候选模型').click();
    await wait(() => document.querySelector('.trace-result-heading h2').textContent === '调用候选模型');
    assert.ok(document.querySelector('.trace-result-pane').textContent.includes('model-fixture'));
    assert.ok(!document.querySelector('.trace-result-pane').textContent.includes('总 Token'));
    button('技术详情').click();
    await wait(() => document.querySelector('.trace-technical'));
    assert.ok(document.querySelector('.trace-technical').textContent.includes('fixture-event'));
    button('查看父步骤').click();
    await wait(() => document.querySelector('.trace-readable-answer'));
    assert.equal(button('结果摘要').getAttribute('aria-pressed'), 'true');
    step('执行本机沙箱下一步').click();
    await wait(() => document.querySelector('.trace-readable-answer')?.textContent === '构造沙箱：仅整理下一步建议');
    assert.ok(document.querySelector('.trace-result-pane').textContent.includes('未执行 / 未连接'));
    document.querySelector('.trace-record-details summary').click();
    await wait(() => document.querySelector('.trace-record-details').open);
    assert.equal(document.querySelector('.trace-record-actions a').getAttribute('href'), '/api/support/traces/trace-fixture/export.json');
    for (let index = 0; index < 8; index++) trace.spans.push({ ...base, id: 'extra-' + index, name: '额外构造步骤 ' + index, kind: 'internal' });
    await refresh();
    await wait(() => document.querySelector('.trace-step-filters'));
    button('模型').click();
    await wait(() => document.querySelectorAll('.trace-step-row').length === 1);
    button('异常').click();
    await wait(() => document.querySelector('.trace-step-list').textContent.includes('没有已记录步骤'));
    const failure = trace.spans[2];
    failure.status = 'error';
    failure.error = { type: 'SyntheticError', message: '构造连接失败', frames: [] };
    trace.issues = [{ kind: 'execution', code: 'fixture-error', message: '构造异常定位', spanId: failure.id }];
    await refresh();
    await wait(() => document.querySelector('.trace-issues button'));
    document.querySelector('.trace-issues button').click();
    await wait(() => document.querySelector('.trace-step-error')?.textContent.includes('构造连接失败'));
    assert.equal(document.querySelector('.trace-step-filters button').getAttribute('aria-pressed'), 'true');
    failed = true;
    await refresh();
    await wait(() => document.querySelector('[role=alert]')?.textContent.includes('隔离读取失败'));
    assert.equal(document.querySelector('.trace-detail'), null);
    failed = false;
    await refresh();
    await wait(() => document.querySelector('.trace-detail'));
    assert.ok(document.querySelector('.trace-step-error').textContent.includes('构造连接失败'));
    assert.deepEqual(errors, []);
    console.log('PASS: compact readable result, no duplicated panels, source conversation, batch link, exact model identity, step selection/filters, technical evidence, error jump, refresh and failure states; GET-only isolated fixture');
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
