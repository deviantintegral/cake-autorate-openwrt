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
  const createRow = page.locator('.cbi-section-create');
  const nameInput = createRow.locator('input.cbi-section-create-name');
  await expect(nameInput).toBeVisible();
  await nameInput.click();
  await nameInput.pressSequentially(name, { delay: 20 });

  // LuCI renders this as <button class="cbi-button-add" title="Add">Add</button>
  // (luci-base form.js), so it has a real accessible name; scope it to the
  // create row to keep the role locator unambiguous.
  const addBtn = createRow.getByRole('button', { name: 'Add' });
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
  // NOT a role locator: LuCI builds this control with ui.ComboButton, which
  // extends UIDropdown and renders a <div class="cbi-dropdown cbi-button-apply">
  // (luci.js addFooter / ui.js UIComboButton.render) -- there is no button role
  // and no accessible name to target, so the widget class is the stable hook.
  const apply = page.locator('.cbi-page-actions .cbi-button-apply');
  await expect(apply).toBeVisible();
  await apply.click();

  const overlay = page.locator('#modal_overlay');
  // The apply modal appears within a beat; tolerate the (rare) instant apply.
  await overlay.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  // MUST stay below playwright.config.js `timeout` (90 s), otherwise the test
  // times out first and the real failure is reported as an opaque test timeout
  // instead of "the apply overlay never cleared". Observed applies take ~5 s.
  await expect(overlay).toBeHidden({ timeout: 60 * 1000 });
}

/*
 * Remove a named instance via its Delete button. LuCI renders one Delete button
 * per section (luci-base form.js), so the accessible name alone is ambiguous --
 * and() intersects it with the section-scoped data hook to pin the right one
 * while still asserting the button really is the accessible "Delete" control.
 */
async function removeInstance(page, name) {
  const del = page.getByRole('button', { name: 'Delete' })
    .and(page.locator(`[data-section-id="${name}"]`));
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
