'use strict';
'require baseclass';

/*
 * cake-autorate option metadata + pure helpers.
 *
 * SINGLE SOURCE OF TRUTH for the config form: the view builds one field per
 * entry in OPTIONS by iterating this array, so "rendered field set" == "OPTIONS"
 * by construction. Each entry is exactly one of the 66 upstream cake-autorate
 * 3.2.2 options (docs/upstream-option-inventory.md / docs/uci-option-schema.tsv).
 * The package-local `enabled` procd gate is NOT here -- it is not an upstream
 * option and is added separately by the view.
 *
 * Keep this file free of LuCI runtime calls (no _(), no L.*) at module scope so
 * the metadata + helpers can be unit-tested under plain node (see
 * tests/options-coverage.test.js). The view wraps descriptions in _() itself.
 *
 * type   -> widget: bool=Flag, integer/float=Value(datatype), string=Value
 *           (pinger_binary=ListValue), list=DynamicList.
 * lo/hi  -> optional numeric bounds turned into a LuCI datatype by the view.
 * doc    -> optional upstream doc link for a concept needing more than a sentence.
 */

var DOC = 'https://github.com/lynxthecat/cake-autorate/wiki';

var OPTIONS = [
	/* ---- essentials (8) ------------------------------------------------ */
	{ name: 'dl_if', group: 'essentials', type: 'string',
	  desc: 'Interface carrying the download (ingress) CAKE qdisc, normally the SQM IFB device (e.g. ifb4eth1). Placeholder here; a later release derives it from the live SQM config.',
	  units: 'interface name, non-empty' },
	{ name: 'ul_if', group: 'essentials', type: 'string',
	  desc: 'Interface carrying the upload (egress) CAKE qdisc, i.e. the WAN device.',
	  units: 'interface name, non-empty' },
	{ name: 'min_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Floor for the download shaper rate.', units: 'Kbit/s, must be <= base' },
	{ name: 'base_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Steady-state download shaper rate the daemon decays back toward; set to your provisioned download rate.',
	  units: 'Kbit/s, between min and max' },
	{ name: 'max_dl_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Ceiling for the download shaper rate.', units: 'Kbit/s, >= base' },
	{ name: 'min_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Floor for the upload shaper rate.', units: 'Kbit/s, must be <= base' },
	{ name: 'base_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Steady-state upload shaper rate; set to your provisioned upload rate.',
	  units: 'Kbit/s, between min and max' },
	{ name: 'max_ul_shaper_rate_kbps', group: 'essentials', type: 'integer', lo: 1,
	  desc: 'Ceiling for the upload shaper rate.', units: 'Kbit/s, >= base' },

	/* ---- shaper (11) --------------------------------------------------- */
	{ name: 'adjust_dl_shaper_rate', group: 'shaper', type: 'bool',
	  desc: 'Apply download shaper rate changes; when off the daemon only monitors.', units: '0 or 1' },
	{ name: 'adjust_ul_shaper_rate', group: 'shaper', type: 'bool',
	  desc: 'Apply upload shaper rate changes; when off the daemon only monitors.', units: '0 or 1' },
	{ name: 'min_shaper_rates_enforcement', group: 'shaper', type: 'bool',
	  desc: 'Drop both shapers to their minimum rates when the connection is idle or stalled.', units: '0 or 1' },
	{ name: 'shaper_rate_min_adjust_down_bufferbloat', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Smallest shaper-rate reduction factor applied on a bufferbloat event.', units: 'multiplier, 0-1', doc: DOC },
	{ name: 'shaper_rate_max_adjust_down_bufferbloat', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Largest shaper-rate reduction factor, applied at the average OWD delta threshold.', units: 'multiplier, 0-1', doc: DOC },
	{ name: 'shaper_rate_adjust_up_load_high', group: 'shaper', type: 'float', lo: 1,
	  desc: 'Shaper-rate increase factor while load is high and no bufferbloat is seen.', units: 'multiplier, >= 1' },
	{ name: 'shaper_rate_adjust_down_load_low', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Decay factor bringing an above-base rate back down toward base on low/idle load.', units: 'multiplier, 0-1' },
	{ name: 'shaper_rate_adjust_up_load_low', group: 'shaper', type: 'float', lo: 1,
	  desc: 'Decay factor bringing a below-base rate back up toward base on low/idle load.', units: 'multiplier, >= 1' },
	{ name: 'high_load_thr', group: 'shaper', type: 'float', lo: 0, hi: 1,
	  desc: 'Achieved-rate fraction of the current shaper rate above which load is classified high.', units: 'fraction, 0-1' },
	{ name: 'bufferbloat_refractory_period_ms', group: 'shaper', type: 'integer',
	  desc: 'Minimum gap between successive bufferbloat-driven rate reductions.', units: 'milliseconds' },
	{ name: 'decay_refractory_period_ms', group: 'shaper', type: 'integer',
	  desc: 'Minimum gap between successive decay (toward-base) rate changes.', units: 'milliseconds' },

	/* ---- pingers (5) --------------------------------------------------- */
	{ name: 'pinger_binary', group: 'pingers', type: 'string', choices: ['fping', 'tsping', 'ping'],
	  desc: 'Probe binary: fping (round-robin RTT), tsping (ICMP type 13 OWD) or ping (individual RTT). Must exist on PATH.',
	  units: 'one of fping, tsping, ping' },
	{ name: 'no_pingers', group: 'pingers', type: 'integer', lo: 1,
	  desc: 'Number of concurrent pinger processes / live reflectors.', units: 'count, >= 1 and <= number of reflectors' },
	{ name: 'reflector_ping_interval_s', group: 'pingers', type: 'float',
	  desc: 'Interval between probes; aggregate ICMP rate is roughly no_pingers / interval.', units: 'seconds' },
	{ name: 'ping_extra_args', group: 'pingers', type: 'string',
	  desc: 'Extra arguments appended to the ping/fping command line. May be empty.', units: 'raw argument string, may be empty' },
	{ name: 'ping_prefix_string', group: 'pingers', type: 'string',
	  desc: 'Wrapper command prefixed to the ping binary (must exec ping, not fork it). May be empty.', units: 'raw command prefix, may be empty' },

	/* ---- reflectors (10) ----------------------------------------------- */
	{ name: 'reflectors', group: 'reflectors', type: 'list',
	  desc: 'Ordered pool of ICMP reflector IPs; the first no_pingers entries are used, the rest are spares for rotation.',
	  units: 'list of IPv4/IPv6 addresses; length should be >= no_pingers', doc: DOC },
	{ name: 'randomize_reflectors', group: 'reflectors', type: 'bool',
	  desc: 'Shuffle the reflector list at startup so instances do not all hammer the same hosts.', units: '0 or 1' },
	{ name: 'reflector_health_check_interval_s', group: 'reflectors', type: 'float',
	  desc: 'How often reflector health is evaluated.', units: 'seconds' },
	{ name: 'reflector_response_deadline_s', group: 'reflectors', type: 'float',
	  desc: 'A reflector response later than this counts as an offence against that reflector.', units: 'seconds' },
	{ name: 'reflector_misbehaving_detection_window', group: 'reflectors', type: 'integer', lo: 1,
	  desc: 'Window length (health-check ticks) over which reflector offences are counted.', units: 'samples / health-check ticks' },
	{ name: 'reflector_misbehaving_detection_thr', group: 'reflectors', type: 'integer', lo: 1,
	  desc: 'Offences within the window before a reflector is deemed misbehaving and replaced.', units: 'offences, <= window' },
	{ name: 'reflector_replacement_interval_mins', group: 'reflectors', type: 'integer',
	  desc: 'How often a random live reflector is proactively swapped for a spare.', units: 'minutes' },
	{ name: 'reflector_comparison_interval_mins', group: 'reflectors', type: 'integer',
	  desc: 'How often live reflectors are compared against each other (drives REFLECTOR lines).', units: 'minutes' },
	{ name: 'reflector_sum_owd_baselines_delta_thr_ms', group: 'reflectors', type: 'float',
	  desc: 'Max allowed excess of a reflector summed OWD baselines over the minimum before rotation.', units: 'milliseconds' },
	{ name: 'reflector_owd_delta_ewma_delta_thr_ms', group: 'reflectors', type: 'float',
	  desc: 'Max allowed excess of a reflector OWD delta EWMA over the minimum before rotation.', units: 'milliseconds' },

	/* ---- detection (10) ------------------------------------------------ */
	{ name: 'dl_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Download one-way-delay increase above baseline that classifies a sample as delayed.', units: 'milliseconds', doc: DOC },
	{ name: 'ul_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Upload one-way-delay increase above baseline that classifies a sample as delayed.', units: 'milliseconds', doc: DOC },
	{ name: 'dl_avg_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Average download OWD delta at which the maximum bufferbloat down-adjustment is applied.', units: 'milliseconds' },
	{ name: 'ul_avg_owd_delta_thr_ms', group: 'detection', type: 'float',
	  desc: 'Average upload OWD delta at which the maximum bufferbloat down-adjustment is applied.', units: 'milliseconds' },
	{ name: 'monitor_achieved_rates_interval_ms', group: 'detection', type: 'integer',
	  desc: 'How often achieved rx/tx byte counters are sampled.', units: 'milliseconds' },
	{ name: 'bufferbloat_detection_window', group: 'detection', type: 'integer', lo: 1,
	  desc: 'Number of recent delay samples retained in the detection window.', units: 'samples, > bufferbloat_detection_thr' },
	{ name: 'bufferbloat_detection_thr', group: 'detection', type: 'integer', lo: 1,
	  desc: 'Number of delayed samples within the window that triggers a bufferbloat event.', units: 'samples, <= window' },
	{ name: 'alpha_baseline_increase', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'EWMA alpha for how rapidly the OWD baseline may rise (kept slow so path changes track without masking bufferbloat).', units: 'EWMA alpha, 0-1', doc: DOC },
	{ name: 'alpha_baseline_decrease', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'EWMA alpha for how rapidly the OWD baseline may fall (kept fast to track the shortest path).', units: 'EWMA alpha, 0-1', doc: DOC },
	{ name: 'alpha_delta_ewma', group: 'detection', type: 'float', lo: 0, hi: 1,
	  desc: 'Smoothing factor applied to the OWD delta from baseline.', units: 'EWMA alpha, 0-1', doc: DOC },

	/* ---- idle (8) ------------------------------------------------------ */
	{ name: 'enable_sleep_function', group: 'idle', type: 'bool',
	  desc: 'Pause all pingers when the connection has been idle, saving CPU and needless ICMP.', units: '0 or 1' },
	{ name: 'connection_active_thr_kbps', group: 'idle', type: 'integer',
	  desc: 'Achieved rate below which a direction counts as idle rather than low-load.', units: 'Kbit/s' },
	{ name: 'sustained_idle_sleep_thr_s', group: 'idle', type: 'float',
	  desc: 'How long both directions must stay below the active threshold before the pingers sleep.', units: 'seconds' },
	{ name: 'startup_wait_s', group: 'idle', type: 'float', lo: 0,
	  desc: 'Delay before the daemon starts work, letting interfaces settle after a reboot.', units: 'seconds, >= 0' },
	{ name: 'stall_detection_thr', group: 'idle', type: 'integer',
	  desc: 'No reflector response for this many ping intervals is one of the two stall conditions.', units: 'multiples of the ping response interval' },
	{ name: 'connection_stall_thr_kbps', group: 'idle', type: 'integer',
	  desc: 'Achieved rate below which, combined with no ping responses, the connection is declared stalled.', units: 'Kbit/s' },
	{ name: 'global_ping_response_timeout_s', group: 'idle', type: 'float',
	  desc: 'With no ping response at all for this long, shaper rates are forced to their minimums.', units: 'seconds' },
	{ name: 'if_up_check_interval_s', group: 'idle', type: 'float',
	  desc: 'How often to re-check that the interface rx/tx byte-counter files exist (boot / sleep recovery).', units: 'seconds' },

	/* ---- logging (14) -------------------------------------------------- */
	{ name: 'output_processing_stats', group: 'logging', type: 'bool',
	  desc: 'Emit the per-ping DATA monitoring lines (full processing detail; heavy).', units: '0 or 1' },
	{ name: 'output_load_stats', group: 'logging', type: 'bool',
	  desc: 'Emit LOAD lines showing achieved dl/ul rates on every rate sample.', units: '0 or 1' },
	{ name: 'output_reflector_stats', group: 'logging', type: 'bool',
	  desc: 'Emit REFLECTOR lines with per-reflector baseline/EWMA comparison data.', units: '0 or 1' },
	{ name: 'output_summary_stats', group: 'logging', type: 'bool', managed: true,
	  desc: 'Emit the condensed SUMMARY lines. Package-managed: the service forces this on so the status view and collectd have data to parse.', units: '0 or 1' },
	{ name: 'output_cake_changes', group: 'logging', type: 'bool',
	  desc: 'Emit a SHAPER line for every tc qdisc change the daemon issues.', units: '0 or 1' },
	{ name: 'debug', group: 'logging', type: 'bool',
	  desc: 'Emit DEBUG lines to the log; the packaged default is off to spare tmpfs RAM.', units: '0 or 1' },
	{ name: 'log_DEBUG_messages_to_syslog', group: 'logging', type: 'bool', managed: true,
	  desc: 'Also send every DEBUG record to syslog (very high volume). Package-managed: the service forces this off.', units: '0 or 1' },
	{ name: 'log_to_file', group: 'logging', type: 'bool', managed: true,
	  desc: 'Write the log stream to the log file. Package-managed: the service forces this on (procd has no terminal).', units: '0 or 1' },
	{ name: 'log_file_max_time_mins', group: 'logging', type: 'integer', lo: 1,
	  desc: 'Rotate the log file once this many minutes of log lines have accumulated.', units: 'minutes, > 0' },
	{ name: 'log_file_max_size_KB', group: 'logging', type: 'integer', lo: 1,
	  desc: 'Rotate the log file once this many KB of log lines have accumulated.', units: 'KB, > 0' },
	{ name: 'log_file_path_override', group: 'logging', type: 'string', managed: true,
	  desc: 'Directory to hold the log file; empty means /var/log. Package-managed: kept empty. A non-existent directory is fatal.', units: 'absolute path to an existing directory, or empty' },
	{ name: 'log_file_buffer_size_B', group: 'logging', type: 'integer',
	  desc: 'Size of the write buffer in front of the log file.', units: 'bytes' },
	{ name: 'log_file_buffer_timeout_ms', group: 'logging', type: 'integer',
	  desc: 'Flush the log buffer after this long even if it is not full.', units: 'milliseconds' },
	{ name: 'log_file_export_compress', group: 'logging', type: 'bool',
	  desc: 'gzip exported log files and append .gz to the export filename.', units: '0 or 1' }
];

/* Expected per-group counts -- the coverage invariant (docs/uci-schema.md 6). */
var GROUP_COUNTS = {
	essentials: 8, shaper: 11, pingers: 5, reflectors: 10,
	detection: 10, idle: 8, logging: 14
};

var TOTAL_OPTIONS = 66;

/*
 * coverageReport(options) -- pure. Proves the rendered option set is exactly the
 * 66 upstream options with the expected per-group split and no duplicates. The
 * view calls this at load time and refuses to render a mismatch, so a "UI option
 * with no daemon backing" defect cannot recur silently.
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
 * optionMatches(query, name, title) -- pure. The search/filter predicate: an
 * option row is shown when the (case-insensitive, trimmed) query is empty or is
 * a substring of the option's UCI name or its human title.
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
 * RATE_TRIOS -- the two min/base/max shaper-rate groups whose ORDERING the
 * Essentials help text promises ("must be <= base", "between min and max",
 * ">= base"). Per-field datatypes cannot express a cross-field relation, so the
 * view attaches checkRateOrder() to all six fields to actually enforce it.
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
 * checkRateOrder(min, base, max) -- pure. Returns null when the trio is
 * consistent, else { code, a, b } naming the violated relation and the two
 * offending values. The view turns `code` into a localized sentence.
 *
 * Any field may be empty (rmempty: the daemon then applies its own default), so
 * a pair is only compared when BOTH of its values parse as numbers -- an
 * unfilled field must never manufacture an error.
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
 * instanceNameSuggestions(egressChoices, existingNames) -- pure. Candidate
 * instance ids for the "Add instance" field, derived from the SQM egress devices
 * (one cake-autorate instance manages one WAN, so the WAN is the natural name).
 *
 * A UCI section name must match [a-zA-Z0-9_]+, but real WAN devices frequently
 * do not -- `pppoe-wan`, `eth0.2`, `wan.835`. Offering those verbatim would
 * suggest names UCI then rejects, so each is sanitized to a valid identifier and
 * anything already configured is dropped. Returns [] when SQM is absent, which
 * is the signal to offer no suggestions at all rather than a misleading list.
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
 * composing sign/format (uinteger/ufloat) with any lo/hi bounds. Bounds are a
 * client-side UX aid only; the config bridge (task 4) is the authority on
 * type/range formatting sent to the daemon.
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
