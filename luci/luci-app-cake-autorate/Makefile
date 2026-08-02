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
#
# luci-app-sqm is required for the same reason, one layer down: cake-autorate
# never creates a qdisc, it only moves the bandwidth of a CAKE qdisc sqm-scripts
# attached. When that setup is missing our UI's whole remedy is "go configure
# SQM", and both views link straight to admin/network/sqm -- a dead link if the
# page is not installed. The base package already depends on sqm-scripts; this
# adds the page a LuCI user needs to drive it.
LUCI_DEPENDS:=+cake-autorate +luci-base +luci-app-statistics +luci-app-sqm
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Andrew Chadwick <andrew@furrypaws.ca>
PKG_LICENSE:=GPL-2.0-or-later

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
