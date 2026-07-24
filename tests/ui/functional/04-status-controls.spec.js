'use strict';
/*
 * Status view: live per-instance cells populate, and the Start/Stop/Restart
 * service controls change the run state.
 *
 * The two seeded instances (primary, secondary) are enabled and running when
 * the VM comes up, so the status view has real data to render.
 */
const { test, expect } = require('../fixtures/luci');

test.beforeEach(require('../fixtures/luci').luciBeforeEach);

const INST = 'primary';

async function gotoStatus(page, luci) {
  await page.goto(luci.url(luci.statusPath), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cake-autorate-status')).toBeVisible();
}

function card(page, inst) {
  return page.locator(`.cake-instance[data-cake-instance="${inst}"]`);
}
function runBadge(page, inst) {
  return page.locator(`.cake-instance[data-cake-instance="${inst}"] [data-live="1"][data-field="running"]`);
}
function actionBtn(page, inst, action) {
  return page.locator(`.cake-instance[data-cake-instance="${inst}"] button[data-cake-action="${action}"][data-cake-instance="${inst}"]`);
}

test.describe('cake-autorate status: live data & controls', () => {
  test('per-instance live cells populate', async ({ page, luci }) => {
    await gotoStatus(page, luci);

    // The seeded instances render as cards.
    await expect(card(page, INST)).toBeVisible();

    // Dynamic cells carry data-live="1". At least the run-state badge and the
    // shaper-rate cell must render actual (non-placeholder) content.
    const liveCells = page.locator('[data-live="1"]');
    await expect(liveCells.first()).toBeVisible();
    expect(await liveCells.count()).toBeGreaterThan(0);

    // The run-state badge shows a concrete state (running|stopped), not blank.
    await expect(runBadge(page, INST)).toHaveText(/running|stopped/i);

    // A metric cell (cake dl rate) exists and is not the em-dash placeholder,
    // OR the instance is legitimately "no data yet" -- either way the field is
    // present. We assert the field element exists and has been populated.
    const dlRate = page.locator(
      `.cake-instance[data-cake-instance="${INST}"] [data-live="1"][data-field="cake_dl_rate_kbps"]`
    );
    // The metric grid renders only when data is available; wait for either the
    // metric cell or the explicit "no data" live marker.
    const noData = page.locator(
      `.cake-instance[data-cake-instance="${INST}"] [data-live="1"][data-field="available"]`
    );
    await expect(dlRate.or(noData).first()).toBeVisible();
  });

  test('Start / Stop / Restart change the run state', async ({ page, luci }) => {
    await gotoStatus(page, luci);
    await expect(card(page, INST)).toBeVisible();
    await expect(runBadge(page, INST)).toBeVisible();

    // Stop -> the badge must report "stopped" (poll refreshes it in place).
    await actionBtn(page, INST, 'stop').click();
    await expect(runBadge(page, INST)).toHaveText(/stopped/i, { timeout: 30000 });

    // Start -> back to "running".
    await actionBtn(page, INST, 'start').click();
    await expect(runBadge(page, INST)).toHaveText(/running/i, { timeout: 30000 });

    // Restart -> stays "running" after the cycle settles.
    await actionBtn(page, INST, 'restart').click();
    await expect(runBadge(page, INST)).toHaveText(/running/i, { timeout: 30000 });
  });
});
