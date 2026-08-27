'use strict';
'require baseclass';

/*
 * cake-autorate option metadata + pure helpers.
 *
 * The single source of truth for the config form: the view builds one field per
 * entry by iterating OPTIONS, so the rendered fields cannot drift from this
 * list. Each entry is one of the 66 options upstream cake-autorate 3.2.2
 * implements (docs/upstream-option-inventory.md / docs/uci-option-schema.tsv).
 * The package-local `enabled` procd gate is not here -- it is not an upstream
 * option and the view adds it separately.
 *
 * Keep this file free of LuCI runtime calls (no _(), no L.*) at module scope so
 * the metadata + helpers can be unit-tested under plain node (see
 * tests/options-coverage.test.js). The view wraps descriptions in _() itself.
 *
 * type   -> widget: bool=Flag, integer/float=Value(datatype), string=Value
 *           (pinger_binary=ListValue), list=DynamicList.
 * desc   -> the field's help text: whole sentences, units and constraints
 *           included. There is no separate units/range field -- a hint bolted
 *           on after an em dash ("Kbit/s, must not be above the base") is a
 *           second, worse register of the same explanation, and a checkbox
 *           needs no hint at all.
 * lo/hi  -> optional numeric bounds turned into a LuCI datatype by the view.
 * doc    -> optional upstream doc link for a concept needing more than a sentence.
 *
 * DOC points at the upstream REPOSITORY, not its wiki: github.com/lynxthecat/
 * cake-autorate/wiki carries no pages and 302-redirects to the repo root, so a
 * wiki link was a dead link dressed up as a destination. The README there is
 * where the concepts below are actually written up.
 */

var DOC = 'https://github.com/lynxthecat/cake-autorate';

var OPTIONS = [
	/* ---- essentials (8) ------------------------------------------------ */
	{ name: 'dl_if', group: 'essentials', type: 'string',
	  desc: 'Interface carrying the download (ingress) CAKE qdisc, normally the SQM IFB device for your WAN, such as ifb4eth1.' },
	{ name: 'ul_if', group: 'essentials', type: 'string',
	  desc: 'Interface carrying the upload (egress) CAKE qdisc, which is the WAN device itself.' },
	{ name: 'min_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Floor for the download shaper rate. It must not be above the base download rate.' },
	{ name: 'base_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Steady-state download shaper rate the daemon decays back toward; set it to your provisioned download rate. It must sit between the minimum and maximum download rates.' },
	{ name: 'max_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Ceiling for the download shaper rate. It must not be below the base download rate.' },
	{ name: 'min_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Floor for the upload shaper rate. It must not be above the base upload rate.' },
	{ name: 'base_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Steady-state upload shaper rate; set it to your provisioned upload rate. It must sit between the minimum and maximum upload rates.' },
	{ name: 'max_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Ceiling for the upload shaper rate. It must not be below the base upload rate.' },

	/* ---- shaper (11) --------------------------------------------------- */
	{ name: 'adjust_dl_shaper_rate', group: 'shaper', type: 'bool',
	  desc: 'Apply download shaper rate changes; when off the daemon only monitors.' },
	{ name: 'adjust_ul_shaper_rate', group: 'shaper', type: 'bool',
	  desc: 'Apply upload shaper rate changes; when off the daemon only monitors.' },
	{ name: 'min_shaper_rates_enforcement', group: 'shaper', type: 'bool',
	  desc: 'Drop both shapers to their minimum rates when the connection is idle or stalled.' },
	{ name: 'shaper_rate_min_adjust_down_bufferbloat', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Smallest shaper-rate reduction applied on a bufferbloat event, as a multiplier between 0 and 1.', doc: DOC },
	{ name: 'shaper_rate_max_adjust_down_bufferbloat', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Largest shaper-rate reduction, applied once the average one-way-delay delta reaches its threshold, as a multiplier between 0 and 1.', doc: DOC },
	{ name: 'shaper_rate_adjust_up_load_high', group: 'shaper', type: 'float', lo: 1,
	  desc: 'Shaper-rate increase applied while load is high and no bufferbloat is seen, as a multiplier of 1 or more.' },
	{ name: 'shaper_rate_adjust_down_load_low', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Decay that brings an above-base rate back down toward base on low or idle load, as a multiplier between 0 and 1.' },
	{ name: 'shaper_rate_adjust_up_load_low', group: 'shaper', type: 'float', lo: 1,
	  desc: 'Decay that brings a below-base rate back up toward base on low or idle load, as a multiplier of 1 or more.' },
	{ name: 'high_load_thr', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Fraction of the current shaper rate that the achieved rate must exceed for load to count as high, between 0 and 1.' },
	{ name: 'bufferbloat_refractory_period_ms', group: 'shaper', type: 'integer',
	  desc: 'Minimum gap in milliseconds between successive bufferbloat-driven rate reductions.' },
	{ name: 'decay_refractory_period_ms', group: 'shaper', type: 'integer',
	  desc: 'Minimum gap in milliseconds between successive decay (toward-base) rate changes.' },

	/* ---- pingers (5) --------------------------------------------------- */
	{ name: 'pinger_binary', group: 'pingers', type: 'string', choices: ['fping', 'tsping', 'ping'],
	  desc: 'Probe binary to use: fping (round-robin round-trip time), tsping (ICMP type 13 one-way delay) or ping (individual round-trip time). It must exist on PATH.' },
	{ name: 'no_pingers', group: 'pingers', type: 'integer', lo: 1,
	  desc: 'How many pinger processes run at once, which is also how many reflectors are live. At least 1, and no more than the number of reflectors configured.' },
	{ name: 'reflector_ping_interval_s', group: 'pingers', type: 'float',
	  desc: 'Interval in seconds between probes. The aggregate ICMP rate is roughly the number of pingers divided by this interval.' },
	{ name: 'ping_extra_args', group: 'pingers', type: 'string',
	  desc: 'Extra arguments appended to the ping or fping command line.' },
	{ name: 'ping_prefix_string', group: 'pingers', type: 'string',
	  desc: 'Wrapper command placed in front of the ping binary. It must exec ping rather than fork it.' },

	/* ---- reflectors (10) ----------------------------------------------- */
	{ name: 'reflectors', group: 'reflectors', type: 'list',
	  desc: 'Ordered pool of ICMP reflector addresses, IPv4 or IPv6. As many entries as there are pingers are used; the rest are spares held for rotation.', doc: DOC },
	{ name: 'randomize_reflectors', group: 'reflectors', type: 'bool',
	  desc: 'Shuffle the reflector list at startup so instances do not all hammer the same hosts.' },
	{ name: 'reflector_health_check_interval_s', group: 'reflectors', type: 'float',
	  desc: 'How often, in seconds, reflector health is evaluated.' },
	{ name: 'reflector_response_deadline_s', group: 'reflectors', type: 'float',
	  desc: 'A reflector response later than this many seconds counts as an offence against that reflector.' },
	{ name: 'reflector_misbehaving_detection_window', group: 'reflectors', type: 'integer', lo: 1,
	  desc: 'How many health checks the offence count is measured over.' },
	{ name: 'reflector_misbehaving_detection_thr', group: 'reflectors', type: 'integer', lo: 1,
	  desc: 'How many offences within the window before a reflector is deemed misbehaving and replaced. It cannot exceed the detection window.' },
	{ name: 'reflector_replacement_interval_mins', group: 'reflectors', type: 'integer',
	  desc: 'How often, in minutes, a random live reflector is proactively swapped for a spare.' },
	{ name: 'reflector_comparison_interval_mins', group: 'reflectors', type: 'integer',
	  desc: 'How often, in minutes, live reflectors are compared against each other, which is what drives the REFLECTOR log lines.' },
	{ name: 'reflector_sum_owd_baselines_delta_thr_ms', group: 'reflectors', type: 'float',
	  desc: 'How far in milliseconds a reflector summed one-way-delay baselines may exceed the lowest of them before it is rotated out.' },
	{ name: 'reflector_owd_delta_ewma_delta_thr_ms', group: 'reflectors', type: 'float',
	  desc: 'How far in milliseconds a reflector one-way-delay delta EWMA may exceed the lowest of them before it is rotated out.' },

	/* ---- detection (10) ------------------------------------------------ */
	{ name: 'dl_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Download one-way-delay increase above baseline, in milliseconds, that classifies a sample as delayed.', doc: DOC },
	{ name: 'ul_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Upload one-way-delay increase above baseline, in milliseconds, that classifies a sample as delayed.', doc: DOC },
	{ name: 'dl_avg_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Average download one-way-delay delta, in milliseconds, at which the largest bufferbloat down-adjustment is applied.' },
	{ name: 'ul_avg_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Average upload one-way-delay delta, in milliseconds, at which the largest bufferbloat down-adjustment is applied.' },
	{ name: 'monitor_achieved_rates_interval_ms', group: 'detection', type: 'integer',
	  desc: 'How often, in milliseconds, the interface receive and transmit byte counters are sampled.' },
	{ name: 'bufferbloat_detection_window', group: 'detection', type: 'integer', lo: 1,
	  desc: 'How many recent delay samples are kept in the detection window. It must be larger than the bufferbloat detection threshold.' },
	{ name: 'bufferbloat_detection_thr', group: 'detection', type: 'integer', lo: 1,
	  desc: 'How many delayed samples within the window trigger a bufferbloat event. It cannot exceed the detection window.' },
	{ name: 'alpha_baseline_increase', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'EWMA alpha, between 0 and 1, for how rapidly the one-way-delay baseline may rise. Kept slow, so a path change is tracked without masking bufferbloat.', doc: DOC },
	{ name: 'alpha_baseline_decrease', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'EWMA alpha, between 0 and 1, for how rapidly the one-way-delay baseline may fall. Kept fast, so the shortest path is tracked.', doc: DOC },
	{ name: 'alpha_delta_ewma', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'EWMA alpha, between 0 and 1, smoothing the one-way-delay delta from baseline.', doc: DOC },

	/* ---- idle (8) ------------------------------------------------------ */
	{ name: 'enable_sleep_function', group: 'idle', type: 'bool',
	  desc: 'Pause all pingers when the connection has been idle, saving CPU and needless ICMP.' },
	{ name: 'connection_active_thr_kbps', group: 'idle', type: 'integer',
	  desc: 'Achieved rate in Kbit/s below which a direction counts as idle rather than lightly loaded.' },
	{ name: 'sustained_idle_sleep_thr_s', group: 'idle', type: 'float',
	  desc: 'How long, in seconds, both directions must stay below the active threshold before the pingers sleep.' },
	{ name: 'startup_wait_s', group: 'idle', type: 'float', lo: 0,
	  desc: 'Delay in seconds before the daemon starts work, letting interfaces settle after a reboot.' },
	{ name: 'stall_detection_thr', group: 'idle', type: 'integer',
	  desc: 'How many ping intervals may pass with no reflector response before that counts as one of the two stall conditions.' },
	{ name: 'connection_stall_thr_kbps', group: 'idle', type: 'integer',
	  desc: 'Achieved rate in Kbit/s below which, combined with no ping responses, the connection is declared stalled.' },
	{ name: 'global_ping_response_timeout_s', group: 'idle', type: 'float',
	  desc: 'With no ping response at all for this many seconds, shaper rates are forced to their minimums.' },
	{ name: 'if_up_check_interval_s', group: 'idle', type: 'float',
	  desc: 'How often, in seconds, to re-check that the interface byte-counter files exist, which is how the daemon recovers after a boot or a sleep.' },

	/* ---- logging (14) -------------------------------------------------- */
	{ name: 'output_processing_stats', group: 'logging', type: 'bool',
	  desc: 'Emit the per-ping DATA monitoring lines (full processing detail; heavy).' },
	{ name: 'output_load_stats', group: 'logging', type: 'bool',
	  desc: 'Emit LOAD lines showing the achieved download and upload rates on every rate sample.' },
	{ name: 'output_reflector_stats', group: 'logging', type: 'bool',
	  desc: 'Emit REFLECTOR lines with per-reflector baseline/EWMA comparison data.' },
	{ name: 'output_summary_stats', group: 'logging', type: 'bool', managed: true,
	  desc: 'Emit the condensed SUMMARY lines. Package-managed: the service forces this on so the status view and collectd have data to parse.' },
	{ name: 'output_cake_changes', group: 'logging', type: 'bool',
	  desc: 'Emit a SHAPER line for every tc qdisc change the daemon issues.' },
	{ name: 'debug', group: 'logging', type: 'bool',
	  desc: 'Emit DEBUG lines to the log; the packaged default is off to spare tmpfs RAM.' },
	{ name: 'log_DEBUG_messages_to_syslog', group: 'logging', type: 'bool', managed: true,
	  desc: 'Also send every DEBUG record to syslog (very high volume). Package-managed: the service forces this off.' },
	{ name: 'log_to_file', group: 'logging', type: 'bool', managed: true,
	  desc: 'Write the log stream to the log file. Package-managed: the service forces this on, because a supervised background service has no terminal to write to.' },
	{ name: 'log_file_max_time_mins', group: 'logging', type: 'integer', lo: 1,
	  desc: 'Rotate the log file once this many minutes of log lines have accumulated.' },
	{ name: 'log_file_max_size_KB', group: 'logging', type: 'integer', lo: 1,
	  desc: 'Rotate the log file once this many kilobytes of log lines have accumulated.' },
	{ name: 'log_file_path_override', group: 'logging', type: 'string', managed: true,
	  desc: 'Directory to hold the log file; leave it empty for /var/log. A directory that does not exist is fatal to the daemon. Package-managed: the service keeps this empty.' },
	{ name: 'log_file_buffer_size_B', group: 'logging', type: 'integer',
	  desc: 'Size in bytes of the write buffer in front of the log file.' },
	{ name: 'log_file_buffer_timeout_ms', group: 'logging', type: 'integer',
	  desc: 'Flush the log buffer after this many milliseconds even if it is not full.' },
	{ name: 'log_file_export_compress', group: 'logging', type: 'bool',
	  desc: 'gzip exported log files and append .gz to the export filename.' }
];

/* Expected per-group counts (docs/uci-schema.md section 6). */
var GROUP_COUNTS = {
	essentials: 8, shaper: 11, pingers: 5, reflectors: 10,
	detection: 10, idle: 8, logging: 14
};

var TOTAL_OPTIONS = 66;

/*
 * coverageReport(options) -- pure. Checks the option set is exactly the 66
 * upstream options, split across groups as expected, with no duplicates. The
 * view runs this at load time and shows an error on a mismatch, so a UI option
 * with nothing behind it in the daemon cannot slip through unnoticed.
 */
function coverageReport(options) {
	var counts = {}, seen = {}, dupes = [], errors = [];

	options.forEach(function (o) {
		counts[o.group] = (counts[o.group] || 0) + 1;
		if (seen[o.name])
			dupes.push(o.name);
		seen[o.name] = true;
	});

	if (options.length !== TOTAL_OPTIONS)
		errors.push('expected ' + TOTAL_OPTIONS + ' options, got ' + options.length);

	Object.keys(GROUP_COUNTS).forEach(function (g) {
		var got = counts[g] || 0;
		if (got !== GROUP_COUNTS[g])
			errors.push('group ' + g + ': expected ' + GROUP_COUNTS[g] + ', got ' + got);
	});

	Object.keys(counts).forEach(function (g) {
		if (!(g in GROUP_COUNTS))
			errors.push('unexpected group "' + g + '"');
	});

	if (dupes.length)
		errors.push('duplicate option(s): ' + dupes.join(', '));

	return { ok: errors.length === 0, errors: errors, total: options.length, counts: counts };
}

/*
 * optionMatches(query, name, title) -- pure. Decides whether the search box
 * shows a row: true when the trimmed, lower-cased query is empty or appears in
 * the option's UCI name or its title.
 */
function optionMatches(query, name, title) {
	var q = String(query == null ? '' : query).trim().toLowerCase();
	if (q === '')
		return true;
	if (String(name || '').toLowerCase().indexOf(q) !== -1)
		return true;
	if (String(title || '').toLowerCase().indexOf(q) !== -1)
		return true;
	return false;
}

/*
 * RATE_TRIOS -- the two min/base/max shaper-rate groups whose ordering the
 * Essentials help text promises in words ("must not be above the base download
 * rate", and so on). A LuCI datatype only sees one field, so the view hangs
 * checkRateOrder() off all six fields to actually enforce it.
 */
var RATE_TRIOS = [
	{ dir: 'dl', min: 'min_dl_shaper_rate_kbps', base: 'base_dl_shaper_rate_kbps', max: 'max_dl_shaper_rate_kbps' },
	{ dir: 'ul', min: 'min_ul_shaper_rate_kbps', base: 'base_ul_shaper_rate_kbps', max: 'max_ul_shaper_rate_kbps' }
];

function rateNum(v) {
	if (v == null)
		return null;
	var s = String(v).trim();
	if (s === '' || !isFinite(Number(s)))
		return null;
	return Number(s);
}

/*
 * checkRateOrder(min, base, max) -- pure. Returns null when the three agree,
 * else { code, a, b } naming the rule broken and the two offending values. The
 * view turns `code` into a translated sentence.
 *
 * Any field may be left empty (rmempty; the daemon then uses its own default),
 * so a pair is only compared when both values parse as numbers -- a blank field
 * must never invent an error.
 */
function checkRateOrder(min, base, max) {
	var m = rateNum(min), b = rateNum(base), x = rateNum(max);

	if (m !== null && b !== null && m > b)
		return { code: 'min-gt-base', a: m, b: b };
	if (x !== null && b !== null && x < b)
		return { code: 'max-lt-base', a: x, b: b };
	if (m !== null && x !== null && m > x)
		return { code: 'min-gt-max', a: m, b: x };
	return null;
}

/*
 * instanceNameSuggestions(egressChoices, existingNames) -- pure. Suggested ids
 * for the "Add instance" field, taken from the SQM egress devices: one instance
 * manages one WAN, so the WAN name is the obvious choice.
 *
 * A UCI section name must match [a-zA-Z0-9_]+, but real WAN devices often do
 * not -- `pppoe-wan`, `eth0.2`, `wan.835`. Offering those as-is would suggest
 * names UCI then rejects, so each is rewritten into a valid identifier and
 * anything already configured is dropped. With no SQM config this returns [],
 * which means "offer nothing" rather than a misleading list.
 */
function instanceNameSuggestions(egressChoices, existingNames) {
	var used = {};
	(Array.isArray(existingNames) ? existingNames : []).forEach(function (n) {
		used[String(n)] = true;
	});

	var seen = {}, out = [];
	(Array.isArray(egressChoices) ? egressChoices : []).forEach(function (dev) {
		var id = String(dev == null ? '' : dev)
			.replace(/[^a-zA-Z0-9_]+/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		if (id === '' || used[id] || seen[id])
			return;
		seen[id] = true;
		out.push(id);
	});
	return out;
}

/*
 * datatypeFor(opt) -- pure. Maps a metadata entry to a LuCI datatype string,
 * combining the base type (uinteger/ufloat) with any lo/hi bounds. The bounds
 * are only there to help in the browser; the config bridge has the final say on
 * the types and ranges the daemon sees.
 */
function datatypeFor(opt) {
	if (opt.type !== 'integer' && opt.type !== 'float')
		return null;

	var base = (opt.type === 'integer') ? 'uinteger' : 'ufloat';
	var hasLo = (typeof opt.lo === 'number');
	var hasHi = (typeof opt.hi === 'number');

	if (hasLo && hasHi)
		return 'and(' + base + ',range(' + opt.lo + ',' + opt.hi + '))';
	if (hasLo)
		return 'and(' + base + ',min(' + opt.lo + '))';
	if (hasHi)
		return 'and(' + base + ',max(' + opt.hi + '))';
	return base;
}

return baseclass.extend({
	OPTIONS: OPTIONS,
	GROUP_COUNTS: GROUP_COUNTS,
	TOTAL_OPTIONS: TOTAL_OPTIONS,
	coverageReport: coverageReport,
	optionMatches: optionMatches,
	datatypeFor: datatypeFor,
	RATE_TRIOS: RATE_TRIOS,
	checkRateOrder: checkRateOrder,
	instanceNameSuggestions: instanceNameSuggestions
});
