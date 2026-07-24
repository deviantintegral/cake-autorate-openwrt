#
# Copyright (C) 2026 Andrew Chadwick
#
# This is free software, licensed under the GNU General Public License v2.
#
# SKELETON -- task 2 created this so the feed registers and the package builds.
# Task 7 owns the actual UI (views, menu, ACL) and may extend LUCI_DEPENDS.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for cake-autorate
LUCI_DESCRIPTION:=Configuration and live status UI for cake-autorate, the \
	adaptive-bandwidth controller for CAKE SQM.
LUCI_DEPENDS:=+cake-autorate +luci-base
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_MAINTAINER:=Andrew Chadwick <andrew@furrypaws.ca>
PKG_LICENSE:=GPL-2.0-or-later

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
