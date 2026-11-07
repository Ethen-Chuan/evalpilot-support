const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

async function check() {
  const base = process.env.EVAL_ONTOLOGY_BASE || 'http://127.0.0.1:4294';
  const output = path.resolve(process.env.EVAL_VISUAL_OUTPUT || '/private/tmp/evalpilot-ontology-business-visual');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Only a local workspace may be tested');
  if (!output.startsWith('/private/tmp/') && !output.startsWith('/tmp/')) throw new Error('Screenshots must stay in temporary storage');
  const dependency = createRequire(path.resolve(process.env.PLAYWRIGHT_PACKAGE_ROOT, 'package.json'));
  const { chromium } = dependency('playwright');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], layouts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), target = new URL(request.url());
    if (target.origin !== base) return route.abort();
    if (request.method() === 'POST' && target.pathname === '/api/support/ontology/business/run') {
      const body = request.postDataJSON();
      if (body.text !== '我的主机报 E102，开不了机。' || body.proposedAction !== 'review' || !['', 'model-a'].includes(body.confirmedModel)) return route.abort();
    } else if (request.method() === 'POST' && target.pathname === '/api/support/ontology/business/verify') {
      if (JSON.stringify(request.postDataJSON()) !== JSON.stringify({ confirmSynthetic: true })) return route.abort();
    } else if (request.method() !== 'GET') return route.abort();
    return route.continue();
  });
  const layout = async state => {
    const value = await page.evaluate(() => {
      const workspace = document.querySelector('.ontology-workspace');
      return { width: innerWidth, pageFits: document.documentElement.scrollWidth <= innerWidth + 1, workspaceFits: workspace.scrollWidth <= workspace.clientWidth + 1, sectionsFit: [...workspace.querySelectorAll('.ob-task-form,.ob-outcome,.ob-comparison-grid,.ob-evidence,.ob-acceptance')].every(element => element.scrollWidth <= element.clientWidth + 1), noGraphInTaskView: !workspace.querySelector('canvas') };
    });
    assert.equal(value.pageFits, true, state);
    assert.equal(value.workspaceFits, true, state);
    assert.equal(value.sectionsFit, true, state);
    layouts.push({ state, ...value });
  };
  try {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + '/#ontology?mode=example');
      await page.locator('.ob-task-form').waitFor();
      assert.equal(await page.locator('.ob-outcome').count(), 0);
      await layout('not-run');
      await page.locator('.ontology-workspace').screenshot({ path: path.join(output, `business-input-${width}.png`) });
      await page.getByRole('button', { name: '运行这条客服任务', exact: true }).click();
      await page.locator('.ob-follow-up').waitFor();
      assert.match(await page.locator('.ob-outcome').textContent(), /0 条知识被实际引用/);
      await layout('clarify');
      await page.getByRole('button', { name: '补充 A-100 并继续', exact: true }).click();
      await page.locator('.ob-source-documents article').waitFor();
      assert.match(await page.locator('.ob-outcome').textContent(), /主控板/);
      await layout('knowledge');
      await page.locator('.ontology-workspace').screenshot({ path: path.join(output, `business-result-${width}.png`) });
      await page.getByRole('button', { name: '在图谱中核对这一步', exact: true }).click();
      await page.locator('canvas,.ontology-object-svg').waitFor();
      assert.match(await page.locator('.ontology-business-evidence').textContent(), /读取符合条件的知识/);
      assert.equal(await page.locator('.ontology-guide').count(), 0);
      await page.getByRole('button', { name: '业务指令', exact: true }).click();
      await page.locator('.oc-composer').waitFor({ state: 'visible' });
      const commandLayout = await page.locator('.ontology-command-panel').evaluate(panel => {
        const bounds = panel.getBoundingClientRect();
        const composer = panel.querySelector('.oc-composer').getBoundingClientRect();
        return { width: innerWidth, state: 'command-panel', fits: panel.scrollWidth <= panel.clientWidth + 1, composerFits: composer.left >= bounds.left - 1 && composer.right <= bounds.right + 1 && composer.bottom <= bounds.bottom + 1 };
      });
      assert.equal(commandLayout.fits, true);
      assert.equal(commandLayout.composerFits, true);
      layouts.push(commandLayout);
      await layout('graph-evidence');
      await page.getByRole('button', { name: '全屏展示', exact: true }).click();
      await page.locator('.ontology-explorer.is-fullscreen').waitFor();
      if (await page.getByRole('button', { name: '元素与证据', exact: true }).getAttribute('aria-pressed') === 'true') await page.getByRole('button', { name: '元素与证据', exact: true }).click();
      const bounds = await page.locator('.ontology-explorer').boundingBox();
      assert.ok(Math.abs(bounds.width - width) < 2);
      await page.locator('.ontology-explorer').screenshot({ path: path.join(output, `business-evidence-${width}.png`) });
      await page.getByRole('button', { name: '返回客服任务', exact: true }).click();
      await page.locator('.ob-outcome').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '运行 12 条固定验收', exact: true }).click();
      await page.locator('.ob-suite-result').waitFor();
      assert.equal(await page.locator('.ob-suite-result details').count(), 12);
      await page.locator('.ob-suite-result summary').first().click();
      await layout('acceptance');
      await page.locator('.ob-acceptance').screenshot({ path: path.join(output, `business-acceptance-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    const report = { passed: true, layouts, screenshots: 12, externalCalls: false, dataWrites: false, manualFullSizeReview: 'required', manualThumbnailReview: 'required' };
    await fs.writeFile(path.join(output, 'browser-layout-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
