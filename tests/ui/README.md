# tests/ui — Playwright UI suites for luci-app-cake-autorate

Browser-driven tests that exercise the LuCI app against a **live** LuCI booted
by the VM integration harness. Task 11 establishes this harness + the
**functional** project; task 12 reuses the same `playwright.config.js`, the same
LuCI bring-up (globalSetup/teardown + login fixture), and adds a **visual**
project.

## Layout

    tests/ui/
      package.json            @playwright/test devDependency
      playwright.config.js     shared config (engine, pinned viewport, projects)
      global-setup.js          boots the live LuCI (see below), writes .runtime/serve-state.json
      global-teardown.js       tears the VM down
      fixtures/luci.js         login fixture + `luci` helper + luciBeforeEach (skip/auth)
      functional/              the functional specs (this task)
        helpers.js             CBI form helpers (add/edit/apply/delete, comboboxes)
        01-config-groups.spec.js
        02-instance-crud.spec.js
        03-essentials-only.spec.js
        04-status-controls.spec.js
      # task 12 adds:  visual/ + screenshot baselines

`node_modules/`, `.runtime/`, `test-results/`, `playwright-report/` are
gitignored. Browser binaries live in `~/.cache/ms-playwright` (never in-repo).

## Install (once)

    cd tests/ui
    npm install
    npx playwright install chromium      # or: --with-deps chromium

## Run

    cd tests/ui
    npx playwright test --project=functional     # DOM/behaviour assertions
    npx playwright test --project=visual         # full-page screenshot diffs

Requires KVM (the suite boots a QEMU VM). Without a live LuCI every spec
**skips** (never fails) — see "No live LuCI" below. Set `CA_IT_REQUIRE_KVM=1` to
turn those skips into hard failures when a green run must mean the browser really
drove a live LuCI.

## Visual-regression suite (`visual` project) — task 12

`tests/ui/visual/` captures **full-page** screenshots of every LuCI page/state
and diffs them against **committed** baselines. It reuses this file's
`globalSetup`/`globalteardown` (one live LuCI), the login fixture, and the pinned
engine + viewport + `deviceScaleFactor` — that pinning is what makes the
baselines reproducible.

Captured states (snapshot stems):

- `status-view` — live status view, both seeded instances running.
- `config-multi-instance` — config form, primary + secondary.
- `config-single-instance` — one populated instance (Essentials).
- `config-tab-{essentials,shaper,pingers,reflectors,detection,idle,logging}` —
  each group tab expanded.
- `config-empty` — no instances (toolbar + create row only).
- `config-post-save-apply` — a freshly created instance committed via Save & Apply.

`01-status-view.spec.js` sorts before `02-config-form.spec.js`, so (with
`workers:1`) the status baselines are taken against the pristine seeded VM
**before** the config spec deletes/creates instances. The config spec is a single
serial flow; its destructive edits are safe because the VM is torn down after the
run.

### Masking (why diffs don't flake)

Every value the status view repaints on its 3-second poll carries
`data-live="1"` — shaper/achieved rates, OWD deltas, load conditions, uptime, the
last-update **datetime**, and the run-state badge. `visual/visual-helpers.js`
masks the single locator `[data-live="1"]` on every capture, so those pixels are
painted over and only **structural/visual** change registers. The config form has
no live cells, so the same mask is a harmless no-op there.

### Refresh the baselines (documented update command)

    cd tests/ui
    npx playwright test --project=visual --update-snapshots
    # or: npm run test:visual:update

This (re)writes the baseline PNGs under `tests/ui/visual/*-snapshots/`, which are
**committed in-repo**. Review the resulting image changes before committing.

### Human-review gallery (always published)

After a capture, build a browsable, labelled gallery of every page/state:

    cd tests/ui
    node visual/generate-gallery.js        # or: npm run gallery

It collects the committed baseline PNGs into `tests/ui/visual/gallery/`
(`index.html` + `images/` + `manifest.json`) — a self-contained artifact a
maintainer can open to evaluate the real UI without a device. The gallery output
dir is **gitignored** (it is a build artifact, regenerated in CI); the generator
script and the baselines are in-repo.

### Does the diff gate the build?

**No — the visual diff is advisory, the gallery always publishes.** Pixel output
can differ across environments (fonts/GPU), so baselines are environment-specific;
task 13's CI runs the diff and uploads the HTML diff report **and** the gallery as
artifacts, but does not fail the pipeline on a visual diff. Maintainers review
structural change via the gallery + diff report and refresh baselines with the
command above when a change is intentional. (Run in the same controlled
environment the baselines were captured in, the diff is a hard, meaningful check.)

## How the live LuCI is brought up

`global-setup.js` gets a LuCI endpoint one of two ways:

1. **`CA_UI_BASE_URL`** — point at an already-running LuCI (dev router, or a VM
   you booted by hand). No VM is spawned. Also honor `CA_UI_ROOT_PASSWORD`.
   Example (fast local iteration against a hand-booted serve VM):

       CA_UI_BASE_URL=http://127.0.0.1:8080 CA_UI_ROOT_PASSWORD=cakeautorate \
         npx playwright test --project=functional

2. **VM `--serve` mode (default / CI path)** — spawns
   `tests/integration/run.sh --serve`, which boots the pinned OpenWrt 25.12.5
   VM, installs the built apks + deps, configures the two instances (primary +
   secondary), sets a known root password, opens the firewall for HTTP, brings
   up uhttpd, and **forwards guest :80 to host :8080** via QEMU
   `hostfwd=tcp::8080-:80`. It then stays up until a stop-file appears. LuCI is
   reachable at `http://127.0.0.1:8080/` and the harness writes a JSON ready-file
   with the base URL + credentials (root / cakeautorate).

`global-teardown.js` writes the stop-file (and, as a backstop, signals the
process group) so the VM is powered off after the run.

Serve mode is an **opt-in addition** to the integration harness — `run.sh`
(positive/negative) and its PASS/FAIL semantics are unchanged. Env knobs:
`CA_UI_SERVE_PORT` (8080), `CA_UI_SERVE_HOST` (127.0.0.1),
`CA_UI_ROOT_PASSWORD` (cakeautorate), `CA_UI_READY_FILE`, `CA_UI_STOP_FILE`,
`CA_UI_READY_TIMEOUT_MS` (900000).

## Login

OpenWrt default user `root`; the serve harness sets the password
(`cakeautorate`). The `luciBeforeEach` fixture drives the real LuCI login form
(so the CSRF token rides along) before each spec.

## No live LuCI (no KVM)

If the VM cannot boot (e.g. a runner without `/dev/kvm`), `run.sh` prints
`INTEGRATION_SKIPPED` and exits 0; globalSetup records `available:false` and
every spec **skips** with a reason. CI stays green-or-skipped, never falsely red.

### `CA_IT_REQUIRE_KVM=1` — skips become hard failures

Skipping is only safe when nobody claimed the run had to happen. Set
`CA_IT_REQUIRE_KVM=1` (CI does, for both the functional and visual steps) and
globalSetup **throws** instead of recording `available:false`, for *any* reason
the endpoint failed to come up — no KVM, apks missing from `CA_IT_APK_DIR`, a
boot timeout.

This matters because the skip path is indistinguishable from success at the exit
code: without it, an infra breakage silently skips every spec and
`npx playwright test` still exits 0. That has bitten this repo for real — a
half-built SDK left `luci-app-cake-autorate-*.apk` missing, `run.sh` exited
3, all specs skipped, and the run reported success. Use the env var whenever a
green result is supposed to mean "the browser actually drove a live LuCI".

## Config essentials reused by task 12

- engine `chromium` (bundled), `headless: true`
- pinned `viewport: { width: 1280, height: 900 }`, `deviceScaleFactor: 1`
- `workers: 1`, `fullyParallel: false` (one VM, one uhttpd)
- `globalSetup` / `globalTeardown` above; login via `fixtures/luci.js`

## Stable selectors (for task 12 screenshots / masks)

- config option row: `div.cbi-value[data-name="<uci_option>"]`
- search box: `input#cake-autorate-filter`; group tab menu: `li[data-tab="<group>"]`
- named section container: `#cbi-cake-autorate-<instance>`
- Save & Apply control: `.cbi-page-actions .cbi-button-apply` (single click)
- status root `#cake-autorate-status`; controls `#cake-autorate-controls`
- service buttons `button[data-cake-action="start|stop|restart"][data-cake-instance="<inst>"]`
- per-instance card `.cake-instance[data-cake-instance="<inst>"]`
- **dynamic cells** `[data-live="1"]` (with `data-field`/`data-instance`) — task 12
  MUST mask these (rates, uptime, datetime, load conditions change every poll).
