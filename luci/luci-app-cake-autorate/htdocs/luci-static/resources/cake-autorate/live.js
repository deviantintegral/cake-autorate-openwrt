'use strict';
'require baseclass';

/*
 * Pure helpers for live status and interface validation, shared by:
 *   - view/cake-autorate/status.js   -- the polling status view.
 *   - view/cake-autorate/overview.js -- the SQM-validated dl_if / ul_if pickers.
 *
 * Keep this file free of LuCI runtime calls (no _(), no L.*, no rpc/poll) at
 * module scope so the decision logic can be unit-tested under plain node (see
 * tests/live.test.js). The views own all rpc.declare / poll.add / DOM wiring and
 * wrap any user-facing string in _() themselves.
 *
 * rpcd methods used (object "cake-autorate"):
 *   status {instance?} -> { "<inst>": {available, running, uptime_s?, reason?,
 *       dl_achieved_kbps, ul_achieved_kbps, dl_sum_delays, ul_sum_delays,
 *       dl_avg_owd_delta_us, ul_avg_owd_delta_us, dl_load_condition,
 *       ul_load_condition, cake_dl_rate_kbps, cake_ul_rate_kbps, datetime,
 *       epoch, dl_if, ul_if }, ... }   (available:false carries reason:
 *       no-log | no-data | no-interface; no-interface also carries missing_ifs)
 *   sqm_interfaces {}  -> { sqm_config_present, sqm_service_enabled,
 *       interfaces:[{egress, ingress_ifb, sqm_enabled, ifb_present, mismatch,
 *       egress_cake, ingress_cake}], egress_choices, ingress_choices,
 *       ifb_devices, cake_devices }.
 *       dl_if <- ingress (ifb) choices; ul_if <- egress choices.
 */

/* Numeric summary fields, normalized to a JS number or null. */
var NUM_FIELDS = [
	'uptime_s', 'epoch',
	'dl_achieved_kbps', 'ul_achieved_kbps',
	'dl_sum_delays', 'ul_sum_delays',
	'dl_avg_owd_delta_us', 'ul_avg_owd_delta_us',
	'cake_dl_rate_kbps', 'cake_ul_rate_kbps'
];

/*
 * String summary fields, normalized to a non-empty string or null.
 *
 * dl_if / ul_if / missing_ifs are carried on the row in BOTH the available and
 * unavailable cases: they are what the view names when it has to explain why an
 * instance that looks "running" is producing nothing.
 */
var STR_FIELDS = [
	'dl_load_condition', 'ul_load_condition', 'datetime', 'reason',
	'dl_if', 'ul_if', 'missing_ifs'
];

/*
 * STATUS_FIELDS -- the DL/UL metric rows the status table renders, in order.
 * Each entry drives two value cells (download + upload). The view marks both
 * data-live="1" and sets data-field to the dl/ul key, which is what the visual
 * suite masks and the functional suite asserts on.
 */
var STATUS_FIELDS = [
	{ label: 'CAKE shaper rate', unit: 'Kbit/s', dl: 'cake_dl_rate_kbps', ul: 'cake_ul_rate_kbps' },
	{ label: 'Achieved rate', unit: 'Kbit/s', dl: 'dl_achieved_kbps', ul: 'ul_achieved_kbps' },
	{ label: 'Load condition', unit: '', dl: 'dl_load_condition', ul: 'ul_load_condition' },
	{ label: 'Avg OWD delta', unit: 'µs', dl: 'dl_avg_owd_delta_us', ul: 'ul_avg_owd_delta_us' },
	{ label: 'Sum delays', unit: '', dl: 'dl_sum_delays', ul: 'ul_sum_delays' }
];

function toNum(v) {
	if (typeof v === 'number' && isFinite(v))
		return v;
	if (typeof v === 'string' && v !== '' && isFinite(Number(v)))
		return Number(v);
	return null;
}

function toStr(v) {
	if (v == null)
		return null;
	var s = String(v);
	return s === '' ? null : s;
}

function pad2(n) {
	n = Math.floor(n);
	return (n < 10 ? '0' : '') + n;
}

/*
 * formatUptime(s) -- seconds -> short human string; anything non-finite gives
 * an em dash. Only the two largest units are shown (days show d+h, hours h+m).
 */
function formatUptime(s) {
	var n = toNum(s);
	if (n == null || n < 0)
		return '—';
	n = Math.floor(n);
	var d = Math.floor(n / 86400);
	var h = Math.floor((n % 86400) / 3600);
	var m = Math.floor((n % 3600) / 60);
	var sec = n % 60;
	if (d > 0)
		return d + 'd ' + pad2(h) + 'h';
	if (h > 0)
		return h + 'h ' + pad2(m) + 'm';
	if (m > 0)
		return m + 'm ' + pad2(sec) + 's';
	return sec + 's';
}

/*
 * statusRow(instance, st) -- turn one instance's status object into a row the
 * view can render. Missing or garbage input becomes an unavailable, stopped
 * row. When available is false the metric fields are null (the view shows
 * "no data yet" / "stopped") but run state and reason are kept.
 */
function statusRow(instance, st) {
	st = (st && typeof st === 'object') ? st : {};
	var available = st.available === true;
	var row = {
		instance: instance,
		available: available,
		running: st.running === true
	};
	NUM_FIELDS.forEach(function (k) {
		row[k] = available ? toNum(st[k]) : (k === 'uptime_s' || k === 'epoch' ? toNum(st[k]) : null);
	});
	STR_FIELDS.forEach(function (k) {
		row[k] = available ? (k === 'reason' ? null : toStr(st[k])) : toStr(st[k]);
	});
	/* reason is only meaningful when unavailable. */
	if (available)
		row.reason = null;
	return row;
}

/*
 * statusRows(resp) -- the whole `status` response -> one row per instance key,
 * sorted by name. Empty or non-object input gives [].
 */
function statusRows(resp) {
	if (!resp || typeof resp !== 'object')
		return [];
	return Object.keys(resp).sort().map(function (k) {
		return statusRow(k, resp[k]);
	});
}

/*
 * interfaceChoices(sqm) -- pull the two validated choice lists out of a
 * sqm_interfaces response: dl <- ingress (ifb) devices, ul <- egress devices.
 */
function interfaceChoices(sqm) {
	sqm = (sqm && typeof sqm === 'object') ? sqm : {};
	return {
		dl: Array.isArray(sqm.ingress_choices) ? sqm.ingress_choices.slice() : [],
		ul: Array.isArray(sqm.egress_choices) ? sqm.egress_choices.slice() : []
	};
}

/*
 * interfaceStatus(value, sqm, direction) -- decides the dl_if / ul_if warning.
 * direction is 'dl' (ingress ifb) or 'ul' (egress). Returns { level, message }:
 *   'none' -- empty value, nothing to say.
 *   'info' -- SQM is not configured yet, so we cannot check. Never blocks.
 *   'ok'   -- the value is backed by a live SQM qdisc.
 *   'warn' -- no SQM qdisc backs it, or (ul) its ingress IFB is missing. Shown
 *             to the user but never blocks the save.
 * Messages are plain strings; the view wraps them for display.
 */
function interfaceStatus(value, sqm, direction) {
	sqm = (sqm && typeof sqm === 'object') ? sqm : {};
	value = (value == null) ? '' : String(value);
	if (value === '')
		return { level: 'none', message: '' };

	if (!sqm.sqm_config_present)
		return {
			level: 'info',
			message: 'SQM is not configured yet, so "' + value + '" cannot be checked against a live CAKE qdisc. Configure SQM first, then re-check.'
		};

	var choices = interfaceChoices(sqm);

	if (direction === 'ul') {
		if (choices.ul.indexOf(value) === -1)
			return {
				level: 'warn',
				message: '"' + value + '" is not an SQM egress interface, so no upload CAKE qdisc is attached to it and CAKE Autorate cannot shape it. SQM egress interfaces: ' + (choices.ul.join(', ') || '(none)') + '.'
			};
		var obj = (Array.isArray(sqm.interfaces) ? sqm.interfaces : []).filter(function (o) {
			return o && o.egress === value;
		})[0];
		if (obj && obj.mismatch)
			return {
				level: 'warn',
				message: 'SQM is enabled on "' + value + '" but its ingress IFB device (' + obj.ingress_ifb + ') is not present, so download shaping will not work until SQM has created it.'
			};
		return { level: 'ok', message: 'Backed by the live SQM egress CAKE qdisc on "' + value + '".' };
	}

	/* direction 'dl' -- ingress ifb device. */
	if (choices.dl.indexOf(value) === -1)
		return {
			level: 'warn',
			message: '"' + value + '" is not a live SQM ingress IFB device, so no download CAKE qdisc is attached to it and CAKE Autorate cannot shape download. Ingress IFB devices: ' + (choices.dl.join(', ') || '(none)') + '.'
		};
	return { level: 'ok', message: 'Backed by the live SQM ingress IFB device "' + value + '".' };
}

/*
 * setupState(sqm) -- the "what do I do next" checklist, derived from one
 * sqm_interfaces response.
 *
 * cake-autorate does not create a qdisc; it only moves the bandwidth of a CAKE
 * qdisc sqm-scripts already attached. Every precondition below is therefore
 * SOMEONE ELSE's setup, and the failure mode when one is unmet is silent: the
 * daemon starts, blocks in upstream's verify_ifs_up() waiting for an interface
 * that will never exist, and reports nothing. This turns that into a visible,
 * ordered list of the remaining steps.
 *
 * Returns { ok, level, title, steps: [{done, text}], link }, where level is
 * 'ok' | 'warn' | 'error' and every step is phrased as an action.
 */
var SQM_PAGE = 'admin/network/sqm';

function setupState(sqm) {
	sqm = (sqm && typeof sqm === 'object') ? sqm : {};

	var configured = sqm.sqm_config_present === true;
	var enabled = sqm.sqm_service_enabled === true;
	var ifaces = Array.isArray(sqm.interfaces) ? sqm.interfaces : [];
	var cake = Array.isArray(sqm.cake_devices) ? sqm.cake_devices : [];
	var queues = ifaces.filter(function (o) { return o && o.sqm_enabled === true; });
	/* tc_available:false means the qdisc probe could not run (tc missing from
	 * rpcd's PATH), NOT that there is no CAKE qdisc. Treating the two the same
	 * would tell a user with a working SQM setup that it is broken, so when we
	 * cannot look we fall back to the device-existence evidence instead. */
	var probed = sqm.tc_available !== false;
	var shaped = probed
		? cake.length > 0
		: queues.some(function (o) { return o.ifb_present === true; });

	var steps = [
		{ done: configured,
		  text: 'Configure SQM on your WAN interface (Network -> SQM QoS), with the queue discipline set to "cake".' },
		{ done: configured && queues.length > 0,
		  text: 'Enable that SQM queue.' },
		{ done: enabled,
		  text: 'Enable the SQM service so it starts at boot, then start it.' },
		{ done: shaped,
		  text: 'Confirm a CAKE qdisc is attached (tc qdisc show | grep cake) -- this creates the ifb4* ingress device.' },
		{ done: shaped,
		  text: 'Set this instance\'s download interface to the ifb4* device and its upload interface to the SQM egress device, then start CAKE Autorate.' }
	];

	if (!configured)
		return {
			ok: false, level: 'error', link: SQM_PAGE, steps: steps,
			title: 'SQM is not set up on this router, so there is no CAKE qdisc for CAKE Autorate to adjust.'
		};

	if (queues.length === 0)
		return {
			ok: false, level: 'error', link: SQM_PAGE, steps: steps,
			title: 'SQM is configured but every queue is disabled, so no CAKE qdisc is attached.'
		};

	if (!shaped)
		return {
			ok: false, level: 'error', link: SQM_PAGE, steps: steps,
			title: enabled
				? 'SQM is configured and enabled but no CAKE qdisc is attached yet. Check that the queue discipline is "cake" (not fq_codel) and that the SQM service started.'
				: 'SQM is configured but the SQM service is not enabled, so no CAKE qdisc is attached.'
		};

	var broken = queues.filter(function (o) { return o.mismatch === true; });
	if (broken.length)
		return {
			ok: false, level: 'warn', link: SQM_PAGE, steps: steps,
			title: 'SQM is enabled on ' + broken.map(function (o) { return o.egress; }).join(', ') +
				' but the matching ingress IFB device has not been created, so download shaping cannot work yet.'
		};

	return {
		ok: true, level: 'ok', link: SQM_PAGE, steps: steps,
		title: probed
			? 'SQM is shaping with CAKE on: ' + cake.join(', ') + '.'
			: 'SQM is configured and its ingress devices are live. (The CAKE qdisc itself could not be verified — tc is not available to rpcd.)'
	};
}

return baseclass.extend({
	STATUS_FIELDS: STATUS_FIELDS,
	SQM_PAGE: SQM_PAGE,
	formatUptime: formatUptime,
	statusRow: statusRow,
	statusRows: statusRows,
	interfaceChoices: interfaceChoices,
	interfaceStatus: interfaceStatus,
	setupState: setupState
});
