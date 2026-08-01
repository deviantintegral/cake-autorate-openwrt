#!/bin/sh
#
# test-bridge.sh -- tests the UCI -> shell config bridge. Runs entirely
# off-device: no libuci, no router.
#
# It runs the real bridge and reads its output and exit code to check that:
#   1. the embedded option schema is byte-identical to docs/uci-option-schema.tsv
#      (the bridge's mapping and the documented metadata cannot drift apart);
#   2. the two-instance fixture produces two config.<name>.sh at distinct paths;
#   3. values are written correctly per type -- floats keep a decimal point,
#      integers have none, bools become 0/1, strings are shell-quoted,
#      reflectors become a bash array literal;
#   4. every generated key is written in a form upstream will accept;
#   5. odd input converts as expected: 6.0 -> 6, 1 -> 1.0, .5 -> 0.5, truthy
#      bool spellings -> 1, a rate unit (20mbit) -> 20000 kbps;
#   6. bad input skips the instance: a non-integral integer, a negative, an
#      empty must-not-be-empty string;
#   7. the forced options win even against UCI that tries to disable them
#      (output_summary_stats=0, log_to_file=0 -> still =1);
#   8. IPv4 and IPv6 reflectors are accepted; an invalid reflector is dropped;
#   9. two runs over unchanged UCI give byte-identical output;
#  10. a disabled instance is not generated, and stale configs are pruned;
#  11. the coverage check passes on a valid config and fires when the bridge is
#      mutated to drop a key or emit a stray one.
#
# Exit 0 = all checks passed.

# SC2015: the `cond && ok "..." || fail "..."` idiom is safe here because ok()
#         always returns 0 (its last command is printf), so fail never runs when
#         cond succeeds.
# SC2012: `ls` only builds messages for a human to read, never drives logic, and
#         our test paths are alphanumeric.
# shellcheck disable=SC2015,SC2012
set -u

here=$(dirname "$0")
root=$(cd "$here/../.." && pwd)

BRIDGE="$root/net/cake-autorate/files/cake-autorate-bridge.sh"
TSV="$root/docs/uci-option-schema.tsv"
FIXTURE="$root/tests/schema/fixtures/two-instances.uci"
SHIPPED="$root/net/cake-autorate/files/cake-autorate.config"
AWK_PARSER="$root/tests/schema/uci-syntax-check.awk"

CAKE_AUTORATE_UCI_AWK="$AWK_PARSER"
export CAKE_AUTORATE_UCI_AWK

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

checks=0
fails=0
ok()   { checks=$((checks + 1)); printf 'ok   %s\n' "$*"; }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); printf 'FAIL %s\n' "$*"; }

run_bridge() { sh "$BRIDGE" "$@"; }

# ------------------------------------------------------------------ check 1
echo "== 1. embedded schema matches the TSV"
run_bridge --check-schema > "$tmp/schema.embedded" 2>/dev/null
awk -F'\t' '$0 !~ /^#/ && NF > 0 {print $1 "\t" $3 "\t" $6}' "$TSV" > "$tmp/schema.tsv"
if diff -u "$tmp/schema.tsv" "$tmp/schema.embedded" > "$tmp/d.schema"; then
	ok "bridge --check-schema matches docs/uci-option-schema.tsv exactly"
else
	fail "embedded schema drifted from the TSV:"; sed 's/^/     /' "$tmp/d.schema"
fi

# ------------------------------------------------------------------ check 2
echo
echo "== 2. two-instance fixture -> two config files at distinct paths"
out2="$tmp/out2"; mkdir -p "$out2"
if run_bridge --uci-file "$FIXTURE" --config-dir "$out2" 2>"$tmp/e2"; then
	:
else
	fail "bridge exited non-zero on the two-instance fixture"; sed 's/^/     /' "$tmp/e2"
fi
if [ -f "$out2/config.wan_dsl.sh" ] && [ -f "$out2/config.wan_lte.sh" ]; then
	ok "produced config.wan_dsl.sh and config.wan_lte.sh"
else
	fail "expected two config files, got: $(ls "$out2" 2>/dev/null | tr '\n' ' ')"
fi
nfiles=$(ls "$out2"/config.*.sh 2>/dev/null | wc -l | tr -d ' ')
if [ "$nfiles" = 2 ]; then ok "exactly two config files (no extras)"; else fail "expected 2 files, found $nfiles"; fi

# ------------------------------------------------------------------ check 3
echo
echo "== 3. values are written correctly per type (from wan_dsl)"
cfg="$out2/config.wan_dsl.sh"
grep -q '^reflector_ping_interval_s=0\.3$' "$cfg" \
	&& ok "float keeps its decimal point (reflector_ping_interval_s=0.3)" \
	|| fail "float form wrong: $(grep '^reflector_ping_interval_s=' "$cfg")"
grep -q '^no_pingers=6$' "$cfg" \
	&& ok "integer carries no decimal point (no_pingers=6)" \
	|| fail "integer form wrong: $(grep '^no_pingers=' "$cfg")"
grep -q '^debug=0$' "$cfg" \
	&& ok "bool is a bare 0/1 (debug=0)" \
	|| fail "bool form wrong: $(grep '^debug=' "$cfg")"
grep -q '^dl_if="ifb4eth1"$' "$cfg" \
	&& ok "string is double-quoted (dl_if=\"ifb4eth1\")" \
	|| fail "string form wrong: $(grep '^dl_if=' "$cfg")"
grep -q '^reflectors=( "1.1.1.1" "8.8.8.8" "9.9.9.9" "2606:4700:4700::1111" "2001:4860:4860::8888" "2620:fe::fe" )$' "$cfg" \
	&& ok "reflectors is a bash array literal with IPv4+IPv6, order preserved" \
	|| fail "reflectors form wrong: $(grep '^reflectors=' "$cfg")"

# ------------------------------------------------------------------ check 4
echo
echo "== 4. every generated key is written in a form upstream accepts"
# Build a type map from the embedded schema, then check a config that uses all
# 66 keys (the shipped 'primary', generated with its enabled gate bypassed).
run_bridge --uci-file "$SHIPPED" --instance primary --stdout > "$tmp/primary.sh" 2>"$tmp/e4" \
	|| { fail "could not generate the shipped primary config"; sed 's/^/     /' "$tmp/e4"; }
awk -v schema="$tmp/schema.embedded" '
	BEGIN {
		while ((getline line < schema) > 0) {
			n = split(line, f, "\t"); if (n >= 2) type[f[1]] = f[2]
		}
		bad = 0
	}
	/^#/ || /^$/ { next }
	/^# ---/ { next }
	{
		line = $0
		key = line; sub(/=.*/, "", key)
		val = line; sub(/^[^=]*=/, "", val)
		t = type[key]
		if (t == "") { printf "  stray key not in schema: %s\n", key; bad++; next }
		if (val ~ /^-/) { printf "  %s: negative value %s\n", key, val; bad++ }
		if (t == "integer") {
			if (val !~ /^[0-9]+$/) { printf "  %s: integer must be bare digits, got %s\n", key, val; bad++ }
		} else if (t == "bool") {
			if (val !~ /^[01]$/) { printf "  %s: bool must be 0/1, got %s\n", key, val; bad++ }
		} else if (t == "float") {
			if (val !~ /^[0-9]+\.[0-9]+$/) { printf "  %s: float must carry a decimal point, got %s\n", key, val; bad++ }
		} else if (t == "string") {
			if (val !~ /^".*"$/) { printf "  %s: string must be double-quoted, got %s\n", key, val; bad++ }
		} else if (t == "list") {
			if (val !~ /^\( .* \)$/) { printf "  %s: list must be a bash array literal, got %s\n", key, val; bad++ }
		}
	}
	END { exit (bad > 0) }
' "$tmp/primary.sh" > "$tmp/lex.err" 2>&1 \
	&& ok "all generated keys in the full primary config are type-valid" \
	|| { fail "type-invalid generated key(s):"; sed 's/^/     /' "$tmp/lex.err"; }

# count: primary sets 65 scalar options + reflectors = 66 UCI options, but the
# 4 forced keys collapse (3 already user-set) -> emitted count check
nkeys=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp/primary.sh")
if [ "$nkeys" = 66 ]; then ok "primary emits all 66 upstream keys"; else fail "primary emitted $nkeys keys, expected 66"; fi

# ------------------------------------------------------------------ check 5
echo
echo "== 5. odd input values convert as expected"
cat > "$tmp/edge.uci" <<'EOF'
config cake-autorate 'edge'
	option enabled '1'
	option dl_if 'ifb-wan'
	option ul_if 'wan'
	option no_pingers '6.0'
	option reflector_ping_interval_s '1'
	option sustained_idle_sleep_thr_s '.5'
	option adjust_dl_shaper_rate 'on'
	option adjust_ul_shaper_rate 'true'
	option enable_sleep_function 'yes'
	option base_dl_shaper_rate_kbps '20mbit'
	option min_dl_shaper_rate_kbps '5000'
	option max_dl_shaper_rate_kbps '80000'
EOF
run_bridge --uci-file "$tmp/edge.uci" --instance edge --stdout > "$tmp/edge.sh" 2>"$tmp/e5" \
	|| { fail "edge fixture failed to generate"; sed 's/^/     /' "$tmp/e5"; }
grep -q '^no_pingers=6$'                   "$tmp/edge.sh" && ok "integer 6.0 -> 6"            || fail "6.0 not normalised: $(grep '^no_pingers=' "$tmp/edge.sh")"
grep -q '^reflector_ping_interval_s=1.0$'  "$tmp/edge.sh" && ok "float 1 -> 1.0"             || fail "1 not floatified: $(grep '^reflector_ping_interval_s=' "$tmp/edge.sh")"
grep -q '^sustained_idle_sleep_thr_s=0.5$' "$tmp/edge.sh" && ok "float .5 -> 0.5"            || fail ".5 not normalised: $(grep '^sustained_idle_sleep_thr_s=' "$tmp/edge.sh")"
grep -q '^adjust_dl_shaper_rate=1$'        "$tmp/edge.sh" && ok "bool 'on' -> 1"            || fail "'on' not 1: $(grep '^adjust_dl_shaper_rate=' "$tmp/edge.sh")"
grep -q '^adjust_ul_shaper_rate=1$'        "$tmp/edge.sh" && ok "bool 'true' -> 1"          || fail "'true' not 1"
grep -q '^enable_sleep_function=1$'        "$tmp/edge.sh" && ok "bool 'yes' -> 1"           || fail "'yes' not 1"
grep -q '^base_dl_shaper_rate_kbps=20000$' "$tmp/edge.sh" && ok "rate '20mbit' -> 20000 kbps" || fail "20mbit not converted: $(grep '^base_dl_shaper_rate_kbps=' "$tmp/edge.sh")"

# ------------------------------------------------------------------ check 6
echo
echo "== 6. bad input skips the instance: never emit a bad value, and never"
echo "      abort the run, so the other instances keep working"
mk_bad() { printf "config cake-autorate 'bad'\n\toption enabled '1'\n\toption dl_if 'x'\n\toption ul_if 'y'\n%b\n" "$1" > "$tmp/bad.uci"; }

# A bad value must produce no config, the bridge must still exit 0, and a skip
# warning must reach stderr.
assert_skipped() {  # <label> <uci-file>
	_out=$(run_bridge --uci-file "$2" --instance bad --stdout 2>"$tmp/e"); _rc=$?
	if [ "$_rc" -eq 0 ] && [ -z "$_out" ] && grep -qi 'skip' "$tmp/e"; then
		ok "$1 -> instance skipped, no config emitted, bridge exit 0"
	else
		fail "$1 -> rc=$_rc, output='$_out' (expected empty output + skip + exit 0)"
	fi
}

mk_bad "\toption no_pingers '6.5'";              assert_skipped "non-integral integer 6.5" "$tmp/bad.uci"
mk_bad "\toption min_dl_shaper_rate_kbps '-5000'"; assert_skipped "negative value" "$tmp/bad.uci"
printf "config cake-autorate 'bad'\n\toption enabled '1'\n\toption dl_if ''\n\toption ul_if 'y'\n" > "$tmp/bad.uci"
assert_skipped "empty dl_if (non-empty-default string)" "$tmp/bad.uci"
printf "config cake-autorate 'bad'\n\toption enabled '1'\n\toption dl_if 'x'\n\toption ul_if 'y'\n\toption bogus_key '1'\n" > "$tmp/bad.uci"
assert_skipped "unknown UCI key (would kill the daemon if emitted)" "$tmp/bad.uci"

# A malformed `enabled` value counts as disabled; it must not abort the run.
printf "config cake-autorate 'bad'\n\toption enabled 'ture'\n\toption dl_if 'x'\n\toption ul_if 'y'\n" > "$tmp/bad.uci"
_out=$(run_bridge --uci-file "$tmp/bad.uci" 2>"$tmp/e"); _rc=$?
if [ "$_rc" -eq 0 ]; then ok "malformed enabled -> treated as disabled, exit 0"
else fail "malformed enabled -> rc=$_rc (expected 0)"; fi

# One bad instance must not stop a second, valid one.
printf "config cake-autorate 'good'\n\toption enabled '1'\n\toption dl_if 'ifb4eth0'\n\toption ul_if 'eth0'\n\toption min_dl_shaper_rate_kbps '2000'\nconfig cake-autorate 'broken'\n\toption enabled '1'\n\toption dl_if 'ifb4eth1'\n\toption ul_if 'eth1'\n\toption no_pingers '6.5'\n" > "$tmp/mixed.uci"
_cfgdir=$(mktemp -d)
run_bridge --uci-file "$tmp/mixed.uci" --config-dir "$_cfgdir" >"$tmp/e" 2>&1; _rc=$?
if [ "$_rc" -eq 0 ] && [ -f "$_cfgdir/config.good.sh" ] && [ ! -f "$_cfgdir/config.broken.sh" ]; then
	ok "one broken instance is skipped; the valid instance is still generated"
else
	fail "resilience broke: rc=$_rc good=$([ -f "$_cfgdir/config.good.sh" ] && echo y || echo n) broken=$([ -f "$_cfgdir/config.broken.sh" ] && echo y || echo n)"
fi
rm -rf "$_cfgdir"

# An all-invalid reflector list drops the option (daemon defaults), keeps the instance.
printf "config cake-autorate 'refl'\n\toption enabled '1'\n\toption dl_if 'x'\n\toption ul_if 'y'\n\tlist reflectors 'one.one.one.one'\n\tlist reflectors 'not-an-ip'\n" > "$tmp/refl.uci"
_out=$(run_bridge --uci-file "$tmp/refl.uci" --instance refl --stdout 2>"$tmp/e"); _rc=$?
if [ "$_rc" -eq 0 ] && [ -n "$_out" ] && ! printf '%s' "$_out" | grep -q '^reflectors=('; then
	ok "all-invalid reflectors -> option dropped, instance still generated (daemon defaults)"
else
	fail "reflector fallback broke: rc=$_rc has_reflectors=$(printf '%s' "$_out" | grep -c '^reflectors=(')"
fi

# ------------------------------------------------------------------ check 7
echo
echo "== 7. forced options win against UCI that tries to override them"
cat > "$tmp/hostile.uci" <<'EOF'
config cake-autorate 'hostile'
	option enabled '1'
	option dl_if 'ifb-wan'
	option ul_if 'wan'
	option output_summary_stats '0'
	option log_to_file '0'
	option log_DEBUG_messages_to_syslog '1'
	option log_file_path_override '/tmp/attacker'
EOF
run_bridge --uci-file "$tmp/hostile.uci" --instance hostile --stdout > "$tmp/hostile.sh" 2>"$tmp/e7" \
	|| { fail "hostile fixture failed to generate"; sed 's/^/     /' "$tmp/e7"; }
grep -q '^output_summary_stats=1$'        "$tmp/hostile.sh" && ok "output_summary_stats forced to 1 despite UCI 0" || fail "output_summary_stats not forced: $(grep '^output_summary_stats=' "$tmp/hostile.sh")"
grep -q '^log_to_file=1$'                 "$tmp/hostile.sh" && ok "log_to_file forced to 1 despite UCI 0"          || fail "log_to_file not forced: $(grep '^log_to_file=' "$tmp/hostile.sh")"
grep -q '^log_DEBUG_messages_to_syslog=0$' "$tmp/hostile.sh" && ok "log_DEBUG_messages_to_syslog forced to 0 despite UCI 1" || fail "log_DEBUG not forced"
grep -q '^log_file_path_override=""$'      "$tmp/hostile.sh" && ok "log_file_path_override forced empty (pins per-instance log path)" || fail "log_file_path_override not forced empty: $(grep '^log_file_path_override=' "$tmp/hostile.sh")"
# and none of the forced keys appears twice
for k in output_summary_stats log_to_file log_DEBUG_messages_to_syslog log_file_path_override; do
	c=$(grep -cE "^$k=" "$tmp/hostile.sh")
	[ "$c" = 1 ] || fail "forced key $k emitted $c times (expected once)"
done
ok "each forced key emitted exactly once (user copy suppressed)"

# ------------------------------------------------------------------ check 8
echo
echo "== 8. reflector validation (IPv4 + IPv6 accepted, invalid dropped)"
cat > "$tmp/refl.uci" <<'EOF'
config cake-autorate 'refl'
	option enabled '1'
	option dl_if 'x'
	option ul_if 'y'
	list reflectors '1.1.1.1'
	list reflectors '2606:4700:4700::1111'
	list reflectors '999.1.2.3'
	list reflectors 'not_an_ip'
	list reflectors '8.8.8.8'
EOF
run_bridge --uci-file "$tmp/refl.uci" --instance refl --stdout > "$tmp/refl.sh" 2>"$tmp/e8"
if grep -q '^reflectors=( "1.1.1.1" "2606:4700:4700::1111" "8.8.8.8" )$' "$tmp/refl.sh"; then
	ok "kept 1.1.1.1, IPv6, 8.8.8.8; dropped 999.1.2.3 and not_an_ip"
else
	fail "reflector filtering wrong: $(grep '^reflectors=' "$tmp/refl.sh")"
fi
grep -q "dropping invalid entry '999.1.2.3'" "$tmp/e8" && grep -q "dropping invalid entry 'not_an_ip'" "$tmp/e8" \
	&& ok "invalid reflectors reported on stderr" || fail "invalid reflectors not reported"

# ------------------------------------------------------------------ check 9
echo
echo "== 9. two runs give byte-identical output"
a="$tmp/run_a"; b="$tmp/run_b"; mkdir -p "$a" "$b"
run_bridge --uci-file "$FIXTURE" --config-dir "$a" 2>/dev/null
run_bridge --uci-file "$FIXTURE" --config-dir "$b" 2>/dev/null
if diff -r "$a" "$b" > "$tmp/d.idem" 2>&1; then
	ok "two independent runs are byte-identical"
else
	fail "outputs differ between runs:"; sed 's/^/     /' "$tmp/d.idem"
fi
# also same dir twice
run_bridge --uci-file "$FIXTURE" --config-dir "$a" 2>/dev/null
if diff -r "$a" "$b" > "$tmp/d.idem2" 2>&1; then
	ok "re-running into the same dir changes nothing"
else
	fail "re-run into same dir differs:"; sed 's/^/     /' "$tmp/d.idem2"
fi

# ------------------------------------------------------------------ check 10
echo
echo "== 10. disabled instances are skipped and stale configs pruned"
cat > "$tmp/toggle.uci" <<'EOF'
config cake-autorate 'alpha'
	option enabled '1'
	option dl_if 'x'
	option ul_if 'y'
config cake-autorate 'beta'
	option enabled '1'
	option dl_if 'x'
	option ul_if 'y'
EOF
pd="$tmp/prune"; mkdir -p "$pd"
run_bridge --uci-file "$tmp/toggle.uci" --config-dir "$pd" 2>/dev/null
[ -f "$pd/config.alpha.sh" ] && [ -f "$pd/config.beta.sh" ] \
	&& ok "both enabled instances generated" || fail "expected alpha+beta configs"
# now disable beta and re-sync
cat > "$tmp/toggle.uci" <<'EOF'
config cake-autorate 'alpha'
	option enabled '1'
	option dl_if 'x'
	option ul_if 'y'
config cake-autorate 'beta'
	option enabled '0'
	option dl_if 'x'
	option ul_if 'y'
EOF
run_bridge --uci-file "$tmp/toggle.uci" --config-dir "$pd" 2>/dev/null
if [ -f "$pd/config.alpha.sh" ] && [ ! -f "$pd/config.beta.sh" ]; then
	ok "disabled beta pruned, alpha retained"
else
	fail "prune wrong: $(ls "$pd" | tr '\n' ' ')"
fi

# ------------------------------------------------------------------ check 11
echo
echo "== 11. the coverage check catches a mutated bridge (drop / stray key)"
anchor='----- Coverage check -----'
# 11a: mutant that emits a stray key
awk -v a="$anchor" '
	index($0, a) && !done { print "\tprintf \"stray_key=1\\n\" >> \"$out\""; done=1 }
	{ print }
' "$BRIDGE" > "$tmp/mut_stray.sh"
# A mutated bridge must still trip the coverage check (message on stderr) and
# skip the affected instance (no --stdout output) rather than quietly emit an
# incomplete config the daemon would choke on. It exits 0 but generates nothing
# for that instance.
_out=$(sh "$tmp/mut_stray.sh" --uci-file "$FIXTURE" --instance wan_dsl --stdout 2>"$tmp/e11a"); _rc=$?
if [ "$_rc" -eq 0 ] && [ -z "$_out" ] && { grep -q 'only emitted' "$tmp/e11a" || grep -qi 'coverage' "$tmp/e11a"; }; then
	ok "stray extra key -> coverage fires, instance skipped (daemon-fatal key blocked)"
else
	fail "stray-key mutant not handled: rc=$_rc out='$_out'"; sed 's/^/     /' "$tmp/e11a"
fi
# 11b: mutant that drops a key
awk -v a="$anchor" '
	index($0, a) && !done { print "\tsed -i \"/^debug=/d\" \"$out\""; done=1 }
	{ print }
' "$BRIDGE" > "$tmp/mut_drop.sh"
_out=$(sh "$tmp/mut_drop.sh" --uci-file "$FIXTURE" --instance wan_dsl --stdout 2>"$tmp/e11b"); _rc=$?
if [ "$_rc" -eq 0 ] && [ -z "$_out" ] && { grep -q 'only in UCI' "$tmp/e11b" || grep -qi 'coverage' "$tmp/e11b"; }; then
	ok "dropped key -> coverage fires, instance skipped (silent drop blocked)"
else
	fail "drop-key mutant not handled: rc=$_rc out='$_out'"; sed 's/^/     /' "$tmp/e11b"
fi
# 11c: unmutated bridge passes coverage cleanly (control)
if run_bridge --uci-file "$FIXTURE" --instance wan_dsl --stdout >/dev/null 2>"$tmp/e11c"; then
	grep -q 'all options mapped' "$tmp/e11c" \
		&& ok "unmutated bridge: coverage passes with 'all options mapped'" \
		|| fail "expected 'all options mapped' on the valid run"
else
	fail "unmutated bridge unexpectedly failed"; sed 's/^/     /' "$tmp/e11c"
fi

# ------------------------------------------------------------------ summary
echo
if [ "$fails" -eq 0 ]; then
	echo "PASS: $checks/$checks checks passed"
	exit 0
fi
echo "FAIL: $fails of $checks checks failed"
exit 1
