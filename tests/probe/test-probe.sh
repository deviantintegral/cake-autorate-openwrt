#!/bin/sh
#
# test-probe.sh -- tests the diagnostic probe
# (net/cake-autorate/files/cake-autorate-probe.sh) off-device: no tc, no fping,
# no cake qdisc, no router.
#
# The probe answers one question on a radio WAN -- is the loaded latency CAKE's
# own egress queue, or the RAN uplink scheduler downstream of it? -- and the
# answer is only as good as three parsers:
#
#   1. the tc RATE-UNIT NORMALISATION. `tc` normalises its own output: a shaper
#      set to 9500Kbit prints "9500Kbit", but 11000Kbit prints "11Mbit". The
#      obvious "strip the Kbit suffix" yields 11, so every later rate
#      comparison -- including the upload-saturation test, which is a fraction
#      of this number -- silently collapses. Checked at every unit.
#   2. the `tc -s qdisc show` PARSER, against a realistic three-line sample
#      (qdisc line / Sent line / backlog line). The backlog byte count is the
#      whole diagnosis: > 0 means CAKE holds the queue.
#   3. the UPLOAD-SATURATION WINDOW, derived from the Sent byte counter rather
#      than from speedtest's output. Only the egress qdisc queues on upload, so
#      a report that fails to isolate that window measures the wrong thing.
#   4. the fping RTT SAMPLER, which turns `fping -D -p 200 -l` into ts,rtt_ms
#      and must drop timeouts and stderr noise rather than sample them.
#   5. the INTERFACE DERIVATION, which reads SQM's own UCI config when -i is
#      not given -- and must never auto-select an ifb4* ingress device, never
#      pick between several shaped interfaces, and never stay silent about
#      what it chose. Driven through a stub `uci` on PATH.
#
# plus the percentile helper the whole report is printed through, and the
# `-h` usage range over the script's own header comment.
#
# HOW IT AVOIDS A SECOND COPY
#   Sourcing the probe with CAKE_AUTORATE_PROBE_LIB=1 (the same idiom as
#   CAKE_AUTORATE_RPCD_LIB=1 in the rpcd backend) defines its awk programs and
#   its percentile helper and returns before it measures anything. So the
#   programs exercised here are the exact text the router runs -- there is no
#   hand-copied duplicate to drift out of lockstep.
#
# ON AWK IMPLEMENTATIONS
#   The router runs BUSYBOX awk, not gawk. Every check that drives an awk
#   program directly is therefore run under every awk on this box (awk, mawk,
#   gawk, `busybox awk` -- whichever exist and differ). Build hosts and CI
#   runners have no busybox, so that one is a NOTE rather than a failure, the
#   same exception the libuci checks in test-uci-schema.sh take.
#
# POSIX sh, no bashisms. Exit 0 = every check passed.

set -u

here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
PROBE="$repo/net/cake-autorate/files/cake-autorate-probe.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

eq() { # eq <description> <expected> <actual>
	if [ "$2" = "$3" ]; then
		ok "$1"
	else
		bad "$1"
		printf '       expected: %s\n       actual:   %s\n' "$2" "$3"
	fi
}

if [ ! -f "$PROBE" ]; then
	printf 'FATAL: probe not found at %s\n' "$PROBE" >&2
	exit 1
fi

# Source the probe as a library: defines AWK_* and pct(), runs nothing.
CAKE_AUTORATE_PROBE_LIB=1
export CAKE_AUTORATE_PROBE_LIB
# shellcheck source=/dev/null
. "$PROBE"

# pct() writes its sorted scratch file to $WORK; point that at our temp dir
# (the probe defaults it to /tmp/cake-autorate-probe.$$, which it never made).
WORK="$work"

# --- which awks can we check against? ---------------------------------------
: > "$work/awks"
awk_paths=""
for cand in awk mawk gawk; do
	p=$(command -v "$cand" 2>/dev/null) || continue
	[ -n "$p" ] || continue
	p=$(readlink -f "$p" 2>/dev/null || printf '%s' "$p")
	case " $awk_paths " in
	*" $p "*) continue ;;
	esac
	awk_paths="$awk_paths $p"
	printf '%s\n' "$cand" >> "$work/awks"
done

HAVE_BUSYBOX_AWK=0
if command -v busybox >/dev/null 2>&1 && busybox awk 'BEGIN{exit 0}' >/dev/null 2>&1; then
	printf 'busybox awk\n' >> "$work/awks"
	HAVE_BUSYBOX_AWK=1
fi

if [ ! -s "$work/awks" ]; then
	printf 'FATAL: no awk implementation found\n' >&2
	exit 1
fi

# --- fixtures ---------------------------------------------------------------

# A realistic `tc -s qdisc show dev <egress>` block for a CAKE root qdisc:
# three lines, exactly as tc prints them (leading space on the last two).
qdisc_show() { # qdisc_show <bandwidth-token> <sent-bytes> <drops> <backlog-b> <backlog-p>
	printf '%s\n' "qdisc cake 8004: root refcnt 2 bandwidth $1 besteffort triple-isolate nonat nowash no-ack-filter split-gso rtt 100ms noatm overhead 18"
	printf '%s\n' " Sent $2 bytes 998877 pkt (dropped $3, overlimits 44556 requeues 0)"
	printf '%s\n' " backlog ${4}b ${5}p requeues 0"
}

sample() { # sample <awk-cmd> <bandwidth> <sent> <drops> <backlog-b> <backlog-p>
	# t0=1000 i=2 per=4 -> the sampler stamps this row at 1000 + 2/4 = 1000.50
	awkcmd=$1
	shift
	# shellcheck disable=SC2086  # $awkcmd is our own literal, may be "busybox awk"
	qdisc_show "$@" | $awkcmd -v t0=1000 -v i=2 -v per=4 "$AWK_QDISC_SAMPLE"
}

# `fping -D -p 200 -l <reflector> 2>&1` as it actually streams: replies, a
# timeout, and a stderr line folded in by the 2>&1. Only replies are samples.
fping_stream() {
	printf '%s\n' '[1786666928.621] 1.1.1.1 : [0], 64 bytes, 25.0 ms (25.0 avg, 0% loss)'
	printf '%s\n' '[1786666928.830] 1.1.1.1 : [1], 64 bytes, 112.4 ms (68.7 avg, 0% loss)'
	printf '%s\n' '[1786666929.038] 1.1.1.1 : [2], timed out (68.7 avg, 33% loss)'
	printf '%s\n' '1.1.1.1: error while sending ping: Network is unreachable'
	printf '%s\n' '[1786666929.240] 1.1.1.1 : [3], 64 bytes, 26.8 ms (54.7 avg, 25% loss)'
}

# --- 1 + 2: rate normalisation and the qdisc parser, under every awk --------
while read -r AWKBIN; do
	[ -n "$AWKBIN" ] || continue

	# The full row, so the parser is checked as a whole:
	#   ts,shaper_kbit,sent_bytes,drops_total,backlog_bytes,backlog_pkts
	eq "[$AWKBIN] 3-line tc block -> one CSV row" \
		'1000.50,9500,123456789,12,15140,11' \
		"$(sample "$AWKBIN" 9500Kbit 123456789 12 15140 11)"

	# Rate unit normalisation -- everything lands in Kbit.
	eq "[$AWKBIN] 11Mbit    -> 11000 Kbit" 11000 \
		"$(sample "$AWKBIN" 11Mbit 100 0 0 0 | cut -d, -f2)"
	eq "[$AWKBIN] 9500Kbit  -> 9500 Kbit" 9500 \
		"$(sample "$AWKBIN" 9500Kbit 100 0 0 0 | cut -d, -f2)"
	eq "[$AWKBIN] 1Gbit     -> 1000000 Kbit" 1000000 \
		"$(sample "$AWKBIN" 1Gbit 100 0 0 0 | cut -d, -f2)"
	eq "[$AWKBIN] 1Tbit     -> 1000000000 Kbit" 1000000000 \
		"$(sample "$AWKBIN" 1Tbit 100 0 0 0 | cut -d, -f2)"
	eq "[$AWKBIN] unlimited -> 0 (no shaper)" 0 \
		"$(sample "$AWKBIN" unlimited 100 0 0 0 | cut -d, -f2)"
	# A fractional Mbit rate must not be truncated to the integer part.
	eq "[$AWKBIN] 11.5Mbit  -> 11500 Kbit" 11500 \
		"$(sample "$AWKBIN" 11.5Mbit 100 0 0 0 | cut -d, -f2)"

	# Exactly one row per tc invocation: the row is printed on the backlog
	# line, so a qdisc line without one must not emit a half-filled row.
	eq "[$AWKBIN] one row per tc block" 1 \
		"$(sample "$AWKBIN" 9500Kbit 123456789 12 15140 11 | wc -l | tr -d ' ')"

	# The drop counter carries tc's trailing comma ("(dropped 12,"); it must
	# be stripped or every drops-per-second delta is a string compare.
	eq "[$AWKBIN] drop count comma stripped" 4321 \
		"$(sample "$AWKBIN" 9500Kbit 100 4321 0 0 | cut -d, -f4)"

	# Backlog is the whole diagnosis: "15140b 11p" -> 15140 bytes, 11 pkts.
	eq "[$AWKBIN] backlog b/p suffixes stripped" '15140,11' \
		"$(sample "$AWKBIN" 9500Kbit 100 0 15140 11 | cut -d, -f5,6)"

	# The RTT sampler: replies become ts,rtt_ms; a timeout and an error line
	# folded in by `2>&1` carry no sample and must not become one.
	# shellcheck disable=SC2086  # $AWKBIN is our own literal ("busybox awk")
	eq "[$AWKBIN] fping -D replies -> ts,rtt (timeouts dropped)" \
		'1786666928.621,25.0 1786666928.830,112.4 1786666929.240,26.8' \
		"$(fping_stream | $AWKBIN "$AWK_RTT_SAMPLE" | tr '\n' ' ' | sed 's/ $//')"
done < "$work/awks"

# The RTT sampler is ended with a kill, and awk's stdout is a file -- so
# without an explicit flush, up to 4KB of samples die in the stdio buffer. A
# short run then reports "(no samples)" and a long one silently loses its TAIL,
# which is the upload window the whole tool exists to measure. Observing that
# off-device costs a multi-second timing test; asserting the flush is in the
# program costs nothing, so this one check is deliberately textual.
case "$AWK_RTT_SAMPLE" in
*fflush*) ok 'RTT sampler flushes each sample (kill-safe)' ;;
*) bad 'RTT sampler flushes each sample (kill-safe)' ;;
esac

# --- 3: upload-saturation window from the Sent byte counter ------------------
#
# Egress carries only ACKs for the first samples (7500 B per 250 ms tick = 240
# Kbit/s against a 9500 Kbit shaper), then saturates (290000 B per tick = 9280
# Kbit/s), then falls back to ACKs. The detected window must be exactly the
# saturated ticks -- no ACK tick, and none missing.
#
# Row format is the sampler's: ts,shaper_kbit,sent_bytes,drops,backlog_b,pkts
{
	printf '1000.00,9500,1000000,0,0,0\n'      # ACK-only baseline (no delta yet)
	printf '1000.25,9500,1007500,0,0,0\n'      # +7500 B  -> 240 Kbit
	printf '1000.50,9500,1015000,0,0,0\n'
	printf '1000.75,9500,1022500,0,0,0\n'
	printf '1001.00,9500,1030000,0,0,0\n'
	printf '1001.25,9500,1320000,0,18820,13\n' # +290000 B -> 9280 Kbit, queue
	printf '1001.50,9500,1610000,1,21160,15\n'
	printf '1001.75,9500,1900000,3,19430,14\n'
	printf '1002.00,9500,2190000,4,20010,14\n'
	printf '1002.25,9500,2480000,7,17780,12\n'
	printf '1002.50,9500,2770000,9,16240,11\n'
	printf '1002.75,9500,2777500,9,0,0\n'      # back to ACKs
	printf '1003.00,9500,2785000,9,0,0\n'
} > "$work/tc.csv"

awk -F, "$AWK_UL_RATE" "$work/tc.csv" > "$work/tcr.csv"
awk -F, "$AWK_UL_SATURATED" "$work/tcr.csv" > "$work/tc.up"

eq 'ul rate derived for every sample but the first' 12 \
	"$(wc -l < "$work/tcr.csv" | tr -d ' ')"
eq 'ACK-only tick reads 240 Kbit' '1000.25,9500,240,0,0' \
	"$(sed -n 1p "$work/tcr.csv")"
eq 'saturated tick reads 9280 Kbit' '1001.25,9500,9280,0,18820' \
	"$(sed -n 5p "$work/tcr.csv")"

eq 'window contains exactly the saturated samples' 6 \
	"$(wc -l < "$work/tc.up" | tr -d ' ')"
eq 'window starts at the first saturated sample' 1001.25 \
	"$(awk -F, 'NR==1{print $1}' "$work/tc.up")"
eq 'window ends at the last saturated sample' 1002.50 \
	"$(awk -F, 'END{print $1}' "$work/tc.up")"
eq 'no ACK-only sample inside the window' 0 \
	"$(awk -F, '$3 < 1000' "$work/tc.up" | wc -l | tr -d ' ')"
eq 'every windowed sample is at the shaper rate' 6 \
	"$(awk -F, '$3 == 9280' "$work/tc.up" | wc -l | tr -d ' ')"
eq 'backlog survives into the window rows' 18820 \
	"$(awk -F, 'NR==1{print $5}' "$work/tc.up")"

# An UNSHAPED interface reports "bandwidth unlimited" -> shaper 0. Saturation
# is defined as a fraction of the shaper rate, so with no shaper there is no
# window to find: 0 > 0.5*0 must not select every sample on the link.
{
	printf '2000.00,0,1000000,0,0,0\n'
	printf '2000.25,0,3000000,0,0,0\n'
	printf '2000.50,0,5000000,0,0,0\n'
} > "$work/tc-unshaped.csv"
awk -F, "$AWK_UL_RATE" "$work/tc-unshaped.csv" |
	awk -F, "$AWK_UL_SATURATED" > "$work/tc-unshaped.up"
eq 'unshaped iface yields no saturation window' 0 \
	"$(wc -l < "$work/tc-unshaped.up" | tr -d ' ')"

# --- 4: the percentile helper -----------------------------------------------
# A known series: RTT 1..100 ms in column 2, deliberately out of order (the
# helper sorts numerically -- a lexical sort would rank 100 below 2).
awk 'BEGIN{ for(i=100;i>=1;i--) printf "%d.0,%d\n", 1700000000+i, i }' > "$work/rtt.csv"

PCTOUT=$(pct "$work/rtt.csv" 2 | tr -s ' ' | sed 's/^ //; s/ $//')
eq 'pct p50/p95/p99/max over 1..100' \
	'p50 50.0 p95 95.0 p99 99.0 max 100.0 (n=100)' "$PCTOUT"

# A short series must still report, not divide by zero or index v[0].
printf '1.0,12.5\n2.0,4.5\n3.0,30.5\n' > "$work/rtt-short.csv"
PCTSHORT=$(pct "$work/rtt-short.csv" 2 | tr -s ' ' | sed 's/^ //; s/ $//')
eq 'pct over a 3-sample series' \
	'p50 4.5 p95 12.5 p99 12.5 max 30.5 (n=3)' "$PCTSHORT"

# No samples at all (fping never answered) must say so, not print zeros that
# read as a perfect link.
: > "$work/rtt-empty.csv"
eq 'pct reports an empty series' '(no samples)' \
	"$(pct "$work/rtt-empty.csv" 2 | sed 's/^ *//')"

# --- 5: the interface default, derived from SQM -----------------------------
#
# With no -i the probe asks SQM what it shapes, because SQM owns the CAKE qdisc
# and a hardcoded device name is only ever right on one router. The rules it
# must follow, in order of how badly each one hurts when wrong:
#
#   * NEVER auto-select an ifb4* device. That is the ingress side; the egress
#     qdisc is the only one that queues on upload, so measuring the ifb would
#     invert the verdict rather than fail visibly.
#   * refuse to guess between several. Picking the first would measure one WAN
#     and report it as the other.
#   * say which interface it picked, or a run is not reproducible.
#
# Driven through a stub `uci` on PATH answering from a fixture in real
# `uci show` format, so the parsing this exercises is the parsing a router
# gets -- anonymous `@queue[0]` sections included, brackets and all.

# The host has no uci at all, which is exactly the "not on a router" case.
if ! command -v uci >/dev/null 2>&1; then
	UCIERR=$(derive_iface_from_sqm 2>&1 >/dev/null)
	UCIRC=$?
	eq 'no uci at all -> fails' 1 "$UCIRC"
	case "$UCIERR" in
	*"pass -i"*) ok 'no uci at all -> says to pass -i' ;;
	*) bad "no uci at all -> says to pass -i (got: $UCIERR)" ;;
	esac
fi

mkdir -p "$work/bin"
cat > "$work/bin/uci" <<'UCISTUB'
#!/bin/sh
# Stub uci: answers `uci -q show sqm` and `uci -q get sqm.<sect>.<opt>` from
# the fixture named by $UCI_FIXTURE, in real `uci show` output format.
f=${UCI_FIXTURE:-/dev/null}
cmd=""
arg=""
for a in "$@"; do
	case "$a" in
	-*) continue ;;
	esac
	if [ -z "$cmd" ]; then cmd=$a; else arg=$a; fi
done
case "$cmd" in
show)
	# Both spellings real uci emits: the section line
	# (sqm.@queue[0]=queue) and its option lines.
	grep "^${arg}\." "$f" 2>/dev/null
	exit 0
	;;
get)
	# Exact key compare, NOT a regex: an anonymous section id like
	# @queue[0] is full of regex metacharacters.
	awk -v k="$arg" '
		substr($0, 1, length(k) + 1) == k "=" {
			v = substr($0, length(k) + 2)
			gsub(/^["\047]|["\047]$/, "", v)
			print v; found = 1; exit
		}
		END { exit(found ? 0 : 1) }' "$f" 2>/dev/null
	exit $?
	;;
esac
exit 1
UCISTUB
chmod +x "$work/bin/uci"
PATH="$work/bin:$PATH"
export PATH

derive() { # derive <fixture-file> -- prints the chosen iface, stderr kept apart
	UCI_FIXTURE=$1 derive_iface_from_sqm 2>"$work/derive.err"
}

# --- one enabled queue, anonymous section: use it -----------------------
cat > "$work/sqm-one" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='eth1'
sqm.@queue[0].enabled='1'
sqm.@queue[0].download='80000'
sqm.@queue[0].upload='10000'
sqm.@queue[0].qdisc='cake'
EOF
eq 'one enabled SQM queue -> that interface' eth1 "$(derive "$work/sqm-one")"
UCI_FIXTURE="$work/sqm-one" derive_iface_from_sqm >/dev/null 2>&1
eq 'one enabled SQM queue -> exit 0' 0 "$?"

# --- named section, and `enabled` absent (uci bool default) -------------
cat > "$work/sqm-named" <<'EOF'
sqm.wan=queue
sqm.wan.interface='eth0.35'
sqm.wan.qdisc='cake'
EOF
eq 'named section, enabled absent -> still derived' eth0.35 \
	"$(derive "$work/sqm-named")"

# --- a disabled queue must not count ------------------------------------
cat > "$work/sqm-mixed" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='eth2'
sqm.@queue[0].enabled='0'
sqm.@queue[1]=queue
sqm.@queue[1].interface='eth1'
sqm.@queue[1].enabled='1'
EOF
eq 'disabled queue skipped, enabled one chosen' eth1 "$(derive "$work/sqm-mixed")"

# --- no SQM config at all ------------------------------------------------
: > "$work/sqm-empty"
eq 'no SQM queue -> no interface printed' '' "$(derive "$work/sqm-empty")"
UCI_FIXTURE="$work/sqm-empty" derive_iface_from_sqm >/dev/null 2>&1
eq 'no SQM queue -> fails rather than guessing' 1 "$?"
UCI_FIXTURE="$work/sqm-empty" derive_iface_from_sqm >/dev/null 2>"$work/derive.err"
if grep -q 'pass -i' "$work/derive.err"; then
	ok 'no SQM queue -> tells the user to pass -i'
else
	bad 'no SQM queue -> tells the user to pass -i'
fi

# --- every queue disabled is the same case ------------------------------
cat > "$work/sqm-alloff" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='eth1'
sqm.@queue[0].enabled='0'
EOF
UCI_FIXTURE="$work/sqm-alloff" derive_iface_from_sqm >/dev/null 2>&1
eq 'all queues disabled -> fails' 1 "$?"

# --- two enabled queues: refuse, and LIST them --------------------------
cat > "$work/sqm-two" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='eth1'
sqm.@queue[0].enabled='1'
sqm.wan2=queue
sqm.wan2.interface='wwan0'
sqm.wan2.enabled='1'
EOF
eq 'two enabled queues -> nothing chosen' '' "$(derive "$work/sqm-two")"
UCI_FIXTURE="$work/sqm-two" derive_iface_from_sqm >/dev/null 2>&1
eq 'two enabled queues -> fails rather than picking one' 1 "$?"
UCI_FIXTURE="$work/sqm-two" derive_iface_from_sqm >/dev/null 2>"$work/derive.err"
if grep -q -- '-i eth1' "$work/derive.err" && grep -q -- '-i wwan0' "$work/derive.err"; then
	ok 'two enabled queues -> lists both candidates'
else
	bad 'two enabled queues -> lists both candidates'
fi

# --- the ifb4 guard ------------------------------------------------------
# An ifb4* device is the INGRESS half. Auto-selecting it would measure the
# wrong direction and silently invert the verdict, so it is never a candidate
# -- not even when it is the only thing SQM names.
cat > "$work/sqm-ifb" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='ifb4eth1'
sqm.@queue[0].enabled='1'
sqm.@queue[1]=queue
sqm.@queue[1].interface='eth1'
sqm.@queue[1].enabled='1'
EOF
eq 'ifb4 device never auto-selected (egress wins)' eth1 "$(derive "$work/sqm-ifb")"

cat > "$work/sqm-ifbonly" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='ifb4eth1'
sqm.@queue[0].enabled='1'
EOF
eq 'ifb4-only config -> nothing chosen' '' "$(derive "$work/sqm-ifbonly")"
UCI_FIXTURE="$work/sqm-ifbonly" derive_iface_from_sqm >/dev/null 2>&1
eq 'ifb4-only config -> fails rather than measuring ingress' 1 "$?"

# --- an option whose VALUE is "queue" is not a section -------------------
cat > "$work/sqm-decoy" <<'EOF'
sqm.@queue[0]=queue
sqm.@queue[0].interface='eth1'
sqm.@queue[0].enabled='1'
sqm.@queue[0].script='queue'
EOF
eq 'option valued "queue" is not read as a section' eth1 \
	"$(derive "$work/sqm-decoy")"

# --- 6: -h prints the whole header comment ----------------------------------
# The usage text is a `sed -n '<a>,<b>p' "$0"` range over this script's own
# header. Nothing keeps that range honest but this check: assert both ENDS of
# the block, so an edit that grows the header cannot silently truncate the only
# usage text the tool has.
# CAKE_AUTORATE_PROBE_LIB=0: this suite exported it as 1 to source the probe,
# and the child would otherwise return out of the library guard instead of
# parsing arguments.
HELP=$(CAKE_AUTORATE_PROBE_LIB=0 sh "$PROBE" -h 2>&1)
HELPRC=$?
eq 'usage exits 2' 2 "$HELPRC"
if printf '%s\n' "$HELP" | grep -q 'does your shaper own the queue'; then
	ok 'usage prints the first header line'
else
	bad 'usage prints the first header line'
fi
if printf '%s\n' "$HELP" | grep -q 'seconds of idle baseline'; then
	ok 'usage prints the last header line'
else
	bad 'usage prints the last header line'
fi
if printf '%s\n' "$HELP" | grep -q 'set -u'; then
	bad 'usage stops at the end of the header comment'
else
	ok 'usage stops at the end of the header comment'
fi
# The -i default is derived, not hardcoded; the usage text is the only place a
# user learns that, so it has to say so.
if printf '%s\n' "$HELP" | grep -q 'SQM is configured to shape' &&
	printf '%s\n' "$HELP" | grep -q 'auto-selects an ifb4'; then
	ok 'usage documents the SQM-derived -i default and the ifb4 guard'
else
	bad 'usage documents the SQM-derived -i default and the ifb4 guard'
fi

# --- summary ----------------------------------------------------------------
printf '\n'
if [ "$HAVE_BUSYBOX_AWK" -eq 0 ]; then
	printf 'NOTE: no busybox on this host -- the awk checks ran under %s only.\n' \
		"$(tr '\n' ' ' < "$work/awks")"
	printf '      The router runs busybox awk; the VM integration harness covers it there.\n\n'
fi
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
