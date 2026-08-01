'use strict';
/*
 * Status view: live per-instance cells populate, and the Start/Stop/Restart
 * service controls change the run state.
 *
 * The two seeded instances (primary, secondary) are enabled and running when
 * the VM comes up, so the status view has real data to render.
 */
const { test, expect, luciBeforeEach } = require('../fixtures/luci');

test.beforeEach(luciBeforeEach);

const INST = 'primary';
// status.js renders the per-instance controls as real <button>s labelled from
// its ACTIONS table, so they are reachable by role + accessible name.
const ACTION_LABEL = { start: 'Start', stop: 'Stop', restart: 'Restart' };

async function gotoStatus(page, luci) {
  await page.goto(luci.url(luci.statusPath), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cake-autorate-status')).toBeVisible();
}

function card(page, inst) {
  return page.locator(`.cake-instance[data-cake-instance="${inst}"]`);
}
/* Any dynamic cell of one instance, by its data-field key (see status.js). */
function liveCell(page, inst, field) {
  return card(page, inst).locator(`[data-live="1"][data-field="${field}"]`);
}
function runBadge(page, inst) {
  return liveCell(page, inst, 'running');
}
/* Scoped to the instance card, so the identically-labelled GLOBAL service
 * buttons (data-cake-instance="") can never be picked up by mistake. */
function actionBtn(page, inst, action) {
  return card(page, inst).getByRole('button', { name: ACTION_LABEL[action], exact: true });
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
    // Retrying form of "there is at least one": expect(await ...count()) would
    // sample once and race LuCI's client-side render.
    await expect(liveCells).not.toHaveCount(0);

    // The run-state badge shows a concrete state (running|stopped), not blank.
    await expect(runBadge(page, INST)).toHaveText(/running|stopped/i);

    // A metric cell (cake dl rate) exists and is not the em-dash placeholder,
    // OR the instance is legitimately "no data yet" -- either way the field is
    // present. The metric grid renders only when data is available, so accept
    // either the metric cell or the explicit "no data" live marker.
    const dlRate = liveCell(page, INST, 'cake_dl_rate_kbps');
    const noData = liveCell(page, INST, 'available');
    await expect(dlRate.or(noData).first()).toBeVisible();
  });

  /*
   * The poll must update the [data-live="1"] cells in place rather than
   * rebuild the instance cards every interval. Both render identical text, so
   * only node identity tells them apart. We stamp each live cell with an
   * attribute the view never writes; a rebuild throws those nodes away and the
   * stamps go with them.
   */
  test('poll updates live cells in place instead of rebuilding the cards', async ({ page, luci }) => {
    await gotoStatus(page, luci);
    await expect(card(page, INST)).toBeVisible();

    // Wait until the metric grid is up, i.e. availability has settled. A change
    // in availability is a STRUCTURAL change and a rebuild is then correct, so
    // settling first keeps this test about the steady-state poll.
    await expect(liveCell(page, INST, 'cake_dl_rate_kbps')).toBeVisible();

    const PROBE = 'data-ca-poll-probe';
    const stamped = await page.evaluate((probe) => {
      const cells = document.querySelectorAll('#cake-autorate-status-body [data-live="1"]');
      cells.forEach((el, i) => el.setAttribute(probe, String(i)));
      return cells.length;
    }, PROBE);
    expect(stamped).toBeGreaterThan(0);

    // Prove poll cycles actually landed -- a poll that never fires would
    // "preserve" the DOM trivially and pass a node-identity check for free.
    // LuCI probes env.ubuspath ("/ubus") first and only falls back to
    // "<scriptname>/admin/ubus" when that is unreachable (luci.js resolveRPCBase),
    // so match the path segment both endpoints share.
    let polls = 0;
    const onResponse = (r) => { if (r.url().includes('/ubus')) polls++; };
    page.on('response', onResponse);
    try {
      await expect.poll(() => polls, { timeout: 45000, intervals: [250] })
        .toBeGreaterThanOrEqual(2);
    }
    finally {
      page.off('response', onResponse);
    }

    // Same nodes, same count, every stamp intact => updated, not replaced.
    const after = await page.evaluate((probe) => {
      const all = Array.from(
        document.querySelectorAll('#cake-autorate-status-body [data-live="1"]'));
      return { total: all.length, probed: all.filter((el) => el.hasAttribute(probe)).length };
    }, PROBE);
    expect(after.total).toBe(stamped);
    expect(after.probed).toBe(stamped);

    // ...and the poll is genuinely feeding the view rather than erroring out
    // (the error path deliberately replaces the body, which would also drop the
    // stamps -- so assert we never took it).
    await expect(page.locator('#cake-autorate-status-body .alert-message')).toHaveCount(0);
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
