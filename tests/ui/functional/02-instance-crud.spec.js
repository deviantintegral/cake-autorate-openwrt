'use strict';
/*
 * Instance lifecycle: create -> edit -> Save & Apply -> assert persistence ->
 * delete -> Save & Apply -> assert gone.
 *
 * Persistence is asserted across a FULL page reload (the values must have been
 * committed to UCI, not merely staged in the browser).
 */
const { test, expect } = require('../fixtures/luci');
const {
  waitForConfigForm, addInstance, saveApply, deleteInstance, setValue, valueInput,
} = require('./helpers');

test.beforeEach(require('../fixtures/luci').luciBeforeEach);

const INST = 'uitest';
const BASE_DL = '12345';

test.describe('cake-autorate config: instance CRUD', () => {
  test('create, edit, Save & Apply, persist across reload, then delete', async ({ page, luci }) => {
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);

    // Clean slate if a prior failed run left the instance behind.
    if (await page.locator(`#cbi-cake-autorate-${INST}`).count()) {
      await deleteInstance(page, INST);
      await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
      await waitForConfigForm(page);
    }

    // --- create ---
    await addInstance(page, INST);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toBeVisible();

    // --- edit: a plain numeric field (robust, no combobox) ---
    await setValue(page, INST, 'base_dl_shaper_rate_kbps', BASE_DL);

    await saveApply(page);

    // --- persistence across a real reload ---
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toBeVisible();
    await expect(valueInput(page, INST, 'base_dl_shaper_rate_kbps')).toHaveValue(BASE_DL);

    // --- delete ---
    await deleteInstance(page, INST);
    await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
    await waitForConfigForm(page);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toHaveCount(0);
  });
});
