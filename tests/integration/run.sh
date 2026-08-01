#!/bin/sh
# cake-autorate OpenWrt VM integration harness -- entrypoint.
#
#   ./tests/integration/run.sh              # full run, exits 0 + prints PASS
#   ./tests/integration/run.sh --negative   # misconfigured run, exits NON-ZERO
#                                           # (proves the assertions have teeth)
#
# Boots a PINNED OpenWrt 25.12.5 x86-64 VM under QEMU/KVM, installs the built
# .apk packages + sqm-scripts + deps, applies a two-instance cake-autorate
# config over two SQM CAKE WANs, induces download load so the control loop moves
# the CAKE bandwidth, and asserts the outcomes. Evidence lands in
# tests/integration/artifacts/ (gitignored).
#
# NO KVM: if /dev/kvm is absent/unusable the harness prints
#   INTEGRATION_SKIPPED: no KVM
# and exits 0 (CI treats this as a skip, not a failure). Set CA_IT_REQUIRE_KVM=1
# to make a missing KVM a hard error instead.
#
# Env overrides:
#   CA_IT_CACHE     image/overlay cache dir           (default /tmp/ca-it-cache)
#   CA_IT_APK_DIR   dir holding the two built .apk s   (default: SDK bin path)
#   CA_IT_MEM       guest RAM MiB                      (default 1024)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CACHE="${CA_IT_CACHE:-/tmp/ca-it-cache}"
ART="$HERE/artifacts"
MEM="${CA_IT_MEM:-1024}"
IMG_VER="25.12.5"
IMG_BASE="openwrt-${IMG_VER}-x86-64-generic-ext4-combined.img"
IMG_URL="https://downloads.openwrt.org/releases/${IMG_VER}/targets/x86/64/${IMG_BASE}.gz"
# Renovate rewrites IMG_VER above (see the custom manager in renovate.json) but
# cannot compute this -- a version-bump PR ships a stale hash on purpose and the
# check below fails loudly. Refresh it from the release's sha256sums file.
IMG_SHA256="23e2538e8ab0eb52dfed1c65d608ecdb71ffd432dd54885da138ae67cd9e4461"  # of the .gz
APK_DIR="${CA_IT_APK_DIR:-/tmp/owrt-sdk/openwrt-sdk-${IMG_VER}-x86-64_gcc-14.3.0_musl.Linux-x86_64/bin/packages/x86_64/cakeautorate}"

NEG=""
SERVE=""
[ "${1:-}" = "--negative" ] && NEG="--negative"
# --serve: opt-in live-LuCI mode for the tests/ui Playwright suite. Boots +
# installs + configures exactly like a positive run, then brings up LuCI and
# STAYS UP (LuCI reachable on a forwarded host port) until a stop-file appears.
# It does NOT run the PASS/FAIL assertion suite, so it cannot change run.sh's
# normal verdict semantics. Controlled entirely by CA_UI_* env vars:
#   CA_UI_SERVE_PORT     host port that forwards to guest :80  (default 8080)
#   CA_UI_SERVE_HOST     host bind address                     (default 127.0.0.1)
#   CA_UI_ROOT_PASSWORD  root password set for LuCI login      (default cakeautorate)
#   CA_UI_READY_FILE     JSON file written when LuCI is live    (required)
#   CA_UI_STOP_FILE      touch this file to shut the VM down    (required)
[ "${1:-}" = "--serve" ] && SERVE="1"

log() { printf '%s\n' "== $* ==" >&2; }

# ---- KVM gate -------------------------------------------------------------
# Read/write, not just existence: on a stock GitHub-hosted runner /dev/kvm is
# present but root:kvm 0660, so an `-e` test passes and QEMU then dies with
# EACCES -- which reads as a harness failure rather than "this box cannot
# virtualize". CI installs a udev rule to make it 0666; this gate is what keeps
# the distinction honest anywhere else.
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ] || ! qemu-system-x86_64 --version >/dev/null 2>&1; then
	if [ "${CA_IT_REQUIRE_KVM:-0}" = 1 ]; then
		echo "ERROR: KVM/qemu required but unavailable" >&2
		exit 3
	fi
	echo "INTEGRATION_SKIPPED: no KVM"
	exit 0
fi

# ---- guest-ICMP gate ------------------------------------------------------
# QEMU user-mode networking implements guest ICMP with a Linux ping socket, and
# the kernel only hands those out to GIDs inside net.ipv4.ping_group_range. The
# default on a stock GitHub-hosted runner is "1 0" -- an EMPTY range -- so the
# guest boots normally and then cannot ping anything at all.
#
# This matters twice over: the harness waits on the guest reaching
# downloads.openwrt.org before it can `apk install`, and cake-autorate itself
# measures one-way delay with fping. Without ICMP the run dies ~2 minutes in
# with a bare "guest has no internet", which points at the network rather than
# at the one sysctl that actually explains it. Fail here instead, with the fix.
#
# Root is exempt: it holds CAP_NET_RAW, so QEMU uses a raw socket regardless.
#
# Parsed with awk, NOT `read`: the two values are TAB-separated and dash's read
# does not split them the way bash's does (it yields an empty second field), so
# a `read`-based gate silently never fires -- on precisely the dash-as-/bin/sh
# runners this exists to protect. Empty/unparseable values skip the gate rather
# than block a run.
if [ "$(id -u)" != 0 ] && [ -r /proc/sys/net/ipv4/ping_group_range ]; then
	PGR_LO=$(awk '{print $1; exit}' /proc/sys/net/ipv4/ping_group_range)
	PGR_HI=$(awk '{print $2; exit}' /proc/sys/net/ipv4/ping_group_range)
	MY_GID=$(id -g)
	if [ -n "$PGR_LO" ] && [ -n "$PGR_HI" ] &&
		{ [ "$MY_GID" -lt "$PGR_LO" ] || [ "$MY_GID" -gt "$PGR_HI" ]; }; then
		echo "ERROR: this user's GID ($MY_GID) is outside net.ipv4.ping_group_range" >&2
		echo "       ($PGR_LO $PGR_HI), so QEMU user-mode networking cannot send guest" >&2
		echo "       ICMP -- the guest would appear to have no internet and cake-autorate" >&2
		echo "       could not measure OWD. Fix with:" >&2
		echo "         sudo sysctl -w net.ipv4.ping_group_range=\"0 2147483647\"" >&2
		exit 3
	fi
fi

# ---- locate build tools ---------------------------------------------------
PATH="$PATH:/usr/sbin:/sbin"
MKFS_EXT4=$(command -v mkfs.ext4 || echo /usr/sbin/mkfs.ext4)
if [ ! -x "$MKFS_EXT4" ]; then
	echo "ERROR: mkfs.ext4 not found (need e2fsprogs)" >&2; exit 3
fi

mkdir -p "$CACHE" "$ART"
rm -f "$ART"/*.txt "$ART"/harness.log "$ART"/serial.log 2>/dev/null || true

# ---- fetch + verify + decompress the pinned image -------------------------
log "ensuring pinned OpenWrt $IMG_VER image"
if [ ! -f "$CACHE/$IMG_BASE.gz" ]; then
	wget -q -O "$CACHE/$IMG_BASE.gz.part" "$IMG_URL"
	mv "$CACHE/$IMG_BASE.gz.part" "$CACHE/$IMG_BASE.gz"
fi
GOT=$(sha256sum "$CACHE/$IMG_BASE.gz" | awk '{print $1}')
if [ "$GOT" != "$IMG_SHA256" ]; then
	echo "ERROR: image sha256 mismatch: got $GOT want $IMG_SHA256" >&2; exit 3
fi
[ -f "$CACHE/$IMG_BASE" ] || gunzip -k -f "$CACHE/$IMG_BASE.gz"

# ---- build the ext4 seed disk (apks + fixtures), no root/mount needed ------
log "building seed disk"
# Located by GLOB, never by literal filename: an apk name embeds PKG_VERSION and
# PKG_RELEASE, and this harness has no business tracking either -- hardcoding
# them means every version bump is also a test edit. Exactly one match per
# package is required, so a stale apk left beside a fresh one is a loud error
# rather than a silent install of the wrong build.
#
# `cake-autorate-*.apk` cannot catch the LuCI package: globs anchor at the start
# of the name and that one begins "luci-app-".
find_one_apk() {
	pat=$1
	set -- "$APK_DIR"/$pat
	if [ ! -f "$1" ]; then
		echo "ERROR: no apk matching $APK_DIR/$pat" >&2
		echo "       set CA_IT_APK_DIR or build it from the feed first" >&2
		exit 3
	fi
	if [ "$#" -gt 1 ]; then
		echo "ERROR: $# apks match $APK_DIR/$pat -- remove the stale builds:" >&2
		for f in "$@"; do echo "         $f" >&2; done
		exit 3
	fi
	printf '%s\n' "$1"
}
# `|| exit 3`: find_one_apk runs in a subshell here, so its own exit cannot stop
# the script -- the status has to be propagated at the call site.
CA_APK=$(find_one_apk 'cake-autorate-*.apk') || exit 3
LUCI_APK=$(find_one_apk 'luci-app-cake-autorate-*.apk') || exit 3
log "seeding $(basename "$CA_APK") + $(basename "$LUCI_APK")"
SEEDDIR="$CACHE/seeddir"
rm -rf "$SEEDDIR"; mkdir -p "$SEEDDIR"
cp "$CA_APK" "$SEEDDIR/"
cp "$LUCI_APK" "$SEEDDIR/"
cp "$HERE"/fixtures/network-two-wan.sh "$SEEDDIR/"
cp "$HERE"/fixtures/sqm-two-wan.config "$SEEDDIR/"
cp "$HERE"/fixtures/cake-autorate-two-instance.config "$SEEDDIR/"
SEED="$CACHE/seed.ext4"
rm -f "$SEED"
"$MKFS_EXT4" -q -F -L caseed -d "$SEEDDIR" -b 1024 "$SEED" 16M

# ---- fresh overlay so the base image stays pristine -----------------------
log "creating qcow2 overlay"
OVERLAY="$CACHE/overlay.qcow2"
rm -f "$OVERLAY"
qemu-img create -f qcow2 -b "$CACHE/$IMG_BASE" -F raw "$OVERLAY" 3G >/dev/null

# ---- run the harness ------------------------------------------------------
if [ -n "$SERVE" ]; then
	SERVE_PORT="${CA_UI_SERVE_PORT:-8080}"
	SERVE_HOST="${CA_UI_SERVE_HOST:-127.0.0.1}"
	SERVE_PW="${CA_UI_ROOT_PASSWORD:-cakeautorate}"
	READY="${CA_UI_READY_FILE:-$ART/serve-ready.json}"
	STOP="${CA_UI_STOP_FILE:-$ART/serve-stop}"
	rm -f "$READY" "$STOP"
	log "running harness (SERVE) -> LuCI at http://$SERVE_HOST:$SERVE_PORT/"
	set +e
	python3 "$HERE/lib/harness.py" \
		--overlay "$OVERLAY" --seed "$SEED" --artifacts "$ART" \
		--mem "$MEM" --serve \
		--serve-host "$SERVE_HOST" --serve-port "$SERVE_PORT" \
		--root-password "$SERVE_PW" \
		--serve-ready-file "$READY" --serve-stop-file "$STOP"
	RC=$?
	set -e
	echo "artifacts: $ART"
	exit $RC
fi

log "running harness${NEG:+ (NEGATIVE)}"
set +e
python3 "$HERE/lib/harness.py" \
	--overlay "$OVERLAY" --seed "$SEED" --artifacts "$ART" \
	--mem "$MEM" $NEG
RC=$?
set -e

echo
echo "artifacts: $ART"
[ -f "$ART/RESULT.txt" ] && { echo "---- RESULT ----"; cat "$ART/RESULT.txt"; }
exit $RC
