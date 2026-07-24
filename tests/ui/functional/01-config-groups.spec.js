'use strict';
/*
 * Config page: group tabs + search filter.
 *
 * Asserts:
 *  - Essentials is the FIRST group tab.
 *  - Every documented group tab is reachable (activates its pane).
 *  - The search box (input#cake-autorate-filter) hides non-matching option rows
 *    and clearing it restores them.
 */
const { test, expect } = require('../fixtures/luci');
const { waitForConfigForm, activateTab } = require('./helpers');

test.beforeEach(require('../fixtures/luci').luciBeforeEach);

// One representative UCI option per documented group (from options.js).
const GROUPS = [
  { id: 'essentials', sample: 'dl_if' },
  { id: 'shaper', sample: 'adjust_dl_shaper_rate' },
  { id: 'pingers', sample: 'pinger_binary' },
  { id: 'reflectors', sample: 'reflectors' },
  { id: 'detection', sample: 'dl_owd_delta_thr_ms' },
  { id: 'idle', sample: 'enable_sleep_function' },
  { id: 'logging', sample: 'output_processing_stats' },
];

test.describe('cake-autorate config: groups & filter', () => {
  test('Essentials is the first group tab and all groups are reachable', async ({ page, luci }) => {
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);

    // Essentials must be the first tab in the tab menu.
    const firstTab = page.locator('li[data-tab]').first();
    await expect(firstTab).toHaveAttribute('data-tab', 'essentials');

    // Each group tab activates and reveals its representative option row.
    for (const g of GROUPS) {
      await activateTab(page, g.id);
      const row = page.locator(`.cbi-value[data-name="${g.sample}"]`).first();
      await expect(row).toBeVisible();
    }
  });

  test('search filter hides non-matching option rows and restores on clear', async ({ page, luci }) => {
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);

    const filter = page.locator('input#cake-autorate-filter');
    const reflectorsRow = page.locator('.cbi-value[data-name="reflectors"]').first();
    const dlIfRow = page.locator('.cbi-value[data-name="dl_if"]').first();

    // overview.js wires the filter to the input's `keyup`/`search` events, so set
    // the value and dispatch keyup (fill() alone only emits `input`).
    async function typeFilter(q) {
      await filter.fill(q);
      await filter.dispatchEvent('keyup');
    }

    // Filter for "reflector": the reflectors row shows, the dl_if row hides.
    await typeFilter('reflector');
    await expect(reflectorsRow).toBeVisible();
    await expect(dlIfRow).toBeHidden();

    // A status line reports the match count.
    await expect(page.locator('#cake-autorate-filter-status')).toContainText(/match/i);

    // Clearing the filter restores every row.
    await typeFilter('');
    await expect(dlIfRow).toBeVisible();
    await expect(reflectorsRow).toBeVisible();
  });
});
