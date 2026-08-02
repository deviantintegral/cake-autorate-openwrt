'use strict';
/*
 * The two Essentials calibration aids in a real browser: the "Seed rates from
 * SQM" control and the read-only clipping notice.
 *
 * This spec deliberately does NOT re-test what
 * luci/luci-app-cake-autorate/tests/live.test.js already pins in node: the seed
 * arithmetic (base = max = the SQM rate, min a quarter of it), the refusal
 * reason codes, or any sentence either feature prints. Those are pure helpers
 * (live.seedPlan / live.calibrationReport) with unit coverage, and repeating
 * them here would only make the wording expensive to change.
 *
 * What only a live browser can prove, and what this spec is for:
 *   - the click really reaches the six CBI widgets -- setValue() on a rendered
 *     ui.Textfield, not just a number in a JS object;
 *   - the seeded values leave the cross-field rate-ordering validator quiet, so
 *     seeding can never hand the user a form they cannot save;
 *   - the control writes into the FORM only: a reload brings the saved values
 *     back, because nothing was committed;
 *   - the enabled/blocked state tracks the ul_if widget live, through the
 *     onchange -> refreshSeedControl wiring, and states a reason when blocked;
 *   - the calibration notice survives the real ubus/ACL round trip and renders
 *     one node per instance -- with a verdict, or with a "not yet" reason, but
 *     never as an error or an empty box.
 *
 * Every element is reached through the data-* hooks documented in the
 * overview.js header comment, never through text or DOM structure.
 *
 * Expected numbers are derived from the SQM fixture the integration harness
 * seeds the VM with, so a fixture rate change cannot silently invalidate them.
 */
const fs = require('fs');
const path = require('path');
const { test, expect, luciBeforeEach } = require('../fixtures/luci');
const {
  waitForConfigForm, addInstance, deleteInstance, setCombo, comboValue, valueInput,
} = require('./helpers');

test.beforeEach(luciBeforeEach);

/* The very file tests/integration/run.sh copies to /etc/config/sqm in the VM. */
const SQM_FIXTURE = path.resolve(
  __dirname, '..', '..', 'integration', 'fixtures', 'sqm-two-wan.config');

/* An instance name used only by the refusal test; created and deleted here. */
const INST = 'seedtest';

/* The reasons a *fresh* VM may legitimately have no diagnosis. 'error' is not
 * among them: it is what calibrationReport() degrades to when the ubus call
 * itself failed (method missing, ACL not granted), which is a defect, not a
 * "statistics have not accumulated yet". */
const NOT_YET_REASONS = ['no-rrdtool', 'no-rrd', 'no-data'];

/*
 * Parse the SQM fixture into { <egress>: { download, upload } } in Kbit/s.
 * sqm-scripts stores both rates in Kbit/s already -- the rpcd method passes
 * them through unconverted as download_kbps / upload_kbps -- so these are the
 * numbers the seed formula is applied to.
 */
function sqmQueues() {
  const out = {};
  let cur = null;
  for (const raw of fs.readFileSync(SQM_FIXTURE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#'))
      continue;
    if (/^config\b/.test(line)) {
      cur = { download: 0, upload: 0 };
      continue;
    }
    const m = /^option\s+(\S+)\s+(.+)$/.exec(line);
    if (!m || !cur)
      continue;
    const key = m[1];
    const val = m[2].trim().replace(/^['"]|['"]$/g, '');
    // `interface` may appear before the rates; `cur` is stored by reference, so
    // the later options still land in the registered object.
    if (key === 'interface')
      out[val] = cur;
    else if (key === 'download' || key === 'upload')
      cur[key] = Number(val);
  }
  return out;
}

/*
 * The seed formula, mirroring live.rateTrio(): base = max = the SQM rate, min a
 * quarter of it floored. null for a rate that carries nothing to seed from --
 * 0 is sqm-scripts' "no limit" sentinel -- because the two directions resolve
 * independently and an unusable one must leave its three fields alone.
 */
function trioFor(rate) {
  const r = Number(rate);
  if (!isFinite(r) || r <= 0 || Math.floor(r) !== r)
    return null;
  return { min: String(Math.floor(r / 4)), base: String(r), max: String(r) };
}

/* The six-field expectation for one egress interface: { <uci_option>: value }. */
function expectedFields(queue) {
  const out = {};
  [['dl', queue.download], ['ul', queue.upload]].forEach(([dir, rate]) => {
    const trio = trioFor(rate);
    if (!trio)
      return;
    out[`min_${dir}_shaper_rate_kbps`] = trio.min;
    out[`base_${dir}_shaper_rate_kbps`] = trio.base;
    out[`max_${dir}_shaper_rate_kbps`] = trio.max;
  });
  return out;
}

/* An egress the fixture gives at least one usable rate for, i.e. one the seed
 * control must offer to run on. */
function seedableEgress() {
  const queues = sqmQueues();
  return Object.keys(queues).find((k) => Object.keys(expectedFields(queues[k])).length > 0);
}

async function gotoConfig(page, luci) {
  await page.goto(luci.url(luci.overviewPath), { waitUntil: 'domcontentloaded' });
  await waitForConfigForm(page);
}

/* Every instance the form rendered, taken from the one seed control per section. */
function seedControls(page) {
  return page.locator('button.cake-seed-btn[data-cake-seed]');
}

test.describe('cake-autorate config: seed rates from SQM', () => {
  test('seeding fills the six rates from SQM, validates clean, and saves nothing', async ({ page, luci }) => {
    await gotoConfig(page, luci);

    // The instance to drive is whichever one the live SQM config already backs;
    // asserting that at least one is ready is itself the check that the rpcd
    // rates reached the widget's decision.
    const reason = page.locator('.cake-seed-reason[data-cake-seed-state="ready"]').first();
    await expect(reason,
      'no instance is seed-ready against the VM SQM config').toBeVisible();
    const inst = await reason.getAttribute('data-cake-seed');

    // The documented control row, on the Essentials tab where it belongs.
    await expect(page.locator(
      `#cbi-cake-autorate-${inst} .cbi-value[data-name="_seed_rates"]`)).toBeVisible();

    const egress = await comboValue(page, inst, 'ul_if');
    const queue = sqmQueues()[egress];
    expect(queue,
      `${SQM_FIXTURE} configures no queue for egress "${egress}"`).toBeTruthy();

    const expected = expectedFields(queue);
    const names = Object.keys(expected);
    expect(names.length,
      'the SQM fixture must configure at least one usable rate').toBeGreaterThan(0);

    // Snapshot first: if the saved config already held exactly the seeded
    // numbers, "the click filled them in" would prove nothing at all.
    const before = {};
    for (const name of names)
      before[name] = await valueInput(page, inst, name).inputValue();
    expect(before,
      'the saved rates already equal the seed, so this test could not fail').not.toEqual(expected);

    const btn = page.locator(`button.cake-seed-btn[data-cake-seed="${inst}"]`);
    await expect(btn).toBeEnabled();
    await btn.click();

    for (const name of names) {
      const input = valueInput(page, inst, name);
      await expect(input).toHaveValue(expected[name]);
      // A seeded trio is min <= base = max, so the cross-field ordering
      // validator must stay quiet on every field the click moved -- seeding may
      // never produce a form the user cannot save.
      await expect(input).not.toHaveClass(/cbi-input-invalid/);
    }

    // Nothing was saved: the control writes into the form and stops there (no
    // rpcd write method, no ACL entry). A reload must bring the saved values
    // back, untouched.
    await gotoConfig(page, luci);
    for (const name of names)
      await expect(valueInput(page, inst, name)).toHaveValue(before[name]);
  });

  test('the control refuses, with a reason, until ul_if names an SQM egress', async ({ page, luci }) => {
    const egress = seedableEgress();
    expect(egress, `${SQM_FIXTURE} configures no seedable egress`).toBeTruthy();

    await gotoConfig(page, luci);

    // Clean slate if a prior failed run left the instance behind.
    if (await page.locator(`#cbi-cake-autorate-${INST}`).count()) {
      await deleteInstance(page, INST);
      await gotoConfig(page, luci);
    }
    await addInstance(page, INST);

    const btn = page.locator(`button.cake-seed-btn[data-cake-seed="${INST}"]`);
    const reason = page.locator(`.cake-seed-reason[data-cake-seed="${INST}"]`);

    // 1. A brand-new instance has no ul_if, and SQM keys its rates on the
    //    egress interface -- so there is nothing to look up. The control comes
    //    up refusing, and says why rather than leaving a dead button.
    await expect(btn).toBeDisabled();
    await expect(reason).toHaveAttribute('data-cake-seed-state', 'blocked');
    await expect(reason).toBeVisible();
    await expect(reason).not.toBeEmpty();

    // 2. Picking a real SQM egress enables it without a reload: the ul_if
    //    widget's onchange is what re-decides this.
    await setCombo(page, INST, 'ul_if', egress);
    await expect(reason).toHaveAttribute('data-cake-seed-state', 'ready');
    await expect(btn).toBeEnabled();

    // 3. An interface SQM knows nothing about takes it straight back to
    //    refusing, and the reason names the interface that has no rates behind
    //    it -- the evidence, not a generic "invalid".
    await setCombo(page, INST, 'ul_if', 'nosqm0');
    await expect(reason).toHaveAttribute('data-cake-seed-state', 'blocked');
    await expect(btn).toBeDisabled();
    await expect(reason).toContainText('nosqm0');

    // Leave the VM as we found it (the section was staged by the Add control).
    await deleteInstance(page, INST);
    await gotoConfig(page, luci);
    await expect(page.locator(`#cbi-cake-autorate-${INST}`)).toHaveCount(0);
  });
});

test.describe('cake-autorate config: clipping notice', () => {
  test('renders one notice per instance, with a verdict or a stated reason', async ({ page, luci }, testInfo) => {
    await gotoConfig(page, luci);

    const sids = await seedControls(page)
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-cake-seed')));
    expect(sids.length,
      'the VM fixture must configure at least one instance').toBeGreaterThan(0);

    for (const sid of sids) {
      // Appended to that section's Essentials pane, beside the rates it is about.
      const notice = page.locator(
        `#cbi-cake-autorate-${sid} .cake-calibration[data-cake-calibration="${sid}"]`);
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute('data-level', /^(ok|warn|info)$/);

      const summary = notice.locator('.cake-calibration-summary');
      await expect(summary).toBeVisible();
      await expect(summary).not.toBeEmpty();

      const available = await notice.getAttribute('data-available');
      const reason = await notice.getAttribute('data-reason');
      // Recorded on the run so the report says which state the VM was in
      // rather than leaving the branch below invisible.
      testInfo.annotations.push({
        type: 'calibration',
        description: `${sid}: available=${available} reason=${reason}`,
      });

      if (available === '1') {
        // Statistics existed: one verdict line per direction, each carrying a
        // verdict and level the notice knows how to render.
        expect(reason, `${sid}: an available diagnosis carries no reason`).toBeNull();
        for (const dir of ['dl', 'ul']) {
          const line = notice.locator(`.cake-calibration-dir[data-direction="${dir}"]`);
          await expect(line).toHaveAttribute(
            'data-verdict', /^(pinned-max|floored-min|ok|insufficient-data)$/);
          await expect(line).toHaveAttribute('data-level', /^(ok|warn|info)$/);
          await expect(line).not.toBeEmpty();
        }
      }
      else {
        // The fresh-VM path: no statistics have accumulated yet. It must say so
        // -- an empty node, or the 'error' reason that means the ubus call
        // failed, is a defect in the wiring, not a fresh install.
        expect(available, `${sid}: data-available must be "0" or "1"`).toBe('0');
        expect(NOT_YET_REASONS,
          `${sid}: notice unavailable for reason "${reason}"`).toContain(reason);
        await expect(notice.locator('.cake-calibration-dir')).toHaveCount(0);
      }
    }
  });
});
