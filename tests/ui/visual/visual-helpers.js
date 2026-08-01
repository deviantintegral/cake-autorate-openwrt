'use strict';
/*
 * Shared helpers for the visual-regression suite.
 *
 * Masking is the important part. The status view marks every value that changes
 * on the 3-second poll -- shaper/achieved rates, OWD deltas, load conditions,
 * uptime, the last-update datetime, the run-state badge -- with `data-live="1"`
 * (see view/cake-autorate/status.js). Comparing those pixels would make every
 * diff flake. `liveMasks()` returns the one locator matching all of them, so
 * `toHaveScreenshot({ mask })` paints them over and only layout or styling
 * changes register.
 *
 * The config form (overview.js) has no live cells, so the mask does nothing
 * there. We pass it anyway to keep every capture call identical.
 */
const { expect } = require('../fixtures/luci');

/*
 * Every region that changes on its own. All polled values in the status view
 * carry data-live="1", including the "last update" datetime, so there is no
 * separate timestamp locator to add. Returned as an array of locators, which is
 * what toHaveScreenshot's `mask` wants; one locator can match many nodes.
 */
function liveMasks(page) {
  return [page.locator('[data-live="1"]')];
}

/*
 * Capture one full-page screenshot and compare it to the committed baseline.
 * `name` becomes the snapshot file stem; Playwright appends
 * -<project>-<platform> and writes it under <spec>.spec.js-snapshots/. Changing
 * regions are always masked, and the rendering settings (animations, caret,
 * scale, tolerance) come from the shared expect.toHaveScreenshot config so every
 * shot is taken the same way.
 */
async function shot(page, name) {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: liveMasks(page),
  });
}

module.exports = { liveMasks, shot };
