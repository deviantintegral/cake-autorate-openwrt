#!/bin/sh
# Guards the on-device libuci path in the config bridge and the rpcd backend.
#
# The bug, found by the VM run: both scripts run `set -u`, then source OpenWrt's
# /lib/functions.sh and call config_load/config_foreach. Those helpers read
# unbound variables like CONFIG_LIST_STATE, so under `set -u` they abort
# mid-load. The off-device unit tests missed it because they go through the
# --uci-file / CAKE_AUTORATE_INSTANCES overrides, which never touch libuci. On
# real hardware the bridge generated no config and the service refused to start.
#
# This test drives the real libuci path of each script against a stub
# functions.sh that reads an unbound variable at source time, just like the real
# one does. Before the fix these abort and produce nothing; with the `set +u`
# fix they must work.
set -u

here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
bridge="$repo/net/cake-autorate/files/cake-autorate-bridge.sh"
rpcd="$repo/net/cake-autorate/files/cake-autorate.rpcd"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

# ---------------------------------------------------------------------------
# A stand-in for /lib/functions.sh that trips over nounset. A bare
# `: "$UCI_UNBOUND"` with no :- default aborts as soon as a shell with `set -u`
# sources it, which is the real failure. It also provides just enough of the
# config_* API for the two callers, and reads another unbound variable inside
# config_foreach so we know `set +u` covers the whole interaction, not just the
# source line.
# ---------------------------------------------------------------------------
cat > "$work/functions.sh" <<'STUB'
: "$UCI_UNBOUND"          # aborts here under `set -u` if nounset is not relaxed

config_load() { : "$CONFIG_LIST_STATE"; CA_LOADED=1; }

# Invoke the callback once per fake section, touching an unbound var first.
config_foreach() {
	: "$CONFIG_SECTIONS"
	cb=$1
	"$cb" primary
	"$cb" secondary
}

# Return canned values so the bridge emits a minimal valid instance.
config_get() {
	# config_get <var> <section> <option> <default>
	_v=$1; _o=$4
	case "$3" in
		dl_if) eval "$_v=ifb4eth1" ;;
		ul_if) eval "$_v=eth1" ;;
		enabled) eval "$_v=1" ;;
		*) eval "$_v=\$_o" ;;   # sentinel default -> option treated as unset
	esac
}

config_get_bool() { _v=$1; eval "$_v=1"; }   # every section enabled
STUB

# ===========================================================================
# 1. Bridge: the real libuci path (no --uci-file) must generate a config.
# ===========================================================================
out="$work/bridge.out"
if CAKE_AUTORATE_FUNCTIONS_SH="$work/functions.sh" \
   sh "$bridge" --stdout --instance primary > "$out" 2> "$work/bridge.err"; then
	if grep -q '^dl_if="ifb4eth1"' "$out" && grep -q '^output_summary_stats=1' "$out"; then
		ok "bridge libuci path emits a config under a nounset-hostile functions.sh"
	else
		bad "bridge ran but produced no recognizable config"
		printf '  --- stdout ---\n'; sed 's/^/  /' "$out"
		printf '  --- stderr ---\n'; sed 's/^/  /' "$work/bridge.err"
	fi
else
	bad "bridge aborted on the libuci path (the set -u regression is back)"
	printf '  --- stderr ---\n'; sed 's/^/  /' "$work/bridge.err"
fi

# ===========================================================================
# 2. rpcd: no-arg `status` enumerates instances via the libuci path. It must
#    return both instances, not an empty object.
# ===========================================================================
logdir="$work/logs"
mkdir -p "$logdir"
# A valid SUMMARY line so status has data to report (13 "; "-separated fields).
sl='SUMMARY; 2026-07-24-00:00:00; 1700000000.0; 42000; 8000; 5; 5; 30; 30; dl_low; ul_low; 45000; 9000'
printf '%s\n' "$sl" > "$logdir/cake-autorate.primary.log"
printf '%s\n' "$sl" > "$logdir/cake-autorate.secondary.log"

out="$work/status.out"
if printf '{}' | CAKE_AUTORATE_FUNCTIONS_SH="$work/functions.sh" \
   CAKE_AUTORATE_LOG_DIR="$logdir" \
   sh "$rpcd" call status > "$out" 2> "$work/status.err"; then
	if grep -q '"primary"' "$out" && grep -q '"secondary"' "$out" \
	   && grep -q '"cake_dl_rate_kbps":45000' "$out"; then
		ok "rpcd status enumerates instances via libuci under a hostile functions.sh"
	else
		bad "rpcd status returned an unexpected/empty body"
		printf '  --- stdout ---\n'; sed 's/^/  /' "$out"
		printf '  --- stderr ---\n'; sed 's/^/  /' "$work/status.err"
	fi
else
	bad "rpcd status aborted on the libuci path (the set -u regression is back)"
	printf '  --- stderr ---\n'; sed 's/^/  /' "$work/status.err"
fi

# ===========================================================================
# 3. Both libuci blocks still have `set +u` before sourcing functions.sh --
#    a cheap backstop if someone reworks the code.
# ===========================================================================
if awk '/^stream_from_libuci\(\)/{f=1} f&&/set \+u/{ok=1} f&&/\. "\$\{CAKE_AUTORATE_FUNCTIONS_SH/{print (ok?"Y":"N"); exit}' "$bridge" | grep -q Y; then
	ok "bridge: set +u precedes the functions.sh source"
else
	bad "bridge: functions.sh sourced without a preceding set +u"
fi
if awk '/^list_instances\(\)/{f=1} f&&/set \+u/{ok=1} f&&/\. "\$fns"/{print (ok?"Y":"N"); exit}' "$rpcd" | grep -q Y; then
	ok "rpcd: set +u precedes the functions.sh source"
else
	bad "rpcd: functions.sh sourced without a preceding set +u"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
	printf 'PASS: %d/%d checks passed\n' "$pass" "$pass"
	exit 0
fi
printf 'FAIL: %d passed, %d failed\n' "$pass" "$fail"
exit 1
