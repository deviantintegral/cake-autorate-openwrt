'use strict';
/*
 * Shared helpers for the task-12 visual-regression suite.
 *
 * The single most important thing here is masking: the status view marks every
 * value that changes on the 3-second poll (shaper/achieved rates, OWD deltas,
 * load conditions, uptime, the last-update datetime, the run-state badge) with
 * `data-live="1"` (see view/cake-autorate/status.js). If those pixels were
 * compared, every diff would flake. `liveMasks()` returns the ONE locator that
 * resolves to all of them, so `toHaveScreenshot({ mask })` paints them over with
 * a solid box and only structural / styling change registers.
 *
 * The config form (overview.js) has no live cells, so the same mask is a no-op
 * there -- we still pass it for uniformity, which keeps the capture call identical
 * across every page/state.
 */
const { expect } = require('../fixtures/luci');

/*
 * All inherently dynamic regions to mask. Every polled value in the status view
 * carries data-live="1"; that includes the datetime "last update" cell, so no
 * separate timestamp locator is needed. Returned as an array of locators (the
 * shape toHaveScreenshot's `mask` wants); a locator matching many nodes masks
 * them all.
 */
function liveMasks(page) {
  return [page.locator('[data-live="1"]')];
}

/*
 * Capture one deterministic full-page screenshot against a committed baseline.
 * `name` becomes the snapshot file stem (Playwright appends -<project>-<platform>
 * and writes it under <spec>.spec.js-snapshots/). Dynamic regions are always
 * masked. Rendering knobs (animations/caret/scale/tolerance) come from the shared
 * expect.toHaveScreenshot config so every shot is pinned identically.
 */
async function shot(page, name) {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: liveMasks(page),
  });
}

module.exports = { liveMasks, shot };
