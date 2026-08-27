# Testing

Three layers, all wired into `.github/workflows/ci.yml`:

1. **Unit suites** (`tests/run-unit.sh`) — shell and node, no VM and no `.apk`.
   Seconds to run; the layer you use while writing code.
2. **VM integration harness** (`tests/integration/`) — boots a real OpenWrt VM,
   installs the `.apk`s, runs the service, induces load, and asserts the CAKE
   bandwidth actually moves.
3. **Playwright UI suites** (`tests/ui/`) — drive the LuCI app in a browser
   against the live LuCI the harness boots (functional + visual-regression).

Layers 2 and 3 are pinned to **OpenWrt 25.12.5** and install the built packages
with **`apk`**.

## Unit suites

```sh
./tests/run-unit.sh              # everything; exits non-zero if any suite fails
./tests/run-unit.sh --list       # what it found, without running it
./tests/run-unit.sh --verbose    # output from passing suites too
./tests/run-unit.sh --no-skip    # a skipped suite is a failure (what CI passes)
```

The runner **discovers** suites rather than listing them:

| Glob | Kind |
| --- | --- |
| `tests/*/test-*.sh` | plain shell — bridge, schema, rpcd, service, statistics, probe, regression |
| `luci/luci-app-cake-autorate/tests/*.test.js` | node — `options.js` and `live.js` logic |

That is deliberate. The suites used to be enumerated in `AGENTS.md` prose and
nowhere else, and prose does not fail when it goes stale: the two node suites
were never on that list, CI had no job for any of it, and a graph-definition bug
consequently shipped to a real router with every suite locally green. Drop a new
file into either location and it runs — there is no list to update. If a glob
ever matches nothing the runner **aborts** rather than reporting a vacuous pass.

`tests/integration/` and `tests/ui/` are excluded by construction (the harness
exposes `run.sh`, not `test-*.sh`, and the UI suites are driven by
`playwright.config.js`); both need KVM and have their own jobs.

Node is only needed for the node suites and for the graph-definition checks,
which load the LuCI class file to compare it against the collectd reader. Without
node those **skip with a NOTE** — right on a build host that has not installed
it, wrong anywhere automated. CI and the release gate install node on purpose and
pass `--no-skip`, which turns those skips into failures: if the setup step ever
breaks, the job goes red rather than reporting a green pass over checks it never
ran. (`--no-skip` reaches self-skipping shell suites via `UNIT_NO_SKIP=1` in the
environment, since suites are invoked with no arguments.)

The libuci-dependent checks in `test-uci-schema.sh` are a deliberate exception:
libuci is genuinely unavailable on any build host, CI included, so those stay a
NOTE and are covered on-device by the VM harness instead.

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

Needs `qemu-system-x86_64` + **`/dev/kvm`** (readable *and writable* by you —
group membership alone is not enough if the node is `0660` and you are not in
`kvm`), `python3` (stdlib only), `qemu-img`, `mkfs.ext4`, and outbound internet
to `downloads.openwrt.org`.

On Debian/Ubuntu the emulator is a **separate package** from the disk tools:
`qemu-utils` supplies `qemu-img`, but `qemu-system-x86_64` comes from
`qemu-system-x86`. A host with only the former passes a `qemu-img` check and
then skips every VM suite for want of an emulator.

`/dev/kvm` is `root:kvm 0660` on a stock Debian, so joining the group is the
durable fix — but a group is granted at **login**, and `usermod -aG kvm $USER`
does nothing for shells that are already open. Start a new session, or borrow
the group for one command:

```sh
sudo usermod -aG kvm "$USER"     # persistent, needs a fresh login
sg kvm -c './tests/integration/run.sh'   # works right now, in this shell
```

(`sudo setfacl -m u:$USER:rw /dev/kvm` also works and takes effect at once, but
it is undone by the next udev event on the node, which is a confusing way to
lose access halfway through a session.)

It also needs **unprivileged ICMP** to be permitted:

```sh
sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"
```

QEMU's user-mode networking sends guest ICMP through a Linux ping socket, which
the kernel grants only to GIDs inside `net.ipv4.ping_group_range`. Several
distros and *every* GitHub-hosted runner ship `1 0` — an empty range. Without
this the guest boots fine and then has no working ping: the harness cannot reach
`downloads.openwrt.org` to `apk install`, and cake-autorate cannot measure OWD
with `fping`, so the shaping assertions are meaningless. `run.sh` checks this up
front and exits 3 with the command above rather than letting it surface two
minutes later as a confusing "guest has no internet".

If `/dev/kvm` or QEMU is missing, `run.sh` prints

```
INTEGRATION_SKIPPED: no KVM
```

and exits **0** — a *skip*, not a failure. Set `CA_IT_REQUIRE_KVM=1` to make a
missing KVM a hard error instead.

### Where you check the tree out is a constraint

QEMU's serial and QMP sockets are UNIX domain sockets in
`tests/integration/artifacts/`, and `sockaddr_un.sun_path` holds **108 bytes**
including the NUL. That budget is spent by wherever you cloned the repo, so a
deep checkout makes the harness unrunnable:

```
$ ./tests/integration/run.sh
ERROR: the QEMU serial socket path is 139 bytes:
         /home/you/src/…/.claude/worktrees/my-branch/tests/integration/artifacts/serial.sock
```

A plain clone under `$HOME` has room to spare; a **git worktree under
`.claude/worktrees/<name>/`** adds roughly 40 bytes and can push an otherwise
fine path over on its own. Run the harness from a shorter path — a worktree
created outside `.claude/worktrees/` is enough.

`run.sh` checks this before it boots anything. Prior to that check the run died
as a bare `qemu exited early (rc=1)`, because the driver started QEMU with its
stderr folded into a `DEVNULL` stdout and discarded the one line explaining
itself. QEMU's stderr is now kept in `artifacts/qemu.log` and its tail is
quoted into the error, so any refusal to start — bad drive, unusable
accelerator, over-long path — says so.

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

**`--update-snapshots` does not refresh every stale baseline.** Bare, it means
`--update-snapshots=changed`, and "changed" is judged by the same
`maxDiffPixelRatio` (0.002) the assertions use. A real UI change too small to
trip that tolerance leaves the committed baseline **stale while the run reports
success** — adding a short link to the end of an existing line does it, if
nothing reflows. The mismatch then sits in the tree until some later, larger
change on the same page happens to rewrite it.

If a change should have moved a baseline and did not, do not assume it was not
rendered. Delete that one PNG and re-run: a *missing* snapshot is always
written. `--update-snapshots=all` rewrites everything unconditionally, which
also works, but it re-encodes the untouched baselines too and commits a page of
anti-aliasing noise with them.

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

### Documentation screenshots

The images embedded in [`../README.md`](../README.md) and
[`configuration.md`](configuration.md) are generated from the same live VM, by a
third Playwright project:

```sh
cd tests/ui
npx playwright test --project=docs      # writes docs/images/*.png
```

One image needs more than that. `statistics-graphs.png` shows the collectd
dashboard, and while `luci-app-statistics` is always installed (the LuCI app
depends on it), a serve VM has no `cake_autorate` RRDs behind it: collectd is
not told to read the package's drop-in, and a VM minutes old has nothing to
graph anyway. Turn that path on for the docs run:

```sh
cd tests/ui
CA_UI_STATISTICS=1 npx playwright test --project=docs
```

That makes serve mode set the `Include /etc/collectd/conf.d` that
luci-app-statistics' generated config omits (see
[`configuration.md`](configuration.md#statistics-caveat-collectd-must-be-told-to-read-the-drop-in)), put real load on the
primary WAN so the shaper moves, and collect for `CA_UI_STATS_WARMUP_S` seconds
(default 600) **before** reporting the VM ready — so the run opens on a
dashboard with data in it rather than racing collectd's first sample. Budget
about ten minutes more wall-clock. Without the variable that one test **skips**,
naming the variable in the skip reason; the other five images still regenerate.

It also shortens collectd's interval and adds a 15-minute RRA, so a VM that is
minutes old draws a readable graph instead of a sliver against an empty
two-hour axis. Those are demo-box settings — the timespan dropdown in that
screenshot therefore offers a `15min` span a stock install does not.

It is a generator, not a test: it asserts nothing and compares against no
baseline. **CI never runs it** (the workflow names `--project=functional` and
`--project=visual` explicitly), so it cannot gate a build or rewrite committed
images unattended.

It exists because the `visual/` baselines cannot double as documentation:

- they **mask** every `data-live="1"` cell with a solid box, which is exactly
  right for a stable diff and useless in a doc — it hides the live rates, OWD
  deltas and load conditions a reader wants to see;
- they capture `fullPage` (up to 2124px tall) to catch structural regressions
  anywhere on the page, whereas a doc wants the one section under discussion.

Regenerate the whole set in one run so the images look consistent with each
other, and commit the result alongside the doc change that needs it.

## Running in CI

`.github/workflows/ci.yml` runs on every push / pull request, pinned to 25.12.5,
with four jobs:

| Job | What it does | Artifact(s) |
| --- | --- | --- |
| **unit** | No `needs:` — runs `tests/run-unit.sh` against the bare checkout (no SDK, no `.apk`, no KVM) and reports in under a minute. | — |
| **build** | Sets up the 25.12.5 SDK, registers this repo as a `src-link` feed, builds both noarch packages **once** (no per-arch matrix). | `cake-autorate-apks` |
| **integration** | `needs: build`; boots the VM harness against the downloaded apks — positive run **and** the `--negative` self-test. | `integration-artifacts` |
| **ui** | `needs: build`; runs the functional + visual Playwright suites and publishes the review gallery. | `ui-playwright-report`, `ui-gallery` |

KVM policy: GitHub-hosted `ubuntu-*` runners expose `/dev/kvm`, so the VM-backed
steps run for real — but only after the workflow fixes up two host defaults that
would otherwise break the VM jobs: `/dev/kvm` ships as `root:kvm 0660` (a udev
rule makes it `0666`), and `net.ipv4.ping_group_range` ships as the empty range
`1 0` (a sysctl opens it so guest ICMP works at all). A runner without KVM **skips them visibly** (a `::warning`
annotation + a job-summary line) — never a silent green pass — while `build` and
the gallery still publish so a KVM-less runner yields signal. The **visual diff
is advisory** (baselines are environment-specific for fonts/GPU): CI uploads the
HTML diff report for human review but does not fail the pipeline on a pixel diff.

The build itself lives in the reusable `.github/workflows/build.yml`, which
`ci.yml` and `release.yml` both call — so the `.apk` files a release publishes
are built by the same steps these jobs test against. See the
[README CI section](../README.md#continuous-integration).
