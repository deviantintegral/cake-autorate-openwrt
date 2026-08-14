#!/bin/sh
#
# Tests the cake-autorate collectd exec reader
# (net/cake-autorate/files/cake-autorate-collectd.sh).
#
# The reader parses the daemon's SUMMARY log lines (see
# docs/upstream-option-inventory.md section 3) and prints collectd PUTVAL
# lines, one metric per line, with the collectd plugin instance set to the
# cake-autorate instance id (parsed from the log filename).
#
# It feeds realistic sample logs -- two live instances plus a rotated instance
# whose current .log is empty and whose data sits in .log.old -- and checks the
# exact per-field, per-instance PUTVAL output, including:
#   * the load-condition string -> numeric gauge mapping,
#   * that the unprefixed SUMMARY_HEADER line is ignored,
#   * that DATA / DEBUG / other TYPE lines are ignored,
#   * that only the last SUMMARY line of a file is reported,
#   * that a rotated instance falls back to <log>.old.
#
# POSIX sh, no bashisms. Exit 0 = every check passed.

set -u

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SELF_DIR/../.." && pwd)
READER="$REPO_ROOT/net/cake-autorate/files/cake-autorate-collectd.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

fail=0
pass=0

# ---- assertion helpers ----------------------------------------------------
have() {
	# have <description> <fixed-string>   -> assert OUTPUT contains it
	if printf '%s\n' "$OUTPUT" | grep -qF -- "$2"; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL: %s\n  expected line containing: %s\n' "$1" "$2" >&2
	fi
}

hasnt() {
	# hasnt <description> <fixed-string>  -> assert OUTPUT does NOT contain it
	if printf '%s\n' "$OUTPUT" | grep -qF -- "$2"; then
		fail=$((fail + 1))
		printf 'FAIL: %s\n  did not expect line containing: %s\n' "$1" "$2" >&2
	else
		pass=$((pass + 1))
	fi
}

# ---- fixtures -------------------------------------------------------------
# A shared header (unprefixed -- written directly to the file, NOT via log_msg,
# so it carries no "TYPE; datetime; timestamp" prefix). Must be ignored.
HEADER='SUMMARY_HEADER; LOG_DATETIME; LOG_TIMESTAMP; DL_ACHIEVED_RATE_KBPS; UL_ACHIEVED_RATE_KBPS; DL_SUM_DELAYS; UL_SUM_DELAYS; DL_AVG_OWD_DELTA_US; UL_AVG_OWD_DELTA_US; DL_LOAD_CONDITION; UL_LOAD_CONDITION; CAKE_DL_RATE_KBPS; CAKE_UL_RATE_KBPS'

# LOG_TIMESTAMP is generated relative to now, because the reader publishes only
# FRESH samples: it drops any SUMMARY line older than two collection intervals
# (60 s here) so that a daemon asleep on an idle link reads as a gap instead of
# a flat line of republished stale numbers. Every fixture below is a few seconds
# old, i.e. comfortably live; the stale cases get their own battery at the end.
#
# The human-readable LOG_DATETIME field stays a fixed literal -- nothing parses
# it, only field 2 (LOG_TIMESTAMP) is read.
NOW=$(date +%s 2>/dev/null) || NOW=''
case "$NOW" in
	''|*[!0-9]*)
		printf 'FAIL: date +%%s did not return an epoch; cannot build fixtures\n' >&2
		exit 1
		;;
esac

# --- instance "primary": header, noise, and TWO summary lines. Only the
#     second (last) one must be reported. High download load, low upload load,
#     no bufferbloat. ---
{
	printf '%s\n' "$HEADER"
	printf 'DEBUG; 2026-07-24-14:30:00; %s.111111; startup complete\n'   "$((NOW - 10))"
	printf 'SUMMARY; 2026-07-24-14:30:01; %s.222222; 11111; 22222; 10; 20; 100; 200; dl_low; ul_idle; 11000; 22000\n' "$((NOW - 9))"
	printf 'DATA; 2026-07-24-14:30:02; %s.000000; 1753367402.0; 48000; 19000; 60; 40; extra; data; fields; here\n'     "$((NOW - 8))"
	printf 'SUMMARY; 2026-07-24-14:30:03; %s.333333; 48000; 19000; 250; 180; 1200; 800; dl_high; ul_low; 45000; 18000\n' "$((NOW - 7))"
} > "$WORK/cake-autorate.primary.log"

# --- instance "secondary": bufferbloat on download, idle upload. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:30:03; %s.444444; 60000; 5000; 900; 60; 30000; 150; dl_high_bb; ul_idle; 52000; 20000\n' "$((NOW - 7))"
} > "$WORK/cake-autorate.secondary.log"

# --- instance "tertiary": just rotated. Current .log is empty; the last
#     SUMMARY is in .log.old and must be picked up via fallback. ---
: > "$WORK/cake-autorate.tertiary.log"
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:29:00; %s.000000; 7000; 3000; 5; 5; 50; 40; dl_idle; ul_idle; 8000; 4000\n' "$((NOW - 8))"
} > "$WORK/cake-autorate.tertiary.log.old"

# --- instance "chunked": a LIVE log as the daemon actually leaves it on disk.
#     Its writer flushes a fixed COUNT of characters, not whole lines
#     (`read -N ${log_file_buffer_size_B}` in maintain_log_file), so the file
#     ends part-way through a line. The fragment still starts with "SUMMARY; ",
#     so it must not be mistaken for the newest sample -- taking it dropped the
#     interval entirely (and blanked the LuCI status view). The second fragment
#     case is cut inside the LAST field, where the field count still reads 13
#     and only the missing newline gives it away. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:30:05; %s.000000; 33000; 12000; 4; 2; 700; 300; dl_low; ul_low; 34000; 13000\n' "$((NOW - 5))"
	printf 'SUMMARY; 2026-07-24-14:30:05; %s.5' "$((NOW - 4))"
} > "$WORK/cake-autorate.chunked.log"
CHUNKED_FRAG_TS="$((NOW - 4)).5"
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:30:06; %s.000000; 21000; 9000; 4; 2; 700; 300; dl_low; ul_low; 24000; 11000\n' "$((NOW - 3))"
	printf 'SUMMARY; 2026-07-24-14:30:06; %s.5; 88000; 7000; 4; 2; 700; 300; dl_high; ul_low; 24000; 1' "$((NOW - 2))"
} > "$WORK/cake-autorate.chunkedlate.log"

# ---- run the reader in one-shot mode over the fixtures --------------------
if [ ! -x "$READER" ]; then
	printf 'FAIL: reader not found or not executable: %s\n' "$READER" >&2
	exit 1
fi

OUTPUT=$(COLLECTD_HOSTNAME=testhost COLLECTD_INTERVAL=30 \
	"$READER" \
	"$WORK/cake-autorate.primary.log" \
	"$WORK/cake-autorate.secondary.log" \
	"$WORK/cake-autorate.tertiary.log" \
	"$WORK/cake-autorate.chunked.log" \
	"$WORK/cake-autorate.chunkedlate.log" 2>/dev/null)

# ---- assertions: primary (last SUMMARY line only) -------------------------
have 'primary dl achieved rate'  'PUTVAL "testhost/cake_autorate-primary/bitrate-dl_achieved" interval=30 N:48000'
have 'primary ul achieved rate'  'PUTVAL "testhost/cake_autorate-primary/bitrate-ul_achieved" interval=30 N:19000'
have 'primary dl shaper rate'    'PUTVAL "testhost/cake_autorate-primary/bitrate-dl_shaper" interval=30 N:45000'
have 'primary ul shaper rate'    'PUTVAL "testhost/cake_autorate-primary/bitrate-ul_shaper" interval=30 N:18000'
have 'primary dl owd delta'      'PUTVAL "testhost/cake_autorate-primary/gauge-dl_owd_delta_us" interval=30 N:1200'
have 'primary ul owd delta'      'PUTVAL "testhost/cake_autorate-primary/gauge-ul_owd_delta_us" interval=30 N:800'
have 'primary dl load = high(2)' 'PUTVAL "testhost/cake_autorate-primary/gauge-dl_load" interval=30 N:2'
have 'primary ul load = low(1)'  'PUTVAL "testhost/cake_autorate-primary/gauge-ul_load" interval=30 N:1'

# only the LAST summary is reported: the first summary's rates must be absent
hasnt 'primary first-summary dl rate suppressed' 'bitrate-dl_achieved" interval=30 N:11111'
hasnt 'primary first-summary ul rate suppressed' 'bitrate-ul_achieved" interval=30 N:22222'

# header / DATA / DEBUG lines must not produce metrics
hasnt 'SUMMARY_HEADER ignored (no header token in output)' 'DL_ACHIEVED_RATE_KBPS'
hasnt 'DATA line not misread as a rate'                    'N:extra'

# ---- assertions: secondary (bufferbloat mapping) --------------------------
have 'secondary dl achieved rate'      'PUTVAL "testhost/cake_autorate-secondary/bitrate-dl_achieved" interval=30 N:60000'
have 'secondary dl load = high+bb(12)' 'PUTVAL "testhost/cake_autorate-secondary/gauge-dl_load" interval=30 N:12'
have 'secondary ul load = idle(0)'     'PUTVAL "testhost/cake_autorate-secondary/gauge-ul_load" interval=30 N:0'
have 'secondary dl owd delta'          'PUTVAL "testhost/cake_autorate-secondary/gauge-dl_owd_delta_us" interval=30 N:30000'

# ---- assertions: tertiary (rotated -> read from .log.old) -----------------
have 'tertiary falls back to .old rate' 'PUTVAL "testhost/cake_autorate-tertiary/bitrate-dl_achieved" interval=30 N:7000'
have 'tertiary falls back to .old load' 'PUTVAL "testhost/cake_autorate-tertiary/gauge-dl_load" interval=30 N:0'

# ---- assertions: chunked (log ending mid-line, the normal live state) ------
have 'chunked reports the last COMPLETE summary' 'PUTVAL "testhost/cake_autorate-chunked/bitrate-dl_achieved" interval=30 N:33000'
have 'chunked still emits a load gauge'          'PUTVAL "testhost/cake_autorate-chunked/gauge-dl_load" interval=30 N:1'
hasnt 'chunked fragment not read as a rate'      "cake_autorate-chunked/bitrate-dl_achieved\" interval=30 N:$CHUNKED_FRAG_TS"
have 'fragment cut inside the last field ignored' 'PUTVAL "testhost/cake_autorate-chunkedlate/bitrate-ul_shaper" interval=30 N:11000'
hasnt 'field-count-13 fragment not published'     'cake_autorate-chunkedlate/bitrate-dl_achieved" interval=30 N:88000'
hasnt 'fragment load state not published'         'cake_autorate-chunkedlate/gauge-dl_load" interval=30 N:2'

# ---- freshness: stale samples must not be published -----------------------
#
# Why this matters: PUTVAL stamps every value with N: (= now), so republishing
# the last SUMMARY line records a minutes-old measurement as a fresh sample. The
# daemon writes no SUMMARY lines at all while it sleeps through an idle link, so
# without this guard an idle connection draws a perfectly flat line that cannot
# be told apart from a genuinely steady one. A gap is the honest rendering.
#
# The threshold is pinned with CAKE_AUTORATE_MAX_SAMPLE_AGE_S rather than left to
# the 2 x COLLECTD_INTERVAL default, so these cases do not race the clock.

# --- "asleep": daemon stopped writing SUMMARY lines 10 minutes ago. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:20:00; %s.000000; 41000; 17000; 4; 2; 700; 300; dl_idle; ul_idle; 20000; 9500\n' "$((NOW - 600))"
} > "$WORK/cake-autorate.asleep.log"

# --- "asleeprotated": same, but the live log has already rotated to headers
#     only and the stale SUMMARY survives in .old. The .old fallback must not
#     smuggle a stale sample back in. ---
{
	printf '%s\n' "$HEADER"
} > "$WORK/cake-autorate.asleeprotated.log"
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:20:00; %s.000000; 41000; 17000; 4; 2; 700; 300; dl_idle; ul_idle; 20000; 9500\n' "$((NOW - 600))"
} > "$WORK/cake-autorate.asleeprotated.log.old"

# --- "awake": inside the window, must still publish (proves the guard is a
#     freshness test and not a blanket mute). ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:29:30; %s.000000; 42000; 18000; 4; 2; 700; 300; dl_low; ul_low; 21000; 9600\n' "$((NOW - 30))"
} > "$WORK/cake-autorate.awake.log"

# --- "future": clock stepped (NTP sync after boot), so the sample is
#     future-dated. Negative age counts as fresh -- fail open, never go dark. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:31:00; %s.000000; 43000; 19000; 4; 2; 700; 300; dl_low; ul_low; 22000; 9700\n' "$((NOW + 3600))"
} > "$WORK/cake-autorate.future.log"

# --- "notime": LOG_TIMESTAMP is not a number. Age is unknowable, so fail open
#     rather than silently killing the feed on a format change. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:30:00; not-a-timestamp; 44000; 20000; 4; 2; 700; 300; dl_low; ul_low; 23000; 9800\n'
} > "$WORK/cake-autorate.notime.log"

OUTPUT=$(COLLECTD_HOSTNAME=testhost COLLECTD_INTERVAL=30 \
	CAKE_AUTORATE_MAX_SAMPLE_AGE_S=60 \
	"$READER" \
	"$WORK/cake-autorate.asleep.log" \
	"$WORK/cake-autorate.asleeprotated.log" \
	"$WORK/cake-autorate.awake.log" \
	"$WORK/cake-autorate.future.log" \
	"$WORK/cake-autorate.notime.log" 2>/dev/null)

hasnt 'stale sample publishes no rate'        'cake_autorate-asleep/bitrate-dl_achieved'
hasnt 'stale sample publishes no load gauge'  'cake_autorate-asleep/gauge-dl_load'
hasnt 'stale sample publishes no shaper rate' 'cake_autorate-asleep/bitrate-dl_shaper'
hasnt 'stale .old fallback publishes nothing' 'cake_autorate-asleeprotated/'
have  'fresh sample still published'          'PUTVAL "testhost/cake_autorate-awake/bitrate-dl_achieved" interval=30 N:42000'
have  'future-dated sample fails open'        'PUTVAL "testhost/cake_autorate-future/bitrate-dl_achieved" interval=30 N:43000'
have  'unparsable timestamp fails open'       'PUTVAL "testhost/cake_autorate-notime/bitrate-dl_achieved" interval=30 N:44000'

# ---- summary --------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
