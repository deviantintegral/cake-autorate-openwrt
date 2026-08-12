#!/bin/sh
# Guards net/cake-autorate/patches/010-reject-malformed-fping-samples.patch.
#
# The bug, reported from a live router on v3.2.2 with pinger_binary=fping: the
# daemon's fping arm accepts ANY line of 12 whitespace fields off the pinger
# fifo, then feeds field 6 to `printf %.3f` and field 0 to `10#${...}` without
# looking at either. One malformed line therefore reaches bash arithmetic, and
# under the `set -u` the daemon runs with, the unbound-variable abort exits the
# process -- cleanly, so procd does not respawn it, and the WAN runs unshaped
# until someone restarts the service by hand:
#
#     line 1292: printf: bytes: invalid number
#     line 1354: ((: (t_start_us - 10#S1786559486685130: value too great for base
#     line 1525: S1786559486685130: unbound variable
#
# This test extracts the gate condition FROM THE SHIPPED PATCH rather than
# restating it, so the two cannot drift, and drives it over the sample shapes
# that matter. It is the semantic half of the guard; the build supplies the
# other half, since a patch that stops applying fails the SDK build loudly.
set -u

here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
patch_file="$repo/net/cake-autorate/patches/010-reject-malformed-fping-samples.patch"
makefile="$repo/net/cake-autorate/Makefile"

# The upstream version the patch's context was cut against. When Renovate moves
# PKG_VERSION this mismatch is the reminder to re-check whether upstream has
# shipped PR #392 yet -- if it has, drop the patch instead of refreshing it.
patched_version=3.2.2

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

[ -f "$patch_file" ] || { printf 'FAIL missing patch: %s\n' "$patch_file"; exit 1; }

# ---------------------------------------------------------------------------
# Pull the gate out of the patch: the added `if ((${#command[@]} == 12))` line
# and every added line after it, up to and including the first that does not end
# in `&&`. That tracks a condition of any length without hardcoding its shape.
# ---------------------------------------------------------------------------
awk '
	/^\+/ {
		line = substr($0, 2)
		if (!p && line ~ /if \(\(\$\{#command\[@\]\} == 12\)\)/) p = 1
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

for field in 'command\[6\]' 'command\[0\]'; do
	if grep -q "$field" "$work/condition"; then
		ok "gate inspects $(printf '%s' "$field" | tr -d '\\')"
	else
		bad "gate does not inspect $(printf '%s' "$field" | tr -d '\\')"
	fi
done

# The daemon is bash, and so is the gate: [[ ]], globs and an indexed array.
# Wrap the extracted condition in the smallest bash program that answers
# "would this line be taken as a reflector response?" via exit status.
{
	printf '#!/usr/bin/env bash\nset -u\ndeclare -a command\nread -r -a command <<< "$1"\n'
	cat "$work/condition"
	printf '\nthen exit 0\nfi\nexit 1\n'
} > "$work/gate"
chmod +x "$work/gate"

bash -n "$work/gate" || { printf 'FAIL extracted gate is not valid bash\n'; exit 1; }

# check <accept|reject> <label> <line>
check() {
	want=$1
	label=$2
	line=$3
	if bash "$work/gate" "$line"; then got=accept; else got=reject; fi
	if [ "$got" = "$want" ]; then ok "$want: $label"; else bad "want $want, got $got: $label"; fi
}

# --- real samples the daemon MUST keep consuming ---------------------------
# Captured from a live fping 5.3 run (the version OpenWrt ships).
check accept "fping 5.3 reply"        '[1786560421.42163] 1.1.1.1 : [0], 64 bytes, 4.81 ms (4.81 avg, 0% loss)'
# fping 4.x prints a six-decimal timestamp; still a valid sample.
check accept "fping 4.x reply"        '[1786559486.685130] 8.8.8.8 : [12], 64 bytes, 12.30 ms (11.90 avg, 0% loss)'
# fping prints "% return)" instead of "% loss)" when replies outnumber sends.
check accept "reply, return not loss" '[1786560421.47185] 9.9.9.9 : [3], 64 bytes, 0.98 ms (1.02 avg, 5% return)'
check accept "integer rtt"            '[1786560421.47185] 9.9.9.9 : [3], 64 bytes, 5 ms (5 avg, 0% loss)'

# --- the shapes that killed the daemon -------------------------------------
# The reported line: a torn write spliced the daemon's own "SARS" load message
# onto a pinger line, leaving `bytes` in the rtt field and `S`+epoch in the
# timestamp field, with the field count still 12.
check reject "rtt is the word bytes"  'S[1786559486.685130] 1.1.1.1 : [0], 64 bytes 4.81 ms (4.81 avg, 0% loss)'
# Upstream PR #392: a backwards clock step makes fping print a negative rtt,
# which `10#` cannot represent.
check reject "negative rtt"           '[1786560421.42163] 1.1.1.1 : [0], 64 bytes, -1.8e+03 ms (4.81 avg, 0% loss)'
# Field 6 alone is fine here -- only the timestamp is junk. Upstream's PR #392
# does not cover this one; the report above proves it is reachable.
check reject "junk timestamp only"    'S[1786559486.685130] 1.1.1.1 : [0], 64 bytes, 4.81 ms (4.81 avg, 0% loss)'
# Strips to the empty string, which would make the arithmetic a bare `10#`.
check reject "all-punctuation ts"     '[.] 1.1.1.1 : [0], 64 bytes, 4.81 ms (4.81 avg, 0% loss)'

# --- other 12-field lines fping itself can put on the fifo ------------------
check reject "ICMP unreachable"       'ICMP Unreachable (Fragmentation Needed) from 192.0.2.1 for ICMP Echo sent to 1.1.1.1'
check reject "short ICMP TS reply"    'received packet too short for ICMP Timestamp Reply (28 bytes from 1.1.1.1)'

# --- lines the field count already rejected, still rejected ----------------
check reject "timed out (10 fields)"  '[1786560421.42163] 1.1.1.1 : [0], timed out (NaN avg, 100% loss)'
check reject "SARS load message"      'SARS 20000 7500'

# ---------------------------------------------------------------------------
# Tripwire: the patch context was cut against one upstream version.
# ---------------------------------------------------------------------------
pkg_version=$(awk -F: '/^PKG_VERSION:=/ { sub(/^=/, "", $2); print $2; exit }' "$makefile")
if [ "$pkg_version" = "$patched_version" ]; then
	ok "PKG_VERSION still $patched_version, patch context valid"
else
	bad "PKG_VERSION moved $patched_version -> $pkg_version: re-check whether upstream now ships PR #392 (then delete this patch and this test) before refreshing the context"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
