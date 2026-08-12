# AGENTS.md

Durable design notes for anyone — human or automated — changing this feed. Keep
it short. The two **cross-cutting invariants** below were the audited failure
modes; do not reintroduce them.

## Feed layout

```
net/cake-autorate/            the daemon package
  Makefile                    pins upstream lynxthecat/cake-autorate v3.2.2; noarch (PKG_ARCH:=all)
  files/
    cake-autorate.config      /etc/config/cake-autorate  (UCI; conffile)
    cake-autorate.init        procd service (START=97, after sqm-scripts=50)
    cake-autorate-bridge.sh   UCI -> per-instance daemon config  (the bridge)
    cake-autorate.collectd.conf + cake-autorate-collectd.sh   collectd exec stats source
    cake-autorate.rpcd        rpcd backend (object "cake-autorate")
  patches/                    applied to the upstream tarball at build time
luci/luci-app-cake-autorate/  the LuCI UI (noarch; depends +cake-autorate +luci-base)
  htdocs/.../view/cake-autorate/{overview.js,status.js}   config form + live status
  htdocs/.../statistics/rrdtool/definitions/cake_autorate.js   graph definition
docs/                         upstream inventory, UCI schema, config/testing references
tests/                        unit suites + VM integration + Playwright UI
.github/workflows/ci.yml      build + integration + ui, pinned to 25.12.5
```

Install paths on target: daemon `/usr/lib/cake-autorate/`, generated config
`/etc/cake-autorate/config.<instance>.sh`, bridge
`/usr/libexec/cake-autorate/`, collectd reader `/usr/libexec/collectd/`, rpcd
backend `/usr/libexec/rpcd/cake-autorate`. Per instance the log is
`/var/log/cake-autorate.<instance>.log`. **Target is OpenWrt 25.12.5; install
with `apk` (not `opkg`).**

## Invariant 1 — the UCI→config bridge is bidirectional

`cake-autorate-bridge.sh` translates UCI into the upstream daemon config. Its
schema is derived from `docs/uci-option-schema.tsv` (kept in lockstep by
`tests/bridge/test-bridge.sh --check-schema`). The bridge enforces, in code, a
**bidirectional coverage assertion** for every instance:

- **every** UCI user option maps to **exactly one** emitted daemon config key,
  **and** every emitted key (minus the forced ones) maps back to a UCI option;
- a silent drop (UCI option that never reaches the config) or a stray key (config
  key with no UCI source) is a **fatal** error that aborts the run.

Only the **66 upstream options** may be emitted — an unknown key is fatal to the
daemon. There is one package-local key, `enabled`, which gates procd and is never
written to the daemon config.

**Package-managed (forced) options.** Four keys are written *after* the user
options with pinned values the user cannot override, because the status view and
the collectd feed depend on them:

| forced key | value |
| --- | --- |
| `log_to_file` | `1` |
| `output_summary_stats` | `1` |
| `log_file_path_override` | `` (empty → deterministic per-instance log path) |
| `log_DEBUG_messages_to_syslog` | `0` |

(Four more — `log_file_max_time_mins`, `log_file_max_size_KB`,
`log_file_buffer_size_B`, `log_file_buffer_timeout_ms` — are *bounded*:
user-settable but clamped to a sane non-zero range.)

If you add or rename an option: update the TSV, regenerate the bridge's embedded
schema, add it to the LuCI form group, and keep the coverage assertion green. Do
**not** hand-add a key on one side only.

## Invariant 2 — the log stream is the only runtime interface

The daemon exposes **no JSON status file and no control socket**. Its only
runtime output is the log stream `/var/log/cake-autorate.<instance>.log`. Both
consumers parse the same `SUMMARY` lines:

- the **LuCI status view** (via the rpcd `status` method in `cake-autorate.rpcd`)
  reads a bounded `tail` of the log and parses the newest `SUMMARY` line;
- the **collectd exec reader** (`cake-autorate-collectd.sh`) parses the same
  `SUMMARY` lines into RRD metrics.

Both share **one** field contract: a `SUMMARY` line is 13 `"; "`-separated
fields, field 0 == `SUMMARY` (documented in
`docs/upstream-option-inventory.md` §3). The unprefixed `SUMMARY_HEADER` line is
**not** a status line — it is ignored by the exact `^SUMMARY; ` match. If you
touch either parser, keep the two in lockstep with that contract, and keep the
forced logging options (Invariant 1) that guarantee the stream exists. **Do not
invent a status file** — the whole design assumes the log stream is the
interface.

## Other durable facts

- **sqm-scripts dependency / qdisc ownership.** The package `DEPENDS` on
  `sqm-scripts`. SQM **owns** the CAKE qdisc (creates it on egress + the
  `ifb4<iface>` ingress); cake-autorate **only adjusts its bandwidth** and never
  calls `tc` to create a qdisc. The init script starts at `START=97`, after SQM
  (`START=50`), so the qdisc already exists.
- **Never `DEPENDS` on a concrete provider of a virtual package.** Use `+tc`,
  never `+tc-tiny`. iproute2 ships `tc-tiny` and `tc-full`; both provide virtual
  `tc` and they **conflict with each other**, so naming one makes the package
  uninstallable on any router that already chose the other. v0.2.0 shipped
  `+tc-tiny` and died on real routers with `unable to select packages`. A fresh
  test VM has no `tc` provider yet and so resolves either spelling happily —
  which is why `harness.install()` now installs `tc-full` first, on purpose.
- **One instance per enabled section.** procd opens one supervised daemon per
  enabled UCI section; the init script re-runs the bridge (whole-world sync +
  prune) on start/reload and aborts the (re)start if the bridge fails, so a
  half-written config never reaches the daemon.
- **rpcd object `cake-autorate`** exposes `sqm_interfaces` (read, derives dl_if/
  ul_if choices from live SQM), `status` (read, per-instance from the log),
  `service` (write, start/stop/restart/reload). Instance names are validated
  against `[A-Za-z0-9_]+`; service actions against a fixed allowlist.
- **Both packages must reload rpcd from their postinst.** rpcd enumerates
  `/usr/libexec/rpcd/*` only when it starts, and resolves a session's ACL groups
  from `/usr/share/rpcd/acl.d/` only when that session is created (at login, or
  when it thaws one across a reload). So installing leaves the ubus object
  unregistered *and* leaves every already-logged-in admin holding a group list
  that predates our ACL file — which LuCI shows as a menu that is simply not
  there. The base package carries the reload by hand (`package.mk` has no
  default); the LuCI app gets it from `luci.mk`, whose default postinst is
  `ifndef`-guarded, so **do not define one in that Makefile** — you would replace
  the feed's version and silently drop its menu-cache eviction. Always `reload`,
  never `restart`: reload freezes/thaws sessions in place, a restart logs
  everyone out. Covered by the integration harness, which asserts `ubus list
  cake-autorate` succeeds after `apk add` with no manual reload.
- **libuci + `set -u`.** OpenWrt's `/lib/functions.sh` is not nounset-clean; any
  script that runs `set -u` and sources it must wrap the `config_load`/
  `config_foreach` block in `set +u` (the bridge and the rpcd backend both do).
  Regression covered by `tests/regression/test-libuci-nounset.sh`.
- **We carry one upstream patch, and it is temporary.**
  `patches/010-reject-malformed-fping-samples.patch` makes the daemon's fping
  arm check the two fields it does arithmetic on before trusting a sample.
  Upstream accepts any line of 12 whitespace fields, so one malformed sample
  reaches `printf %.3f` / `10#${...}` and, under the daemon's `set -u`, exits the
  process — **cleanly**, so procd never respawns it and the WAN runs unshaped
  with nothing but three lines in `logread` to say so. Upstream fixed half of
  this in PR #392, which is merged to master but **in no release**: v3.2.2 is
  still the newest tag, which is why it is carried here rather than picked up by
  a version bump. Drop the patch on the upstream bump that first ships #392 —
  `tests/regression/test-fping-sample-gate.sh` fails the moment `PKG_VERSION`
  moves, so the bump PR cannot land without that decision being made.

## Running the tests + CI

```sh
# fast off-device unit suites (no VM)
tests/bridge/test-bridge.sh ; tests/schema/test-uci-schema.sh
tests/rpcd/test-rpcd.sh ; tests/service/test-init.sh
tests/statistics/test-collectd-parser.sh ; tests/regression/test-libuci-nounset.sh
tests/regression/test-fping-sample-gate.sh

# VM integration harness (needs QEMU + /dev/kvm)
./tests/integration/run.sh              # PASS / exit 0
./tests/integration/run.sh --negative   # must exit NON-ZERO (self-test)

# Playwright UI suites (boot a live LuCI via serve mode; need KVM)
cd tests/ui && npm install && npx playwright install chromium
npx playwright test --project=functional
npx playwright test --project=visual
npx playwright test --project=visual --update-snapshots   # refresh baselines
```

CI (`.github/workflows/ci.yml`, pinned 25.12.5) runs three jobs on push/PR —
**build** (SDK, noarch, artifact `cake-autorate-apks`), **integration**
(`integration-artifacts`) and **ui** (`ui-playwright-report`, `ui-gallery`).
VM-backed steps skip **visibly** without `/dev/kvm`. See `docs/testing.md` for
detail.

The build recipe lives in the reusable `.github/workflows/build.yml`; `ci.yml`
and `release.yml` (on a `v*` tag) both call it. **Do not fork that recipe into a
second workflow** — a release has to ship what CI tested.

**Do not bump the OpenWrt or upstream cake-autorate version by hand.** Neither
lives in one place — the OpenWrt release is restated across both workflows, the
integration harness and six docs, and `renovate.json` carries a custom manager
that rewrites every one of them as a single dependency. Editing one site by hand
desynchronises the rest. The two companion hashes (`PKG_HASH`, `IMG_SHA256`)
cannot be computed by Renovate, so those bumps land as PRs that deliberately
fail until a human refreshes the hash; the PR body carries the checklist. If you
add a new place that names either version, add a matching pattern to
`renovate.json` — and keep it non-overlapping with the existing ones.

**One script owns every version field.**
`.github/scripts/package-versions.sh` is the authority, and `release.yml`'s
`validate` job runs it before it will publish a tag. The contract: the LuCI app's
`PKG_VERSION` **is** the repo tag (it has no upstream, and its `PKG_RELEASE` is
pinned at 1); the base package's `PKG_VERSION` is upstream's, so its
`PKG_RELEASE` carries the packaging revision — reset to 1 when upstream moves,
+1 when `net/cake-autorate/` changed since the previous tag. Cutting a release
means `package-versions.sh --fix --tag vX.Y.Z`, then commit, then tag; do not
hand-edit either field, and do not give Renovate a second claim on `PKG_RELEASE`.
This is load-bearing: v0.1.0 and v0.2.0 each published
`cake-autorate-3.2.2-r1.apk` and `luci-app-cake-autorate-1.0.0-r1.apk` with
*different payloads*, and because apk compares name-version-release, a router
holding r1 was never offered r1 again — the second release could not reach anyone
who had installed the first, and nothing in the pipeline said so.

**Every `uses:` is pinned to a commit sha, with the version in a trailing
comment.** A tag is a mutable pointer, and `release.yml` is the one job that
holds `contents: write` — a retagged action would be running with it. Add new
steps the same way (`owner/action@<sha> # vX.Y.Z`); Renovate moves the sha and
the comment together on a version bump, and routes a sha-only move to the
dependency dashboard for review rather than automerging it.

**Never hardcode an apk filename.** `cake-autorate-<PKG_VERSION>-r<PKG_RELEASE>.apk`
moves whenever either field does, so the test harness and the release job locate
the packages by glob (`cake-autorate-*.apk`, `luci-app-cake-autorate-*.apk` —
the first cannot match the second, since globs anchor at the start of the name).
Hardcoding one turns every version bump into a test edit.
