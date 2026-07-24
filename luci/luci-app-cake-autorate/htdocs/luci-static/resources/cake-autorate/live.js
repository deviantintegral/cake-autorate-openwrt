'use strict';
'require baseclass';

/*
 * cake-autorate live-status + interface-validation pure helpers (task 9).
 *
 * SHARED, RUNTIME-FREE logic for two consumers:
 *   - view/cake-autorate/status.js  -- the polling status view.
 *   - view/cake-autorate/overview.js -- the SQM-validated dl_if / ul_if pickers.
 *
 * Keep this file free of LuCI runtime calls (no _(), no L.*, no rpc/poll) at
 * module scope so the decision logic can be unit-tested under plain node (see
 * tests/live.test.js). The views own all rpc.declare / poll.add / DOM wiring and
 * wrap any user-facing string in _() themselves.
 *
 * Contracts consumed (task 8 rpcd, object "cake-autorate"):
 *   status {instance?} -> { "<inst>": {available, running, uptime_s?, reason?,
 *       dl_achieved_kbps, ul_achieved_kbps, dl_sum_delays, ul_sum_delays,
 *       dl_avg_owd_delta_us, ul_avg_owd_delta_us, dl_load_condition,
 *       ul_load_condition, cake_dl_rate_kbps, cake_ul_rate_kbps, datetime,
 *       epoch }, ... }   (available:false carries reason: no-log | no-data)
 *   sqm_interfaces {}  -> { sqm_config_present, interfaces:[{egress, ingress_ifb,
 *       sqm_enabled, ifb_present, mismatch}], egress_choices, ingress_choices,
 *       ifb_devices }.  dl_if <- ingress (ifb) choices; ul_if <- egress choices.
 */

/* Numeric summary fields, normalized to a JS number or null. */
var NUM_FIELDS = [
	'uptime_s', 'epoch',
	'dl_achieved_kbps', 'ul_achieved_kbps',
	'dl_sum_delays', 'ul_sum_delays',
	'dl_avg_owd_delta_us', 'ul_avg_owd_delta_us',
	'cake_dl_rate_kbps', 'cake_ul_rate_kbps'
];

/* String summary fields, normalized to a non-empty string or null. */
var STR_FIELDS = ['dl_load_condition', 'ul_load_condition', 'datetime', 'reason'];

/*
 * STATUS_FIELDS -- the DL/UL metric rows the status table renders, in order.
 * Each entry drives two value cells (download + upload). The view marks both
 * cells data-live="1" (task 12 masks them) with data-field set to the dl/ul key
 * (task 11 asserts them).
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
 * formatUptime(s) -- seconds -> compact human string. Non-finite -> em dash.
 * Grain drops as the value grows (days show d+h, hours show h+m, etc).
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
 * statusRow(instance, st) -- normalize one instance's status object into a
 * stable row model. Missing/garbage input degrades to an unavailable, stopped
 * row. When available:false the metric fields are null (the view shows
 * "no data yet" / "stopped") but run state + reason are preserved.
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
 * statusRows(resp) -- the whole `status` response -> a sorted array of row
 * models (one per instance key). Empty / non-object -> [].
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
 * interfaceStatus(value, sqm, direction) -- the mismatch decision behind the
 * visible dl_if / ul_if warning. direction is 'dl' (ingress ifb) or 'ul'
 * (egress). Returns { level, message } where level is:
 *   'none' -- empty value, nothing to say.
 *   'info' -- SQM not configured yet; cannot validate (do NOT hard-block).
 *   'ok'   -- value is backed by the live SQM qdisc.
 *   'warn' -- value is not backed by an SQM qdisc, or (ul) its ingress IFB is
 *             missing. Surfaced as a visible, NON-blocking warning.
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

return baseclass.extend({
	STATUS_FIELDS: STATUS_FIELDS,
	formatUptime: formatUptime,
	statusRow: statusRow,
	statusRows: statusRows,
	interfaceChoices: interfaceChoices,
	interfaceStatus: interfaceStatus
});
