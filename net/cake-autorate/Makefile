#
# Copyright (C) 2026 Andrew Chadwick
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=cake-autorate
PKG_VERSION:=3.2.2
PKG_RELEASE:=1

# Pinned upstream: lynxthecat/cake-autorate tag v3.2.2 (the canonical bash
# implementation, not the "Darkmoon" C rewrite). See
# docs/upstream-option-inventory.md for the provenance of this hash.
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/lynxthecat/cake-autorate/tar.gz/refs/tags/v$(PKG_VERSION)?
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
  # collectd-mod-exec: task 6 feeds luci-app-statistics via a collectd `exec`
  # reader (the tail plugin cannot map the string load-condition to a number).
  DEPENDS:=+bash +fping +tc-tiny +kmod-sched-cake +sqm-scripts +collectd-mod-exec
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

	# --- generated per-instance config lives here (task 4 bridge writes it)
	$(INSTALL_DIR) $(1)$(CA_CONFIG_PREFIX)

	# --- UCI configuration (task 3 owns the body; conffile above) -------
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/cake-autorate.config $(1)/etc/config/cake-autorate

	# --- procd init script (task 5 owns the body) -----------------------
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/cake-autorate.init $(1)/etc/init.d/cake-autorate

	# --- UCI -> native config bridge (task 4 owns the body) -------------
	$(INSTALL_DIR) $(1)/usr/libexec/cake-autorate
	$(INSTALL_BIN) ./files/cake-autorate-bridge.sh \
		$(1)/usr/libexec/cake-autorate/cake-autorate-bridge.sh

	# --- collectd exec statistics source (task 6 owns the body) ---------
	$(INSTALL_DIR) $(1)/etc/collectd/conf.d
	$(INSTALL_CONF) ./files/cake-autorate.collectd.conf \
		$(1)/etc/collectd/conf.d/cake-autorate.conf
	# task 6: the exec reader parsed by the collectd config above.
	$(INSTALL_DIR) $(1)/usr/libexec/collectd
	$(INSTALL_BIN) ./files/cake-autorate-collectd.sh \
		$(1)/usr/libexec/collectd/cake-autorate-collectd.sh

	# task 008: rpcd backend (SQM interface derivation, log-stream status,
	# service controls) -- object name "cake-autorate", gated by the LuCI ACL.
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/cake-autorate.rpcd $(1)/usr/libexec/rpcd/cake-autorate
endef

$(eval $(call BuildPackage,cake-autorate))
