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

/* ---- setupState (the "what do I do next" checklist) --------------------- */
/*
 * The precondition ladder, in the order a user climbs it. Every rung is someone
 * else's setup (sqm-scripts), and an unmet rung is silent at the daemon level --
 * upstream parks in verify_ifs_up() and reports nothing -- so this decision is
 * the only thing standing between a user and a blank status page.
 */
const SQM_READY = {
	sqm_config_present: true,
	sqm_service_enabled: true,
	cake_devices: ['eth1', 'ifb4eth1'],
	egress_choices: ['eth1'],
	ingress_choices: ['ifb4eth1'],
	interfaces: [{
		egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
		ifb_present: true, mismatch: false, egress_cake: true, ingress_cake: true
	}]
};

test('setupState: no SQM config at all -> error, nothing done', function () {
	const s = mod.setupState({});
	assert.strictEqual(s.ok, false);
	assert.strictEqual(s.level, 'error');
	assert.ok(/no CAKE qdisc/i.test(s.title));
	assert.strictEqual(s.steps.filter(function (x) { return x.done; }).length, 0);
	assert.ok(s.steps.length >= 4, 'gives the user an ordered list to follow');
});

test('setupState: garbage / missing response degrades to the error path', function () {
	assert.strictEqual(mod.setupState(null).ok, false);
	assert.strictEqual(mod.setupState(undefined).level, 'error');
});

test('setupState: SQM configured but every queue disabled -> error', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: true, cake_devices: [],
		interfaces: [{ egress: 'eth1', sqm_enabled: false, mismatch: false }]
	});
	assert.strictEqual(s.ok, false);
	assert.ok(/every queue is disabled/i.test(s.title));
	assert.strictEqual(s.steps[0].done, true, 'the "configure SQM" step is satisfied');
	assert.strictEqual(s.steps[1].done, false, 'the "enable the queue" step is not');
});

test('setupState: queue enabled but service disabled -> error naming the service', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: false, cake_devices: [],
		interfaces: [{ egress: 'eth1', sqm_enabled: true, mismatch: false }]
	});
	assert.strictEqual(s.ok, false);
	assert.ok(/service is not enabled/i.test(s.title));
});

/*
 * The trap this check exists for: SQM is configured, enabled and running, but
 * with fq_codel. Every name-based check passes and there is still no CAKE qdisc
 * to adjust, so only cake_devices can catch it.
 */
test('setupState: SQM running with a non-cake qdisc -> error, not ok', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: true, cake_devices: [],
		interfaces: [{
			egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
			ifb_present: true, mismatch: false, egress_cake: false, ingress_cake: false
		}]
	});
	assert.strictEqual(s.ok, false);
	assert.ok(/cake.*not fq_codel/i.test(s.title), 'names the actual mistake');
});

test('setupState: enabled egress whose ifb was never created -> warn', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: true, cake_devices: ['eth1'],
		interfaces: [{
			egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
			ifb_present: false, mismatch: true, egress_cake: true, ingress_cake: false
		}]
	});
	assert.strictEqual(s.ok, false);
	assert.strictEqual(s.level, 'warn');
	assert.ok(/eth1/.test(s.title));
});

test('setupState: fully set up -> ok, every step done, no banner', function () {
	const s = mod.setupState(SQM_READY);
	assert.strictEqual(s.ok, true);
	assert.strictEqual(s.level, 'ok');
	assert.ok(/ifb4eth1/.test(s.title), 'names the shaped devices');
	assert.strictEqual(s.steps.filter(function (x) { return !x.done; }).length, 0);
});

/*
 * The regression this guards: tc missing from rpcd's PATH makes cake_devices
 * empty for a reason that has nothing to do with the user's SQM setup. Reporting
 * "no CAKE qdisc" then would be a confident lie about a working router.
 */
test('setupState: tc unavailable -> falls back to device evidence, does not cry wolf', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: true,
		tc_available: false, cake_devices: [],
		interfaces: [{
			egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
			ifb_present: true, mismatch: false
		}]
	});
	assert.strictEqual(s.ok, true, 'a live ifb device is enough evidence when we cannot probe');
	assert.ok(/could not be verified/i.test(s.title), 'says the qdisc check did not run');
});

test('setupState: tc unavailable AND no ifb device -> still an error', function () {
	const s = mod.setupState({
		sqm_config_present: true, sqm_service_enabled: true,
		tc_available: false, cake_devices: [],
		interfaces: [{
			egress: 'eth1', ingress_ifb: 'ifb4eth1', sqm_enabled: true,
			ifb_present: false, mismatch: true
		}]
	});
	assert.strictEqual(s.ok, false);
});

test('setupState: always offers a link to the SQM page', function () {
	assert.strictEqual(mod.setupState({}).link, mod.SQM_PAGE);
	assert.ok(/sqm/.test(mod.SQM_PAGE));
});

/* ---- the parked-daemon fields the status view renders ------------------- */
test('statusRow: no-interface carries reason, missing_ifs and the interfaces', function () {
	const r = mod.statusRow('primary', {
		available: false, running: true, reason: 'no-interface',
		missing_ifs: 'ifb-wan wan', dl_if: 'ifb-wan', ul_if: 'wan', uptime_s: 480
	});
	assert.strictEqual(r.reason, 'no-interface');
	assert.strictEqual(r.missing_ifs, 'ifb-wan wan');
	assert.strictEqual(r.dl_if, 'ifb-wan');
	assert.strictEqual(r.running, true);
	assert.strictEqual(r.uptime_s, 480);
});

test('statusRow: dl_if/ul_if survive on an available row too', function () {
	const r = mod.statusRow('primary', {
		available: true, running: true, dl_if: 'ifb4eth1', ul_if: 'eth1',
		cake_dl_rate_kbps: 45000
	});
	assert.strictEqual(r.dl_if, 'ifb4eth1');
	assert.strictEqual(r.ul_if, 'eth1');
	assert.strictEqual(r.reason, null);
});

console.log('\n' + passed + ' tests passed');
