#!/bin/sh
#
# test-rpcd.sh -- tests the rpcd backend off-device: no ubus, no rpcd, no
# jsonfilter, no router.
#
# It sources the rpcd script as a library (CAKE_AUTORATE_RPCD_LIB=1) and drives
# its functions with fixtures, checking that:
#
#   1. the SUMMARY-line parser keys off field 0 == "SUMMARY", uses the 13-field
#      layout from docs/upstream-option-inventory.md section 3.3 (the same field
#      positions the collectd reader uses), and ignores the unprefixed
#      SUMMARY_HEADER line and every other line type (DATA/LOAD/...);
#   2. per-instance status is keyed by instance, reports parsed fields for an
#      instance with data, and still returns something sensible for one whose
#      log is empty (no SUMMARY yet) or missing entirely;
#   3. the SQM interface derivation reads /etc/config/sqm plus the live ifb4*
#      devices, pairs each egress with its ifb4<iface> ingress, and flags a
#      mismatch when SQM configured an egress whose ifb device is absent;
#   4. the validators reject hostile instance names (path traversal, command
#      injection) and bad service actions before any init.d call.
#
# Exit 0 = all checks passed.

# SC2015: the `cond && ok || fail` idiom is safe -- ok() always returns 0.
# SC2016: the single-quoted hostile fixtures are literal on purpose -- we check
#         the validators reject the raw metacharacters, so they must not expand
#         here.
# shellcheck disable=SC2015,SC2016
set -u

here=$(dirname "$0")
root=$(cd "$here/../.." && pwd)
RPCD="$root/net/cake-autorate/files/cake-autorate.rpcd"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

checks=0
fails=0
ok()   { checks=$((checks + 1)); printf 'ok   %s\n' "$*"; }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); printf 'FAIL %s\n' "$*"; }

if [ ! -f "$RPCD" ]; then
	echo "FATAL: rpcd backend not found at $RPCD" >&2
	exit 1
fi

# Source the backend as a library so we can unit-test its functions.
CAKE_AUTORATE_RPCD_LIB=1
export CAKE_AUTORATE_RPCD_LIB
# shellcheck source=/dev/null
. "$RPCD"

# A valid SUMMARY line (inventory 3.3): 13 "; "-separated fields.
#  0        1                     2                 3     4    5 6 7    8   9        10      11    12
# SUMMARY; datetime;             epoch;            dlach ulach ds us dowd uowd     dlcond  ulcond cdl   cul
SUM_PRIMARY='SUMMARY; 2026-07-23-10:00:00; 1753264800.123456; 42000; 8000; 3; 1; 1200; 800; dl_high; ul_low; 45000; 9000'
# an EARLIER line in the same log (must be superseded by the last one)
SUM_PRIMARY_OLD='SUMMARY; 2026-07-23-09:59:59; 1753264799.000000; 100; 200; 0; 0; -50; -20; dl_idle; ul_idle; 20000; 20000'
# the unprefixed header line that MUST be ignored (field 0 == SUMMARY_HEADER)
SUM_HEADER='SUMMARY_HEADER; LOG_DATETIME; LOG_TIMESTAMP; DL_ACHIEVED_RATE_KBPS; UL_ACHIEVED_RATE_KBPS; DL_SUM_DELAYS; UL_SUM_DELAYS; DL_AVG_OWD_DELTA_US; UL_AVG_OWD_DELTA_US; DL_LOAD_CONDITION; UL_LOAD_CONDITION; CAKE_DL_RATE_KBPS; CAKE_UL_RATE_KBPS'
# a DATA line (field 0 == DATA) -- a different TYPE, must not be parsed as SUMMARY
DATA_LINE='DATA; 2026-07-23-10:00:00; 1753264800.1; 1753264800.1; 42000; 8000; 70; 12; 1753264800; 1.1.1.1; 42; 5000; 5200; 30; 32; 33; 5000; 5100; 20; 22; 23; 3; 1200; 60; 1; 800; 60; dl_high; ul_low; 45000; 9000'

# ==========================================================================
echo "== 1. SUMMARY parser: field layout (inventory 3.3)"
p=$(parse_summary_line "$SUM_PRIMARY")
field() { printf '%s\n' "$p" | awk -F'\t' -v k="$1" '$1==k{print $2; exit}'; }

[ "$(field dl_achieved_kbps)"   = 42000    ] && ok "field 3 -> dl_achieved_kbps=42000"   || fail "dl_achieved_kbps wrong: $(field dl_achieved_kbps)"
[ "$(field ul_achieved_kbps)"   = 8000     ] && ok "field 4 -> ul_achieved_kbps=8000"     || fail "ul_achieved_kbps wrong: $(field ul_achieved_kbps)"
[ "$(field dl_sum_delays)"      = 3        ] && ok "field 5 -> dl_sum_delays=3"            || fail "dl_sum_delays wrong: $(field dl_sum_delays)"
[ "$(field ul_sum_delays)"      = 1        ] && ok "field 6 -> ul_sum_delays=1"            || fail "ul_sum_delays wrong: $(field ul_sum_delays)"
[ "$(field dl_avg_owd_delta_us)" = 1200    ] && ok "field 7 -> dl_avg_owd_delta_us=1200"   || fail "dl_avg_owd_delta_us wrong: $(field dl_avg_owd_delta_us)"
[ "$(field ul_avg_owd_delta_us)" = 800     ] && ok "field 8 -> ul_avg_owd_delta_us=800"    || fail "ul_avg_owd_delta_us wrong: $(field ul_avg_owd_delta_us)"
[ "$(field dl_load_condition)"  = dl_high  ] && ok "field 9 -> dl_load_condition=dl_high"   || fail "dl_load_condition wrong: $(field dl_load_condition)"
[ "$(field ul_load_condition)"  = ul_low   ] && ok "field 10 -> ul_load_condition=ul_low"   || fail "ul_load_condition wrong: $(field ul_load_condition)"
[ "$(field cake_dl_rate_kbps)"  = 45000    ] && ok "field 11 -> cake_dl_rate_kbps=45000"    || fail "cake_dl_rate_kbps wrong: $(field cake_dl_rate_kbps)"
[ "$(field cake_ul_rate_kbps)"  = 9000     ] && ok "field 12 -> cake_ul_rate_kbps=9000"     || fail "cake_ul_rate_kbps wrong: $(field cake_ul_rate_kbps)"

echo
echo "== 2. SUMMARY parser: non-SUMMARY lines are rejected"
if parse_summary_line "$SUM_HEADER" >/dev/null 2>&1; then
	fail "SUMMARY_HEADER line was parsed as a SUMMARY line"
else
	ok "SUMMARY_HEADER line rejected (field 0 == SUMMARY_HEADER, not SUMMARY)"
fi
[ -z "$(parse_summary_line "$SUM_HEADER" 2>/dev/null)" ] \
	&& ok "SUMMARY_HEADER yields no field output" || fail "SUMMARY_HEADER leaked field output"
if parse_summary_line "$DATA_LINE" >/dev/null 2>&1; then
	fail "DATA line was parsed as a SUMMARY line"
else
	ok "DATA line rejected (different TYPE)"
fi
if parse_summary_line "" >/dev/null 2>&1; then
	fail "empty line was parsed as a SUMMARY line"
else
	ok "empty line rejected"
fi

# ==========================================================================
echo
echo "== 3. status: JSON keyed by instance, sensible output when data is missing"
logd="$tmp/log"; mkdir -p "$logd"
# primary: header + an old SUMMARY + the latest SUMMARY (latest must win)
{ printf '%s\n' "$SUM_HEADER"; printf '%s\n' "$SUM_PRIMARY_OLD"; printf '%s\n' "$SUM_PRIMARY"; } > "$logd/cake-autorate.primary.log"
# secondary: header only, no SUMMARY data line yet
printf '%s\n' "$SUM_HEADER" > "$logd/cake-autorate.secondary.log"
# third: no log file at all

CAKE_AUTORATE_LOG_DIR="$logd"
CAKE_AUTORATE_RUN_DIR="$tmp/run-nonexistent"
CAKE_AUTORATE_INSTANCES="primary secondary third"
export CAKE_AUTORATE_LOG_DIR CAKE_AUTORATE_RUN_DIR CAKE_AUTORATE_INSTANCES

sj=$(do_status "")
printf '%s' "$sj" | jq -e . >/dev/null 2>&1 \
	&& ok "status output is valid JSON" || { fail "status output is not valid JSON: $sj"; }

[ "$(printf '%s' "$sj" | jq -r '.primary.available')" = true ] \
	&& ok "primary.available == true" || fail "primary.available wrong"
[ "$(printf '%s' "$sj" | jq -r '.primary.cake_dl_rate_kbps')" = 45000 ] \
	&& ok "primary.cake_dl_rate_kbps == 45000 (from the LAST SUMMARY, header ignored)" \
	|| fail "primary.cake_dl_rate_kbps wrong: $(printf '%s' "$sj" | jq -r '.primary.cake_dl_rate_kbps')"
[ "$(printf '%s' "$sj" | jq -r '.primary.ul_load_condition')" = ul_low ] \
	&& ok "primary.ul_load_condition == ul_low" || fail "primary.ul_load_condition wrong"
# numeric fields must be JSON numbers, not strings
[ "$(printf '%s' "$sj" | jq -r '.primary.dl_achieved_kbps | type')" = number ] \
	&& ok "primary.dl_achieved_kbps is a JSON number" || fail "dl_achieved_kbps not a JSON number"
[ "$(printf '%s' "$sj" | jq -r '.primary.dl_load_condition | type')" = string ] \
	&& ok "primary.dl_load_condition is a JSON string" || fail "load condition not a JSON string"

[ "$(printf '%s' "$sj" | jq -r '.secondary.available')" = false ] \
	&& ok "secondary.available == false (empty log, no SUMMARY yet)" || fail "secondary.available wrong"
[ "$(printf '%s' "$sj" | jq -r '.secondary.reason')" = no-data ] \
	&& ok "secondary.reason == no-data" || fail "secondary.reason wrong: $(printf '%s' "$sj" | jq -r '.secondary.reason')"
[ "$(printf '%s' "$sj" | jq -r '.third.available')" = false ] \
	&& ok "third.available == false (log file missing)" || fail "third.available wrong"
[ "$(printf '%s' "$sj" | jq -r '.third.reason')" = no-log ] \
	&& ok "third.reason == no-log" || fail "third.reason wrong: $(printf '%s' "$sj" | jq -r '.third.reason')"

# a negative OWD delta (valid) must survive as a signed JSON number
logd2="$tmp/log2"; mkdir -p "$logd2"
{ printf '%s\n' "$SUM_HEADER"; printf '%s\n' "$SUM_PRIMARY_OLD"; } > "$logd2/cake-autorate.neg.log"
neg=$(CAKE_AUTORATE_LOG_DIR="$logd2" status_instance_json neg)
[ "$(printf '%s' "$neg" | jq -r '.dl_avg_owd_delta_us')" = -50 ] \
	&& ok "negative OWD delta preserved as signed number (-50)" \
	|| fail "negative delta wrong: $(printf '%s' "$neg" | jq -r '.dl_avg_owd_delta_us')"

# a single-instance status query returns only that instance
one=$(do_status primary)
[ "$(printf '%s' "$one" | jq -r 'keys | join(",")')" = primary ] \
	&& ok "status {instance:primary} returns only that instance" \
	|| fail "single-instance query wrong: $(printf '%s' "$one" | jq -r 'keys|join(",")')"

# ==========================================================================
echo
echo "== 3b. status: a log ending mid-line is still live (chunked-writer artefact)"
# Upstream's log writer flushes a fixed COUNT of characters, not whole lines
# (`read -N ${log_file_buffer_size_B}` in maintain_log_file), so a live log
# almost always ends part-way through a line. That fragment still starts with
# "SUMMARY; ", and taking it as the newest sample is what made the status view
# flip to "no data yet" between polls while the daemon was writing ~20 SUMMARY
# lines a second. The newest COMPLETE line must win instead.
logd3="$tmp/log3"; mkdir -p "$logd3"

# (a) cut early in the line: 3 fields, no trailing newline
{
	printf '%s\n' "$SUM_HEADER"
	printf '%s\n' "$SUM_PRIMARY_OLD"
	printf '%s\n' "$SUM_PRIMARY"
	printf 'SUMMARY; 2026-07-23-10:00:01; 17532648'
} > "$logd3/cake-autorate.chunkedearly.log"

# (b) cut inside the LAST field: 13 fields, but "90" is really "9000" truncated.
# Field count alone cannot catch this one -- only the missing newline can.
{
	printf '%s\n' "$SUM_HEADER"
	printf '%s\n' "$SUM_PRIMARY_OLD"
	printf '%s\n' "$SUM_PRIMARY"
	printf 'SUMMARY; 2026-07-23-10:00:01; 1753264801.5; 42000; 8000; 3; 1; 1200; 800; dl_high; ul_low; 45000; 90'
} > "$logd3/cake-autorate.chunkedlate.log"

# (c) freshly rotated: the live log holds only the header, the data is in .old.
# Upstream rotates on log_file_max_time_mins whether or not the daemon has
# anything to say, and it says nothing while it sleeps through an idle link.
printf '%s\n' "$SUM_HEADER" > "$logd3/cake-autorate.rotated.log"
{ printf '%s\n' "$SUM_HEADER"; printf '%s\n' "$SUM_PRIMARY_OLD"; } > "$logd3/cake-autorate.rotated.log.old"

ce=$(CAKE_AUTORATE_LOG_DIR="$logd3" status_instance_json chunkedearly)
[ "$(printf '%s' "$ce" | jq -r '.available')" = true ] \
	&& ok "trailing fragment (3 fields) does not blank the status" \
	|| fail "trailing fragment reported unavailable: $ce"
[ "$(printf '%s' "$ce" | jq -r '.cake_dl_rate_kbps')" = 45000 ] \
	&& ok "trailing fragment ignored, last COMPLETE SUMMARY used (45000)" \
	|| fail "wrong line used: $(printf '%s' "$ce" | jq -r '.cake_dl_rate_kbps')"

cl=$(CAKE_AUTORATE_LOG_DIR="$logd3" status_instance_json chunkedlate)
[ "$(printf '%s' "$cl" | jq -r '.cake_ul_rate_kbps')" = 9000 ] \
	&& ok "fragment cut inside the last field ignored (9000, not the truncated 90)" \
	|| fail "truncated final field leaked through: $(printf '%s' "$cl" | jq -r '.cake_ul_rate_kbps')"

ro=$(CAKE_AUTORATE_LOG_DIR="$logd3" status_instance_json rotated)
[ "$(printf '%s' "$ro" | jq -r '.available')" = true ] \
	&& ok "freshly rotated log falls back to .old instead of 'no data yet'" \
	|| fail "rotated log reported unavailable: $ro"
[ "$(printf '%s' "$ro" | jq -r '.cake_dl_rate_kbps')" = 20000 ] \
	&& ok "rotated fallback reports the .old sample (20000)" \
	|| fail "rotated fallback wrong: $(printf '%s' "$ro" | jq -r '.cake_dl_rate_kbps')"

# newest_summary_line on a log with no complete SUMMARY at all prints nothing,
# and a missing file is not an error.
printf 'SUMMARY; 2026-07-23-10:00:01; 17532648' > "$logd3/frag-only.log"
[ -z "$(newest_summary_line "$logd3/frag-only.log")" ] \
	&& ok "a log holding only a fragment yields no line" || fail "fragment-only log yielded a line"
[ -z "$(newest_summary_line "$logd3/nosuchfile.log")" ] \
	&& ok "missing file yields no line" || fail "missing file yielded a line"

# age_s: how stale the newest sample is, by the router's clock. The daemon stops
# emitting SUMMARY lines while it sleeps, so the view needs to say so.
nowts=$(date +%s)
{
	printf '%s\n' "$SUM_HEADER"
	printf 'SUMMARY; 2026-07-23-10:00:00; %s.000000; 42000; 8000; 3; 1; 1200; 800; dl_high; ul_low; 45000; 9000\n' "$((nowts - 90))"
} > "$logd3/cake-autorate.aged.log"
ag=$(CAKE_AUTORATE_LOG_DIR="$logd3" status_instance_json aged)
agev=$(printf '%s' "$ag" | jq -r '.age_s')
[ "$(printf '%s' "$ag" | jq -r '.age_s | type')" = number ] \
	&& ok "age_s is a JSON number" || fail "age_s not a number: $ag"
[ "${agev:-0}" -ge 85 ] && [ "${agev:-0}" -le 150 ] \
	&& ok "age_s reports a 90s-old sample as ~90s ($agev)" || fail "age_s wrong: $agev"

# a sample stamped in the future (clock skew) must clamp to 0, never go negative
{
	printf '%s\n' "$SUM_HEADER"
	printf 'SUMMARY; 2026-07-23-10:00:00; %s.000000; 42000; 8000; 3; 1; 1200; 800; dl_high; ul_low; 45000; 9000\n' "$((nowts + 600))"
} > "$logd3/cake-autorate.future.log"
fu=$(CAKE_AUTORATE_LOG_DIR="$logd3" status_instance_json future | jq -r '.age_s')
[ "$fu" = 0 ] && ok "a future-stamped sample clamps age_s to 0" || fail "future sample age_s wrong: $fu"

# ==========================================================================
echo
echo "== 4. sqm_interfaces: SQM-derived choices + mismatch detection"
cat > "$tmp/sqm" <<'EOF'
config queue 'eth1'
	option interface 'eth1'
	option enabled '1'
	option qdisc 'cake'

config queue 'eth2'
	option interface 'eth2'
	option enabled '1'
	option qdisc 'cake'

config queue 'lan_disabled'
	option interface 'eth3'
	option enabled '0'
EOF
# live ifb devices: only ifb4eth1 exists (SQM ran for eth1 only)
netd="$tmp/net"; mkdir -p "$netd"
: > "$netd/eth0"; : > "$netd/ifb4eth1"; : > "$netd/lo"

ij=$(CAKE_AUTORATE_SQM_CONFIG="$tmp/sqm" CAKE_AUTORATE_NET_DIR="$netd" do_sqm_interfaces)
printf '%s' "$ij" | jq -e . >/dev/null 2>&1 \
	&& ok "sqm_interfaces output is valid JSON" || { fail "sqm_interfaces not valid JSON: $ij"; }

[ "$(printf '%s' "$ij" | jq -r '.sqm_config_present')" = true ] \
	&& ok "sqm_config_present == true" || fail "sqm_config_present wrong"

# eth1: ifb4eth1 present -> valid, no mismatch
e1=$(printf '%s' "$ij" | jq -c '.interfaces[] | select(.egress=="eth1")')
[ "$(printf '%s' "$e1" | jq -r '.ingress_ifb')" = ifb4eth1 ] \
	&& ok "eth1 pairs with ingress ifb4eth1" || fail "eth1 ingress_ifb wrong: $e1"
[ "$(printf '%s' "$e1" | jq -r '.ifb_present')" = true ] \
	&& ok "eth1 ifb_present == true" || fail "eth1 ifb_present wrong: $e1"
[ "$(printf '%s' "$e1" | jq -r '.mismatch')" = false ] \
	&& ok "eth1 mismatch == false (SQM built its ifb)" || fail "eth1 mismatch wrong: $e1"

# eth2: enabled in SQM but ifb4eth2 absent -> MISMATCH
e2=$(printf '%s' "$ij" | jq -c '.interfaces[] | select(.egress=="eth2")')
[ "$(printf '%s' "$e2" | jq -r '.ifb_present')" = false ] \
	&& ok "eth2 ifb_present == false (ifb4eth2 not created)" || fail "eth2 ifb_present wrong: $e2"
[ "$(printf '%s' "$e2" | jq -r '.mismatch')" = true ] \
	&& ok "eth2 mismatch == true (enabled SQM egress with no ifb qdisc)" || fail "eth2 mismatch wrong: $e2"

# what the UI binds: ul_if <- egress_choices, dl_if <- ingress_choices
[ "$(printf '%s' "$ij" | jq -r '.egress_choices | index("eth1") != null and index("eth2") != null')" = true ] \
	&& ok "egress_choices (ul_if) includes eth1 and eth2" || fail "egress_choices wrong: $(printf '%s' "$ij" | jq -c '.egress_choices')"
[ "$(printf '%s' "$ij" | jq -r '.ingress_choices | index("ifb4eth1") != null')" = true ] \
	&& ok "ingress_choices (dl_if) includes the live ifb4eth1" || fail "ingress_choices wrong: $(printf '%s' "$ij" | jq -c '.ingress_choices')"
[ "$(printf '%s' "$ij" | jq -r '.ifb_devices | index("ifb4eth1") != null')" = true ] \
	&& ok "ifb_devices lists live ifb4eth1" || fail "ifb_devices wrong: $(printf '%s' "$ij" | jq -c '.ifb_devices')"

# no SQM config at all -> present:false, empty choices, still valid JSON
ij0=$(CAKE_AUTORATE_SQM_CONFIG="$tmp/nosuchsqm" CAKE_AUTORATE_NET_DIR="$netd" do_sqm_interfaces)
[ "$(printf '%s' "$ij0" | jq -r '.sqm_config_present')" = false ] \
	&& ok "missing /etc/config/sqm -> sqm_config_present == false" || fail "missing sqm not handled: $ij0"

# ==========================================================================
echo
echo "== 5. validators: reject path traversal / command injection / bad action"
for bad in '../../etc/x' 'a;reboot' 'a b' 'a/b' 'a\$(reboot)' '' 'a;rm -rf /'; do
	if valid_instance "$bad"; then
		fail "valid_instance ACCEPTED hostile name: [$bad]"
	else
		ok "valid_instance rejected hostile name: [$bad]"
	fi
done
for good in primary wan_lte wan_dsl2 A_1; do
	valid_instance "$good" && ok "valid_instance accepted [$good]" || fail "valid_instance rejected legit [$good]"
done

for bad in bogus 'start;reboot' 'restart x' '' 'START' 'stop ; rm'; do
	if valid_action "$bad"; then
		fail "valid_action ACCEPTED bad action: [$bad]"
	else
		ok "valid_action rejected bad action: [$bad]"
	fi
done
for good in start stop restart reload; do
	valid_action "$good" && ok "valid_action accepted [$good]" || fail "valid_action rejected legit [$good]"
done

echo
echo "== 6. service dispatch: no init.d call on invalid input; correct call on valid"
stub="$tmp/init-stub"
marker="$tmp/init-marker"
cat > "$stub" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$marker"
exit 0
EOF
chmod +x "$stub"
: > "$marker"
CAKE_AUTORATE_INIT="$stub"; export CAKE_AUTORATE_INIT

# hostile action must be rejected BEFORE the init script is touched
if do_service 'start;reboot' '' >/dev/null 2>&1; then
	fail "do_service ran with a hostile action"
else
	ok "do_service rejected hostile action (exit non-zero)"
fi
[ ! -s "$marker" ] && ok "init.d was NOT invoked for the hostile action" || fail "init.d WAS invoked for hostile action: $(cat "$marker")"

# hostile instance must be rejected BEFORE the init script is touched
: > "$marker"
if do_service restart '../../etc/x' >/dev/null 2>&1; then
	fail "do_service ran with a path-traversal instance"
else
	ok "do_service rejected path-traversal instance"
fi
[ ! -s "$marker" ] && ok "init.d was NOT invoked for the hostile instance" || fail "init.d WAS invoked for hostile instance: $(cat "$marker")"

# a valid action+instance must invoke the init script with exactly those args
: > "$marker"
sv=$(do_service restart primary 2>/dev/null)
printf '%s' "$sv" | jq -e . >/dev/null 2>&1 && ok "service result is valid JSON" || fail "service result not JSON: $sv"
grep -qx 'restart primary' "$marker" && ok "init.d invoked as 'cake-autorate restart primary'" || fail "init.d args wrong: $(cat "$marker")"
[ "$(printf '%s' "$sv" | jq -r '.action')" = restart ] && ok "service JSON echoes action=restart" || fail "service action wrong: $sv"

# a whole-service action (no instance) invokes without an instance arg
: > "$marker"
do_service reload '' >/dev/null 2>&1
grep -qx 'reload' "$marker" && ok "init.d invoked as 'cake-autorate reload' (no instance)" || fail "whole-service call wrong: $(cat "$marker")"

# ==========================================================================
echo
if [ "$fails" -eq 0 ]; then
	echo "PASS: $checks/$checks checks passed"
	exit 0
fi
echo "FAIL: $fails of $checks checks failed"
exit 1
