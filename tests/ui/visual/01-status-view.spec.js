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
const { test, expect, luciBeforeEach } = require('../fixtures/luci');
const { shot } = require('./visual-helpers');

test.beforeEach(luciBeforeEach);

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

    // The committed baseline shows the data-available layout (the metric grid),
    // which a running daemon reaches within a couple of polls. Assert it rather
    // than swallowing the wait: if the grid never arrives the screenshot would
    // capture the "no data yet" layout and fail the pixel diff anyway, so failing
    // HERE reports the actual cause instead of an unexplained visual mismatch.
    await expect(
      page.locator('.cake-instance[data-cake-instance="primary"] .cake-metric-table')
    ).toBeVisible({ timeout: 30000 });

    await shot(page, 'status-view');
  });
});
