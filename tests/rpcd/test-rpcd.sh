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

# the fixture above declares no rates at all -> both rates report 0, not null
[ "$(printf '%s' "$ij" | jq -r '.interfaces[] | select(.egress=="eth1") | .download_kbps')" = 0 ] \
	&& ok "section with no download/upload option -> download_kbps == 0" || fail "rate-less download_kbps wrong: $e1"
[ "$(printf '%s' "$ij" | jq -r '.interfaces[] | select(.egress=="eth1") | .upload_kbps')" = 0 ] \
	&& ok "section with no download/upload option -> upload_kbps == 0" || fail "rate-less upload_kbps wrong: $e1"

# ==========================================================================
echo
echo "== 4b. sqm_interfaces: SQM's configured download/upload rates (Kbit/s)"
# sqm-scripts stores both rates in Kbit/s -- cake-autorate's own unit, so the
# backend passes them through untouched. '0' is sqm-scripts' "no limit"
# sentinel and a non-numeric value carries no rate; both must surface as 0 so
# the JSON stays a bare number for every consumer.
cat > "$tmp/sqm-rates" <<'EOF'
config queue 'wan'
	option interface 'eth1'
	option enabled '1'
	option download '90000'
	option upload '11000'
	option qdisc 'cake'

config queue 'zero'
	option interface 'eth2'
	option enabled '1'
	option download '0'
	option upload '4500'

config queue 'bare'
	option interface 'eth3'
	option enabled '1'

config queue 'nonnum'
	option interface 'eth4'
	option enabled '1'
	option download 'auto'
	option upload '12mbit'

config queue 'leadingzero'
	option interface 'eth5'
	option enabled '1'
	option download '0090000'
	option upload '-5000'
EOF

ir=$(CAKE_AUTORATE_SQM_CONFIG="$tmp/sqm-rates" CAKE_AUTORATE_NET_DIR="$netd" do_sqm_interfaces)
printf '%s' "$ir" | jq -e . >/dev/null 2>&1 \
	&& ok "sqm_interfaces with rates is valid JSON" || { fail "rates output not valid JSON: $ir"; }

# both rates set -> passed through verbatim, as JSON numbers
r1=$(printf '%s' "$ir" | jq -c '.interfaces[] | select(.egress=="eth1")')
[ "$(printf '%s' "$ir" | jq -r '.interfaces[0].download_kbps')" = 90000 ] \
	&& ok "interfaces[0].download_kbps == 90000" || fail "download_kbps wrong: $r1"
[ "$(printf '%s' "$ir" | jq -r '.interfaces[0].upload_kbps')" = 11000 ] \
	&& ok "interfaces[0].upload_kbps == 11000" || fail "upload_kbps wrong: $r1"
[ "$(printf '%s' "$r1" | jq -r '.download_kbps | type')" = number ] \
	&& ok "download_kbps is a JSON number, not a string" || fail "download_kbps not a JSON number: $r1"
[ "$(printf '%s' "$r1" | jq -r '.upload_kbps | type')" = number ] \
	&& ok "upload_kbps is a JSON number, not a string" || fail "upload_kbps not a JSON number: $r1"

# the four-field split must not disturb the fields that were already there
[ "$(printf '%s' "$r1" | jq -r '.ingress_ifb')" = ifb4eth1 ] \
	&& ok "rates present: eth1 still pairs with ifb4eth1" || fail "eth1 ingress_ifb wrong with rates: $r1"
[ "$(printf '%s' "$r1" | jq -r '.sqm_enabled')" = true ] \
	&& ok "rates present: eth1 sqm_enabled still true" || fail "eth1 sqm_enabled wrong with rates: $r1"
[ "$(printf '%s' "$r1" | jq -r '.mismatch')" = false ] \
	&& ok "rates present: eth1 mismatch still false" || fail "eth1 mismatch wrong with rates: $r1"

# download '0' (sqm-scripts' no-limit sentinel) -> 0, and the sibling rate survives
r2=$(printf '%s' "$ir" | jq -c '.interfaces[] | select(.egress=="eth2")')
[ "$(printf '%s' "$r2" | jq -r '.download_kbps')" = 0 ] \
	&& ok "download '0' -> download_kbps == 0" || fail "zero download wrong: $r2"
[ "$(printf '%s' "$r2" | jq -r '.upload_kbps')" = 4500 ] \
	&& ok "download '0' does not clobber upload_kbps (4500)" || fail "sibling upload wrong: $r2"
[ "$(printf '%s' "$r2" | jq -r '.mismatch')" = true ] \
	&& ok "rates present: eth2 mismatch still true (no ifb4eth2)" || fail "eth2 mismatch wrong with rates: $r2"

# neither option present -> both 0 (defaults must not leak from the section above)
r3=$(printf '%s' "$ir" | jq -c '.interfaces[] | select(.egress=="eth3")')
[ "$(printf '%s' "$r3" | jq -r '.download_kbps')" = 0 ] \
	&& ok "no download option -> download_kbps == 0" || fail "missing download wrong: $r3"
[ "$(printf '%s' "$r3" | jq -r '.upload_kbps')" = 0 ] \
	&& ok "no upload option -> upload_kbps == 0" || fail "missing upload wrong: $r3"

# a non-numeric rate must degrade to 0 rather than emit invalid JSON
r4=$(printf '%s' "$ir" | jq -c '.interfaces[] | select(.egress=="eth4")')
[ "$(printf '%s' "$r4" | jq -r '.download_kbps')" = 0 ] \
	&& ok "non-numeric download ('auto') -> 0" || fail "non-numeric download wrong: $r4"
[ "$(printf '%s' "$r4" | jq -r '.upload_kbps')" = 0 ] \
	&& ok "non-numeric upload ('12mbit') -> 0" || fail "non-numeric upload wrong: $r4"

# JSON forbids a leading zero and a rate cannot be negative -- emitting either
# verbatim would make the whole object unparseable for every consumer.
r5=$(printf '%s' "$ir" | jq -c '.interfaces[] | select(.egress=="eth5")')
[ "$(printf '%s' "$r5" | jq -r '.download_kbps')" = 0 ] \
	&& ok "leading-zero download ('0090000') -> 0, never an invalid JSON number" || fail "leading-zero download wrong: $r5"
[ "$(printf '%s' "$r5" | jq -r '.upload_kbps')" = 0 ] \
	&& ok "negative upload ('-5000') -> 0" || fail "negative upload wrong: $r5"

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
echo "== 7. rrdtool fetch parser: valid samples only, from RRDtool 1.0.x output"
# RRDtool on OpenWrt is 1.0.x (`rrdtool1` is the only rrdtool in the feed, and is
# what luci-app-statistics depends on). `fetch` is its only export verb --
# `xport` arrived in RRDtool 1.2 -- and its `fetch` output is a header line of DS
# names, a blank line, then "<timestamp>: <value>" rows whose value formatting and
# NaN spelling are of their era. The three fixtures capture that shape; if the
# real on-device format ever differs, only rrd_samples and those files change.
FIXD="$root/tests/rpcd/fixtures"

# -- the normal run: exact values, so a mis-parsed exponent cannot pass as
#    "some number" ------------------------------------------------------------
rrd_samples < "$FIXD/rrdtool-fetch-normal.txt" > "$tmp/samples-normal"
want='12345.678900
12000.000000
11980.000000
9900.000000
45000.000000'
[ "$(cat "$tmp/samples-normal")" = "$want" ] \
	&& ok "normal fixture -> exactly the 5 valid samples, exponents expanded" \
	|| fail "normal fixture parsed wrong: $(cat "$tmp/samples-normal")"
[ "$(rrd_sample_count < "$tmp/samples-normal")" = 5 ] \
	&& ok "normal fixture -> reported sample count 5 (3 nan rows dropped)" \
	|| fail "normal count wrong: $(rrd_sample_count < "$tmp/samples-normal")"
# 1.2345678900e+04 must become 12345.6789, not 1.234568 or 1
head -n1 "$tmp/samples-normal" | grep -qx '12345.678900' \
	&& ok "scientific notation 1.2345678900e+04 -> plain 12345.678900" \
	|| fail "exponent conversion wrong: $(head -n1 "$tmp/samples-normal")"
# the header line carries no colon and must never reach the output
grep -q 'value' "$tmp/samples-normal" \
	&& fail "header line leaked into the sample stream" \
	|| ok "header line ('value', no colon) skipped"

# -- the all-nan run: zero lines out, count 0 ---------------------------------
rrd_samples < "$FIXD/rrdtool-fetch-all-nan.txt" > "$tmp/samples-nan"
[ ! -s "$tmp/samples-nan" ] \
	&& ok "all-nan fixture -> zero output lines" \
	|| fail "all-nan fixture emitted output: $(cat "$tmp/samples-nan")"
[ "$(rrd_sample_count < "$tmp/samples-nan")" = 0 ] \
	&& ok "all-nan fixture -> reported count 0 (nan/-nan/NaN all dropped)" \
	|| fail "all-nan count wrong: $(rrd_sample_count < "$tmp/samples-nan")"

# -- the empty/near-empty run: header only ------------------------------------
rrd_samples < "$FIXD/rrdtool-fetch-empty.txt" > "$tmp/samples-empty"
[ ! -s "$tmp/samples-empty" ] \
	&& ok "header-only fixture -> zero output lines" \
	|| fail "header-only fixture emitted output: $(cat "$tmp/samples-empty")"
[ "$(rrd_sample_count < "$tmp/samples-empty")" = 0 ] \
	&& ok "header-only fixture -> reported count 0" \
	|| fail "header-only count wrong: $(rrd_sample_count < "$tmp/samples-empty")"
[ "$(rrd_sample_count < /dev/null)" = 0 ] \
	&& ok "rrd_sample_count on empty input == 0 (a bare number, not padded)" \
	|| fail "empty-input count wrong: [$(rrd_sample_count < /dev/null)]"

# -- ragged output: RRDtool 1.0.x formatting we cannot pin down ---------------
# Built with printf rather than a fixture file so the trailing whitespace and the
# whitespace-only line survive any future whitespace-stripping tooling.
printf '%s\n' \
	'                           value' \
	'' \
	'1754006400: 1.0000000000e+03   ' \
	'1754006430:' \
	'1754006460: UNKN' \
	'1754006490: U' \
	'   ' \
	'1754006520: 2.5000000000e+03' \
	'1754006550: 42' \
	'1754006580: 0.5' \
	> "$tmp/fetch-ragged"
rrd_samples < "$tmp/fetch-ragged" > "$tmp/samples-ragged"
want_ragged='1000.000000
2500.000000
42.000000
0.500000'
[ "$(cat "$tmp/samples-ragged")" = "$want_ragged" ] \
	&& ok "ragged output: trailing whitespace, empty rows, UNKN and U tolerated without garbage" \
	|| fail "ragged output parsed wrong: $(cat "$tmp/samples-ragged")"
[ "$(rrd_sample_count < "$tmp/samples-ragged")" = 4 ] \
	&& ok "ragged output -> reported count 4" \
	|| fail "ragged count wrong: $(rrd_sample_count < "$tmp/samples-ragged")"

# -- the invocation is `rrdtool fetch <file> AVERAGE ...`, never xport --------
rrdstub="$tmp/rrdtool-stub"
rrdargs="$tmp/rrdtool-args"
cat > "$rrdstub" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$rrdargs"
cat "$FIXD/rrdtool-fetch-normal.txt"
EOF
chmod +x "$rrdstub"
: > "$rrdargs"
: > "$tmp/fake.rrd"

piped=$(CAKE_AUTORATE_RRDTOOL="$rrdstub" rrd_fetch "$tmp/fake.rrd" --start end-6h | rrd_samples | rrd_sample_count)
grep -qx "fetch $tmp/fake.rrd AVERAGE --start end-6h" "$rrdargs" \
	&& ok "rrd_fetch invokes 'rrdtool fetch <file> AVERAGE --start end-6h'" \
	|| fail "rrd_fetch argv wrong: $(cat "$rrdargs")"
grep -q 'xport' "$rrdargs" \
	&& fail "rrd_fetch used xport, which RRDtool 1.0.x does not have" \
	|| ok "rrd_fetch never invokes xport (absent before RRDtool 1.2)"
[ "$piped" = 5 ] \
	&& ok "rrd_fetch | rrd_samples | rrd_sample_count == 5 end to end" \
	|| fail "end-to-end pipe wrong: $piped"

# a missing RRD or a missing rrdtool is a normal state on a fresh install: fail
# quietly rather than erroring, and never reach the binary for a file that is not
# there.
: > "$rrdargs"
if CAKE_AUTORATE_RRDTOOL="$rrdstub" rrd_fetch "$tmp/no-such.rrd" >/dev/null 2>&1; then
	fail "rrd_fetch succeeded for a missing RRD"
else
	ok "rrd_fetch returns non-zero for a missing RRD"
fi
[ ! -s "$rrdargs" ] \
	&& ok "rrdtool was NOT invoked for a missing RRD" \
	|| fail "rrdtool WAS invoked for a missing RRD: $(cat "$rrdargs")"
if CAKE_AUTORATE_RRDTOOL="$tmp/no-such-rrdtool" rrd_fetch "$tmp/fake.rrd" >/dev/null 2>&1; then
	fail "rrd_fetch succeeded with no rrdtool binary"
else
	ok "rrd_fetch returns non-zero when rrdtool is absent"
fi

# the strongest form of the constraint: no CODE path in the backend can reach
# xport. Comment lines are excluded because the header deliberately explains why
# xport is unusable; -w keeps the word "export" from matching.
if grep -v '^[[:space:]]*#' "$RPCD" | grep -qw 'xport'; then
	fail "the rpcd backend has code mentioning xport, absent from RRDtool 1.0.x"
else
	ok "no code path in the rpcd backend can reach xport"
fi

# ==========================================================================
echo
if [ "$fails" -eq 0 ]; then
	echo "PASS: $checks/$checks checks passed"
	exit 0
fi
echo "FAIL: $fails of $checks checks failed"
exit 1
