#!/usr/bin/env node
'use strict';

/*
 * Unit tests for the logic we wrote in
 *   htdocs/luci-static/resources/cake-autorate/live.js
 *
 * live.js holds the pure helpers shared by the status view
 * (view/cake-autorate/status.js) and the SQM interface checks in overview.js.
 * The parts worth testing are the ones that make decisions:
 *   - statusRow()/statusRows(): turning the rpcd `status` JSON into rows,
 *     including the available:false ("no data yet" / "stopped") path.
 *   - formatUptime(): seconds -> human string.
 *   - interfaceChoices(): pulling dl/ul choice lists out of `sqm_interfaces`.
 *   - interfaceStatus(): the decision behind the dl_if/ul_if warning, i.e.
 *     whether the chosen interface really has the qdisc SQM built.
 *   - seedRates(): the min/base/max arithmetic behind "Seed rates from SQM",
 *     including every case in which it refuses to seed a direction.
 *   - seedPlan(): whether that control may run at all, and the specific reason
 *     shown when it refuses.
 *   - calibrationReport(): the clipping notice's level, wording and the UCI
 *     field it names, from one `calibration` response.
 *
 * Not tested here: the poll.add/rpc.declare wiring, the DOM table build, the
 * CBI combobox declaration, and the seed's writes into the form widgets. Those
 * are LuCI framework glue, covered end to end by the Playwright and VM suites.
 *
 * live.js is a LuCI class file (it returns baseclass.extend(...)), so we load
 * the shipped source with a stub `baseclass` whose extend() hands back the
 * plain object. Same trick as options-coverage.test.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const modPath = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'cake-autorate', 'live.js');

function loadModule() {
	const src = fs.readFileSync(modPath, 'utf8');
	const stubBase = { extend: function (o) { return o; } };
	// eslint-disable-next-line no-new-func
	const factory = new Function('window', 'document', 'L', 'baseclass', src);
	return factory(undefined, undefined, undefined, stubBase);
}

let passed = 0;
function test(name, fn) {
	fn();
	passed++;
	console.log('ok - ' + name);
}

const mod = loadModule();

/* ---- formatUptime -------------------------------------------------------- */
test('formatUptime: null / non-finite -> em dash', function () {
	assert.strictEqual(mod.formatUptime(null), '—');
	assert.strictEqual(mod.formatUptime(undefined), '—');
	assert.strictEqual(mod.formatUptime(NaN), '—');
	assert.strictEqual(mod.formatUptime('nope'), '—');
});

test('formatUptime: sub-minute, minutes, hours, days', function () {
	assert.strictEqual(mod.formatUptime(0), '0s');
	assert.strictEqual(mod.formatUptime(45), '45s');
	assert.strictEqual(mod.formatUptime(125), '2m 05s');
	assert.strictEqual(mod.formatUptime(3 * 3600 + 4 * 60 + 9), '3h 04m');
	assert.strictEqual(mod.formatUptime(2 * 86400 + 3 * 3600 + 30), '2d 03h');
});

/* ---- statusRow / statusRows --------------------------------------------- */
test('statusRow: available instance normalizes all summary fields', function () {
	const r = mod.statusRow('wan', {
		available: true, running: true, uptime_s: 90,
		dl_achieved_kbps: 12000, ul_achieved_kbps: 3400,
		dl_sum_delays: 2, ul_sum_delays: 0,
		dl_avg_owd_delta_us: 150, ul_avg_owd_delta_us: 80,
		dl_load_condition: 'dl_high', ul_load_condition: 'ul_low',
		cake_dl_rate_kbps: 20000, cake_ul_rate_kbps: 5000,
		datetime: '2026-07-23T12:00:00', epoch: 1753272000
	});
	assert.strictEqual(r.instance, 'wan');
	assert.strictEqual(r.available, true);
	assert.strictEqual(r.running, true);
	assert.strictEqual(r.reason, null);
	assert.strictEqual(r.uptime_s, 90);
	assert.strictEqual(r.cake_dl_rate_kbps, 20000);
	assert.strictEqual(r.dl_achieved_kbps, 12000);
	assert.strictEqual(r.dl_load_condition, 'dl_high');
	assert.strictEqual(r.ul_avg_owd_delta_us, 80);
	assert.strictEqual(r.datetime, '2026-07-23T12:00:00');
	assert.strictEqual(r.epoch, 1753272000);
});

test('statusRow: available:false keeps run state, carries reason, nulls metrics', function () {
	const r = mod.statusRow('wan', { available: false, reason: 'no-data', running: true, uptime_s: 5 });
	assert.strictEqual(r.available, false);
	assert.strictEqual(r.reason, 'no-data');
	assert.strictEqual(r.running, true);
	assert.strictEqual(r.uptime_s, 5);
	assert.strictEqual(r.cake_dl_rate_kbps, null);
	assert.strictEqual(r.dl_load_condition, null);
});

test('statusRow: stopped instance (not running, no log)', function () {
	const r = mod.statusRow('wan', { available: false, reason: 'no-log', running: false });
	assert.strictEqual(r.running, false);
	assert.strictEqual(r.reason, 'no-log');
	assert.strictEqual(r.uptime_s, null);
});

test('statusRow: missing/garbage status object degrades safely', function () {
	const r = mod.statusRow('wan', undefined);
	assert.strictEqual(r.instance, 'wan');
	assert.strictEqual(r.available, false);
	assert.strictEqual(r.running, false);
});

test('statusRows: keys sorted, one row each', function () {
	const rows = mod.statusRows({
		wan2: { available: false, reason: 'no-log', running: false },
		wan: { available: true, running: true, cake_dl_rate_kbps: 1 }
	});
	assert.strictEqual(rows.length, 2);
	assert.deepStrictEqual(rows.map(function (r) { return r.instance; }), ['wan', 'wan2']);
});

test('statusRows: empty / missing response -> []', function () {
	assert.deepStrictEqual(mod.statusRows({}), []);
	assert.deepStrictEqual(mod.statusRows(null), []);
});

/* ---- interfaceChoices ---------------------------------------------------- */
test('interfaceChoices: dl from ingress_choices, ul from egress_choices', function () {
	const c = mod.interfaceChoices({
		ingress_choices: ['ifb4eth1', 'ifb4wan'],
		egress_choices: ['eth1', 'wan']
	});
	assert.deepStrictEqual(c.dl, ['ifb4eth1', 'ifb4wan']);
	assert.deepStrictEqual(c.ul, ['eth1', 'wan']);
});

test('interfaceChoices: missing arrays -> empty lists', function () {
	assert.deepStrictEqual(mod.interfaceChoices({}), { dl: [], ul: [] });
	assert.deepStrictEqual(mod.interfaceChoices(null), { dl: [], ul: [] });
});

/* ---- interfaceStatus ---------------------------------------------------- */
const SQM = {
	sqm_config_present: true,
	egress_choices: ['eth1'],
	ingress_choices: ['ifb4eth1'],
	interfaces: [{ egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true, ifb_present: true, mismatch: false }]
};

test('interfaceStatus: empty value -> none (no warning)', function () {
	assert.strictEqual(mod.interfaceStatus('', SQM, 'ul').level, 'none');
	assert.strictEqual(mod.interfaceStatus(null, SQM, 'dl').level, 'none');
});

test('interfaceStatus: SQM not configured -> info, never warn (do not hard-block)', function () {
	const s = mod.interfaceStatus('eth1', { sqm_config_present: false }, 'ul');
	assert.strictEqual(s.level, 'info');
});

test('interfaceStatus: ul value backed by an SQM egress qdisc -> ok', function () {
	assert.strictEqual(mod.interfaceStatus('eth1', SQM, 'ul').level, 'ok');
});

test('interfaceStatus: ul value NOT among egress choices -> warn', function () {
	const s = mod.interfaceStatus('eth9', SQM, 'ul');
	assert.strictEqual(s.level, 'warn');
	assert.ok(/eth1/.test(s.message), 'lists the valid choices');
});

test('interfaceStatus: ul egress present but its ingress IFB missing (mismatch) -> warn', function () {
	const sqm = {
		sqm_config_present: true,
		egress_choices: ['eth1'],
		ingress_choices: [],
		interfaces: [{ egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true, ifb_present: false, mismatch: true }]
	};
	const s = mod.interfaceStatus('eth1', sqm, 'ul');
	assert.strictEqual(s.level, 'warn');
	assert.ok(/ifb4eth1/.test(s.message));
});

test('interfaceStatus: dl value backed by a live IFB device -> ok', function () {
	assert.strictEqual(mod.interfaceStatus('ifb4eth1', SQM, 'dl').level, 'ok');
});

test('interfaceStatus: dl value with no live IFB device -> warn', function () {
	const s = mod.interfaceStatus('ifb4eth9', SQM, 'dl');
	assert.strictEqual(s.level, 'warn');
	assert.ok(/ifb4eth1/.test(s.message), 'lists the valid ingress choices');
});

/* ---- seedRates ----------------------------------------------------------- */
const SQM_RATES = {
	sqm_config_present: true,
	egress_choices: ['eth1'],
	ingress_choices: ['ifb4eth1'],
	interfaces: [{
		egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
		ifb_present: true, mismatch: false,
		download_kbps: 90000, upload_kbps: 11000
	}]
};

test('seedRates: normal rates -> base=max=SQM rate, min=rate/4, per direction', function () {
	const s = mod.seedRates(SQM_RATES, 'eth1');
	/* dl comes from download_kbps, ul from upload_kbps -- never transposed. */
	assert.deepStrictEqual(s.dl, { min: 22500, base: 90000, max: 90000 });
	assert.deepStrictEqual(s.ul, { min: 2750, base: 11000, max: 11000 });
});

test('seedRates: 0 in one direction only -> that direction null, the other still seeded', function () {
	/* sqm-scripts' "no limit" sentinel. The usable direction must survive it. */
	const s = mod.seedRates({
		interfaces: [{ egress: 'eth1', download_kbps: 90000, upload_kbps: 0 }]
	}, 'eth1');
	assert.deepStrictEqual(s.dl, { min: 22500, base: 90000, max: 90000 });
	assert.strictEqual(s.ul, null);

	/* ...and the mirror case, to prove the two are genuinely independent. */
	const t = mod.seedRates({
		interfaces: [{ egress: 'eth1', download_kbps: 0, upload_kbps: 11000 }]
	}, 'eth1');
	assert.strictEqual(t.dl, null);
	assert.deepStrictEqual(t.ul, { min: 2750, base: 11000, max: 11000 });
});

test('seedRates: min floors -- an indivisible-by-four rate never yields a fraction', function () {
	const s = mod.seedRates({
		interfaces: [{ egress: 'eth1', download_kbps: 4999, upload_kbps: 4999 }]
	}, 'eth1');
	assert.deepStrictEqual(s.dl, { min: 1249, base: 4999, max: 4999 });
	assert.deepStrictEqual(s.ul, { min: 1249, base: 4999, max: 4999 });
});

test('seedRates: no interface matches egressIface -> both directions null', function () {
	assert.deepStrictEqual(mod.seedRates(SQM_RATES, 'eth9'), { dl: null, ul: null });
	assert.deepStrictEqual(mod.seedRates(SQM_RATES, ''), { dl: null, ul: null });
	assert.deepStrictEqual(mod.seedRates(SQM_RATES, undefined), { dl: null, ul: null });
});

test('seedRates: empty / missing sqm object -> both directions null', function () {
	assert.deepStrictEqual(mod.seedRates({}, 'eth1'), { dl: null, ul: null });
	assert.deepStrictEqual(mod.seedRates({ interfaces: [] }, 'eth1'), { dl: null, ul: null });
	assert.deepStrictEqual(mod.seedRates(undefined, 'eth1'), { dl: null, ul: null });
	assert.deepStrictEqual(mod.seedRates(null, 'eth1'), { dl: null, ul: null });
});

test('seedRates: missing, negative or non-numeric rate -> that direction null', function () {
	const missing = mod.seedRates({ interfaces: [{ egress: 'eth1' }] }, 'eth1');
	assert.deepStrictEqual(missing, { dl: null, ul: null });

	const bad = mod.seedRates({
		interfaces: [{ egress: 'eth1', download_kbps: -90000, upload_kbps: 'lots' }]
	}, 'eth1');
	assert.deepStrictEqual(bad, { dl: null, ul: null });

	/* A fractional rate is refused, not rounded: cake-autorate's rates are
	 * integer Kbit/s and a decimal point is fatal upstream. */
	const frac = mod.seedRates({
		interfaces: [{ egress: 'eth1', download_kbps: 4999.5, upload_kbps: null }]
	}, 'eth1');
	assert.deepStrictEqual(frac, { dl: null, ul: null });
});

/* ---- seedPlan ------------------------------------------------------------
 * The decision BEHIND the "Seed rates from SQM" button: may it run, and what
 * does it tell the user either way. seedRates() answers "which numbers"; this
 * answers "and should the control be offered at all", which is the part the
 * acceptance criteria are written against (disabled with a SPECIFIC reason). */

test('seedPlan: no ul_if chosen yet -> blocked, and says to pick the interface', function () {
	const p = mod.seedPlan(SQM_RATES, '');
	assert.strictEqual(p.enabled, false);
	assert.strictEqual(p.reason, 'no-interface');
	assert.deepStrictEqual([p.dl, p.ul], [null, null]);
	assert.ok(/ul_if/.test(p.message), 'names the field to fill in first');

	assert.strictEqual(mod.seedPlan(SQM_RATES, null).reason, 'no-interface');
	assert.strictEqual(mod.seedPlan(SQM_RATES, undefined).reason, 'no-interface');
});

test('seedPlan: SQM not configured -> blocked, says so rather than blaming the interface', function () {
	const p = mod.seedPlan({ sqm_config_present: false }, 'eth1');
	assert.strictEqual(p.enabled, false);
	assert.strictEqual(p.reason, 'no-sqm');
	assert.ok(/SQM/.test(p.message));

	/* The rpc-failure fallback ({}) must not throw or claim a rate. */
	assert.strictEqual(mod.seedPlan({}, 'eth1').reason, 'no-sqm');
	assert.strictEqual(mod.seedPlan(null, 'eth1').reason, 'no-sqm');

	/* No SQM and no interface: the blocker reported is the one that has to be
	 * cleared, not the one checked first. Choosing an interface would change
	 * nothing while SQM holds no rates at all. */
	assert.strictEqual(mod.seedPlan({}, '').reason, 'no-sqm');
});

test('seedPlan: interface is not an SQM egress -> blocked, and lists the ones that are', function () {
	const p = mod.seedPlan(SQM_RATES, 'eth9');
	assert.strictEqual(p.enabled, false);
	assert.strictEqual(p.reason, 'no-section');
	assert.ok(/eth9/.test(p.message), 'names the offending value');
	assert.ok(/eth1/.test(p.message), 'lists the SQM egress interfaces');
});

test('seedPlan: matched section but both rates unusable -> blocked, explains the 0 sentinel', function () {
	const p = mod.seedPlan({
		sqm_config_present: true,
		egress_choices: ['eth1'],
		interfaces: [{ egress: 'eth1', download_kbps: 0, upload_kbps: 0 }]
	}, 'eth1');
	assert.strictEqual(p.enabled, false);
	assert.strictEqual(p.reason, 'no-rate');
	assert.deepStrictEqual([p.dl, p.ul], [null, null]);
	assert.ok(/no limit/i.test(p.message), 'explains what a 0 rate means in SQM');
});

test('seedPlan: both directions usable -> ready, with both trios and both rates named', function () {
	const p = mod.seedPlan(SQM_RATES, 'eth1');
	assert.strictEqual(p.enabled, true);
	assert.strictEqual(p.reason, 'ready');
	assert.deepStrictEqual(p.dl, { min: 22500, base: 90000, max: 90000 });
	assert.deepStrictEqual(p.ul, { min: 2750, base: 11000, max: 11000 });
	assert.ok(/90000/.test(p.message) && /11000/.test(p.message));
	assert.ok(/six/i.test(p.message), 'says all six fields are filled');
});

test('seedPlan: one usable direction -> still ready, and says the other three are left alone', function () {
	const dlOnly = mod.seedPlan({
		sqm_config_present: true,
		egress_choices: ['eth1'],
		interfaces: [{ egress: 'eth1', download_kbps: 90000, upload_kbps: 0 }]
	}, 'eth1');
	assert.strictEqual(dlOnly.enabled, true);
	assert.deepStrictEqual(dlOnly.dl, { min: 22500, base: 90000, max: 90000 });
	assert.strictEqual(dlOnly.ul, null);
	assert.ok(/upload/i.test(dlOnly.message) && /untouched/i.test(dlOnly.message));

	/* The mirror case: one null direction must never suppress the other. */
	const ulOnly = mod.seedPlan({
		sqm_config_present: true,
		egress_choices: ['eth1'],
		interfaces: [{ egress: 'eth1', download_kbps: 0, upload_kbps: 11000 }]
	}, 'eth1');
	assert.strictEqual(ulOnly.enabled, true);
	assert.strictEqual(ulOnly.dl, null);
	assert.deepStrictEqual(ulOnly.ul, { min: 2750, base: 11000, max: 11000 });
	assert.ok(/download/i.test(ulOnly.message) && /untouched/i.test(ulOnly.message));
});

test('seedPlan: every seeded trio satisfies checkRateOrder (the form can never reject it)', function () {
	/* The seed writes straight into the six widgets, so if the formula could
	 * produce min > base the user would be handed an error they did not cause. */
	const p = mod.seedPlan(SQM_RATES, 'eth1');
	[p.dl, p.ul].forEach(function (t) {
		assert.ok(t.min <= t.base, 'min <= base');
		assert.ok(t.base <= t.max, 'base <= max');
	});
});

/* ---- calibrationReport ---------------------------------------------------
 * The display-only clipping notice. Turns one `calibration` rpc response into
 * the level, the summary and the per-direction sentences the view renders. It
 * decides which UCI field to name and how loud to be -- so it is tested here,
 * while the DOM injection is left to the Playwright suite. */

const CALIB = {
	available: true, instance: 'primary', window_s: 604800, min_samples: 12,
	tolerance_fraction: 0.005, threshold_fraction: 0.9,
	dl: {
		samples: 21, pinned_max_fraction: 0.9048, floored_min_fraction: 0.0,
		verdict: 'pinned-max', configured_min: 5000, configured_max: 80000
	},
	ul: {
		samples: 20, pinned_max_fraction: 0.0, floored_min_fraction: 0.95,
		verdict: 'floored-min', configured_min: 5000, configured_max: 35000
	}
};

function dirOf(rep, dir) {
	return rep.directions.filter(function (d) { return d.dir === dir; })[0];
}

test('calibrationReport: rpc failure (null) -> unavailable, info, states it could not be read', function () {
	const r = mod.calibrationReport(null);
	assert.strictEqual(r.available, false);
	assert.strictEqual(r.level, 'info');
	assert.strictEqual(r.reason, 'error');
	assert.deepStrictEqual(r.directions, []);
	assert.ok(/could not be read/i.test(r.summary));
});

test('calibrationReport: each available:false reason gets its own plain sentence', function () {
	const seen = {};
	['no-rrdtool', 'no-rrd', 'no-data'].forEach(function (reason) {
		const r = mod.calibrationReport({ available: false, reason: reason, instance: 'primary' });
		assert.strictEqual(r.available, false);
		assert.strictEqual(r.level, 'info', 'a fresh install is not an error');
		assert.strictEqual(r.reason, reason);
		assert.deepStrictEqual(r.directions, []);
		assert.ok(r.summary.length > 0);
		assert.ok(!seen[r.summary], 'reason "' + reason + '" must not reuse another reason\'s wording');
		seen[r.summary] = true;
	});
	assert.ok(/rrdtool/i.test(mod.calibrationReport({ available: false, reason: 'no-rrdtool' }).summary));
});

test('calibrationReport: an unknown reason is reported verbatim, not swallowed', function () {
	const r = mod.calibrationReport({ available: false, reason: 'moon-phase' });
	assert.strictEqual(r.available, false);
	assert.strictEqual(r.reason, 'moon-phase');
	assert.ok(/moon-phase/.test(r.summary));
});

test('calibrationReport: pinned-max -> warn, names the max field and the evidence', function () {
	const r = mod.calibrationReport(CALIB);
	assert.strictEqual(r.available, true);
	assert.strictEqual(r.level, 'warn');
	const d = dirOf(r, 'dl');
	assert.strictEqual(d.verdict, 'pinned-max');
	assert.strictEqual(d.level, 'warn');
	assert.strictEqual(d.field, 'max_dl_shaper_rate_kbps');
	assert.ok(/90\.5%/.test(d.message), 'states the fraction of the window at the bound');
	assert.ok(/21 samples/.test(d.message), 'states the sample count');
	assert.ok(/7 days/.test(d.message), 'states the window covered');
	assert.ok(/80000/.test(d.message), 'states the configured bound it sat at');
});

test('calibrationReport: floored-min -> warn, names the min field', function () {
	const d = dirOf(mod.calibrationReport(CALIB), 'ul');
	assert.strictEqual(d.verdict, 'floored-min');
	assert.strictEqual(d.level, 'warn');
	assert.strictEqual(d.field, 'min_ul_shaper_rate_kbps');
	assert.ok(/95%/.test(d.message));
	assert.ok(/5000/.test(d.message));
});

test('calibrationReport: ok -> no field to change, and the report is not a warning', function () {
	const r = mod.calibrationReport(Object.assign({}, CALIB, {
		dl: Object.assign({}, CALIB.dl, { verdict: 'ok', pinned_max_fraction: 0.1 }),
		ul: Object.assign({}, CALIB.ul, { verdict: 'ok', floored_min_fraction: 0.1 })
	}));
	assert.strictEqual(r.level, 'ok');
	const d = dirOf(r, 'dl');
	assert.strictEqual(d.level, 'ok');
	assert.strictEqual(d.field, null);
	assert.ok(/21 samples/.test(d.message), 'still shows the evidence behind "ok"');
});

test('calibrationReport: too few samples -> info, names how many are still needed', function () {
	const r = mod.calibrationReport(Object.assign({}, CALIB, {
		dl: { samples: 3, pinned_max_fraction: 0, floored_min_fraction: 0,
			verdict: 'insufficient-data', configured_min: 5000, configured_max: 80000 },
		ul: { samples: 0, pinned_max_fraction: 0, floored_min_fraction: 0,
			verdict: 'insufficient-data', configured_min: 5000, configured_max: 35000 }
	}));
	assert.strictEqual(r.level, 'info');
	const d = dirOf(r, 'dl');
	assert.strictEqual(d.level, 'info');
	assert.strictEqual(d.field, null);
	assert.ok(/3/.test(d.message) && /12/.test(d.message), 'states what it has and what it needs');
});

test('calibrationReport: enough samples but no configured bound -> says THAT, not "not enough data"', function () {
	/* The backend emits verdict "insufficient-data" for both causes; conflating
	 * them in the UI would send the user to wait for statistics that would never
	 * change the answer. */
	const d = dirOf(mod.calibrationReport(Object.assign({}, CALIB, {
		dl: { samples: 400, pinned_max_fraction: 0, floored_min_fraction: 0,
			verdict: 'insufficient-data', configured_min: 0, configured_max: 0 }
	})), 'dl');
	assert.strictEqual(d.level, 'info');
	assert.ok(/min_dl_shaper_rate_kbps/.test(d.message) && /max_dl_shaper_rate_kbps/.test(d.message));
	assert.ok(!/samples/.test(d.message) || /no .*bound|neither/i.test(d.message),
		'the sentence must be about the missing bound, not the sample count');
});

test('calibrationReport: one clipped direction and one starved one -> warn overall, both reported', function () {
	/* available:true holds as soon as ONE direction has a sample; the other may
	 * still be empty. Neither may hide the other. */
	const r = mod.calibrationReport(Object.assign({}, CALIB, {
		ul: { samples: 0, pinned_max_fraction: 0, floored_min_fraction: 0,
			verdict: 'insufficient-data', configured_min: 0, configured_max: 0 }
	}));
	assert.strictEqual(r.level, 'warn');
	assert.strictEqual(r.directions.length, 2);
	assert.strictEqual(dirOf(r, 'dl').level, 'warn');
	assert.strictEqual(dirOf(r, 'ul').level, 'info');
});

test('calibrationReport: a truncated available:true payload degrades instead of throwing', function () {
	const r = mod.calibrationReport({ available: true, instance: 'primary' });
	assert.strictEqual(r.available, true);
	assert.strictEqual(r.directions.length, 2);
	r.directions.forEach(function (d) {
		assert.strictEqual(d.verdict, 'insufficient-data');
		assert.strictEqual(d.level, 'info');
		assert.ok(d.message.length > 0);
	});
	assert.ok(/window/i.test(r.summary), 'falls back to naming the window generically');
});

console.log('\n' + passed + ' tests passed');
