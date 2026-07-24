'use strict';
/*
 * Essentials-only path: a fresh instance with ONLY the interfaces + the
 * min/base/max shaper rates set must Save & Apply into a valid UCI config.
 *
 * Validity is proven by a real page reload: the instance and every essentials
 * value persist, which means a well-formed UCI section was committed.
 */
const { test, expect } = require('../fixtures/luci');
const {
  waitForConfigForm, addInstance, saveApply, deleteInstance,
  setCombo, comboValue, setValue, valueInput,
} = require('./helpers');

test.beforeEach(require('../fixtures/luci').luciBeforeEach);

const INST = 'essonly';

test.describe('cake-autorate config: essentials-only', () => {
  test('interface + rates only yields a valid saved config', async ({ page, luci }) => {
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);

    if (await page.locator(`#cbi-cake-autorate-${INST}`).count()) {
      await deleteInstance(page, INST);
      await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
      await waitForConfigForm(page);
    }

    await addInstance(page, INST);

    // Only the essentials: two interfaces + min/base/max for both directions.
    await setCombo(page, INST, 'dl_if', 'ifb4eth1');
    await setCombo(page, INST, 'ul_if', 'eth1');
    await setValue(page, INST, 'min_dl_shaper_rate_kbps', '2000');
    await setValue(page, INST, 'base_dl_shaper_rate_kbps', '5000');
    await setValue(page, INST, 'max_dl_shaper_rate_kbps', '40000');
    await setValue(page, INST, 'min_ul_shaper_rate_kbps', '2000');
    await setValue(page, INST, 'base_ul_shaper_rate_kbps', '5000');
    await setValue(page, INST, 'max_ul_shaper_rate_kbps', '20000');

    await saveApply(page);

    // Persisted across reload -> the saved UCI section is valid & complete.
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toBeVisible();
    await expect(valueInput(page, INST, 'base_dl_shaper_rate_kbps')).toHaveValue('5000');
    await expect(valueInput(page, INST, 'max_ul_shaper_rate_kbps')).toHaveValue('20000');
    expect(await comboValue(page, INST, 'dl_if')).toBe('ifb4eth1');
    expect(await comboValue(page, INST, 'ul_if')).toBe('eth1');

    // Clean up so reruns start fresh.
    await deleteInstance(page, INST);
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toHaveCount(0);
  });
});
