# cake-autorate for OpenWrt

An OpenWrt feed that packages [`lynxthecat/cake-autorate`](https://github.com/lynxthecat/cake-autorate)
— the adaptive-bandwidth controller for CAKE SQM — as first-class OpenWrt
packages with a UCI configuration, a procd service, a LuCI web UI and
luci-app-statistics graphs.

cake-autorate continuously measures load and one-way delay on a variable-rate
link (LTE, 5G, Starlink, congested cable/DSL) and nudges the CAKE shaper
bandwidth up and down to keep latency low without giving away throughput.

## What this feed ships

| Package | What it is |
| --- | --- |
| `cake-autorate` | The upstream **bash** daemon (pinned to tag **v3.2.2**) plus the OpenWrt glue: `/etc/config/cake-autorate` UCI, a procd init script (one supervised daemon per enabled instance), the UCI→native config bridge, an rpcd backend, and a collectd `exec` statistics source. |
| `luci-app-cake-autorate` | The LuCI UI: an Essentials-first configuration form with SQM-validated interface pickers, plus a live status view. Depends on `cake-autorate` + `luci-base`. |
| Statistics graphs | Shipped inside `luci-app-cake-autorate`: a collectd RRD definition (`cake_autorate.js`) that renders the daemon's achieved/shaper rates, OWD deltas and load state under **Statistics → Graphs**, one panel per instance. |

Both packages are **noarch** (`PKG_ARCH:=all` / pure shell + JS payload), so a
single build serves every target.

> The canonical bash implementation is deliberately pinned — this is **not** the
> experimental "Darkmoon" C rewrite. The pin (tag, commit, tarball SHA-256) and
> the full option provenance live in [`docs/upstream-option-inventory.md`](docs/upstream-option-inventory.md).

## What it looks like

**Network → CAKE Autorate → Configuration.** A fresh instance needs only its two
interfaces and the min/base/max rates; the interface pickers are populated from
the live SQM config and confirm what they are backed by:

![The Essentials tab of the LuCI configuration form, showing the DL/UL interface
pickers with their SQM validation hints and the six shaper-rate fields](docs/images/config-essentials.png)

**Network → CAKE Autorate → Status.** A live per-instance readout, refreshed
every 3 seconds from the running daemon, with start/stop/restart controls per
instance and for the service as a whole:

![The LuCI live status view, showing two running instances with their CAKE
shaper rates, achieved rates, load conditions and average OWD deltas](docs/images/status-view.png)

The daemon only samples while there is traffic: with `enable_sleep_function`
(the default) it sleeps the pingers after `sustained_idle_sleep_thr_s` of an
idle link and stops reporting until traffic returns. The table then holds the
last sample it did report, and **Last update** says how long ago that was —
`16:25:36 (4m 12s ago)`. That is normal on an idle line, not a stalled service.

More screenshots — the grouped advanced tabs, the option search and a two-WAN
setup — are in the [configuration reference](docs/configuration.md). All of them
are captured from a real OpenWrt VM by the UI suite; see
[`docs/testing.md`](docs/testing.md#documentation-screenshots) to regenerate them.

## Relationship to upstream cake-autorate

Upstream is normally installed by hand into `/root/cake-autorate/` via its
interactive `setup.sh`. This feed instead:

- installs the daemon to the OpenWrt-standard prefix `/usr/lib/cake-autorate/`
  (which is one of upstream's `POSSIBLE_SCRIPT_PREFIXES`, so no environment
  override is needed);
- keeps the per-instance generated daemon config in `/etc/cake-autorate/`;
- **does not run** upstream's `setup.sh` (it downloads from the network and
  writes outside the build root) — the build only substitutes upstream's
  `%%SCRIPT_PREFIX%%` / `%%CONFIG_PREFIX%%` launcher placeholders;
- exposes every option through UCI + LuCI instead of a hand-edited
  `config.primary.sh`.

### Coexistence with a manual `/root/cake-autorate/` install

The package installs only to its own paths (`/usr/lib/cake-autorate`,
`/etc/cake-autorate`, `/etc/config/cake-autorate`, `/etc/init.d/cake-autorate`,
…) and **never touches `/root/cake-autorate/`**. A pre-existing manual install
there is left completely intact — the package neither clobbers it nor migrates
its settings automatically.

If you previously ran a manual install, **disable it before enabling this
package** so two daemons do not fight over the same CAKE qdisc: stop/disable the
old service (e.g. its own init script or cron entry) and then port your rates and
interfaces into `/etc/config/cake-autorate` (or the LuCI form) by hand. There is
no automatic migration — this is intentional, so an upgrade can never silently
change a working hand-tuned setup.

## The SQM relationship (who owns the qdisc)

This package **depends on `sqm-scripts`** and follows a strict division of
labour:

- **SQM owns the qdisc.** `sqm-scripts` creates and owns the CAKE root qdisc on
  the egress device and the `ifb4<iface>` ingress device. cake-autorate's init
  script starts at `START=97`, well after SQM (`START=50`), so the qdiscs already
  exist before the daemon runs.
- **cake-autorate only adjusts the bandwidth.** The daemon changes the
  *bandwidth* of those existing qdiscs at runtime; it never creates, deletes or
  re-parents a qdisc and never calls `tc` to build one.

So you configure CAKE in SQM as usual (pick `cake` + a `piece_of_cake`/layer-cake
script, set a sane starting bandwidth), and cake-autorate takes it from there.
See [`docs/configuration.md`](docs/configuration.md) for the interface/rate
setup.

## Building with the OpenWrt 25.12.5 SDK

Everything is pinned to **OpenWrt 25.12.5**. Build the two noarch packages with
the release SDK — no full buildroot needed.

```sh
# 1. Fetch + extract the pinned SDK (x86-64 shown; any target works, noarch).
SDK=openwrt-sdk-25.12.5-x86-64_gcc-14.3.0_musl.Linux-x86_64
wget "https://downloads.openwrt.org/releases/25.12.5/targets/x86/64/$SDK.tar.zst"
tar --use-compress-program=unzstd -xf "$SDK.tar.zst"
cd "$SDK"

# 2. Add THIS repo as a src-link feed named "cakeautorate" -- APPEND it to the
#    feed list the SDK ships. Overwriting feeds.conf.default drops the pinned
#    `luci` feed, and luci-app-cake-autorate includes feeds/luci/luci.mk, so the
#    LuCI package then fails with "No rule to make target .../luci.mk".
cp feeds.conf.default feeds.conf
echo "src-link cakeautorate /path/to/cake-autorate-openwrt" >> feeds.conf
# `base` is needed too, not just `luci`: the SDK ships only package/kernel and
# package/toolchain, so luci-base's own C dependencies (liblua, libucode,
# libubox, libubus, libnl-tiny, rpcd, iwinfo) all come from the base feed.
# Without it the build stops at lucihttp with "fatal error: lua.h".
./scripts/feeds update base luci cakeautorate
# `install -a` (not `-p cakeautorate`): -p installs only our own feed's
# packages, leaving luci-base's dependencies unresolved. This just creates
# symlinks -- the compile steps below still build only our two packages and
# their actual dependency chain.
./scripts/feeds install -a

# 3. Select the two packages. Skipping the `packages` feed keeps this quick;
#    cake-autorate's remaining runtime deps -- bash, fping, sqm-scripts,
#    collectd-mod-exec -- are recorded in the .apk regardless and are resolved
#    by apk on the router at install time. They show up as "has a dependency on
#    X, which does not exist" warnings here, which are expected and harmless.
#    Run `./scripts/feeds update -a` instead if you want them at build time.
{
  echo "CONFIG_PACKAGE_cake-autorate=m"
  echo "CONFIG_PACKAGE_luci-app-cake-autorate=m"
} > .config
make defconfig

# 4. Compile each package.
make package/cake-autorate/compile V=s
make package/luci-app-cake-autorate/compile V=s
```

The resulting `.apk` files land under `bin/packages/x86_64/cakeautorate/`
(noarch, so they install on any 25.12.5 target regardless of that path's arch
name).

## Installing (apk, not opkg)

OpenWrt 25.12 uses the **`apk`** package manager — `opkg` is gone.

Grab both `.apk` files from the [latest
release](https://github.com/deviantintegral/cake-autorate-openwrt/releases/latest)
(or build them yourself, above), copy them to the router, and install them
together so the dependency between them resolves in one shot:

```sh
apk add --allow-untrusted ./cake-autorate-*.apk ./luci-app-cake-autorate-*.apk
```

`--allow-untrusted` is needed because loose `.apk` files are not signed by a
repository key; verify them against the release's `SHA256SUMS` first. There is
**no hosted apk repository yet**, so the `apk add cake-autorate` form does not
work — that needs a signed package index, which this feed does not publish.

`apk` pulls the runtime dependencies automatically: `bash`, `fping`, `tc`,
`kmod-sched-cake`, **`sqm-scripts`** and `collectd-mod-exec`. `tc` is virtual —
whichever of `tc-tiny` or `tc-full` your router already has satisfies it.

After installing, configure at least one instance's interfaces and rates
(LuCI → **Network → CAKE Autorate**, or edit `/etc/config/cake-autorate`), set
`option enabled '1'`, and start it:

```sh
/etc/init.d/cake-autorate enable
/etc/init.d/cake-autorate start
```

### If the LuCI menu entry does not appear

Installing is meant to be enough — both packages reload rpcd from their postinst
— but the failure mode is worth knowing, because the app looks uninstalled when
it hits.

Two things live behind rpcd, and rpcd only picks either of them up when it
(re)starts:

- **the ACL file** `/usr/share/rpcd/acl.d/luci-app-cake-autorate.json`. Every
  node of the menu declares `depends.acl` on that group, and rpcd resolves a
  session's groups from `acl.d` when the session is created — at login, and again
  when it thaws a session across a reload. A browser session that was **already
  logged in** when you installed holds a group list that predates the file, so
  LuCI filters the entire menu away for it;
- **the ubus object** `cake-autorate` (`/usr/libexec/rpcd/cake-autorate`, from
  the base package), which the Status view and the interface pickers call. rpcd
  enumerates `/usr/libexec/rpcd/` only at startup.

`/etc/init.d/rpcd reload` fixes both without logging anyone out: rpcd freezes its
sessions, re-execs, and thaws them, re-reading `acl.d` for each one. So the first
thing to try is a reload, then reload the LuCI page:

```sh
/etc/init.d/rpcd reload
ubus list cake-autorate      # prints the object name when rpcd is serving it
```

If the menu is still missing, restart rpcd and log back in — that drops every
rpcd session, so the fresh login is guaranteed to read `acl.d`:

```sh
/etc/init.d/rpcd restart
```

Either way it is a bug worth reporting; `logread | grep cake-autorate` shows the
warning the base package's postinst logs when its reload did not take.

## Documentation

- [`docs/configuration.md`](docs/configuration.md) — user configuration
  reference: the Essentials-first path, the grouped advanced options, SQM
  interface validation, multi-WAN, and reading the statistics graphs.
- [`docs/testing.md`](docs/testing.md) — running the VM integration harness and
  the Playwright UI suites locally and in CI.
- [`docs/upstream-option-inventory.md`](docs/upstream-option-inventory.md) — the
  upstream pin and the authoritative list of the 66 daemon options.
- [`docs/uci-schema.md`](docs/uci-schema.md) /
  [`docs/uci-option-schema.tsv`](docs/uci-option-schema.tsv) — the UCI schema and
  the machine-readable option table the config bridge is built from.
- [`AGENTS.md`](AGENTS.md) — durable design invariants for anyone (human or
  automated) changing the code.

## Continuous integration

`.github/workflows/ci.yml` defines a four-job pipeline on every push / PR —
**unit** (`tests/run-unit.sh`; no SDK, no VM, reports in under a minute),
**build** (25.12.5 SDK, noarch, one build), **integration** (QEMU/KVM VM
harness) and **ui** (Playwright functional + visual + review gallery) — pinned to
25.12.5 throughout.

The build recipe itself lives in `.github/workflows/build.yml`, a reusable
workflow. `ci.yml` and `release.yml` both call it, so a release ships packages
built by exactly the steps every commit is tested with.

GitHub-hosted `ubuntu-*` runners expose `/dev/kvm`, so the VM-backed jobs run
for real; a runner without KVM **skips them visibly** (a `::warning` + summary
line), never a silent green pass. See [`docs/testing.md`](docs/testing.md).

## Cutting a release

`.github/workflows/release.yml` runs on a `v*` tag. It rebuilds both packages
from the tagged tree and publishes them as `.apk` assets on a GitHub Release,
with a `SHA256SUMS` file alongside.

```sh
git tag -a v1.1.0 -m "v1.1.0"
git push origin v1.1.0
```

A tag publishes **immediately** — there is no draft step. A tag with a suffix
(`v1.1.0-rc1`) is marked as a prerelease so it never becomes "Latest".

The tag is the *repository's* version and is deliberately not checked against
either package's `PKG_VERSION`: `cake-autorate` tracks **upstream's** version
(3.2.2) and is not ours to choose, while `luci-app-cake-autorate` carries its
own. Bump `PKG_RELEASE` when the packaging changes without an upstream bump.
The release notes list the real built filenames, so what a tag shipped is never
ambiguous.

## Upstream-submission readiness

The `cake-autorate` package is structured to the OpenWrt `packages` feed
conventions and is a candidate for upstream submission:

- standard `Makefile` layout — `PKG_NAME`/`PKG_VERSION`/`PKG_RELEASE`, a verified
  `PKG_HASH` against the pinned upstream tag, `PKG_MAINTAINER`,
  `PKG_LICENSE:=GPL-2.0-or-later` with `PKG_LICENSE_FILES:=LICENCE.md`;
- `/etc/config/cake-autorate` registered as a `conffile` so user config survives
  upgrades;
- pure-shell noarch payload with no network access at build time (upstream's
  `setup.sh` is not invoked);
- explicit runtime `DEPENDS`, and a procd service that respects SQM's ownership
  of the qdisc.

Before submission a maintainer should: confirm the upstream tarball is fetched
from a stable URL (`codeload.github.com` tag tarball, hash pinned); decide
whether `luci-app-cake-autorate` goes to the `luci` feed as a sibling; and run
the full CI (see above) on the published repo. This feed intentionally ships **no
standalone submission-notes document** — this section and `AGENTS.md` are the
submission guidance.

## Licence

GPL-2.0-or-later. The vendored upstream daemon retains its own `LICENCE.md`.
