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
IMG_SHA256="23e2538e8ab0eb52dfed1c65d608ecdb71ffd432dd54885da138ae67cd9e4461"  # of the .gz
APK_DIR="${CA_IT_APK_DIR:-/tmp/owrt-sdk/openwrt-sdk-${IMG_VER}-x86-64_gcc-14.3.0_musl.Linux-x86_64/bin/packages/x86_64/cakeautorate}"

NEG=""
[ "${1:-}" = "--negative" ] && NEG="--negative"

log() { printf '%s\n' "== $* ==" >&2; }

# ---- KVM gate -------------------------------------------------------------
if [ ! -e /dev/kvm ] || ! qemu-system-x86_64 --version >/dev/null 2>&1; then
	if [ "${CA_IT_REQUIRE_KVM:-0}" = 1 ]; then
		echo "ERROR: KVM/qemu required but unavailable" >&2
		exit 3
	fi
	echo "INTEGRATION_SKIPPED: no KVM"
	exit 0
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
if [ ! -f "$APK_DIR/cake-autorate-3.2.2-r1.apk" ] || \
   [ ! -f "$APK_DIR/luci-app-cake-autorate-1.0.0-r1.apk" ]; then
	echo "ERROR: built apks not found in $APK_DIR" >&2
	echo "       set CA_IT_APK_DIR or build them from the feed first" >&2
	exit 3
fi
SEEDDIR="$CACHE/seeddir"
rm -rf "$SEEDDIR"; mkdir -p "$SEEDDIR"
cp "$APK_DIR"/cake-autorate-3.2.2-r1.apk "$SEEDDIR/"
cp "$APK_DIR"/luci-app-cake-autorate-1.0.0-r1.apk "$SEEDDIR/"
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
