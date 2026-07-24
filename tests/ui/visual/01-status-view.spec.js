'use strict';
/*
 * Visual regression -- LIVE STATUS VIEW (task 9 page).
 *
 * Runs FIRST (file name sorts ahead of the config spec) so it screenshots the
 * pristine, seeded VM -- primary + secondary, both enabled and running -- before
 * 02-config-form.spec.js mutates the instance set. workers:1 + fullyParallel:false
 * (config) guarantee that ordering.
 *
 * Every polled value carries data-live="1" and is masked (see visual-helpers),
 * so the diff sees the page STRUCTURE (two instance cards, the metric grid,
 * the global + per-instance controls) but not the churning numbers.
 */
const { test, expect } = require('../fixtures/luci');
const { shot } = require('./visual-helpers');

test.beforeEach(require('../fixtures/luci').luciBeforeEach);

async function gotoStatus(page, luci) {
  await page.goto(luci.url(luci.statusPath), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cake-autorate-status')).toBeVisible();
  // The global service-control block is static structure -- a good "rendered" signal.
  await expect(page.locator('#cake-autorate-controls')).toBeVisible();
  // Wait for BOTH seeded instance cards so the layout is complete before capture.
  await expect(page.locator('.cake-instance[data-cake-instance="primary"]')).toBeVisible();
  await expect(page.locator('.cake-instance[data-cake-instance="secondary"]')).toBeVisible();
}

test.describe('visual: status view', () => {
  test('live status -- two running instances (dynamic cells masked)', async ({ page, luci }) => {
    await gotoStatus(page, luci);

    // Prefer the data-available layout (metric grid) for a stable structure: a
    // running daemon reaches it within a couple of polls. If it never arrives in
    // budget we still capture whatever rendered -- the baseline just reflects the
    // "no data yet" layout, which is itself a valid, masked, deterministic state.
    await page
      .locator('.cake-instance[data-cake-instance="primary"] .cake-metric-table')
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});

    await shot(page, 'status-view');
  });
});
