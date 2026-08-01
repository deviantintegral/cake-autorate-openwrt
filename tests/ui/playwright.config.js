'use strict';
/*
 * Shared Playwright config for the luci-app-cake-autorate UI suites.
 *
 * The functional and visual projects share it, which is why the viewport and
 * deviceScaleFactor are pinned here in the top-level `use`: every project then
 * renders identically and the visual baselines stay stable. Do not move
 * anything that affects rendering into an individual project.
 *
 * Live LuCI endpoint:
 *   - globalSetup (./global-setup.js) boots the tests/integration VM in --serve
 *     mode (or reuses an external endpoint from CA_UI_BASE_URL) and writes
 *     ./.runtime/serve-state.json with { available, base_url, username, password }.
 *   - globalTeardown (./global-teardown.js) tears the VM down.
 *   - The login fixture (./fixtures/luci.js) reads that state file, logs into
 *     LuCI, and hands specs an authenticated page. Tests self-skip when no live
 *     LuCI is available (e.g. no KVM on the runner) so CI stays green-or-skipped,
 *     never falsely red.
 */
const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: __dirname,
  globalSetup: require.resolve('./global-setup.js'),
  globalTeardown: require.resolve('./global-teardown.js'),

  // One VM, one uhttpd: serialize everything. No cross-test parallelism.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  // LuCI's client-rendered forms take a beat to hydrate; be patient but bounded.
  timeout: 90 * 1000,
  expect: {
    timeout: 20 * 1000,
    // Visual-regression defaults. Everything that affects rendering lives here
    // (and in the top-level `use` viewport pin) so screenshots come out the same
    // every time:
    //  - animations/caret off  -> no blinking cursor or transition frames;
    //  - scale css              -> device-independent pixels (DSR is pinned to 1);
    //  - a small pixel tolerance -> absorbs font anti-aliasing jitter between two
    //    VM boots without hiding a real change.
    //
    // The tolerance used to be 0.02, which is not small: 2% of a 1280x900 page is
    // ~23,000 pixels and a line of text is ~3,000. It hid a real change --
    // rewording the filter placeholder still counted as a match, so
    // --update-snapshots left the committed `config-empty` baseline stale. 0.002
    // still absorbs anti-aliasing jitter across two VM boots (checked by
    // regenerating every baseline on one boot and passing them on the next),
    // and a changed line of text now fails.
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.002,
    },
  },

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    browserName: 'chromium',
    headless: true,
    // Pinned so rendering, and therefore the visual diffs, stay stable.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    actionTimeout: 20 * 1000,
    navigationTimeout: 45 * 1000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'functional',
      testDir: path.join(__dirname, 'functional'),
    },
    {
      // Full-page screenshot diffs. Shares the globalSetup/teardown (one live
      // LuCI), the login fixture, and the pinned engine, viewport and
      // deviceScaleFactor from `use` above -- that pinning is what makes the
      // committed baselines under visual/*-snapshots/ reproducible.
      name: 'visual',
      testDir: path.join(__dirname, 'visual'),
    },
    {
      // Documentation screenshots. Writes unmasked PNGs into docs/images/
      // instead of comparing against baselines -- docs/screenshots.spec.js
      // explains why the visual/ baselines cannot serve as documentation. Run
      // on demand with `--project=docs`; CI names the functional and visual
      // projects explicitly, so this never runs there and never rewrites the
      // committed images behind anyone's back.
      name: 'docs',
      testDir: path.join(__dirname, 'docs'),
    },
  ],
});
