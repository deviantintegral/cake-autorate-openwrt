# cake-autorate OpenWrt VM integration harness

Boots a **pinned OpenWrt 25.12.5 x86-64** VM under QEMU/KVM and proves, end to
end and unattended, that the built packages **install, configure, run, shape,
and report** on a real system:

1. fetches + verifies the pinned combined image (cached, never committed);
2. boots it under QEMU/KVM and drives it over the **serial console** (no SSH
   keys, no dropbear config needed);
3. injects and installs the two built `.apk`s plus `sqm-scripts` + deps via
   `apk`;
4. brings up a **two-WAN** topology, enables **SQM CAKE** on both, applies a
   **two-instance** `cake-autorate` UCI config, and starts the service;
5. **induces controlled download load** on the primary WAN so the control loop
   moves the CAKE bandwidth;
6. asserts the observable outcomes and writes evidence to `artifacts/`;
7. emits a single machine-checkable `PASS`/`FAIL` (exit 0 / non-zero).

## Usage

```sh
./tests/integration/run.sh            # full run: exits 0 and prints PASS
./tests/integration/run.sh --negative # misconfigured run: exits NON-ZERO
```

`--negative` injects a deliberately broken config (an invalid `pinger_binary`
so the primary daemon exits at startup); the primary instance then emits no
`SUMMARY` and never shapes, so those assertions fail and the harness exits
**non-zero**. This proves the assertions have teeth — a green run is not a
rubber stamp.

### Requirements (host)

- `qemu-system-x86_64` + **`/dev/kvm`** (KVM acceleration; the user must be in
  the `kvm` group);
- `python3` (stdlib only — no pip deps), `qemu-img`, `mkfs.ext4` (e2fsprogs),
  `wget`, `gzip`, `sha256sum`;
- outbound internet to `downloads.openwrt.org` (for the image, the apk deps, and
  the induced download load).

### Environment overrides

| var | default | meaning |
| --- | --- | --- |
| `CA_IT_CACHE` | `/tmp/ca-it-cache` | image + overlay + seed cache dir |
| `CA_IT_APK_DIR` | SDK `bin/packages/.../cakeautorate` | dir holding the two built `.apk`s |
| `CA_IT_MEM` | `1024` | guest RAM (MiB) |
| `CA_IT_REQUIRE_KVM` | `0` | if `1`, a missing `/dev/kvm` is a hard error instead of a skip |

### No-KVM fallback (CI)

If `/dev/kvm` is absent or `qemu-system-x86_64` is missing, `run.sh` prints

```
INTEGRATION_SKIPPED: no KVM
```

and exits **0** so a CI job treats it as a *skip*, not a failure. Set
`CA_IT_REQUIRE_KVM=1` to force a hard error (exit 3) where KVM is mandatory.

## How it works

### VM topology

Two QEMU user-mode NICs give two independent "WANs", each with a SLIRP gateway
that answers ICMP (so each cake-autorate instance has a reachable, low-latency
reflector):

| guest if | qemu netdev | subnet | role | reflector | default route |
| --- | --- | --- | --- | --- | --- |
| `eth1` | `net1` | `10.0.2.0/24` | **primary** WAN (gets the load) | `10.0.2.2` | yes (+ internet) |
| `eth0` | `net0` | `10.0.3.0/24` | **secondary** WAN (proves isolation) | `10.0.3.2` | no (`defaultroute 0`) |

`fixtures/network-two-wan.sh` reshapes the stock image's `lan`/`wan` into this
`wan`/`wan2` layout. SQM (`fixtures/sqm-two-wan.config`) puts a CAKE qdisc on
each egress device and an `ifb4<dev>` ingress device; `cake-autorate`
(`fixtures/cake-autorate-two-instance.config`) then *changes* the bandwidth of
those existing qdiscs.

### Control channel

`lib/vmdriver.py` talks to QEMU's serial port over a UNIX socket and drives the
`ash` login shell with a start/end-marker + exit-code protocol, so every guest
command yields captured stdout and a real exit status. No SSH, no extra guest
packages, fully deterministic. ANSI/CR noise is stripped from captures.

### File injection

The two `.apk`s and the fixtures are packed into a small **ext4 image** with
`mkfs.ext4 -d` (no root, no loop-mount) and attached as a second virtio disk the
guest mounts read-only at `/mnt/seed`. This avoids any dependency on guest
filesystem modules beyond ext4 (which the rootfs already uses) and on flaky
early-boot networking.

### Induced load / shaping movement

The primary WAN's ingress CAKE (`ifb4eth1`) is configured with a deliberately
low base rate (`base_dl_shaper_rate_kbps=3000`). The guest then downloads a
large file from `downloads.openwrt.org` in a loop: the ingress shaper saturates
at the low cap → **high load** with a low-latency reflector → the control loop
raises the CAKE bandwidth toward `max` (the up-adjust factor is bumped to `1.10`
in the test config so the movement is fast and unambiguous). When the load
stops, the rate **decays back** toward base. The harness samples
`tc qdisc show dev ifb4eth1` at t0, across the load window, and after settle, and
asserts the bandwidth moved in the expected direction (direction/occurrence over
a window — never an exact rate, per the anti-flake requirement).

This is a genuine control-loop response; it does not require a public reflector
or `netem` on the shaped interface (which cannot coexist with the CAKE root
qdisc). The reflectors are the qemu SLIRP gateways, reachable with stable low
delay, which keeps the loop in its RUNNING/high-load path.

## Assertions

| # | assertion |
| --- | --- |
| 1 | boots an OpenWrt 25.12.x VM to a root shell |
| 2 | ext4 fixture disk mounts with the apks |
| 3 | guest reaches the internet (for apk) |
| 4 | package + deps + all install artifacts present |
| 5 | both test WANs come up |
| 6 | both reflectors answer ICMP |
| 7 | SQM CAKE qdiscs + ifb devices created on both WANs |
| 8 | two procd instances (primary + secondary) registered |
| 9 | one `cake-autorate.sh` daemon per enabled instance |
| 10 | each instance writes its own `/var/log/cake-autorate.<name>.log` |
| 11 | primary instance emits parseable `SUMMARY` lines |
| 12 | **CAKE ingress bandwidth rises above base under load** |
| 13 | CAKE bandwidth decays back down after load removed |
| 14 | rpcd `status` returns populated per-instance data |
| 15 | collectd RRDs appear under `.../cake_autorate-<instance>/` |
| 16 | service stop leaves no daemon running |
| 17 | run dir cleaned up on stop |
| 18 | `apk del` removes all package files |

## Artifacts (evidence)

Written to `tests/integration/artifacts/` (gitignored):

- `harness.log` — full transcript of every guest command + rc;
- `serial.log` — raw serial console (boot log included);
- `RESULT.txt` — verdict + per-assertion PASS/FAIL;
- `tc-before.txt` / `tc-under-load.txt` / `tc-after.txt` — `tc -s qdisc` snapshots;
- `ubus-service-list.txt`, `rpcd-status.txt`, `collectd-rrds.txt`,
  `sqm-qdiscs.txt`, `apk-install.txt`, `apk-del.txt`, `per-instance-logs.txt`,
  `bridge-defect.txt`, and more.

## CI (task 013)

On a GitHub `ubuntu` runner with nested KVM:

```yaml
- run: |
    sudo apt-get update
    sudo apt-get install -y qemu-system-x86 qemu-utils e2fsprogs python3
- run: ls -l /dev/kvm || echo "no kvm"        # bare metal / larger runners have it
- run: ./tests/integration/run.sh
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: integration-artifacts, path: tests/integration/artifacts/ }
```

- The build job must produce the two `.apk`s and expose their directory via
  `CA_IT_APK_DIR` (or place them at the default SDK path).
- Runners without `/dev/kvm` print `INTEGRATION_SKIPPED: no KVM` and exit 0; the
  CI job can grep that line to mark the step "skipped" rather than "passed".
- Add `./tests/integration/run.sh --negative` as a second step to prove the
  harness can fail.

## Reuse by task 011 (Playwright / LuCI UI)

The harness boots a fully-provisioned LuCI stack (`luci-base`,
`luci-app-cake-autorate`, `rpcd` object `cake-autorate`, SQM, two running
instances). `lib/vmdriver.py` and the boot/install/configure phases in
`lib/harness.py` can be reused to stand up that environment; add an
`-netdev user,...,hostfwd=tcp::PORT-:80` forward (the driver already supports a
`hostfwd` SSH port hook — the same mechanism forwards `:80`) to reach `uhttpd`
from a host browser / Playwright.

## Known defects surfaced by this harness

Both stem from the same root cause: a package script runs `set -u` and then
sources OpenWrt's `/lib/functions.sh` (which is **not** `set -u`-clean) and calls
`config_load`. These on-device libuci paths are exercised here for the first
time — the scripts' own unit tests use file/`--uci-file` inputs and never hit
`/lib/functions.sh`.

1. **task-4 config bridge**
   (`net/cake-autorate/files/cake-autorate-bridge.sh`): in `stream_from_libuci`
   the sourced `/lib/functions.sh` dereferences the conventionally-unset
   `IPKG_INSTROOT` (and later `CONFIG_LIST_STATE`) under `set -u`, aborting the
   bridge. **No per-instance config is generated and the service refuses to
   start** (`daemon.err ... config bridge failed; refusing to (re)start
   instances`). This is a hard blocker for the service on a real device.

2. **task-8 rpcd backend** (`net/cake-autorate/files/cake-autorate.rpcd`): the
   `status` method's `list_instances()` has the identical `set -u` +
   `config_load` issue. It runs inside a `$(...)` command substitution, so only
   the *enumeration* returns empty — a `status` call **with** an explicit
   `instance` works (that path reads the daemon log directly and is what the
   LuCI UI uses).

**Fix for both:** wrap the libuci interaction in `set +u` (or export
`IPKG_INSTROOT="${IPKG_INSTROOT:-}"` and initialise `CONFIG_LIST_STATE`). The
harness records the bridge failure to `artifacts/bridge-defect.txt`, applies an
**in-VM emulated fix** (`set +u` inserted into the installed bridge's
`stream_from_libuci`, throwaway VM only — never the repo), gated on the defect
being detected, so the rest of the stack is validated live. Once tasks 4/8 fix
the scripts, `defect_present` is false, the emulated fix is skipped, and the
harness is a clean gate. Both defects are reported as **non-gating** findings in
`RESULT.txt` (this harness's job is to prove the runtime stack).
