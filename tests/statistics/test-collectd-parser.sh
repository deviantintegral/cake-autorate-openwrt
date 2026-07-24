#!/bin/sh
#
# Contract test for the cake-autorate collectd exec reader
# (net/cake-autorate/files/cake-autorate-collectd.sh).
#
# The reader parses the daemon's SUMMARY log lines (see
# docs/upstream-option-inventory.md section 3) and prints collectd PUTVAL
# lines, one metric per line, with the collectd plugin instance set to the
# cake-autorate instance id (parsed from the log filename).
#
# This test feeds realistic sample logs -- two live instances plus a rotated
# instance whose current .log is empty and whose data lives in .log.old -- and
# asserts the exact per-field, per-instance PUTVAL output, including:
#   * the load-condition string -> numeric gauge mapping,
#   * that the unprefixed SUMMARY_HEADER line is ignored,
#   * that DATA / DEBUG / other TYPE lines are ignored,
#   * that only the LAST SUMMARY line of a file is reported (poll semantics),
#   * that a rotated instance falls back to <log>.old.
#
# POSIX sh; no bashisms. Exit 0 = all assertions passed.

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

# --- instance "primary": header, noise, and TWO summary lines. Only the
#     second (last) one must be reported. High download load, low upload load,
#     no bufferbloat. ---
{
	printf '%s\n' "$HEADER"
	printf 'DEBUG; 2026-07-24-14:30:00; 1753367400.111111; startup complete\n'
	printf 'SUMMARY; 2026-07-24-14:30:01; 1753367401.222222; 11111; 22222; 10; 20; 100; 200; dl_low; ul_idle; 11000; 22000\n'
	printf 'DATA; 2026-07-24-14:30:02; 1753367402.000000; 1753367402.0; 48000; 19000; 60; 40; extra; data; fields; here\n'
	printf 'SUMMARY; 2026-07-24-14:30:03; 1753367403.333333; 48000; 19000; 250; 180; 1200; 800; dl_high; ul_low; 45000; 18000\n'
} > "$WORK/cake-autorate.primary.log"

# --- instance "secondary": bufferbloat on download, idle upload. ---
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:30:03; 1753367403.444444; 60000; 5000; 900; 60; 30000; 150; dl_high_bb; ul_idle; 52000; 20000\n'
} > "$WORK/cake-autorate.secondary.log"

# --- instance "tertiary": just rotated. Current .log is empty; the last
#     SUMMARY is in .log.old and must be picked up via fallback. ---
: > "$WORK/cake-autorate.tertiary.log"
{
	printf '%s\n' "$HEADER"
	printf 'SUMMARY; 2026-07-24-14:29:00; 1753367340.000000; 7000; 3000; 5; 5; 50; 40; dl_idle; ul_idle; 8000; 4000\n'
} > "$WORK/cake-autorate.tertiary.log.old"

# ---- run the reader in one-shot mode over the fixtures --------------------
if [ ! -x "$READER" ]; then
	printf 'FAIL: reader not found or not executable: %s\n' "$READER" >&2
	exit 1
fi

OUTPUT=$(COLLECTD_HOSTNAME=testhost COLLECTD_INTERVAL=30 \
	"$READER" \
	"$WORK/cake-autorate.primary.log" \
	"$WORK/cake-autorate.secondary.log" \
	"$WORK/cake-autorate.tertiary.log" 2>/dev/null)

# ---- assertions: primary (last SUMMARY line only) -------------------------
have 'primary dl achieved rate'  'PUTVAL "testhost/cake_autorate-primary/bitrate-dl_achieved" interval=30 N:48000'
have 'primary ul achieved rate'  'PUTVAL "testhost/cake_autorate-primary/bitrate-ul_achieved" interval=30 N:19000'
have 'primary dl shaper rate'    'PUTVAL "testhost/cake_autorate-primary/bitrate-dl_shaper" interval=30 N:45000'
have 'primary ul shaper rate'    'PUTVAL "testhost/cake_autorate-primary/bitrate-ul_shaper" interval=30 N:18000'
have 'primary dl owd delta'      'PUTVAL "testhost/cake_autorate-primary/delay-dl_owd_delta" interval=30 N:1200'
have 'primary ul owd delta'      'PUTVAL "testhost/cake_autorate-primary/delay-ul_owd_delta" interval=30 N:800'
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
have 'secondary dl owd delta'          'PUTVAL "testhost/cake_autorate-secondary/delay-dl_owd_delta" interval=30 N:30000'

# ---- assertions: tertiary (rotated -> read from .log.old) -----------------
have 'tertiary falls back to .old rate' 'PUTVAL "testhost/cake_autorate-tertiary/bitrate-dl_achieved" interval=30 N:7000'
have 'tertiary falls back to .old load' 'PUTVAL "testhost/cake_autorate-tertiary/gauge-dl_load" interval=30 N:0'

# ---- summary --------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
