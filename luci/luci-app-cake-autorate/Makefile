#
# Copyright (C) 2026 Andrew Chadwick
#
# This is free software, licensed under the GNU General Public License v2.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for cake-autorate
LUCI_DESCRIPTION:=Configuration and live status UI for cake-autorate, the \
	adaptive-bandwidth controller for CAKE SQM.
# luci-app-statistics is required, not optional: this package ships a graph
# definition into its rrdtool/definitions tree, and luci-app-statistics is what
# points collectd's Include at /etc/collectd/conf.d, where the base package
# drops its exec source. Without it there is no Statistics -> Graphs menu and
# the graphs never get any data. Same arrangement collectd-mod-sqm uses.
LUCI_DEPENDS:=+cake-autorate +luci-base +luci-app-statistics
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Andrew Chadwick <andrew@furrypaws.ca>
PKG_LICENSE:=GPL-2.0-or-later

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
