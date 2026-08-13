#!/bin/sh
# Guards net/cake-autorate/patches/020-reject-malformed-sars-records.patch.
#
# The other half of the bug test-fping-sample-gate.sh covers. ${main_fd} is one
# unframed pipe shared by the achieved-rate monitor (`SARS <dl> <ul>`) and the
# pinger, so a torn write splices one stream into the other. 010 hardened the
# pinger arm. Reported from a live router on v3.2.2 with pinger_binary=fping,
# the splice landed in the SARS arm instead -- an fping `--timestamp` prefix
# welded onto a rate, with the field count still 3, which is all upstream's gate
# checks. Seven crashes in three hours, every one of them this, hitting both
# halves of the same comparison -- the dl rate on line 1181, the ul rate on 1191:
#
#     line 1181: ((: 0[1786626254.60005]: arithmetic syntax error
#     line 1191: ((: 390[1786630033.55848]: arithmetic syntax error
#
# And where 010's failure mode is a clean exit procd does not respawn, this one
# is louder and worse: bash writes to stderr, upstream's intercept_stderr()
# answers any stderr line with `kill $$`, and the router logs a crash loop.
#
# Same method as the sibling suite: extract the gate condition FROM THE SHIPPED
# PATCH rather than restating it, so the two cannot drift, then drive it over
# the record shapes that matter. The build supplies the other half -- a patch
# that stops applying fails the SDK build loudly.
set -u

here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
patch_file="$repo/net/cake-autorate/patches/020-reject-malformed-sars-records.patch"
makefile="$repo/net/cake-autorate/Makefile"

# The upstream version the patch's context was cut against. When Renovate moves
# PKG_VERSION this mismatch is the reminder to re-check whether upstream has
# fixed the SARS arm -- as of master at 3.3.0-PRERELEASE it is byte-identical.
patched_version=3.2.2

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

[ -f "$patch_file" ] || { printf 'FAIL missing patch: %s\n' "$patch_file"; exit 1; }

# ---------------------------------------------------------------------------
# Pull the gate out of the patch: the added `if ((${#command[@]} == 3))` line
# and every added line after it, up to and including the first that does not end
# in `&&`. That tracks a condition of any length without hardcoding its shape.
# ---------------------------------------------------------------------------
awk '
	/^\+/ {
		line = substr($0, 2)
		if (!p && line ~ /if \(\(\$\{#command\[@\]\} == 3\)\)/) p = 1
		if (p) {
			print line
			if (line !~ /&&[ \t]*$/) exit
		}
	}
' "$patch_file" > "$work/condition"

if [ ! -s "$work/condition" ]; then
	printf 'FAIL could not extract the gate condition from %s\n' "$patch_file"
	exit 1
fi
ok "gate condition extracted from the patch"

for field in 'command\[1\]' 'command\[2\]'; do
	if grep -q "$field" "$work/condition"; then
		ok "gate inspects $(printf '%s' "$field" | tr -d '\\')"
	else
		bad "gate does not inspect $(printf '%s' "$field" | tr -d '\\')"
	fi
done

# The daemon is bash, and so is the gate. Wrap the extracted condition in the
# smallest bash program that answers "would this record set the achieved
# rates?" via exit status. IFS is set the way the daemon sets it globally --
# space AND comma -- because that is what splits the record.
{
	printf '#!/usr/bin/env bash\nset -u\nIFS=" ,"\ndeclare -a command\nread -r -a command <<< "$1"\n'
	cat "$work/condition"
	printf '\nthen exit 0\nfi\nexit 1\n'
} > "$work/gate"
chmod +x "$work/gate"

bash -n "$work/gate" || { printf 'FAIL extracted gate is not valid bash\n'; exit 1; }

# check <accept|reject> <label> <record>
check() {
	want=$1
	label=$2
	record=$3
	if bash "$work/gate" "$record"; then got=accept; else got=reject; fi
	if [ "$got" = "$want" ]; then ok "$want: $label"; else bad "want $want, got $got: $label"; fi
}

# --- real records the daemon MUST keep consuming ---------------------------
check accept "typical load record"    'SARS 20000 7500'
check accept "idle link, both zero"   'SARS 0 0'
check accept "asymmetric rates"       'SARS 943210 390'

# --- the shapes that killed the daemon -------------------------------------
# Both reported records, verbatim. The field count is 3 either way, so the count
# check alone passes them straight through to the (( )) comparisons -- line 1191
# for the ul rate, line 1181 for the dl rate. The reporting router hit the dl
# half five times and the ul half twice, which is why both fields are gated:
# the splice lands at no fixed offset in the record.
check reject "fping ts on ul rate"    'SARS 12000 390[1786630033.55848]'
check reject "fping ts on dl rate"    'SARS 0[1786626254.60005] 459'
# A torn write can leave the fragment in front of the value just as easily.
check reject "ts prefixed to a rate"  'SARS [1786630033.55848]12000 390'
# Three fields, one of them empty -- IFS holds a comma as well as a space, so
# a splice on a delimiter produces this. An empty field passes a digits-only
# class (there is no non-digit in it), which is what the -n half is for.
check reject "empty dl field"         'SARS,,390'
# A rate is an unsigned integer; upstream clamps negatives to 0 before sending.
check reject "negative rate"          'SARS 12000 -390'
check reject "fractional rate"        'SARS 12000 39.0'

# --- records the field count already rejected, still rejected --------------
check reject "truncated record"       'SARS 12000'
check reject "extra field"            'SARS 12000 390 4'
check reject "whole fping reply"      '[1786630033.55848] 1.1.1.1 : [0], 64 bytes, 4.81 ms (4.81 avg, 0% loss)'

# ---------------------------------------------------------------------------
# Tripwire: the patch context was cut against one upstream version.
# ---------------------------------------------------------------------------
pkg_version=$(awk -F: '/^PKG_VERSION:=/ { sub(/^=/, "", $2); print $2; exit }' "$makefile")
if [ "$pkg_version" = "$patched_version" ]; then
	ok "PKG_VERSION still $patched_version, patch context valid"
else
	bad "PKG_VERSION moved $patched_version -> $pkg_version: re-check whether upstream now validates the SARS record (then delete this patch and this test) before refreshing the context"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
