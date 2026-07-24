'use strict';
/*
 * DOM helpers for the cake-autorate LuCI config form, isolating the flaky bits
 * of LuCI's client-rendered CBI (tab activation, the create/remove section
 * controls, comboboxes, and the Save & Apply modal cycle) behind explicit,
 * waited operations. No arbitrary sleeps.
 *
 * Selectors below were verified against a live LuCI (OpenWrt 25.12.5,
 * luci-mod-admin-full, bootstrap theme) served by tests/integration --serve.
 */
const { expect } = require('../fixtures/luci');

/* Wait for the config form (overview.js) to finish client-side rendering. */
async function waitForConfigForm(page) {
  await expect(page.locator('input#cake-autorate-filter')).toBeVisible();
  await expect(page.locator('.cbi-value[data-name]').first()).toBeVisible();
}

/*
 * Activate a group tab. The tab menu renders one <li data-tab="<id>"> per
 * section; clicking the first reveals that group's pane. Callers then assert on
 * a representative option row becoming visible (the real "reachable" signal).
 */
async function activateTab(page, tabId) {
  const menuItem = page.locator(`li[data-tab="${tabId}"]`).first();
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

/*
 * Add a named section (instance) via the CBI "create" row. The Add button is
 * disabled until the name field emits real key events (LuCI validates on keyup),
 * so type with pressSequentially rather than fill().
 */
async function addInstance(page, name) {
  const nameInput = page.locator('.cbi-section-create input.cbi-section-create-name').first();
  await expect(nameInput).toBeVisible();
  await nameInput.click();
  await nameInput.pressSequentially(name, { delay: 20 });

  const addBtn = page.locator('.cbi-section-create .cbi-button-add').first();
  await expect(addBtn).toBeEnabled();
  await addBtn.click();

  await expect(page.locator(`#cbi-cake-autorate-${name}`)).toBeVisible();
}

/*
 * Drive Save & Apply to completion. A single click on the apply control fires
 * its default action ("Save & Apply"); LuCI then shows the "Applying
 * configuration changes… Ns" modal, flips it to "Configuration changes applied."
 * and hides it. We wait for that overlay to clear -- no sleeps, no rollback
 * confirmation needed (connectivity is never lost on a forwarded port).
 */
async function saveApply(page) {
  const apply = page.locator('.cbi-page-actions .cbi-button-apply').first();
  await expect(apply).toBeVisible();
  await apply.click();

  const overlay = page.locator('#modal_overlay');
  // The apply modal appears within a beat; tolerate the (rare) instant apply.
  await overlay.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await expect(overlay).toBeHidden({ timeout: 95 * 1000 });
}

/* Remove a named instance via its Delete button (carries data-section-id). */
async function removeInstance(page, name) {
  const del = page.locator(`button[data-section-id="${name}"]`).first();
  await expect(del).toBeVisible();
  await del.click();
}

/* Remove + Save & Apply in one shot. */
async function deleteInstance(page, name) {
  await removeInstance(page, name);
  await saveApply(page);
}

/*
 * Set a LuCI ComboBox (e.g. dl_if/ul_if) value. Opens the dropdown and picks the
 * matching <li data-value>; falls back to the free-text create-item-input for a
 * value not in the offered choices.
 */
async function setCombo(page, sid, opt, value) {
  const scope = `#cbi-cake-autorate-${sid} .cbi-value[data-name="${opt}"]`;
  const dropdown = page.locator(`${scope} .cbi-dropdown`).first();
  await dropdown.scrollIntoViewIfNeeded();
  await dropdown.click();

  const choice = page.locator(`${scope} .cbi-dropdown li[data-value="${value}"]`).first();
  if (await choice.count()) {
    await choice.click();
    return;
  }
  const custom = page.locator(`${scope} .create-item-input`).first();
  await custom.fill(value);
  await custom.press('Enter');
}

/* Read a ComboBox's current value (from the selected <li>). */
async function comboValue(page, sid, opt) {
  return page
    .locator(`#cbi-cake-autorate-${sid} .cbi-value[data-name="${opt}"] .cbi-dropdown`)
    .first()
    .evaluate((el) => {
      const sel = el.querySelector('li[selected]');
      return sel ? sel.getAttribute('data-value') : (el.getAttribute('data-value') || '');
    });
}

/* Set a plain text/number option input scoped to a section. */
async function setValue(page, sid, opt, value) {
  const input = page.locator(`#cbi-cake-autorate-${sid} .cbi-value[data-name="${opt}"] input`).first();
  await expect(input).toBeVisible();
  await input.fill(value);
}

/* Read a plain text/number option input scoped to a section. */
function valueInput(page, sid, opt) {
  return page.locator(`#cbi-cake-autorate-${sid} .cbi-value[data-name="${opt}"] input`).first();
}

module.exports = {
  waitForConfigForm,
  activateTab,
  addInstance,
  saveApply,
  removeInstance,
  deleteInstance,
  setCombo,
  comboValue,
  setValue,
  valueInput,
};
