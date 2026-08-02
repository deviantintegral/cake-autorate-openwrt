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
 *       epoch }, ... }   (available:false carries reason: no-log | no-data)
 *   sqm_interfaces {}  -> { sqm_config_present, interfaces:[{egress, ingress_ifb,
 *       sqm_enabled, ifb_present, mismatch, download_kbps, upload_kbps}],
 *       egress_choices, ingress_choices, ifb_devices }.
 *       dl_if <- ingress (ifb) choices; ul_if <- egress choices.
 *       The two *_kbps rates are always numbers, and 0 is overloaded: it is both
 *       sqm-scripts' "no limit" sentinel and the backend's "unusable value"
 *       fallback. Either way it carries no rate, so seedRates() refuses it.
 *   calibration {instance} -> either
 *       { available:true, instance, window_s, min_samples, tolerance_fraction,
 *         threshold_fraction, dl:{samples, pinned_max_fraction,
 *         floored_min_fraction, verdict, configured_min, configured_max}, ul:{…} }
 *       or { available:false, reason: no-rrdtool | no-rrd | no-data, instance }.
 *       verdict is pinned-max | floored-min | ok | insufficient-data. Read-only
 *       and slow-moving (days), so the view fetches it once at render.
 *       available:true holds as soon as ONE direction has a sample, so the other
 *       may still be empty -- the two are reported independently.
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
 * rateTrio(rate) -- one direction's SQM rate -> its min/base/max trio, or null
 * when the rate carries nothing to seed from.
 *
 * base = max = the SQM rate: that is the rate the user told SQM the line does,
 * so autorate may shape DOWN from it but never probes above a rate the user has
 * not validated. min is a deliberately conservative floor -- an over-optimistic
 * min is the one value that actively harms, since it is a hard floor the daemon
 * cannot shape below when the line degrades.
 *
 * Math.floor is not cosmetic: cake-autorate's rates are integer Kbit/s and a
 * decimal point is a fatal type error upstream, so a fractional rate in is
 * refused rather than rounded into a value the user never configured.
 */
function rateTrio(rate) {
	var r = toNum(rate);
	if (r == null || r <= 0 || Math.floor(r) !== r)
		return null;
	return { min: Math.floor(r / 4), base: r, max: r };
}

/*
 * seedRates(sqm, egressIface) -- the SQM section matching egressIface -> the two
 * trios the Essentials form is seeded from: { dl: trio|null, ul: trio|null }.
 *
 * The direction mapping is sqm-scripts': SQM's `download` is the ingress rate
 * (cake-autorate's dl_*) and `upload` the egress rate (ul_*).
 *
 * The directions resolve independently because SQM commonly has one rate set
 * and the other left at 0 ("no limit"), which carries nothing to seed from; a
 * usable download must still seed dl even when upload is unusable. The caller
 * decides what to say about a null -- this function never guesses a rate.
 */
function seedRates(sqm, egressIface) {
	var list = (sqm && Array.isArray(sqm.interfaces)) ? sqm.interfaces : [];
	var match = null;

	for (var i = 0; i < list.length; i++) {
		if (list[i] && list[i].egress === egressIface) {
			match = list[i];
			break;
		}
	}
	if (!match)
		return { dl: null, ul: null };

	return {
		dl: rateTrio(match.download_kbps),
		ul: rateTrio(match.upload_kbps)
	};
}

/* Shared vocabulary for the two rate-facing helpers below. The UCI names are
 * built from the direction rather than listed, so they cannot drift apart from
 * options.RATE_TRIOS the way a second hand-written list would. */
var DIR_WORD = { dl: 'download', ul: 'upload' };
var DIR_LABEL = { dl: 'Download', ul: 'Upload' };

function rateField(dir, which) {
	return which + '_' + dir + '_shaper_rate_kbps';
}

/*
 * seedPlan(sqm, egressIface) -- everything the "Seed rates from SQM" control
 * needs for one section: whether it may run, the two trios it would write, and
 * one sentence saying either what it will do or exactly why it refuses.
 *
 * seedRates() answers "which numbers"; this answers "and should the control be
 * offered at all", which is the half the user sees. Refusals are never silent
 * and never generic -- "no rate" and "not an SQM interface" are different
 * problems with different fixes, so they get different sentences.
 *
 * reason: 'ready' | 'no-interface' | 'no-sqm' | 'no-section' | 'no-rate'.
 */
function seedPlan(sqm, egressIface) {
	var s = (sqm && typeof sqm === 'object') ? sqm : {};
	var iface = (egressIface == null) ? '' : String(egressIface);

	function blocked(reason, message) {
		return { enabled: false, reason: reason, dl: null, ul: null, message: message };
	}

	/* Order matters: with no SQM config there is nothing to seed whatever
	 * interface is chosen, so sending the user off to pick one first would be a
	 * dead end. The blocker named is always the one that has to be cleared. */
	if (!s.sqm_config_present)
		return blocked('no-sqm',
			'SQM is not configured on this router, so it holds no rates to seed from. Configure SQM first, then reload this page.');

	if (iface === '')
		return blocked('no-interface',
			'Choose the upload interface (ul_if) for this instance first: SQM keys its rates on the egress interface, so until one is chosen there is nothing to look up.');

	var match = (Array.isArray(s.interfaces) ? s.interfaces : []).filter(function (o) {
		return o && o.egress === iface;
	})[0];

	if (!match)
		return blocked('no-section',
			'"' + iface + '" is not an SQM egress interface, so SQM holds no configured rates for it. SQM egress interfaces: ' + (interfaceChoices(s).ul.join(', ') || '(none)') + '.');

	var trios = seedRates(s, iface);

	if (!trios.dl && !trios.ul)
		return blocked('no-rate',
			'SQM has no usable rate for "' + iface + '" in either direction, so there is nothing to seed from. A rate of 0 is sqm-scripts\' "no limit" setting, which carries no number to derive from.');

	var have = [], missing = [];
	['dl', 'ul'].forEach(function (d) {
		(trios[d] ? have : missing).push(d);
	});

	var message;
	if (!missing.length)
		message = 'Fills all six shaper rates from SQM\'s configured rates for "' + iface + '": ' +
			'download ' + trios.dl.base + ' Kbit/s and upload ' + trios.ul.base + ' Kbit/s, ' +
			'each as base = max = the SQM rate with min a quarter of it.';
	else
		message = 'Fills the three ' + DIR_WORD[have[0]] + ' shaper rates from SQM\'s configured ' +
			trios[have[0]].base + ' Kbit/s for "' + iface + '" (base = max = the SQM rate, min a quarter of it). ' +
			'SQM has no usable ' + DIR_WORD[missing[0]] + ' rate for "' + iface + '", so the three ' +
			DIR_WORD[missing[0]] + ' fields are left untouched.';

	return {
		enabled: true,
		reason: 'ready',
		dl: trios.dl,
		ul: trios.ul,
		message: message + ' Nothing is saved until you press Save & Apply.'
	};
}

/* Severity ordering for the calibration notice: the loudest direction sets the
 * level of the whole notice. */
var LEVEL_RANK = { ok: 0, info: 1, warn: 2 };

function worstLevel(a, b) {
	return (LEVEL_RANK[b] > LEVEL_RANK[a]) ? b : a;
}

/* A window in seconds -> "7 days" / "12 hours" / null when unknowable. */
function formatWindow(sec) {
	var n = toNum(sec);
	if (n == null || n <= 0)
		return null;
	n = Math.floor(n);
	if (n % 86400 === 0)
		return (n / 86400) + (n === 86400 ? ' day' : ' days');
	if (n % 3600 === 0)
		return (n / 3600) + (n === 3600 ? ' hour' : ' hours');
	if (n % 60 === 0)
		return (n / 60) + (n === 60 ? ' minute' : ' minutes');
	return n + (n === 1 ? ' second' : ' seconds');
}

function windowPhrase(sec) {
	var w = formatWindow(sec);
	return w ? ('the last ' + w) : 'the observed window';
}

/* A fraction of the window -> a percentage the user can weigh. */
function pctText(f) {
	var n = toNum(f);
	if (n == null)
		return 'an unknown share';
	return (Math.round(n * 1000) / 10) + '%';
}

function boundsPhrase(cmin, cmax) {
	if (cmin > 0 && cmax > 0)
		return 'between the configured bounds of ' + cmin + ' and ' + cmax + ' Kbit/s';
	if (cmax > 0)
		return 'below the configured maximum of ' + cmax + ' Kbit/s';
	if (cmin > 0)
		return 'above the configured minimum of ' + cmin + ' Kbit/s';
	return 'across the whole window';
}

/* Reason -> the one sentence shown when there is no verdict to give. None of
 * these is a fault: on a fresh install "the statistics have not accumulated
 * yet" is simply the truth, and the form must say so rather than look broken. */
var CALIB_REASON_TEXT = {
	'no-rrdtool': 'No clipping diagnosis: rrdtool is not installed, so the recorded shaper-rate statistics cannot be read.',
	'no-rrd': 'No clipping diagnosis yet: no shaper-rate statistics have been recorded for this instance. They appear once the daemon has run long enough for the statistics collector to write them.',
	'no-data': 'No clipping diagnosis yet: the shaper-rate statistics exist but hold no samples in the observed window. That is normal shortly after a reboot, since the statistics live in /tmp by default.',
	'error': 'The clipping diagnosis could not be read from the router, so nothing is claimed about the shaper here. Every other field on this page is unaffected.'
};

/*
 * calibrationDirection(dir, obj, windowS, need) -- one direction's verdict from
 * the `calibration` response into { dir, level, verdict, field, message }.
 *
 * `field` is the UCI option the user would change, or null when there is
 * nothing to change. The message states the evidence -- which bound, what share
 * of the window, how many samples, over how long -- because the whole point of
 * the feature is that the user can judge the claim rather than obey it.
 */
function calibrationDirection(dir, obj, windowS, need) {
	var o = (obj && typeof obj === 'object') ? obj : {};
	var label = DIR_LABEL[dir];
	var samples = toNum(o.samples) || 0;
	var cmin = toNum(o.configured_min) || 0;
	var cmax = toNum(o.configured_max) || 0;
	var verdict = toStr(o.verdict) || 'insufficient-data';
	var when = ' over ' + windowPhrase(windowS) + '.';

	if (verdict === 'pinned-max')
		return {
			dir: dir, level: 'warn', verdict: verdict, field: rateField(dir, 'max'),
			message: label + ': the shaper sat at the configured maximum of ' + cmax + ' Kbit/s for ' +
				pctText(o.pinned_max_fraction) + ' of ' + samples + ' samples' + when +
				' A bound the shaper never leaves is what is limiting the line, not the line itself — raise ' +
				rateField(dir, 'max') + ' if the connection can carry more.'
		};

	if (verdict === 'floored-min')
		return {
			dir: dir, level: 'warn', verdict: verdict, field: rateField(dir, 'min'),
			message: label + ': the shaper sat at the configured minimum of ' + cmin + ' Kbit/s for ' +
				pctText(o.floored_min_fraction) + ' of ' + samples + ' samples' + when +
				' The daemon wanted to shape further down and could not — lower ' +
				rateField(dir, 'min') + ' so it can.'
		};

	if (verdict === 'ok')
		return {
			dir: dir, level: 'ok', verdict: verdict, field: null,
			message: label + ': the shaper moved freely ' + boundsPhrase(cmin, cmax) + ' across ' +
				samples + ' samples' + when + ' Nothing to change here.'
		};

	/*
	 * "insufficient-data" covers two unrelated causes and the backend cannot
	 * tell them apart in one word: too few samples, or no bound configured to
	 * be clipped against. Conflating them would send a user off to wait for
	 * statistics that could never change the answer.
	 */
	if (need != null && samples >= need && cmin <= 0 && cmax <= 0)
		return {
			dir: dir, level: 'info', verdict: 'insufficient-data', field: null,
			message: label + ': neither ' + rateField(dir, 'min') + ' nor ' + rateField(dir, 'max') +
				' is set for this instance, so there is no configured bound for the shaper to be clipped against.'
		};

	return {
		dir: dir, level: 'info', verdict: 'insufficient-data', field: null,
		message: (need == null)
			? label + ': only ' + samples + ' shaper-rate samples have been recorded' + when + ' A verdict needs more than that.'
			: label + ': ' + samples + ' of the ' + need + ' samples needed have been recorded' + when +
				' The verdict appears once enough have accumulated.'
	};
}

/*
 * calibrationReport(resp) -- one `calibration` response -> the display-only
 * notice: { available, level, reason, summary, directions[] }.
 *
 * Pass null for a call that failed outright; it degrades to the same shape with
 * reason 'error', because a diagnosis that cannot be read must never look like
 * a diagnosis of "fine" -- nor stop the form rendering.
 *
 * This decides wording and severity only. It never returns anything to apply:
 * the verdict names the field, and the user changes it.
 */
function calibrationReport(resp) {
	var r = (resp && typeof resp === 'object') ? resp : {};

	if (r.available !== true) {
		var reason = toStr(r.reason) || 'error';
		return {
			available: false,
			level: 'info',
			reason: reason,
			summary: CALIB_REASON_TEXT[reason] ||
				('No clipping diagnosis is available. The router reported: ' + reason + '.'),
			directions: []
		};
	}

	var windowS = toNum(r.window_s);
	var need = toNum(r.min_samples);
	var directions = ['dl', 'ul'].map(function (d) {
		return calibrationDirection(d, r[d], windowS, need);
	});

	return {
		available: true,
		level: directions.reduce(function (acc, d) { return worstLevel(acc, d.level); }, 'ok'),
		reason: null,
		summary: 'Clipping diagnosis from the shaper rates recorded over ' + windowPhrase(windowS) +
			'. Read once when this page loaded, and a recommendation only — nothing here changes a value for you.',
		directions: directions
	};
}

return baseclass.extend({
	STATUS_FIELDS: STATUS_FIELDS,
	formatUptime: formatUptime,
	statusRow: statusRow,
	statusRows: statusRows,
	interfaceChoices: interfaceChoices,
	interfaceStatus: interfaceStatus,
	seedRates: seedRates,
	seedPlan: seedPlan,
	calibrationReport: calibrationReport
});
