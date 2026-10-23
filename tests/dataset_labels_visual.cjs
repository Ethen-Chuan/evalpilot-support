const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const esbuild = require(project + '/node_modules/esbuild');

async function check({ packageRoot = process.env.PLAYWRIGHT_PACKAGE_ROOT, outputFolder = process.env.EVAL_VISUAL_OUTPUT || '/private/tmp/dataset-labels-visual' } = {}) {
  const dependencies = createRequire(path.resolve(packageRoot, 'package.json'));
  const { chromium } = dependencies('playwright');
  const output = path.resolve(outputFolder);
  if (!output.startsWith('/private/tmp/') && !output.startsWith('/tmp/')) throw new Error('Visual fixtures must stay in a temporary directory');
  await fs.mkdir(output, { recursive: true });
  const fixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Theme } from '@radix-ui/themes';
    import { DatasetLabels, labelFields } from './src/DatasetLabels';
    const total = 16500;
    const rows = {
      intent: [['fault_repair', 12345], ['info_query', 2300], ['feature_inquiry', 830], ['policy_inquiry', 390], ['complaint', 200]],
      emotion: [['平稳（正常沟通）', 14000], ['不满（安抚话术）', 1600], ['投诉（转人工）', 500]],
      product_line: [['类别-DEMOABCDEFGHIJK', 11000], ['类别-DEMOSECOND', 3500], ['类别-DEMOTHIRD', 1500]],
      fault_domain: [['硬件域', 7200], ['软件域', 5000], ['不适用', 3800], ['无法判断', 350]],
      type: [['不需要派单', 10000], ['报修', 5900], ['报装', 350]],
      kb_expectation: [['has_answer', 11200], ['irrelevant', 3100], ['gap', 1700]],
      expected_system: [['类别-DEMOSYSTEMA', 7000], ['类别-DEMOSYSTEMB', 3500], ['类别-DEMOSYSTEMC', 2100], ['类别-DEMOSYSTEMD', 1500], ['类别-DEMOSYSTEME', 550], ['类别-DEMOSYSTEMF', 220], ['类别-DEMOSYSTEMG', 90]],
      knowledge_category: [['这是一项专门用于验证长标签省略与可访问名称的测试分类', 10000], ['功能使用', 5000], ['售后政策与流程', 450]],
    };
    const facets = { total, projectTotal: total, scope: 'all', filters: {}, policy: '仅用于排版测试的合成统计，非客户数据', scopes: [{id:'all',name:'全部会话',count:16500},{id:'regular',name:'常规会话',count:15000},{id:'invalid',name:'无效会话',count:700},{id:'handoff',name:'直接转人工',count:500},{id:'unclassified',name:'范围待确认',count:300}], dimensions: Object.entries(labelFields).map(([field,name]) => {
      const covered = rows[field].reduce((sum, item) => sum + item[1], 0);
      return {field,name,total,covered,missing:total-covered,coverage:covered/total,multiValueSessions:0,conflictSessions:0,values:rows[field].map(([value,count])=>({value,count,ratio:count/total}))};
    }) };
    const state = new URLSearchParams(location.search).get('state');
    const filters = state === 'selected' ? {intent: 'fault_repair'} : {};
    if (state === 'zero') { facets.total = 0; facets.dimensions.forEach(dimension => { Object.assign(dimension,{total:0,covered:0,missing:0,coverage:null,values:[]}); }); }
    createRoot(document.getElementById('root')).render(<Theme><div className="visual-fixture"><p className="fixture-caption">隔离排版验证 · 合成统计，非客户数据</p><DatasetLabels facets={facets} pending={state==='loading'} error={state==='error'?'fixture':''} scope="all" filters={filters} chooseScope={()=>{}} choose={()=>{}} remove={()=>{}} clear={()=>{}} refresh={()=>{}} /></div></Theme>);
  `;
  const built = await esbuild.build({ stdin: { contents: fixture, resolveDir: project, sourcefile: 'label-visual.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const assets = await fs.readdir(project + '/dist/assets');
  const styles = await fs.readFile(project + '/dist/assets/' + assets.find(name => name.startsWith('index-') && name.endsWith('.css')), 'utf8');
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
  async function render(width, mode = 'light', state = '', palette = 'blue') {
    await page.setViewportSize({ width, height: 1050 });
    await page.goto('http://127.0.0.1/?state=' + state);
    await page.evaluate(({ mode, palette }) => { document.documentElement.dataset.mode = mode; document.documentElement.dataset.palette = palette; }, { mode, palette });
    await page.addStyleTag({ content: styles + '\n.visual-fixture{padding:24px;max-width:1490px;margin:auto}.fixture-caption{color:var(--secondary);font-size:12px;margin-bottom:16px}@media(max-width:600px){.visual-fixture{padding:12px}}' });
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.locator('.dataset-labels').waitFor();
  }
  try {
    const layouts = [];
    for (const [width, mode] of [[1440, 'light'], [960, 'light'], [760, 'light'], [390, 'light'], [320, 'light'], [390, 'dark'], [1440, 'dark']]) {
      await render(width, mode);
      assert.equal(await page.locator('.dataset-label-card').count(), 8);
      const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.dataset-label-card')];
        const counts = [...document.querySelectorAll('.dataset-label-count')];
        return {
          width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
          columns: getComputedStyle(document.querySelector('.dataset-label-grid')).gridTemplateColumns.split(' ').length,
          countsIntact: counts.every(element => element.scrollWidth <= element.clientWidth && element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) + 1),
          cardsContainRows: cards.every(card => [...card.querySelectorAll('.dataset-label-row')].every(row => row.getBoundingClientRect().right <= card.getBoundingClientRect().right)),
          labelsFit: [...document.querySelectorAll('.dataset-label-name')].every(element => element.getBoundingClientRect().right < element.nextElementSibling.getBoundingClientRect().left),
          noAutoStretch: cards.every(card => getComputedStyle(card.querySelector('footer')).marginTop === '0px'),
          equalTrackWidths: cards.every(card => new Set([...card.querySelectorAll('.dataset-label-track')].map(element => element.clientWidth)).size <= 1),
          proportionalBars: [...document.querySelectorAll('.dataset-label-row')].every(row => {
            const count = Number(row.querySelector('.dataset-label-count').textContent.replaceAll(',', ''));
            const track = row.querySelector('.dataset-label-track').getBoundingClientRect().width;
            const fill = row.querySelector('.dataset-label-track i').getBoundingClientRect().width;
            return Math.abs(fill - track * count / 16500) < .1;
          }),
        };
      });
      assert.equal(layout.overflow, false);
      assert.equal(layout.countsIntact, true);
      assert.equal(layout.cardsContainRows, true);
      assert.equal(layout.labelsFit, true);
      assert.equal(layout.noAutoStretch, true);
      assert.equal(layout.equalTrackWidths, true);
      assert.equal(layout.proportionalBars, true);
      assert.equal(layout.columns, width >= 1440 ? 4 : width === 960 ? 3 : width === 760 ? 2 : 1);
      assert.ok(await page.getByRole('button', { name: /筛选知识分类：这是一项专门/ }).getAttribute('title'));
      layouts.push({ ...layout, mode });
      await page.locator('.dataset-labels').screenshot({ path: path.join(output, `labels-${width}-${mode}.png`) });
    }
    await render(960, 'light');
    const systems = page.getByRole('region', { name: '关联系统分类卡片' });
    await systems.getByRole('button', { name: '展开其余 4 项' }).click();
    assert.equal(await systems.locator('.dataset-label-row').count(), 7);
    await systems.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await systems.locator('.dataset-label-row').count(), 3);
    const firstLabel = page.locator('.dataset-label-row').first();
    await firstLabel.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.dataset-label-row').nth(1).evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.dataset-label-row').nth(1).evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true);
    await render(960, 'light', 'selected');
    assert.equal(await page.locator('.dataset-label-card.is-filtered').count(), 1);
    assert.equal(await page.locator('.dataset-label-row[aria-pressed=true]').count(), 1);
    await render(960, 'light', 'loading');
    assert.equal(await page.locator('.dataset-label-skeleton').count(), 8);
    assert.equal(await page.locator('.dataset-label-count').count(), 0);
    await render(960, 'light', 'error');
    assert.equal(await page.locator('.dataset-label-card').count(), 0);
    assert.equal(await page.getByRole('button', { name: '重试统计' }).count(), 1);
    await render(960, 'light', 'zero');
    assert.equal(await page.locator('.dataset-label-card').count(), 0);
    assert.ok(await page.getByText('没有符合条件的会话').isVisible());
    for (const palette of ['graphite', 'teal', 'orange']) {
      await render(960, 'light', '', palette);
      const matching = await page.locator('.dataset-label-track i').first().evaluate(element => getComputedStyle(element).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().replace(/^#([0-9a-f]{6})$/i, (_, hex) => `rgb(${parseInt(hex.slice(0,2),16)}, ${parseInt(hex.slice(2,4),16)}, ${parseInt(hex.slice(4,6),16)})`));
      assert.equal(matching, true);
    }
    assert.deepEqual(errors, []);
    return { passed: true, layouts, checks: ['five-digit counts remain on one line', 'long labels never overlap counts', 'equal track widths and true proportions', 'container-responsive columns', 'low-frequency expansion', 'keyboard focus', 'selected state', 'loading/error/empty states', 'appearance palettes'], externalRequests: false };
  } finally { await browser.close(); }
}

module.exports = { check };
if (require.main === module) check().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
