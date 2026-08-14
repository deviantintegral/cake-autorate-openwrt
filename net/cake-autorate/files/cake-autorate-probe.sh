#!/bin/sh
# cake-autorate-probe -- does your shaper own the queue, or does the link?
#
# On a radio link (5G/LTE/WISP) much of the loaded latency comes from the RAN
# uplink scheduler, not from a queue on your router. Shaping cannot remove that
# part, and cake-autorate will chase it forever if its delay thresholds sit
# below it. This separates the two by watching CAKE's own egress backlog:
#
#   backlog > 0 during upload      -> CAKE is holding the queue; SQM is working
#                                     and the residual latency is the radio's
#                                     floor. Shaping harder buys nothing.
#   backlog ~ 0 but latency climbs -> the shaper is above real capacity; the
#                                     queue has moved past your router.
#
# The egress qdisc only queues on UPLOAD, so the report isolates the upload
# saturation window (detected from the Sent counter) and reports that window
# separately. That window is the one whose numbers you tune against: it is
# measured with sparse ICMP, exactly like cake-autorate's own reflectors, so
# the excess it reports is directly comparable to ul_owd_delta_thr_ms. A
# speedtest's own "loaded latency" measures its bulk flows instead and reads
# roughly twice as high -- tuning against that number produces a threshold the
# detector never fires on. See docs/tuning.md for the full workflow.
#
# Needs only what the router already has: tc, fping, and (optionally) the Ookla
# speedtest CLI to generate load -- from PATH, or ./speedtest in the current
# directory if you just unpacked the tarball there.
#
# Usage: cake-autorate-probe [-i iface] [-r reflector] [-s server-id] [-b secs]
#
#   -i  egress (upload) interface carrying the CAKE qdisc. Defaults to the
#       interface SQM is configured to shape: with exactly one enabled SQM
#       queue the probe uses it and says so, and with none or several it
#       refuses to guess and asks for -i. It never auto-selects an ifb4*
#       device -- that is the INGRESS side, and measuring it would invert the
#       diagnosis this tool exists to make.
#   -r  ICMP reflector to sample RTT against               (default 1.1.1.1)
#   -s  Ookla speedtest server id -- pin it; a server that differs between runs
#       is the single biggest source of noise in these measurements
#   -b  seconds of idle baseline before the load phase     (default 10)

set -u

IFACE=""
REFLECTOR=1.1.1.1
SRV=""
BASE=10
WORK=/tmp/cake-autorate-probe.$$

# --- parsers, shared verbatim with tests/probe/test-probe.sh -----------------
# The awk programs below live in variables so the test suite can drive the
# EXACT text this script runs instead of a hand-copied duplicate that drifts.
# Sourcing this file with CAKE_AUTORATE_PROBE_LIB=1 (same idiom as
# CAKE_AUTORATE_RPCD_LIB=1 in the rpcd backend) defines them and the percentile
# helper, then returns before anything is measured.
#
# No awk functions anywhere: busybox awk -- the awk that actually runs on the
# router -- rejects a function definition after an END block, and the daemon's
# runtime is busybox ash + busybox awk, not bash + gawk.

# tc -s qdisc show dev <iface> -> one CSV row:
#   ts,shaper_kbit,sent_bytes,drops_total,backlog_b,pkts
AWK_QDISC_SAMPLE='
	# tc normalises the rate unit on output: 9500Kbit stays Kbit, but
	# 11000Kbit prints as "11Mbit". Stripping a "Kbit" suffix alone
	# yields 11, which silently wrecks every rate comparison below.
	# Normalise everything to Kbit.
	/^qdisc cake/ { r=0
	  for(n=1;n<=NF;n++) if($n=="bandwidth") {
	    v=$(n+1); u=v
	    sub(/^[0-9.]+/,"",u)     # unit suffix: bit/Kbit/Mbit/Gbit/Tbit
	    sub(/[A-Za-z]+$/,"",v)   # numeric part
	    m=0
	    if(u=="bit")       m=0.001
	    else if(u=="Kbit") m=1
	    else if(u=="Mbit") m=1000
	    else if(u=="Gbit") m=1000000
	    else if(u=="Tbit") m=1000000000
	    r=(m>0) ? v*m : 0        # 0 for "unlimited" or anything odd
	  } }
	/^ Sent/      { s=$2; d=$7; sub(/,$/,"",d) }
	/^ backlog/   { b=$2; p=$3; sub(/b$/,"",b); sub(/p$/,"",p);
	                printf "%.2f,%.0f,%s,%s,%s,%s\n", t0+i/per, r, s, d, b, p }'

# Per-sample upload throughput from the Sent byte delta -- which is what lets
# the upload phase be found without parsing speedtest output.
#   ts,shaper_kbit,sent_bytes,drops,backlog -> ts,shaper_kbit,ul_kbit,drops,backlog
AWK_UL_RATE='NR>1 { dt=$1-pt; db=$3-ps
	                if(dt>0) printf "%.2f,%s,%.0f,%s,%d\n", $1, $2, db*8/1000/dt, $4, $5+0 }
	         { pt=$1; ps=$3 }'

# Upload saturation = offered rate within striking distance of the shaper.
# Idle-with-ACKs sits two orders of magnitude below it, so the window this
# selects is the upload phase and nothing else.
AWK_UL_SATURATED='$2>0 && $3 > 0.5*$2'

# fping -D -p 200 -l output -> ts,rtt_ms. Lines without "bytes," (timeouts,
# errors, anything fping writes to stderr) carry no sample and are dropped.
#
# fflush() is not decoration. awk's stdout here is a FILE, so stdio buffers it
# in 4KB blocks, and this sampler is ended with a kill -- which discards
# whatever is still in that buffer. A whole short run can land under 4KB and
# report "(no samples)"; a long one loses its TAIL, which is exactly the upload
# window this tool exists to measure. busybox awk, mawk and gawk all implement
# fflush().
AWK_RTT_SAMPLE='
	/bytes,/ { ts=$1; gsub(/[][]/,"",ts)
	           for(n=1;n<=NF;n++) if($n=="ms") { print ts","$(n-1); fflush(); break } }'

# --- where to measure, when -i is not given ---------------------------------
# SQM owns the CAKE qdisc (see AGENTS.md); its config is therefore the
# authority on which egress is shaped, and it is the same source the rpcd
# backend's sqm_interfaces method reads. Deriving from it beats any hardcoded
# device name, and beats sniffing `tc` output: a router with SQM on two WANs
# has two cake qdiscs and only the operator knows which link is under test.
#
# The uci CLI, NOT /lib/functions.sh. This script runs `set -u`, and OpenWrt's
# libuci helpers are not nounset-clean -- sourcing them would force a `set +u`
# wrapper around every call (AGENTS.md, tests/regression/test-libuci-nounset.sh).
# The CLI has no such problem and needs no wrapper.

sqm_egress_candidates() { # -> one shaped egress interface per line
	uci -q show sqm 2>/dev/null | while IFS= read -r line; do
		key=${line%%=*}
		val=${line#*=}
		# `uci show` quotes option VALUES but not section types; strip
		# either spelling rather than depending on which uci this is.
		val=$(printf '%s' "$val" | tr -d "\"'")
		[ "$val" = queue ] || continue
		# Section lines are sqm.<section>; an option line has a second
		# dot (sqm.<section>.<option>) and is not a section.
		case "$key" in
		sqm.*.*) continue ;;
		sqm.*) ;;
		*) continue ;;
		esac
		sect=${key#sqm.}

		# UCI bool spellings, and ABSENT means enabled -- the same
		# reading parse_sqm_sections() in the rpcd backend applies.
		en=$(uci -q get "sqm.$sect.enabled" 2>/dev/null)
		case "${en:-1}" in
		1 | on | true | yes | enabled) ;;
		*) continue ;;
		esac

		iface=$(uci -q get "sqm.$sect.interface" 2>/dev/null)
		[ -n "$iface" ] || continue

		# NEVER an ifb device. SQM's `interface` option names the egress,
		# so this should not fire -- but the egress qdisc is the only one
		# that queues on upload, and silently measuring the ingress ifb
		# would invert the verdict itself. Cheap to make impossible,
		# expensive to debug if it ever happened.
		case "$iface" in
		ifb*) continue ;;
		esac
		printf '%s\n' "$iface"
	done
}

derive_iface_from_sqm() { # -> the one shaped egress on stdout, or fails
	if ! command -v uci >/dev/null 2>&1; then
		echo "cake-autorate-probe: uci not found -- pass -i <egress interface>" >&2
		return 1
	fi
	_cands=$(sqm_egress_candidates | sort -u)
	_n=$(printf '%s' "$_cands" | grep -c . 2>/dev/null || true)
	case "${_n:-0}" in
	1)
		printf '%s\n' "$_cands"
		return 0
		;;
	0)
		echo "cake-autorate-probe: no enabled SQM queue names an interface to shape." >&2
		echo "cake-autorate-probe: is SQM configured? Otherwise pass -i <egress interface>." >&2
		echo "cake-autorate-probe: (ifb4* ingress devices are never auto-selected.)" >&2
		return 1
		;;
	*)
		echo "cake-autorate-probe: SQM shapes more than one interface; pass -i to choose:" >&2
		printf '%s\n' "$_cands" | sed 's/^/    -i /' >&2
		return 1
		;;
	esac
}

pct() { # pct <file> <colnum>  -- prints p50/p95/p99/max of that column
	# No awk functions here: busybox awk rejects them inside END.
	awk -F, -v c="$2" '{print $c}' "$1" | sort -n > "$WORK/.s"
	awk '{v[++n]=$1} END{
		if(n==0){print "  (no samples)"; exit}
		i50=int(50*n/100); if(i50<1)i50=1
		i95=int(95*n/100); if(i95<1)i95=1
		i99=int(99*n/100); if(i99<1)i99=1
		printf "  p50 %8.1f   p95 %8.1f   p99 %8.1f   max %8.1f   (n=%d)\n",
		       v[i50], v[i95], v[i99], v[n], n }' "$WORK/.s"
}

# Stay inert when sourced by the test suite; everything below this line runs
# only when the probe is executed for real.
if [ "${CAKE_AUTORATE_PROBE_LIB:-0}" = 1 ]; then
	return 0
fi

while getopts "i:r:s:b:h" o 2>/dev/null; do
	case "$o" in
	i) IFACE=$OPTARG ;;
	r) REFLECTOR=$OPTARG ;;
	s) SRV=$OPTARG ;;
	b) BASE=$OPTARG ;;
	# -h (and any bad flag) prints the whole header comment above. The range
	# ends on the last "#" line of that block -- tests/probe/test-probe.sh
	# asserts both ends of it, so moving the header cannot silently truncate
	# the only usage text this tool has.
	*) sed -n '2,39p' "$0"; exit 2 ;;
	esac
done

command -v tc >/dev/null    || { echo "cake-autorate-probe: tc not found" >&2; exit 1; }
command -v fping >/dev/null || { echo "cake-autorate-probe: fping not found" >&2; exit 1; }

# No -i: ask SQM what it shapes, and say out loud what that turned out to be.
# A measurement whose subject is implicit is a measurement nobody can repeat.
if [ -z "$IFACE" ]; then
	IFACE=$(derive_iface_from_sqm) || exit 1
	echo "cake-autorate-probe: no -i given: measuring $IFACE, the egress SQM is configured to shape"
fi

tc qdisc show dev "$IFACE" 2>/dev/null | grep -q '^qdisc cake' || {
	echo "cake-autorate-probe: no cake qdisc on $IFACE -- is SQM running? (-i names the egress interface)" >&2; exit 1; }

mkdir -p "$WORK" || exit 1
cleanup() {
	[ -n "${TC_PID:-}" ] && kill "$TC_PID" 2>/dev/null
	[ -n "${FP_PID:-}" ] && kill "$FP_PID" 2>/dev/null
	wait 2>/dev/null
	rm -rf "$WORK"
}
trap 'cleanup; exit 130' INT TERM

# Sub-second sleep is a busybox build option. Prefer fractional sleep, then the
# usleep applet, then fall back to 1Hz. At 1Hz a queue that fills and drains in
# milliseconds is badly undersampled, so the fallback is worth avoiding.
if sleep 0.25 2>/dev/null; then
	SLEEPCMD="sleep 0.25"; PER_S=4
elif command -v usleep >/dev/null 2>&1 && usleep 250000 2>/dev/null; then
	SLEEPCMD="usleep 250000"; PER_S=4
else
	SLEEPCMD="sleep 1"; PER_S=1
fi

T0=$(date +%s)

# --- qdisc sampler: one CSV row per tick -------------------------------------
# Timestamps come from a sample counter, not date +%N, which busybox does not
# always implement. Row: ts,shaper_kbit,sent_bytes,drops_total,backlog_b,pkts
(
	i=0
	while :; do
		tc -s qdisc show dev "$IFACE" |
			awk -v t0="$T0" -v i="$i" -v per="$PER_S" "$AWK_QDISC_SAMPLE"
		i=$((i+1))
		$SLEEPCMD
	done
) > "$WORK/tc.csv" 2>/dev/null &
TC_PID=$!

# --- latency sampler ---------------------------------------------------------
fping -D -p 200 -l "$REFLECTOR" 2>&1 | awk "$AWK_RTT_SAMPLE" > "$WORK/rtt.csv" &
FP_PID=$!

echo "cake-autorate-probe: iface=$IFACE reflector=$REFLECTOR sampling=${PER_S}Hz"
echo "cake-autorate-probe: ${BASE}s idle baseline..."
sleep "$BASE"
IDLE_END=$(date +%s)

# Prefer a speedtest on PATH; fall back to ./speedtest so an Ookla tarball
# unpacked into the current directory works without installing anything.
if command -v speedtest >/dev/null 2>&1; then
	SPEEDTEST=speedtest
elif [ -x ./speedtest ]; then
	SPEEDTEST=./speedtest
else
	SPEEDTEST=""
fi

if [ -n "$SPEEDTEST" ]; then
	echo "cake-autorate-probe: running $SPEEDTEST to generate load..."
	if [ -n "$SRV" ]; then
		"$SPEEDTEST" -s "$SRV" --accept-license --accept-gdpr 2>&1 | sed 's/^/    | /'
	else
		echo "    (no -s server-id given: the server may differ between runs,"
		echo "     which is the single biggest source of noise in these tests)"
		"$SPEEDTEST" --accept-license --accept-gdpr 2>&1 | sed 's/^/    | /'
	fi
else
	echo "cake-autorate-probe: speedtest not found -- generate upload load yourself now."
	echo "cake-autorate-probe: sampling for 40s, press Ctrl-C when your load stops."
	sleep 40
fi
LOAD_END=$(date +%s)

kill "$TC_PID" "$FP_PID" 2>/dev/null
wait 2>/dev/null
trap - INT TERM

# --- derive per-sample upload throughput -------------------------------------
# ts,shaper_kbit,ul_kbit,drops_total,backlog_b
awk -F, "$AWK_UL_RATE" "$WORK/tc.csv" > "$WORK/tcr.csv"

awk -F, -v s="$IDLE_END" '$1>=s' "$WORK/tcr.csv" > "$WORK/tc.load"
awk -F, "$AWK_UL_SATURATED" "$WORK/tc.load" > "$WORK/tc.up"

UP_START=$(awk -F, 'NR==1{print $1}' "$WORK/tc.up")
UP_END=$(awk -F, 'END{print $1}' "$WORK/tc.up")

# --- report ------------------------------------------------------------------
echo
echo "============ cake-autorate-probe report ============"

awk -F, -v e="$IDLE_END" '$1<e' "$WORK/rtt.csv" > "$WORK/rtt.idle"
echo
echo "-- ICMP RTT to $REFLECTOR, idle baseline (ms)"
pct "$WORK/rtt.idle" 2

echo
echo "-- ICMP RTT to $REFLECTOR, whole load phase, up+down (ms)"
awk -F, -v s="$IDLE_END" -v e="$LOAD_END" '$1>=s && $1<=e' "$WORK/rtt.csv" > "$WORK/rtt.load"
pct "$WORK/rtt.load" 2

if [ -n "${UP_START:-}" ]; then
	awk -F, -v s="$UP_START" -v e="$UP_END" '$1>=s && $1<=e' "$WORK/rtt.csv" > "$WORK/rtt.up"
	echo
	echo "-- ICMP RTT during UPLOAD SATURATION only (ms)  <-- tune against this"
	pct "$WORK/rtt.up" 2
	echo
	echo "-- CAKE egress backlog during upload saturation (bytes)"
	pct "$WORK/tc.up" 5
else
	: > "$WORK/rtt.up"
	echo
	echo "-- upload saturation window: NOT FOUND"
	echo "   No sample reached 50% of the shaper rate. Either the upload phase"
	echo "   was shorter than the sample interval, or load never materialised."
fi

echo
echo "-- shaper rate written to $IFACE during the run (Kbit)"
awk -F, '{print $2}' "$WORK/tc.load" | sort -n | uniq -c |
	awk '{printf "  %8s Kbit  for %s samples\n", $2, $1}'

echo
echo "-- per-second timeline ('*' = upload saturation)"
echo "   shaper / ul rate / backlog / drops-per-sec / rtt mean / rtt max"
awk -F, -v ustart="${UP_START:-0}" -v uend="${UP_END:-0}" '
	{ sec=int($1); if(!(sec in seen)){seen[sec]=1; order[++k]=sec}
	  rate[sec]=$2
	  if($3+0>ul[sec]) ul[sec]=$3+0
	  if($5+0>bl[sec]) bl[sec]=$5+0
	  drp[sec]=$4+0
	  if(ustart>0 && $1>=ustart && $1<=uend) up[sec]="*" }
	END{ for(j=1;j<=k;j++){ s=order[j]
	       printf "%d,%s,%d,%d,%d,%s\n", s, rate[s], ul[s]+0, bl[s]+0, drp[s], (s in up)?up[s]:" " } }' \
	"$WORK/tc.load" > "$WORK/tl.tc"

# Column 2 here is the arithmetic mean, not a median -- labelled accordingly.
awk -F, '{ sec=int($1); n[sec]++; sum[sec]+=$2; if($2+0>mx[sec]) mx[sec]=$2+0 }
	END{ for(s in n) printf "%d,%.1f,%.1f\n", s, sum[s]/n[s], mx[s] }' \
	"$WORK/rtt.load" | sort -n > "$WORK/tl.rtt"

awk -F, 'NR==FNR{ mean[$1]=$2; mx[$1]=$3; next }
	{ if(!base){base=$1; prev=$5} d=$5-prev; prev=$5
	  printf "  %s +%02ds  %6s Kbit  ul %6d Kbit  backlog %7d B  drops %4d  rtt %6.1f / %6.1f ms\n",
	         $6, $1-base, $2, $3, $4, d, mean[$1], mx[$1] }' \
	"$WORK/tl.rtt" "$WORK/tl.tc"

echo
echo "-- verdict"
if [ -s "$WORK/rtt.up" ]; then
	RTTF="$WORK/rtt.up"; BLF="$WORK/tc.up"; WHAT="upload saturation"
else
	RTTF="$WORK/rtt.load"; BLF="$WORK/tc.load"; WHAT="whole load phase (upload window not isolated)"
fi
MAXBL=$(awk -F, 'BEGIN{m=0} {if($5+0>m)m=$5+0} END{print m+0}' "$BLF")
IDLEP50=$(awk -F, '{print $2}' "$WORK/rtt.idle" | sort -n |
	awk '{v[++n]=$1} END{i=int(n/2); if(i<1)i=1; printf "%.1f", v[i]+0}')
LOADP95=$(awk -F, '{print $2}' "$RTTF" | sort -n |
	awk '{v[++n]=$1} END{i=int(95*n/100); if(i<1)i=1; printf "%.1f", v[i]+0}')
EXCESS=$(awk -v a="$LOADP95" -v b="$IDLEP50" 'BEGIN{printf "%.1f", a-b}')
SHAPER=$(awk -F, 'END{print $2+0}' "$WORK/tc.load")
# Queue delay CAKE itself is responsible for: backlog drained at the shaper rate.
QDELAY=$(awk -v b="$MAXBL" -v r="$SHAPER" 'BEGIN{ if(r>0) printf "%.1f", b*8/r; else printf "0.0" }')

echo "  measured over: $WHAT"
echo "  idle p50 ${IDLEP50} ms -> loaded p95 ${LOADP95} ms  (excess ${EXCESS} ms)"
echo "  peak CAKE egress backlog: ${MAXBL} bytes = ${QDELAY} ms at ${SHAPER} Kbit"
if [ "$MAXBL" -gt 8000 ]; then
	echo "  => CAKE IS holding the egress queue, and only ${QDELAY} ms of the"
	echo "     ${EXCESS} ms excess is CAKE's own queue. The rest is downstream"
	echo "     of your shaper (RAN scheduling / modem) and no shaper can remove"
	echo "     it. Set ul_owd_delta_thr_ms above ${EXCESS} ms with margin, or"
	echo "     cake-autorate will cut the rate forever chasing it."
else
	echo "  => CAKE is NOT holding the egress queue (backlog stayed near zero)."
	echo "     Your shaper is at or above real capacity, so the queue is past"
	echo "     your router. Lower the upload shaper rate until backlog appears."
fi
echo
echo "  NOTE: this is sparse-ICMP latency, the same signal cake-autorate uses."
echo "  A speedtest's own 'loaded latency' measures its bulk flows and will"
echo "  read considerably higher. Tune thresholds against THIS number."
echo "===================================================="
cleanup
