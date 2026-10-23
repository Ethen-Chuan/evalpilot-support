const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const runtime = process.env.PLAYWRIGHT_PACKAGE_ROOT ? createRequire(path.resolve(process.env.PLAYWRIGHT_PACKAGE_ROOT, 'package.json')) : require;
const esbuild = require(project + '/node_modules/esbuild');

async function check(existingBrowser) {
  const built = await esbuild.build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Theme} from '@radix-ui/themes';
    import '@radix-ui/themes/styles.css';
    import './src/support.css';
    import './src/experience.css';
    import {ConversationLearning} from './src/ConversationLearning';
    const root = createRoot(document.getElementById('root'));
    const ratio = {value:null,numerator:0,denominator:0};
    const quality = {total:0,changed:0,maintained:0,unresolved:0,conflict:0,changedRate:ratio,coverage:ratio,localCompletion:ratio,classifications:{},slices:[],scope:'isolated fixture'};
    const inventory = {source:240,eligible:200,splits:{train:120,validation:30,test:50},handoffLabels:{},excluded:{}};
    const running = {id:'fixture',metadata:{name:'隔离测试',favorite:false,archived:false,revision:0},model:'fixture',status:'running',stage:'测试进行中',createdAt:'2026-01-01T00:00:00Z',total:50,completed:0,trainCount:120,results:[],models:{},metrics:{route:ratio,routeSingleClass:false,mandatoryRecall:ratio,missedHandoff:0,unknownHandoff:0,form:ratio,formExact:ratio,fields:{}}};
    window.renderLearning = (active=false) => root.render(<Theme><ConversationLearning learning={{inventory,run:active?running:null,recordCount:0,requestedMissing:false,history:[]}} quality={quality} projectId="fixture" changed={()=>{}}/></Theme>);
    window.renderLearning();
  `, resolveDir: project, loader: 'tsx' }, outdir: '/private/tmp/learning-layout-build', bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  const javascript = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const stylesheet = built.outputFiles.find(file => file.path.endsWith('.css')).text;
  const browser = existingBrowser || await runtime('playwright').chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  try {
    await page.setContent('<!doctype html><html><head></head><body><div id="root" style="padding:16px;max-width:1280px;margin:auto"></div></body></html>');
    await page.addStyleTag({ content: stylesheet });
    await page.addScriptTag({ content: javascript });
    const training = page.getByLabel('训练数据量', { exact: true });
    const count = page.getByLabel('真实回放数量', { exact: true });
    await training.waitFor();
    const checkBounds = async label => {
      const result = await page.locator('.learning-hero').evaluate(hero => {
        const controls = hero.querySelector('.learning-run-controls');
        const inputs = [...controls.querySelectorAll('select,input,button')];
        const bounds = inputs.map(element => element.getBoundingClientRect());
        const overlap = bounds.some((first, index) => bounds.slice(index + 1).some(second => Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1));
        const parent = controls.getBoundingClientRect();
        const fits = bounds.every(rect => rect.left >= parent.left - 1 && rect.right <= parent.right + 1 && rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1);
        const copy = hero.firstElementChild.getBoundingClientRect();
        const separate = Math.min(copy.right, parent.right) <= Math.max(copy.left, parent.left) + 1 || Math.min(copy.bottom, parent.bottom) <= Math.max(copy.top, parent.top) + 1;
        const labelsFit = [...controls.querySelectorAll('label')].every(label => label.scrollWidth <= label.clientWidth + 1);
        return { overlap, fits, separate, labelsFit, noOverflow: controls.scrollWidth <= controls.clientWidth + 1 && hero.scrollWidth <= hero.clientWidth + 1, buttonBelow: bounds[2].top >= Math.max(bounds[0].bottom, bounds[1].bottom) + 8 };
      });
      assert.deepEqual(result, { overlap: false, fits: true, separate: true, labelsFit: true, noOverflow: true, buttonBelow: true }, label);
    };
    for (const width of [320, 390, 540, 768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const value of ['25', '60', '100']) {
        await training.selectOption(value);
        await count.fill('12');
        await checkBounds(`${width}px, training=${value}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#root').evaluate(element => { element.style.maxWidth = '460px'; });
    await checkBounds('narrow parent on desktop');
    await page.locator('#root').evaluate(element => { element.style.maxWidth = '1280px'; element.style.zoom = '1.5'; });
    await checkBounds('150% layout zoom');
    await page.locator('#root').evaluate(element => { element.style.zoom = '1'; });
    await count.fill('0');
    assert.equal(await page.getByRole('button', { name: '学习并回放', exact: true }).isDisabled(), true);
    await count.fill('12');
    assert.equal(await page.getByRole('button', { name: '学习并回放', exact: true }).isEnabled(), true);
    await page.evaluate(() => window.renderLearning(true));
    await page.getByRole('button', { name: '正在学习回放', exact: true }).waitFor();
    assert.equal(await training.isDisabled(), true);
    assert.equal(await count.isDisabled(), true);
    for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 1000 }); await checkBounds(`running ${width}px`); }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log('PASS: real component/CSS, 8 viewport widths × 3 training options, narrow parent, 150% zoom, running/disabled state, no control/copy overlap; no network or training calls');
  } finally { if (existingBrowser) await page.close(); else await browser.close(); }
}

module.exports = check;
if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
