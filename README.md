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

# 2. Register THIS repo as a src-link feed named "cakeautorate".
echo "src-link cakeautorate /path/to/cake-autorate-openwrt" > feeds.conf.default
./scripts/feeds update cakeautorate
./scripts/feeds install -p cakeautorate -a

# 3. Minimal .config (avoid CONFIG_ALL — no kernel build required).
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

OpenWrt 25.12 uses the **`apk`** package manager — `opkg` is gone. Copy the two
built `.apk` files to the router and install them together (so the dependency
resolves in one shot):

```sh
apk add ./cake-autorate-3.2.2-r1.apk ./luci-app-cake-autorate-1.0.0-r1.apk
```

If you serve the feed from a repository instead, add it to `apk` and:

```sh
apk add cake-autorate luci-app-cake-autorate
```

`apk` pulls the runtime dependencies automatically: `bash`, `fping`, `tc-tiny`,
`kmod-sched-cake`, **`sqm-scripts`** and `collectd-mod-exec`.

After installing, configure at least one instance's interfaces and rates
(LuCI → **Network → Cake Autorate**, or edit `/etc/config/cake-autorate`), set
`option enabled '1'`, and start it:

```sh
/etc/init.d/cake-autorate enable
/etc/init.d/cake-autorate start
```

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

## Continuous integration (GitHub-hosting prerequisite)

`.github/workflows/ci.yml` defines a three-job pipeline on every push / PR —
**build** (25.12.5 SDK, noarch, one build), **integration** (QEMU/KVM VM
harness) and **ui** (Playwright functional + visual + review gallery) — pinned to
25.12.5 throughout.

> **This repository has no git remote yet.** The workflow file exists but cannot
> run until the repo is published to GitHub. To enable CI, create a GitHub
> repository and push:
>
> ```sh
> git remote add origin git@github.com:<owner>/cake-autorate-openwrt.git
> git push -u origin main
> git push origin HEAD          # push the feature branch / open a PR
> ```
>
> GitHub-hosted `ubuntu-*` runners expose `/dev/kvm`, so the VM-backed jobs run
> for real; a runner without KVM **skips them visibly** (a `::warning` + summary
> line), never a silent green pass. See [`docs/testing.md`](docs/testing.md).

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
