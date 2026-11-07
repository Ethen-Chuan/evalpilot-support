const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');
const dependency = createRequire(path.resolve(process.env.JSDOM_PACKAGE_ROOT, 'package.json'));
const { JSDOM, VirtualConsole } = dependency('jsdom');

async function check() {
  const base = process.env.EVAL_QUALITY_BASE || 'http://127.0.0.1:4294';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Local read-only verification only');
  const built = await esbuild.build({ entryPoints: [project + '/src/main.tsx'], bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, plugins: [{ name: 'raw-docs', setup(build) { build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-docs' })); build.onLoad({ filter: /.*/, namespace: 'raw-docs' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' })); } }], define: { 'process.env.NODE_ENV': '"production"' } });
  const errors = [], requests = [];
  const proxy = new VirtualConsole();
  proxy.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/#datasets', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: proxy });
  const window = dom.window, document = window.document;
  let failNext = false, slowDetail = false;
  const delay = duration => new Promise(resolve => setTimeout(resolve, duration));
  window.AbortController = global.AbortController;
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.fetch = async (input, options) => {
    const target = new URL(input, base);
    assert.equal(target.origin, base);
    assert.equal(options?.method || 'GET', 'GET');
    requests.push(target.pathname);
    if (failNext && target.pathname === '/api/support/quality/records') { failNext = false; return new Response(JSON.stringify({ error: '合成读取失败' }), { status: 503 }); }
    const response = await fetch(target, options);
    if (slowDetail && target.pathname.startsWith('/api/support/quality/records/')) await delay(500);
    return response;
  };
  const wait = async predicate => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { assert.deepEqual(errors, []); if (predicate()) return; await delay(40); } throw new Error('Timed out: ' + predicate.toString()); };
  const click = async name => { const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name); assert.ok(button, name); assert.equal(button.disabled, false); button.click(); await delay(100); };
  const open = async channel => { window.location.hash = '#datasets?project=quality-' + channel + '-redacted-v1'; await wait(() => document.querySelectorAll('.quality-detail tbody tr').length === 20); };
  try {
    window.eval(built.outputFiles[0].text);
    await wait(() => document.querySelectorAll('.quality-projects .project-card').length === 2);
    await open('hotline');
    document.querySelector('.quality-detail tbody button').click();
    await wait(() => document.querySelector('.quality-missing-evidence'));
    assert.equal(document.querySelectorAll('.quality-dimensions>div').length, 7);
    assert.ok(document.querySelector('.quality-missing-evidence').textContent.includes('没有录音或对话正文'));
    assert.equal(document.querySelector('.quality-transcript'), null);
    await click('下一页'); await wait(() => document.querySelectorAll('.quality-detail tbody tr').length === 20);
    await click('下一页'); await wait(() => document.querySelectorAll('.quality-detail tbody tr').length === 11);
    assert.ok([...document.querySelectorAll('button')].find(button => button.textContent === '下一页').disabled);
    window.location.hash = '#datasets'; await wait(() => document.querySelector('.quality-projects'));
    failNext = true; window.location.hash = '#datasets?project=quality-online-redacted-v1';
    await wait(() => document.querySelector('.quality-case-list')?.textContent.includes('暂时无法读取'));
    await click('重新读取'); await wait(() => document.querySelectorAll('.quality-detail tbody tr').length === 20);
    document.querySelector('.quality-detail tbody button').click();
    await wait(() => document.querySelector('.quality-transcript'));
    assert.equal(document.querySelectorAll('.quality-dimensions>div').length, 7);
    assert.ok(document.querySelector('.quality-label-note').textContent.includes('不根据总分反推'));
    slowDetail = true;
    document.querySelectorAll('.quality-detail tbody button')[1].click();
    await delay(80); window.location.hash = '#datasets?project=quality-hotline-redacted-v1';
    await wait(() => document.querySelectorAll('.quality-detail tbody tr').length === 20);
    await delay(600);
    assert.equal(document.querySelector('.quality-transcript'), null);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, projects: 2, records: 102, checks: ['private dataset cards', 'source-only seven labels', 'missing hotline evidence', 'online redacted text', 'pagination', 'retry', 'stale detail cancelled'], requests: requests.length, dataWrites: false, visualVerification: false }));
  } finally { window.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
