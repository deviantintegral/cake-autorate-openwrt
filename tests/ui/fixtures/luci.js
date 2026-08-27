'use strict';
/*
 * Shared LuCI test fixtures for the cake-autorate UI suites.
 *
 * Exposes:
 *   - test / expect      : Playwright's, extended with a `luci` helper fixture.
 *   - luciBeforeEach     : a beforeEach body that skips the test when no live
 *                          LuCI came up (e.g. no KVM), then logs the page in.
 *                          Each spec does:
 *                              test.beforeEach(luciBeforeEach);
 *   - login(page, state) : the login routine itself, driving the real LuCI
 *                          login form so the CSRF token is submitted for us.
 *
 * The live endpoint + credentials come from ./.runtime/serve-state.json, written
 * by global-setup.js (VM --serve) or from CA_UI_BASE_URL (external endpoint).
 */
const base = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '.runtime', 'serve-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_e) {
    return { available: false, reason: 'no serve-state.json (globalSetup did not run)' };
  }
}

function makeLuci(state) {
  const baseUrl = String(process.env.CA_UI_BASE_URL || state.base_url || '')
    .replace(/\/$/, '');
  return {
    state,
    base: baseUrl,
    username: state.username || 'root',
    password: state.password != null ? state.password : '',
    overviewPath: state.overview_path
      || '/cgi-bin/luci/admin/network/cake-autorate/overview',
    statusPath: state.status_path
      || '/cgi-bin/luci/admin/network/cake-autorate/status',
    statisticsPath: state.statistics_path
      || '/cgi-bin/luci/admin/statistics/graphs',
    // True only when the endpoint really has luci-app-statistics AND
    // cake_autorate RRDs behind it (CA_UI_STATISTICS=1). Specs that need the
    // graphs skip on false rather than screenshot an empty dashboard.
    statistics: !!state.statistics,
    url(p) {
      if (!p) return baseUrl + '/';
      return baseUrl + (p.startsWith('/') ? p : '/' + p);
    },
  };
}

/*
 * Drive the real LuCI login form. Navigating to any admin path while
 * unauthenticated yields the server-rendered login page; we fill it and submit
 * so the hidden CSRF token rides along. Idempotent: if we are already
 * authenticated (no password field), it is a no-op.
 */
async function login(page, state) {
  const luci = makeLuci(state);
  await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });

  // LuCI's login template (luci-base ucode/template/sysauth.ut) renders its
  // <label>s WITHOUT a `for` attribute, so the fields have no accessible name and
  // getByLabel() cannot reach them -- the name attribute is the stable hook here.
  // The submit control does have one ("Log in"), so it uses a role locator.
  const pw = page.locator('input[name="luci_password"]');
  // The login form is server-rendered, so it is present immediately if needed.
  if ((await pw.count()) === 0) {
    return; // already logged in (or no auth required)
  }

  const user = page.locator('input[name="luci_username"]');
  if ((await user.count()) > 0) {
    await user.fill(luci.username);
  }
  await pw.fill(luci.password);

  await page.getByRole('button', { name: 'Log in' }).click();

  // After a successful login the password field is gone. This web-first
  // assertion is the navigation wait -- no waitForLoadState race needed.
  await base.expect(page.locator('input[name="luci_password"]'))
    .toHaveCount(0, { timeout: 20000 });
}

const test = base.test.extend({
  luci: async ({}, use) => {
    await use(makeLuci(readState()));
  },
});

/*
 * beforeEach body shared by every spec: skip when there is no live LuCI, else
 * log the page in. Exported as a function rather than registered here, so each
 * spec hooks it up in its own file scope.
 */
async function luciBeforeEach({ page }) {
  const state = readState();
  test.skip(!state.available,
    `live LuCI unavailable: ${state.reason || 'unknown'}`);
  await login(page, state);
}

module.exports = { test, expect: base.expect, login, luciBeforeEach, readState, makeLuci };
