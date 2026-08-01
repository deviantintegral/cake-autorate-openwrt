'use strict';
/*
 * Visual regression for the live status view.
 *
 * Runs first -- the file name sorts ahead of the config spec -- so it captures
 * the freshly seeded VM, primary and secondary both enabled and running, before
 * 02-config-form.spec.js starts changing the instance set. workers:1 and
 * fullyParallel:false in the config guarantee that order.
 *
 * Every polled value carries data-live="1" and is masked (see visual-helpers),
 * so the diff sees the page layout -- two instance cards, the metric grid, the
 * global and per-instance controls -- but not the numbers churning inside it.
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

    // The committed baseline shows the metric grid, which a running daemon
    // reaches within a couple of polls. Wait for it explicitly: if it never
    // arrives the screenshot would capture the "no data yet" layout and fail the
    // pixel diff anyway, and failing here names the real cause.
    await expect(
      page.locator('.cake-instance[data-cake-instance="primary"] .cake-metric-table')
    ).toBeVisible({ timeout: 30000 });

    await shot(page, 'status-view');
  });
});
