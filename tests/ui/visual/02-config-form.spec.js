'use strict';
/*
 * Visual regression for the config form (overview.js).
 *
 * One serial flow walks the instance set through each state, screenshotting as
 * it goes:
 *   multi-instance  ->  single instance + each group tab  ->  empty  ->  post Save&Apply
 *
 * It runs after 01-status-view.spec.js (file-name order, workers:1) so the
 * status baselines are captured against the freshly seeded VM before this spec
 * starts changing instances. The VM is thrown away by globalTeardown, so the
 * deletes here are safe -- nothing runs after this file.
 *
 * The config form has no data-live cells, so the live mask does nothing here.
 * The screenshots still come out the same every time because the seeded UCI and
 * the values we set are fixed, and the engine and viewport are pinned in the
 * config.
 */
const { test, expect, luciBeforeEach } = require('../fixtures/luci');
const {
  activateTab, addInstance, saveApply, deleteInstance, setValue,
} = require('../functional/helpers');
const { shot } = require('./visual-helpers');

test.describe.configure({ mode: 'serial' });
test.beforeEach(luciBeforeEach);

// One representative option row per group tab (must become visible once active).
const TABS = [
  { id: 'essentials', sample: 'dl_if' },
  { id: 'shaper', sample: 'adjust_dl_shaper_rate' },
  { id: 'pingers', sample: 'pinger_binary' },
  { id: 'reflectors', sample: 'reflectors' },
  { id: 'detection', sample: 'dl_owd_delta_thr_ms' },
  { id: 'idle', sample: 'enable_sleep_function' },
  { id: 'logging', sample: 'output_processing_stats' },
];

async function gotoConfig(page, luci) {
  await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
  // Wait only for the always-present form chrome (the search toolbar). Each test
  // asserts the specific instance sections/rows it expects afterwards. Waiting
  // on a .cbi-value row here (as waitForConfigForm does) would hang on the
  // empty-config states exercised by the empty and post-Save&Apply tests.
  await expect(page.locator('input#cake-autorate-filter')).toBeVisible();
}

test.describe('visual: config form', () => {
  // 1) Multi-instance: the two seeded instances, default Essentials tab active.
  test('multi-instance overview (primary + secondary)', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    await expect(page.locator('#cbi-cake-autorate-primary')).toBeVisible();
    await expect(page.locator('#cbi-cake-autorate-secondary')).toBeVisible();
    await shot(page, 'config-multi-instance');
  });

  // 2) Single populated instance + every group tab expanded.
  test('single instance + each group tab', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    // Reduce to one instance so the per-section tab menu is unambiguous.
    if (await page.locator('#cbi-cake-autorate-secondary').count()) {
      await deleteInstance(page, 'secondary');
      await gotoConfig(page, luci);
    }
    await expect(page.locator('#cbi-cake-autorate-primary')).toBeVisible();
    await expect(page.locator('#cbi-cake-autorate-secondary')).toHaveCount(0);

    // Landing (Essentials) == the populated single-instance view.
    await shot(page, 'config-single-instance');

    // Each collapsible group tab, expanded, captured full-page.
    for (const t of TABS) {
      await activateTab(page, t.id);
      await expect(page.locator(`.cbi-value[data-name="${t.sample}"]`).first()).toBeVisible();
      await shot(page, `config-tab-${t.id}`);
    }
  });

  // 3) Empty config: no instances -> just the toolbar + create row.
  test('empty config (no instances)', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    if (await page.locator('#cbi-cake-autorate-primary').count()) {
      await deleteInstance(page, 'primary');
      await gotoConfig(page, luci);
    }
    await expect(page.locator('.cbi-value[data-name="dl_if"]')).toHaveCount(0);
    await expect(page.locator('input#cake-autorate-filter')).toBeVisible();
    await shot(page, 'config-empty');
  });

  // 4) Post Save & Apply: create a fresh instance, set essentials, apply, capture
  //    the settled form (apply modal cleared, new section committed & rendered).
  test('post Save & Apply (new instance committed)', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    if (await page.locator('#cbi-cake-autorate-vshot').count()) {
      await deleteInstance(page, 'vshot');
      await gotoConfig(page, luci);
    }
    await addInstance(page, 'vshot');
    await setValue(page, 'vshot', 'min_dl_shaper_rate_kbps', '2000');
    await setValue(page, 'vshot', 'base_dl_shaper_rate_kbps', '5000');
    await setValue(page, 'vshot', 'max_dl_shaper_rate_kbps', '40000');
    await setValue(page, 'vshot', 'min_ul_shaper_rate_kbps', '2000');
    await setValue(page, 'vshot', 'base_ul_shaper_rate_kbps', '5000');
    await setValue(page, 'vshot', 'max_ul_shaper_rate_kbps', '20000');
    await saveApply(page);
    // The apply overlay has cleared (saveApply waits for it); the committed
    // section is rendered. Re-navigate for a clean, fully-settled layout.
    await gotoConfig(page, luci);
    await expect(page.locator('#cbi-cake-autorate-vshot')).toBeVisible();
    await shot(page, 'config-post-save-apply');
  });
});
