# Testing

Two suites prove the feed works end to end, both pinned to **OpenWrt 25.12.5**
and installing the built packages with **`apk`**:

1. **VM integration harness** (`tests/integration/`) — boots a real OpenWrt VM,
   installs the `.apk`s, runs the service, induces load, and asserts the CAKE
   bandwidth actually moves.
2. **Playwright UI suites** (`tests/ui/`) — drive the LuCI app in a browser
   against the live LuCI the harness boots (functional + visual-regression).

Both are wired into `.github/workflows/ci.yml`.

There are also fast off-device unit tests under `tests/bridge`, `tests/schema`,
`tests/rpcd`, `tests/service`, `tests/statistics` and `tests/regression` (plain
shell, no VM) that CI and contributors can run directly; the sections below cover
the two VM-backed suites.

## Building the apks first

Both VM suites install the two **noarch** `.apk`s. Build them with the pinned
25.12.5 SDK (full steps in the [README](../README.md#building-with-the-openwrt-251205-sdk)):

```sh
make package/cake-autorate/compile V=s
make package/luci-app-cake-autorate/compile V=s
# -> bin/packages/x86_64/cakeautorate/*.apk
```

Point the harness at them with `CA_IT_APK_DIR` (otherwise it looks under the
default SDK bin path).

## VM integration harness

```sh
./tests/integration/run.sh              # full run: prints PASS, exits 0
./tests/integration/run.sh --negative   # misconfigured run: exits NON-ZERO
```

The harness fetches and boots the pinned **OpenWrt 25.12.5 x86-64** image under
QEMU/KVM, drives it over the serial console (no SSH), injects the two built
`.apk`s on an ext4 seed disk and **installs them with `apk`** alongside
`sqm-scripts` + deps. It then brings up a two-WAN topology, enables SQM CAKE on
both, applies a two-instance `cake-autorate` config, starts the service, and
checks the observable outcomes (18 assertions: install artifacts present, both
instances register a procd job and write their own log, `SUMMARY` lines parse,
the shaper rate moves, rpcd `status` is populated, collectd RRDs appear, clean
`apk del`, …). Evidence is written to `tests/integration/artifacts/`.

### The induced-load step (not netem)

The interesting assertion is that the control loop **actually moves the CAKE
bandwidth**. The harness does **not** use `netem` for this — `netem` cannot
coexist with the CAKE root qdisc on the shaped interface. Instead it induces a
genuine control-loop response:

- the primary WAN's ingress CAKE (`ifb4eth1`) is configured with a deliberately
  **low base rate** (`base_dl_shaper_rate_kbps=3000`);
- the guest then downloads a large file from `downloads.openwrt.org` **in a
  loop**, saturating that low cap → **high load**;
- with a stable low-latency reflector (the QEMU SLIRP gateways answer ICMP), the
  loop stays in its high-load path and **raises the CAKE bandwidth toward `max`**
  (the up-adjust factor is bumped to `1.10` in the test config so the movement is
  fast and unambiguous);
- when the download stops, the rate **decays back** toward base.

The harness samples `tc qdisc show dev ifb4eth1` before, during and after the
load window and asserts the bandwidth moved in the expected **direction** over
the window (never an exact rate — that would flake).

### The `--negative` self-test

`--negative` injects a deliberately broken config (an invalid `pinger_binary` so
the primary daemon exits at startup). The primary instance then emits no
`SUMMARY` and never shapes, so those assertions **fail** and the harness exits
non-zero. This proves the assertions have teeth — a green positive run is not a
rubber stamp. CI runs it and inverts the exit code (a zero exit here is a CI
failure).

### Requirements and the no-KVM skip

Needs `qemu-system-x86_64` + **`/dev/kvm`** (user in the `kvm` group),
`python3` (stdlib only), `qemu-img`, `mkfs.ext4`, and outbound internet to
`downloads.openwrt.org`. If `/dev/kvm` or QEMU is missing, `run.sh` prints

```
INTEGRATION_SKIPPED: no KVM
```

and exits **0** — a *skip*, not a failure. Set `CA_IT_REQUIRE_KVM=1` to make a
missing KVM a hard error instead.

### Environment overrides (`CA_IT_*`)

| var | default | meaning |
| --- | --- | --- |
| `CA_IT_CACHE` | `/tmp/ca-it-cache` | image + overlay + seed cache dir |
| `CA_IT_APK_DIR` | SDK `bin/packages/.../cakeautorate` | dir holding the two built `.apk`s |
| `CA_IT_MEM` | `1024` | guest RAM (MiB) |
| `CA_IT_REQUIRE_KVM` | `0` | if `1`, a missing `/dev/kvm` is a hard error (exit 3) instead of a skip |

See [`tests/integration/README.md`](../tests/integration/README.md) for the full
topology, assertion list and artifact index.

## Playwright UI suites

The UI suites live in `tests/ui/` and run against a **live LuCI** booted by the
same integration harness in its opt-in **`--serve`** mode (boots the VM, installs
the apks, configures two instances, and forwards guest `:80` to host `:8080`).

### Install (once)

```sh
cd tests/ui
npm install
npx playwright install chromium        # or: --with-deps chromium
```

### Run

```sh
cd tests/ui
npx playwright test --project=functional     # DOM / behaviour assertions
npx playwright test --project=visual         # full-page screenshot diffs
```

Both projects need KVM (they boot the serve-mode VM). Without a live LuCI every
spec **skips** rather than fails. To iterate against an already-running LuCI
instead of spawning a VM, point at it:

```sh
CA_UI_BASE_URL=http://127.0.0.1:8080 CA_UI_ROOT_PASSWORD=cakeautorate \
  npx playwright test --project=functional
```

### Visual-regression baselines

The **visual** project captures full-page screenshots of every LuCI page/state
(status view, config form tabs, empty/post-save states) and diffs them against
**committed** baseline PNGs under `tests/ui/visual/*-snapshots/`. Live cells
(rates, uptime, datetime, load state — everything tagged `data-live="1"`) are
masked so the daemon's 3-second poll can't flake the diff.

When a UI change is intentional, review the diff and refresh the baselines with
the **exact update command**:

```sh
cd tests/ui
npx playwright test --project=visual --update-snapshots
# or: npm run test:visual:update
```

Review the resulting PNG changes before committing them.

### The review gallery

After a capture, build a browsable, labelled gallery of every page/state:

```sh
cd tests/ui
node visual/generate-gallery.js        # or: npm run gallery
```

This collects the committed baselines into `tests/ui/visual/gallery/`
(`index.html` + `images/` + `manifest.json`) — a self-contained artifact a
maintainer can open to evaluate the real UI without a device. The gallery output
dir is gitignored (it is regenerated in CI); CI publishes it as the `ui-gallery`
artifact.

See [`tests/ui/README.md`](../tests/ui/README.md) for the full spec layout,
masking details and serve-mode env knobs.

## Running in CI

`.github/workflows/ci.yml` runs on every push / pull request, pinned to 25.12.5,
with three jobs:

| Job | What it does | Artifact(s) |
| --- | --- | --- |
| **build** | Sets up the 25.12.5 SDK, registers this repo as a `src-link` feed, builds both noarch packages **once** (no per-arch matrix). | `cake-autorate-apks` |
| **integration** | `needs: build`; boots the VM harness against the downloaded apks — positive run **and** the `--negative` self-test. | `integration-artifacts` |
| **ui** | `needs: build`; runs the functional + visual Playwright suites and publishes the review gallery. | `ui-playwright-report`, `ui-gallery` |

KVM policy: GitHub-hosted `ubuntu-*` runners expose `/dev/kvm`, so the VM-backed
steps run for real. A runner without KVM **skips them visibly** (a `::warning`
annotation + a job-summary line) — never a silent green pass — while `build` and
the gallery still publish so a KVM-less runner yields signal. The **visual diff
is advisory** (baselines are environment-specific for fonts/GPU): CI uploads the
HTML diff report for human review but does not fail the pipeline on a pixel diff.

> **The workflow cannot run until the repo is published to GitHub** — this repo
> has no git remote yet. Create a GitHub repository and push (see the
> [README CI section](../README.md#continuous-integration-github-hosting-prerequisite)).
