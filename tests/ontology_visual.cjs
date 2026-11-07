const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

async function check() {
  const base = process.env.EVAL_ONTOLOGY_BASE || 'http://127.0.0.1:4294';
  const output = path.resolve(process.env.EVAL_VISUAL_OUTPUT || '/private/tmp/evalpilot-workbench-visual');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(output.startsWith('/private/tmp/') || output.startsWith('/tmp/'));
  const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT_PACKAGE_ROOT, 'package.json'))('playwright');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], layouts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), target = new URL(request.url());
    if (target.origin !== base || request.method() !== 'GET') return route.abort();
    return route.continue();
  });
  const measure = async stage => {
    const result = await page.evaluate(() => {
      const explorer = document.querySelector('.ontology-studio');
      const diagram = explorer.querySelector('.ontology-object-svg,canvas');
      const bounds = diagram.getBoundingClientRect();
      const stageBounds = explorer.querySelector('.ontology-stage').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, pageFits: document.documentElement.scrollWidth <= innerWidth + 1, explorerFits: explorer.scrollWidth <= explorer.clientWidth + 1 && explorer.scrollHeight <= explorer.clientHeight + 1, canvasWidth: bounds.width, canvasHeight: bounds.height, canvasFits: bounds.left >= stageBounds.left - 1 && bounds.right <= stageBounds.right + 1, zoom: parseInt(explorer.querySelector('[aria-label="当前缩放"]').textContent, 10), hiddenPanelsRemoved: [...explorer.querySelectorAll('[hidden]')].every(element => getComputedStyle(element).display === 'none'), fullscreen: explorer.dataset.fullscreen, renderer: diagram.tagName.toLowerCase() };
    });
    assert.equal(result.pageFits, true, stage);
    assert.equal(result.explorerFits, true, stage);
    assert.equal(result.canvasFits, true, stage);
    assert.equal(result.hiddenPanelsRemoved, true, stage);
    assert.ok(result.canvasWidth > 280 && result.canvasHeight > 180, stage);
    layouts.push({ stage, ...result });
  };
  try {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + '/#ontology?mode=example&view=graph');
      await page.locator('[data-object-id="equipment"]').waitFor();
      await measure('objects');
      assert.ok(layouts.at(-1).zoom >= 78);
      assert.ok(await page.locator('.og-object-name').allTextContents().then(names => names.includes('E102 · A-100')));
      await page.screenshot({ path: path.join(output, `workbench-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '元素目录', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索图谱元素' }).fill('主机');
      await page.getByRole('listitem', { name: '查看元素：整机', exact: true }).click();
      await page.getByRole('button', { name: '定位节点', exact: true }).click();
      await measure('selected');
      await page.getByRole('button', { name: '业务指令', exact: true }).click();
      await page.locator('.oc-welcome').waitFor();
      await page.getByRole('button', { name: '带入第一条指令', exact: true }).click();
      assert.match(await page.getByRole('textbox', { name: '图谱业务指令' }).inputValue(), /启动没反应/);
      await page.locator('.ontology-studio').screenshot({ path: path.join(output, `commands-${width}.png`) });
      await page.getByRole('button', { name: '收起对象面板', exact: true }).click();
      await page.getByRole('button', { name: '全屏展示', exact: true }).click();
      await page.locator('.ontology-studio.is-fullscreen').waitFor();
      await measure('fullscreen');
      await page.locator('.ontology-studio').screenshot({ path: path.join(output, `fullscreen-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.locator('.ontology-studio:not(.is-fullscreen)').waitFor();
      await page.getByRole('button', { name: '切换自由布局', exact: true }).click();
      await page.locator('canvas').waitFor(); await measure('force-layout');
      for (const route of ['datasets', 'simulator', 'overview', 'compare', 'modelops']) {
        await page.goto(base + '/#' + route);
        await page.locator('.workbench-shell[data-page="' + route + '"]').waitFor();
        await page.waitForFunction(() => !document.querySelector('.loading-screen,.cx-loading,.lab-loading'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, route);
        await page.screenshot({ path: path.join(output, `${route}-${width}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'browser-layout-report.json'), JSON.stringify({ passed: true, layouts, externalRequests: false, writes: false, fullSizeVisualReview: 'required', thumbnailVisualReview: 'required' }, null, 2));
    console.log(JSON.stringify({ passed: true, output, layouts }));
  } finally { await browser.close(); }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
