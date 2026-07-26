'use strict';
/*
 * Documentation screenshot GENERATOR -- deliberately not a test.
 *
 * It asserts nothing about appearance and compares against no baseline; it drives
 * the same live LuCI VM the other suites use and writes curated PNGs into
 * docs/images/ for the Markdown docs to embed. Regenerate with:
 *
 *   cd tests/ui && npx playwright test --project=docs
 *
 * It is NOT part of the CI pipeline (CI runs --project=functional and
 * --project=visual explicitly), so it never gates anything and never rewrites
 * committed images behind your back.
 *
 * Two things separate these from the visual/ baselines, which are unusable as
 * documentation:
 *   - NO MASKING. visual/ paints every data-live="1" cell with a solid box so
 *     the 3-second poll cannot flake a diff; that hides exactly the numbers a
 *     reader wants to see. Here the real values are the point.
 *   - Framed to the subject. visual/ captures fullPage (up to 2124px tall) to
 *     catch structural regressions anywhere. Docs want the one section being
 *     described, so most shots here are element-scoped.
 *
 * Because these are illustrations rather than assertions, small rendering
 * differences between machines do not matter -- but do regenerate the whole set
 * on one machine so the images look consistent alongside each other.
 */
const path = require('path');
const fs = require('fs');
const { test, expect, luciBeforeEach } = require('../fixtures/luci');
const { activateTab } = require('../functional/helpers');

const OUT = path.resolve(__dirname, '..', '..', '..', 'docs', 'images');

test.describe.configure({ mode: 'serial' });
test.beforeEach(luciBeforeEach);

/* Write one PNG. `target` is a Page (viewport shot) or a Locator (element shot). */
async function capture(target, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await target.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/*
 * Capture an instance section TOGETHER WITH the tab strip above it.
 *
 * A plain element shot of #cbi-cake-autorate-<name> begins at the tab
 * description, below the tab menu -- so the reader cannot tell which tab is
 * being shown, which is precisely the point when the docs are explaining that
 * the advanced options are grouped into tabs. So clip to the union of the tab
 * menu's box and the section's box instead, padded up a little to take in the
 * section heading.
 */
async function captureSectionWithTabs(page, sectionSel, name) {
  fs.mkdirSync(OUT, { recursive: true });
  // boundingBox() is viewport-relative while a fullPage clip is document-
  // relative; the two only agree at scroll offset 0. Activating a tab can
  // scroll, so pin the page to the top before measuring.
  await page.evaluate(() => window.scrollTo(0, 0));
  const section = await page.locator(sectionSel).boundingBox();
  const tabs = await page.locator('ul.cbi-tabmenu').first().boundingBox();
  if (!section || !tabs) {
    // No tab menu found -- fall back to the plain element shot rather than
    // producing a mis-clipped image.
    await capture(page.locator(sectionSel), name);
    return;
  }
  const top = Math.max(0, Math.min(tabs.y, section.y) - 34);
  const left = Math.max(0, Math.min(tabs.x, section.x) - 8);
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    // fullPage so a section taller than the 900px viewport is not truncated.
    fullPage: true,
    clip: {
      x: left,
      y: top,
      width: Math.max(tabs.width, section.width) + 16,
      height: (section.y + section.height) - top + 8,
    },
  });
}

async function gotoConfig(page, luci) {
  await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input#cake-autorate-filter')).toBeVisible();
}

test.describe('docs screenshots', () => {
  /*
   * Live status. A viewport shot rather than an element one: the OpenWrt
   * navigation bar and the Configuration/Status tabs tell a reader where in
   * LuCI this page lives, which is most of the value in a docs image.
   */
  test('status view', async ({ page, luci }) => {
    await page.goto(luci.url(luci.statusPath), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#cake-autorate-status-body')).toBeVisible();
    // Let one poll land so the cells hold real values instead of the "--"
    // placeholders the first paint shows.
    await expect(page.locator('.cake-instance').first()).toBeVisible();
    await page.waitForTimeout(4000);
    await capture(page, 'status-view');
  });

  /* The Essentials tab -- the "fill these in and you are done" story. */
  test('config: Essentials tab', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    const section = page.locator('#cbi-cake-autorate-primary');
    await expect(section).toBeVisible();
    await activateTab(page, 'essentials');
    await expect(page.locator('[data-name="dl_if"]').first()).toBeVisible();
    await captureSectionWithTabs(page, '#cbi-cake-autorate-primary', 'config-essentials');
  });

  /* One grouped advanced tab, to show the tabs are where the other 60 options live. */
  test('config: Shaper rates tab', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    const section = page.locator('#cbi-cake-autorate-primary');
    await expect(section).toBeVisible();
    await activateTab(page, 'shaper');
    await expect(page.locator('[data-name="adjust_dl_shaper_rate"]').first()).toBeVisible();
    await captureSectionWithTabs(page, '#cbi-cake-autorate-primary', 'config-shaper-tab');
  });

  /* The search box: how a reader maps an upstream UCI option name to a field. */
  test('config: option search', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    const filter = page.locator('input#cake-autorate-filter');
    await filter.click();
    await filter.pressSequentially('owd', { delay: 30 });
    await page.waitForTimeout(500);
    await capture(page, 'config-search');
  });

  /* Two instances = two WANs, for the multi-instance section of the docs. */
  test('config: multi-instance', async ({ page, luci }) => {
    await gotoConfig(page, luci);
    await expect(page.locator('#cbi-cake-autorate-primary')).toBeVisible();
    await expect(page.locator('#cbi-cake-autorate-secondary')).toBeVisible();
    await page.screenshot({
      path: path.join(OUT, 'config-multi-instance.png'),
      fullPage: true,
    });
  });
});
