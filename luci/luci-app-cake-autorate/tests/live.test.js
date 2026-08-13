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
 *
 * Not tested here: the poll.add/rpc.declare wiring, the DOM table build and the
 * CBI combobox declaration. Those are LuCI framework glue, covered end to end
 * by the Playwright and VM suites.
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

/* ---- sampleAgeSuffix ------------------------------------------------------
 * The daemon writes a SUMMARY per ping response, but it sleeps through an idle
 * link and stops writing altogether, and rpcd keeps serving the last sample it
 * wrote. The suffix is how a frozen table admits it is frozen. */
test('sampleAgeSuffix: silent while the feed is live', function () {
	assert.strictEqual(mod.sampleAgeSuffix(0), '');
	assert.strictEqual(mod.sampleAgeSuffix(3), '');
	assert.strictEqual(mod.sampleAgeSuffix(mod.STALE_AFTER_S - 1), '');
});

test('sampleAgeSuffix: reports the age once the feed goes quiet', function () {
	assert.strictEqual(mod.sampleAgeSuffix(mod.STALE_AFTER_S), ' (15s ago)');
	assert.strictEqual(mod.sampleAgeSuffix(125), ' (2m 05s ago)');
	assert.strictEqual(mod.sampleAgeSuffix(3 * 3600 + 4 * 60), ' (3h 04m ago)');
	assert.strictEqual(mod.sampleAgeSuffix('600'), ' (10m 00s ago)');
});

test('sampleAgeSuffix: no age from the backend -> no suffix', function () {
	assert.strictEqual(mod.sampleAgeSuffix(null), '');
	assert.strictEqual(mod.sampleAgeSuffix(undefined), '');
	assert.strictEqual(mod.sampleAgeSuffix('nonsense'), '');
});

/* ---- loadCondition --------------------------------------------------------
 * The raw token is "<dir>_<level>" with an optional "_bb" bufferbloat suffix.
 * The view turns { key, bb } into a label + badge colour, so getting the split
 * wrong silently mislabels the one state a user is watching for. */
test('loadCondition: the three levels, either direction', function () {
	assert.deepStrictEqual(mod.loadCondition('dl_idle'), { key: 'idle', bb: false, raw: 'dl_idle' });
	assert.deepStrictEqual(mod.loadCondition('ul_low'), { key: 'low', bb: false, raw: 'ul_low' });
	assert.deepStrictEqual(mod.loadCondition('dl_high'), { key: 'high', bb: false, raw: 'dl_high' });
});

test('loadCondition: the _bb suffix flags bufferbloat, level survives', function () {
	assert.deepStrictEqual(mod.loadCondition('dl_high_bb'), { key: 'high', bb: true, raw: 'dl_high_bb' });
	assert.deepStrictEqual(mod.loadCondition('ul_idle_bb'), { key: 'idle', bb: true, raw: 'ul_idle_bb' });
	assert.deepStrictEqual(mod.loadCondition('UL_LOW_BB'), { key: 'low', bb: true, raw: 'UL_LOW_BB' });
});

test('loadCondition: missing token -> nothing to show', function () {
	assert.deepStrictEqual(mod.loadCondition(null), { key: null, bb: false, raw: null });
	assert.deepStrictEqual(mod.loadCondition(''), { key: null, bb: false, raw: null });
	assert.deepStrictEqual(mod.loadCondition(undefined), { key: null, bb: false, raw: null });
});

test('loadCondition: an unknown level keeps raw so the view can show it', function () {
	const r = mod.loadCondition('dl_wat');
	assert.strictEqual(r.key, null);
	assert.strictEqual(r.bb, false);
	assert.strictEqual(r.raw, 'dl_wat');
	/* Unknown level, but the bufferbloat flag is still readable. */
	assert.deepStrictEqual(mod.loadCondition('dl_wat_bb'), { key: null, bb: true, raw: 'dl_wat_bb' });
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
		datetime: '2026-07-23T12:00:00', epoch: 1753272000, age_s: 42
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
	assert.strictEqual(r.age_s, 42);
});

test('statusRow: an old backend that sends no age_s leaves the field null', function () {
	const r = mod.statusRow('wan', { available: true, running: true, cake_dl_rate_kbps: 1 });
	assert.strictEqual(r.age_s, null);
	assert.strictEqual(mod.sampleAgeSuffix(r.age_s), '');
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

console.log('\n' + passed + ' tests passed');
