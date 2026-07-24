#!/bin/sh
#
# cake-autorate -> collectd exec reader
# =====================================
# Owned by task 6 (statistics). Installed to
#   /usr/libexec/collectd/cake-autorate-collectd.sh
# and driven by the collectd `exec` plugin (see cake-autorate.collectd.conf).
#
# WHY exec (not the tail plugin):
#   * The daemon's load/bufferbloat state is a STRING (dl_idle/dl_low/dl_high,
#     +"_bb" on a bufferbloat event). collectd's tail plugin can only capture a
#     NUMERIC value from a regex group -- it cannot map an arbitrary matched
#     string to a constant number, so the load gauge is not expressible in tail.
#   * The collectd plugin instance must equal the cake-autorate instance id so a
#     multi-WAN setup produces distinct RRDs. The instance id is only known from
#     the log FILENAME (cake-autorate.<id>.log); a static tail <File> block
#     cannot label an unknown, user-defined set of instances. exec derives the
#     id per file at runtime.
#
# INPUT CONTRACT (docs/upstream-option-inventory.md section 3, verified against
# upstream cake-autorate.sh:1483):
#   A SUMMARY line has 13 "; "-separated fields; field 0 == "SUMMARY".
#   0-based indices ( -> awk 1-based field in parentheses ):
#     3(=$4)  DL_ACHIEVED_RATE_KBPS   4(=$5)  UL_ACHIEVED_RATE_KBPS
#     5(=$6)  DL_SUM_DELAYS           6(=$7)  UL_SUM_DELAYS
#     7(=$8)  DL_AVG_OWD_DELTA_US     8(=$9)  UL_AVG_OWD_DELTA_US
#     9(=$10) DL_LOAD_CONDITION      10(=$11) UL_LOAD_CONDITION
#    11(=$12) CAKE_DL_RATE_KBPS      12(=$13) CAKE_UL_RATE_KBPS
#   The SUMMARY_HEADER line is written WITHOUT the "TYPE; datetime; timestamp"
#   prefix, so its field 0 is "SUMMARY_HEADER" (!= "SUMMARY") and it is ignored
#   naturally by the exact field-0 match below.
#
# EXPORTED METRICS (reusing stock collectd types so no custom types.db /
# TypesDB wiring is required -- avoids a fragile deployment dependency):
#   bitrate-dl_achieved     bitrate-ul_achieved     achieved rate/direction (kbit/s)
#   bitrate-dl_shaper       bitrate-ul_shaper        CAKE shaper rate/direction (kbit/s)
#   gauge-dl_owd_delta_us   gauge-ul_owd_delta_us    avg OWD delta/direction (us)
#   gauge-dl_load           gauge-ul_load            load/bufferbloat state (see mapping)
# OWD delta uses the UNBOUNDED `gauge` type (not `delay`, which clamps to +/-1e6
# and would drop severe-bufferbloat samples).
#
# LOAD-CONDITION STRING -> NUMERIC GAUGE MAPPING:
#     dl_idle / ul_idle  -> 0   (connection idle)
#     dl_low  / ul_low   -> 1   (low load)
#     dl_high / ul_high  -> 2   (high load)
#     ...with "_bb" suffix (bufferbloat event) -> add 10:
#       *_idle_bb -> 10   *_low_bb -> 11   *_high_bb -> 12
#     anything unrecognised -> -1
#   So a value >= 10 means "bufferbloat currently flagged"; value % 10 is the
#   load level 0/1/2. Keep this identical to the status backend (task 8), which
#   parses the same field.
#
# MODES:
#   * No arguments  (collectd exec):  loop until orphaned, once per
#     $COLLECTD_INTERVAL, over /var/log/cake-autorate.*.log (falling back to
#     <log>.old when the current file holds no SUMMARY line yet).
#   * File arguments (tests / manual): one pass over exactly those files, print,
#     exit. The instance id is still parsed from each filename.

set -u

HOSTNAME="${COLLECTD_HOSTNAME:-localhost}"
INTERVAL="${COLLECTD_INTERVAL:-30}"
INTERVAL="${INTERVAL%%.*}"                 # collectd may pass a float; want int
[ -n "$INTERVAL" ] && [ "$INTERVAL" -ge 1 ] 2>/dev/null || INTERVAL=30

LOG_GLOB='/var/log/cake-autorate.*.log'

# instance_id_from_path <path>  ->  echoes the <id> in cake-autorate.<id>.log
instance_id_from_path() {
	base=${1##*/}                      # strip directory
	base=${base#cake-autorate.}        # strip leading "cake-autorate."
	base=${base%.log}                  # strip trailing ".log"
	printf '%s' "$base"
}

# emit_metrics <instance_id> <summary_line>
# Parses one SUMMARY line and prints its PUTVAL lines. Non-SUMMARY input
# (including the unprefixed SUMMARY_HEADER) and short/malformed lines print
# nothing.
emit_metrics() {
	printf '%s\n' "$2" | awk \
		-v host="$HOSTNAME" -v inst="$1" -v ival="$INTERVAL" \
		-F'; ' '
		function loadnum(s,   n) {
			n = -1
			if (s ~ /idle/)      n = 0
			else if (s ~ /low/)  n = 1
			else if (s ~ /high/) n = 2
			if (n >= 0 && s ~ /_bb/) n += 10   # bufferbloat overlay
			return n
		}
		function put(type_inst, value) {
			printf "PUTVAL \"%s/cake_autorate-%s/%s\" interval=%s N:%s\n", \
				host, inst, type_inst, ival, value
		}
		$1 != "SUMMARY" { next }               # ignores SUMMARY_HEADER & all else
		NF < 13         { next }               # malformed / truncated guard
		{
			put("bitrate-dl_achieved", $4)
			put("bitrate-ul_achieved", $5)
			# OWD delta uses the UNBOUNDED gauge type, not delay: the stock
			# collectd delay type clamps to +/-1e6, which would silently drop
			# severe-bufferbloat samples above 1,000,000 us -- exactly when the
			# graph matters most. gauge is U:U so the spike is recorded.
			put("gauge-dl_owd_delta_us", $8)
			put("gauge-ul_owd_delta_us", $9)
			put("gauge-dl_load",       loadnum($10))
			put("gauge-ul_load",       loadnum($11))
			put("bitrate-dl_shaper",   $12)
			put("bitrate-ul_shaper",   $13)
		}
	'
}

# process_file <path> -- report the newest SUMMARY line for one instance,
# falling back to the rotated <path>.old when the current file has none.
process_file() {
	logf=$1
	[ -f "$logf" ] || return 0
	inst=$(instance_id_from_path "$logf")
	[ -n "$inst" ] || return 0

	# Only the NEWEST SUMMARY is reported, and SUMMARY lines are frequent (one per
	# processed ping response), so bound the read with `tail` first instead of
	# grepping the whole file -- the log is clamped up to 100 MB and this runs
	# every interval as `nobody` on a possibly low-power router. Mirrors the
	# bounded read the rpcd status path uses on the same log.
	line=$(tail -n 1000 "$logf" 2>/dev/null | grep '^SUMMARY; ' | tail -n 1)
	if [ -z "$line" ] && [ -f "$logf.old" ]; then
		line=$(tail -n 1000 "$logf.old" 2>/dev/null | grep '^SUMMARY; ' | tail -n 1)
	fi
	[ -n "$line" ] || return 0

	emit_metrics "$inst" "$line"
}

one_pass() {
	if [ "$#" -gt 0 ]; then
		# explicit file list (tests / manual invocation)
		for logf in "$@"; do
			process_file "$logf"
		done
	else
		# collectd mode: scan the glob (guard the no-match case)
		for logf in $LOG_GLOB; do
			[ -e "$logf" ] || continue
			process_file "$logf"
		done
	fi
}

# One-shot when given file arguments; otherwise run as a collectd exec daemon:
# emit once per interval and stop when collectd (our parent) goes away.
if [ "$#" -gt 0 ]; then
	one_pass "$@"
	exit 0
fi

while [ "$(awk '$1 == "PPid:" { print $2; exit }' "/proc/$$/status" 2>/dev/null)" != "1" ]; do
	one_pass
	sleep "$INTERVAL"
done
