#
# Copyright (C) 2026 Andrew Chadwick
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=cake-autorate
PKG_VERSION:=3.2.2
# PKG_RELEASE counts packagings of ONE upstream PKG_VERSION -- it is the only
# field that can distinguish two of them, since PKG_VERSION above is upstream's
# and not ours to choose. It resets to 1 when upstream moves (3.2.3-r1 already
# sorts above 3.2.2-r7, because the version dominates and the release is only a
# tiebreaker within it) and increments when anything in this directory changes
# at the same upstream version. r2 is the +tc-tiny -> +tc fix over v0.2.0's r1.
#
# Owned by .github/scripts/package-versions.sh, which release.yml runs before it
# will publish a tag; Renovate deliberately leaves it alone. Do not hand-edit --
# run the script with --fix. Getting this wrong is silent: v0.1.0 and v0.2.0 both
# shipped r1 with different payloads, and apk never offers a router the version
# string it already holds.
PKG_RELEASE:=2

# Pinned upstream: lynxthecat/cake-autorate tag v3.2.2 (the original bash
# implementation, not the "Darkmoon" C rewrite). See
# docs/upstream-option-inventory.md for where this hash came from.
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/lynxthecat/cake-autorate/tar.gz/refs/tags/v$(PKG_VERSION)?
# Renovate rewrites PKG_VERSION above (see the custom manager in renovate.json)
# but cannot compute this -- a version-bump PR ships a stale hash on purpose and
# fails the download loudly. Regenerate it before merging.
PKG_HASH:=892d8e648f6b3705f31799736e697874da3802b5e56ce4aea257cfdf6a376414
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

PKG_MAINTAINER:=Andrew Chadwick <andrew@furrypaws.ca>
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENCE.md

# Pure shell payload -- nothing architecture-specific ships. Note that OpenWrt
# only consumes the per-package PKGARCH (see include/package-defaults.mk);
# PKG_ARCH is declared here for readability and wired through below.
PKG_ARCH:=all

include $(INCLUDE_DIR)/package.mk

# Install prefixes. CA_SCRIPT_PREFIX must be one of upstream's
# POSSIBLE_SCRIPT_PREFIXES (see cake-autorate.sh) so the daemon locates
# defaults.sh/lib.sh without any environment override. CA_CONFIG_PREFIX keeps
# the per-instance config out of /usr/lib; the procd init script exports
# CAKE_AUTORATE_CONFIG_PREFIX to match.
CA_SCRIPT_PREFIX:=/usr/lib/cake-autorate
CA_CONFIG_PREFIX:=/etc/cake-autorate

define Package/cake-autorate
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Routing and Redirection
  TITLE:=CAKE with adaptive bandwidth for bufferbloat control
  URL:=https://github.com/lynxthecat/cake-autorate
  # collectd-mod-exec: statistics reach luci-app-statistics through a collectd
  # `exec` reader (the tail plugin cannot map the load-condition string to a
  # number).
  #
  # `tc`, NOT `tc-tiny`: iproute2 ships two mutually-conflicting providers of
  # the virtual `tc` package, and either one runs the `tc qdisc change` the
  # daemon issues. Naming the tiny variant made the package uninstallable on
  # any router that had already chosen tc-full -- apk cannot satisfy a concrete
  # tc-tiny and an installed tc-full at once. sqm-scripts depends on `tc` for
  # the same reason.
  DEPENDS:=+bash +fping +tc +kmod-sched-cake +sqm-scripts +collectd-mod-exec
  PKGARCH:=$(PKG_ARCH)
endef

define Package/cake-autorate/description
 cake-autorate is a script that automatically adapts the CAKE Smart Queue
 Management (SQM) bandwidth settings by measuring traffic load and one-way
 delay (OWD) on variable-rate connections such as LTE, 5G, Starlink and
 congested cable/DSL links.

 This package ships the upstream bash daemon together with OpenWrt
 integration: a UCI configuration, a procd service, a UCI-to-native config
 bridge and a collectd exec source feeding luci-app-statistics.
endef

define Package/cake-autorate/conffiles
/etc/config/cake-autorate
endef

# Pure shell payload -- nothing to cross-compile. The only build step is
# substituting upstream's %%SCRIPT_PREFIX%% / %%CONFIG_PREFIX%% placeholders,
# which upstream's interactive setup.sh would otherwise do. setup.sh is NOT run
# (it downloads from the network and writes outside the build root).
define Build/Configure
endef

define Build/Compile
	# Fail loudly if upstream ever renames a file we depend on.
	for f in cake-autorate.sh defaults.sh lib.sh launcher.sh.template; do \
		test -f $(PKG_BUILD_DIR)/$$$$f || { echo "ERROR: missing upstream file: $$$$f"; exit 1; }; \
	done
	$(CP) $(PKG_BUILD_DIR)/launcher.sh.template $(PKG_BUILD_DIR)/launcher.sh
	$(SED) 's|%%SCRIPT_PREFIX%%|$(CA_SCRIPT_PREFIX)|g' $(PKG_BUILD_DIR)/launcher.sh
	$(SED) 's|%%CONFIG_PREFIX%%|$(CA_CONFIG_PREFIX)|g' $(PKG_BUILD_DIR)/launcher.sh
	# No placeholder may survive into the shipped launcher.
	if grep -q '%%' $(PKG_BUILD_DIR)/launcher.sh; then \
		echo "ERROR: unsubstituted placeholder left in launcher.sh"; exit 1; \
	fi
endef

define Package/cake-autorate/install
	# --- upstream daemon ------------------------------------------------
	$(INSTALL_DIR) $(1)$(CA_SCRIPT_PREFIX)
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/cake-autorate.sh $(1)$(CA_SCRIPT_PREFIX)/
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/launcher.sh $(1)$(CA_SCRIPT_PREFIX)/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/defaults.sh $(1)$(CA_SCRIPT_PREFIX)/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib.sh $(1)$(CA_SCRIPT_PREFIX)/

	# --- where the bridge writes the generated per-instance config ------
	$(INSTALL_DIR) $(1)$(CA_CONFIG_PREFIX)

	# --- UCI configuration (a conffile, see above) ----------------------
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/cake-autorate.config $(1)/etc/config/cake-autorate

	# --- procd init script ----------------------------------------------
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/cake-autorate.init $(1)/etc/init.d/cake-autorate

	# --- UCI -> native config bridge ------------------------------------
	$(INSTALL_DIR) $(1)/usr/libexec/cake-autorate
	$(INSTALL_BIN) ./files/cake-autorate-bridge.sh \
		$(1)/usr/libexec/cake-autorate/cake-autorate-bridge.sh

	# --- collectd exec statistics source --------------------------------
	$(INSTALL_DIR) $(1)/etc/collectd/conf.d
	$(INSTALL_CONF) ./files/cake-autorate.collectd.conf \
		$(1)/etc/collectd/conf.d/cake-autorate.conf
	# the exec reader the collectd config above runs.
	$(INSTALL_DIR) $(1)/usr/libexec/collectd
	$(INSTALL_BIN) ./files/cake-autorate-collectd.sh \
		$(1)/usr/libexec/collectd/cake-autorate-collectd.sh

	# --- rpcd backend: SQM interface derivation, log-stream status and
	# service controls. ubus object "cake-autorate", gated by the LuCI ACL.
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/cake-autorate.rpcd $(1)/usr/libexec/rpcd/cake-autorate
endef

# rpcd enumerates /usr/libexec/rpcd/* exactly once, when it starts. So the ubus
# object installed above -- the one the LuCI status view, the SQM interface
# picker and the service buttons all call -- does not exist until rpcd is told
# to come back, and installing this package alone left it missing until the next
# reboot. Same postinst the upstream rpcd-mod-* packages carry.
#
# `reload`, NOT `restart`: on SIGHUP rpcd freezes its sessions, re-execs itself
# with RPC_HANGUP=1 and thaws them, so the new process re-scans
# /usr/libexec/rpcd AND re-reads /usr/share/rpcd/acl.d for every restored
# session -- nobody is logged out. A `restart` drops the sessions instead and
# forces every open LuCI tab to log in again. (rpcd main.c: exec_self();
# session.c: rpc_session_from_blob -> rpc_login_setup_acls.)
#
# The wait is not decoration. When both packages are installed together apk runs
# this script first and luci-app-cake-autorate's postinst -- which reloads rpcd
# again, to pick up its ACL file -- moments later. execv restores the default
# SIGHUP disposition, so a second SIGHUP arriving inside this re-exec window
# kills rpcd outright; procd respawns it *without* RPC_HANGUP, which purges every
# session and logs the admin out. Waiting for the object to reappear closes that
# window, and doubles as a check that the reload took at all.
define Package/cake-autorate/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/rpcd reload
command -v ubus >/dev/null 2>&1 || exit 0
ubus -t 10 wait_for cake-autorate || \
	logger -t cake-autorate "rpcd did not register the cake-autorate ubus object after a reload -- the LuCI status view stays empty until rpcd restarts"
exit 0
endef

$(eval $(call BuildPackage,cake-autorate))
