'use strict';
/*
 * Generates the screenshots the docs embed. Deliberately not a test.
 *
 * It checks nothing about appearance and compares against no baseline. It
 * drives the same live LuCI VM the other suites use and writes PNGs into
 * docs/images/. Regenerate with:
 *
 *   cd tests/ui && npx playwright test --project=docs
 *
 * CI runs --project=functional and --project=visual explicitly, so this never
 * runs there, never gates anything, and never rewrites committed images behind
 * your back.
 *
 * Two things make these different from the visual/ baselines, which cannot
 * serve as documentation:
 *   - No masking. visual/ paints every data-live="1" cell over so the 3-second
 *     poll cannot flake a diff, which hides exactly the numbers a reader wants
 *     to see. Here the real values are the point.
 *   - Framed on the subject. visual/ captures the full page, up to 2124px tall,
 *     to catch layout changes anywhere. Docs want the one section being
 *     described, so most shots here are scoped to an element.
 *
 * Since these are illustrations, small rendering differences between machines
 * do not matter -- but regenerate the whole set on one machine so the images
 * look consistent next to each other.
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
 * Capture an instance section together with the tab strip above it.
 *
 * A plain element shot of #cbi-cake-autorate-<name> starts at the tab
 * description, below the tab menu, so the reader cannot tell which tab is
 * showing -- which is the whole point when the docs are explaining that the
 * advanced options are grouped into tabs. Clip to both boxes instead, padded a
 * little at the top to take in the section heading.
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

  /*
   * The collectd statistics dashboard.
   *
   * Needs a live luci-app-statistics with real cake_autorate RRDs behind it,
   * which only CA_UI_STATISTICS=1 sets up (see tests/integration/lib/
   * harness.py enable_statistics). Skip loudly rather than capture an empty
   * "No RRD data found" modal and commit it as documentation.
   */
  test('statistics: CAKE Autorate graphs', async ({ page, luci }) => {
    test.skip(!luci.statistics,
      'no populated luci-app-statistics on this endpoint -- regenerate with '
      + 'CA_UI_STATISTICS=1 (see docs/testing.md#documentation-screenshots)');

    await page.goto(luci.url(luci.statisticsPath), { waitUntil: 'domcontentloaded' });

    // luci-app-statistics builds one tab per collectd plugin that has both RRDs
    // and a definition file; ours is named for the plugin the exec reader emits
    // under, so this locator is also the assertion that cake_autorate.js was
    // found and loaded.
    const tab = page.locator('li[data-tab="cake_autorate"]');
    await expect(tab).toBeVisible();
    await tab.click();

    // Graphs are rendered server-side by rrdtool and handed back as PNG blobs,
    // so "the tab is active" is not "the graphs are drawn" -- wait for the
    // images themselves.
    const pane = page.locator('[data-plugin="cake_autorate"]').first();
    await expect(pane.locator('img').first()).toBeVisible({ timeout: 60000 });
    // Every panel in the group, not just the first to arrive.
    await expect.poll(() => pane.locator('img').count(), { timeout: 60000 })
      .toBeGreaterThan(1);

    await page.screenshot({
      path: path.join(OUT, 'statistics-graphs.png'),
      fullPage: true,
    });
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
