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
- **One instance per enabled section.** procd opens one supervised daemon per
  enabled UCI section; the init script re-runs the bridge (whole-world sync +
  prune) on start/reload and aborts the (re)start if the bridge fails, so a
  half-written config never reaches the daemon.
- **rpcd object `cake-autorate`** exposes `sqm_interfaces` (read, derives dl_if/
  ul_if choices from live SQM), `status` (read, per-instance from the log),
  `service` (write, start/stop/restart/reload). Instance names are validated
  against `[A-Za-z0-9_]+`; service actions against a fixed allowlist.
- **libuci + `set -u`.** OpenWrt's `/lib/functions.sh` is not nounset-clean; any
  script that runs `set -u` and sources it must wrap the `config_load`/
  `config_foreach` block in `set +u` (the bridge and the rpcd backend both do).
  Regression covered by `tests/regression/test-libuci-nounset.sh`.

## Running the tests + CI

```sh
# fast off-device unit suites (no VM)
tests/bridge/test-bridge.sh ; tests/schema/test-uci-schema.sh
tests/rpcd/test-rpcd.sh ; tests/service/test-init.sh
tests/statistics/test-collectd-parser.sh ; tests/regression/test-libuci-nounset.sh

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

**Never hardcode an apk filename.** `cake-autorate-<PKG_VERSION>-r<PKG_RELEASE>.apk`
moves whenever either field does, so the test harness and the release job locate
the packages by glob (`cake-autorate-*.apk`, `luci-app-cake-autorate-*.apk` —
the first cannot match the second, since globs anchor at the start of the name).
Hardcoding one turns every version bump into a test edit.
