'use strict';
/*
 * Shaper-rate ordering: the Essentials help promises min <= base <= max, and the
 * form must actually enforce it.
 *
 * A LuCI datatype is per-field and cannot express a relation BETWEEN fields, so
 * before the cross-field validator existed the form accepted min > base without
 * a murmur and handed the daemon a nonsensical config. This spec pins the three
 * things a user should experience instead: the offending field is marked invalid
 * as they type, Save & Apply is refused with a sentence naming the rule, and
 * correcting the value clears the error on its siblings too.
 */
const { test, expect, luciBeforeEach } = require('../fixtures/luci');
const {
  waitForConfigForm, addInstance, saveApply, deleteInstance, setValue, valueInput,
} = require('./helpers');

test.beforeEach(luciBeforeEach);

const INST = 'valtest';

async function gotoConfig(page, luci) {
  await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
  await waitForConfigForm(page);
}

test.describe('cake-autorate config: shaper-rate ordering', () => {
  test('min above base is rejected inline and blocks Save & Apply', async ({ page, luci }) => {
    await gotoConfig(page, luci);

    // Clean slate if a prior failed run left the instance behind.
    if (await page.locator(`#cbi-cake-autorate-${INST}`).count()) {
      await deleteInstance(page, INST);
      await gotoConfig(page, luci);
    }

    await addInstance(page, INST);
    await setValue(page, INST, 'base_dl_shaper_rate_kbps', '5000');
    await setValue(page, INST, 'min_dl_shaper_rate_kbps', '9000');

    const minInput = valueInput(page, INST, 'min_dl_shaper_rate_kbps');
    await minInput.blur();

    // 1. Marked invalid in place, before any save is attempted.
    await expect(minInput).toHaveClass(/cbi-input-invalid/);

    // 2. Save & Apply is refused, and the reason names the rule and both values
    //    rather than saying "invalid value". (Not the saveApply() helper: that
    //    waits for the apply overlay to CLEAR, which is exactly what must not
    //    happen here.)
    await page.locator('.cbi-page-actions .cbi-button-apply').click();

    const modal = page.locator('#modal_overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      /Minimum download rate \(9000\) must not exceed the base download rate \(5000\)/i);
    await modal.getByRole('button', { name: 'Dismiss' }).click();
    await expect(modal).toBeHidden();

    // 3. Correcting the value clears it — and clears it on the SIBLING fields
    //    too, which only re-check themselves without the onchange cross-trigger.
    await setValue(page, INST, 'min_dl_shaper_rate_kbps', '2000');
    await minInput.blur();
    await expect(minInput).not.toHaveClass(/cbi-input-invalid/);
    await expect(valueInput(page, INST, 'base_dl_shaper_rate_kbps'))
      .not.toHaveClass(/cbi-input-invalid/);

    // The form is valid again, so this save really does go through.
    await saveApply(page);
    await gotoConfig(page, luci);
    await expect(valueInput(page, INST, 'min_dl_shaper_rate_kbps')).toHaveValue('2000');

    await deleteInstance(page, INST);
    await gotoConfig(page, luci);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toHaveCount(0);
  });

  test('max below base is rejected on the upload trio too', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    if (await page.locator(`#cbi-cake-autorate-${INST}`).count()) {
      await deleteInstance(page, INST);
      await gotoConfig(page, luci);
    }

    await addInstance(page, INST);
    await setValue(page, INST, 'base_ul_shaper_rate_kbps', '5000');
    await setValue(page, INST, 'max_ul_shaper_rate_kbps', '4000');

    const maxInput = valueInput(page, INST, 'max_ul_shaper_rate_kbps');
    await maxInput.blur();
    await expect(maxInput).toHaveClass(/cbi-input-invalid/);

    // Both directions are wired from the same RATE_TRIOS metadata, so the upload
    // trio must report in upload wording — proving the trios are not hard-coded
    // to download.
    await page.locator('.cbi-page-actions .cbi-button-apply').click();
    const modal = page.locator('#modal_overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(
      /Maximum upload rate \(4000\) must not be below the base upload rate \(5000\)/i);
    await modal.getByRole('button', { name: 'Dismiss' }).click();
    await expect(modal).toBeHidden();

    await setValue(page, INST, 'max_ul_shaper_rate_kbps', '20000');
    await maxInput.blur();
    await expect(maxInput).not.toHaveClass(/cbi-input-invalid/);

    await saveApply(page);
    await gotoConfig(page, luci);
    await deleteInstance(page, INST);
    await gotoConfig(page, luci);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toHaveCount(0);
  });
});
