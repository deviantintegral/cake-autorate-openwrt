'use strict';
/*
 * Shared Playwright config for the luci-app-cake-autorate UI suites.
 *
 * Task 11 (this file) establishes it and adds the "functional" project.
 * Task 12 REUSES this exact config and adds a "visual" project for screenshot
 * diffs -- which is why the viewport + deviceScaleFactor are pinned HERE, at the
 * top-level `use`, so every project renders identically and visual baselines are
 * stable. Do not move rendering-affecting settings into the functional project.
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
    // Task 12 visual-regression defaults. Rendering-affecting knobs live here (and
    // in the top-level `use` viewport pin) so every screenshot is deterministic:
    //  - animations/caret off  -> no blinking-cursor or transition frames leak in;
    //  - scale css              -> device-independent pixels (we already pin DSR=1);
    //  - a tiny pixel tolerance -> absorbs sub-pixel font AA jitter between two
    //    independent VM boots without hiding real structural change.
    //
    // The tolerance was 0.02, which is not "tiny": 2% of a 1280x900 page is
    // ~23,000 pixels, and a line of text is ~3,000. It hid a real change --
    // rewording the filter placeholder left `config-empty` reporting a match, so
    // --update-snapshots did not rewrite it and the committed baseline went
    // stale. 0.002 still absorbs anti-aliasing jitter across two independent VM
    // boots (verified by regenerating every baseline on one boot and passing
    // them on the next) while a changed line of text now fails.
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
    // Pinned for deterministic rendering / stable task-12 visual diffs.
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
      // Task 12: full-page screenshot diffs. Reuses the SAME globalSetup/teardown
      // (one live LuCI), the SAME login fixture, and the SAME pinned engine +
      // viewport + deviceScaleFactor from `use` above -- that pinning is what makes
      // the committed baselines under visual/*-snapshots/ reproducible.
      name: 'visual',
      testDir: path.join(__dirname, 'visual'),
    },
  ],
});
