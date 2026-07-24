---
id: 2
group: "packaging"
dependencies: [1]
status: "pending"
created: 2026-07-23
skills:
  - openwrt-packaging
  - make
complexity_score: 6
---
# cake-autorate Package Makefile and Feed Layout

## Objective
Create the feed directory structure (following official `openwrt/packages` and
`openwrt/luci` conventions) and the `cake-autorate` package Makefile that fetches
upstream at the pinned tag (hash-verified), declares dependencies, marks the
package architecture-independent, and installs the daemon plus the integration
files that later tasks populate (UCI defaults, procd init, config bridge, collectd
config). This is the SDK-buildable skeleton the rest of the feed hangs off.

## Skills Required
- `openwrt-packaging` — feed structure, `package.mk`, `PKG_*` variables, `$(Build/Compile)`, `$(Package/*/install)`.
- `make` — Makefile authoring.

## Acceptance Criteria
- [ ] Feed layout created: a `cake-autorate` package directory and a `luci-app-cake-autorate` package directory, arranged per `openwrt/packages` + `openwrt/luci` conventions, plus a place for the statistics files where `luci-app-statistics` expects contributed graph scripts.
- [ ] The `cake-autorate` Makefile fetches upstream at the pinned tag from task 1 with `PKG_HASH` verification, declares dependencies (`bash`, the chosen pinger backend, `sqm-scripts`, collectd pieces), sets `PKG_ARCH:=all`, `PKG_LICENSE:=GPL-2.0-or-later`, and a maintainer.
- [ ] Install stanzas place the daemon and reserve paths for the UCI default (`/etc/config` via `/etc/uci-defaults` or conffiles), the procd init (`/etc/init.d`), the bridge, and collectd config — even if those files are stubs owned by later tasks.
- [ ] Verification: with the OpenWrt 25.12.x SDK, `make package/cake-autorate/download` succeeds with a matching hash, and `make package/cake-autorate/compile V=s` finishes without error and emits an `.apk` artifact (post-24.10 format). Expected: the build log ends with the produced package path and no error.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Target: OpenWrt **25.12.x** SDK; package format **apk**. Keep the Makefile format-agnostic (no opkg assumptions).
- `PKG_ARCH:=all` — no compiled code ships.
- Use the pinned tag + hash recorded by task 1.

## Input Dependencies
- Task 1: pinned upstream tag + source hash; the option inventory (informs which files upstream ships).

## Output Artifacts
- Feed directory skeleton (both package dirs + statistics location).
- `cake-autorate/Makefile` that builds and installs upstream + integration file slots.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Create the feed root layout, e.g. `net/cake-autorate/Makefile` for the daemon package and `luci/luci-app-cake-autorate/Makefile` for the UI package (task 7 fills the UI Makefile body; here just create the skeleton so the feed registers). Statistics graph scripts go where `luci-app-statistics` looks for contributed graphs (task 6 owns their content).
2. In `cake-autorate/Makefile`: `include $(TOPDIR)/rules.mk`; set `PKG_NAME`, `PKG_VERSION` (the pinned tag), `PKG_SOURCE_URL`/`PKG_SOURCE`/`PKG_HASH` for the GitHub tag tarball, `PKG_ARCH:=all`, `PKG_LICENSE:=GPL-2.0-or-later`, `PKG_MAINTAINER`.
3. `define Package/cake-autorate` — set `SECTION`, `CATEGORY:=Network`, `TITLE`, and `DEPENDS:=+bash +sqm-scripts +<pinger> +collectd-mod-tail` (exact pinger/collectd module names settled here from the inventory; tail/exec per the plan — no compiled plugin).
4. `Build/Compile` is a no-op for pure shell (`define Build/Compile\nendef`).
5. `Package/cake-autorate/install`: `$(INSTALL_DIR)` + `$(INSTALL_BIN/DATA)` to drop the upstream daemon under a standard path, the init script into `/etc/init.d`, the bridge into a libexec path, the UCI default into `/etc/uci-defaults` (or ship `/etc/config/cake-autorate` as a conffile), and collectd config. Later tasks provide the real file bodies; commit minimal stubs here so the package builds.
6. Build with the SDK to prove it compiles and to confirm the target's default package manager is apk (record it for tests/docs).

Keep naming/sections/licensing aligned with upstream feed conventions so a future `openwrt/packages` PR needs no structural rework.
</details>
