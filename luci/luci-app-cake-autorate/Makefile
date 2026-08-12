#
# Copyright (C) 2026 Andrew Berry
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

# PKG_VERSION IS the repo tag, minus the leading `v`. This app exists only in
# this repo, so there is no upstream version to track and the tag is the honest
# answer -- unlike the base package, whose PKG_VERSION is upstream's. Because
# every release therefore moves PKG_VERSION, PKG_RELEASE has no work to do and
# is PINNED at 1: it is not a counter here, and the explicit line says so rather
# than looking like an oversight.
#
# Both fields are owned by .github/scripts/package-versions.sh, which release.yml
# runs before it will publish a tag. Do not hand-edit them -- run the script with
# --fix. (It also spells a prerelease apk-style, v0.3.0-rc1 -> 0.3.0_rc1, because
# apk reserves `-r<digits>` for the release field.)
#
# It was 1.0.0 up to and including v0.2.0 -- a leftover from the skeleton this
# package started as. v0.2.1 renumbered it DOWN to match the tag, so anyone who
# installed 1.0.0-r1 must `apk del luci-app-cake-autorate` before installing:
# apk will not walk a version backwards.
PKG_VERSION:=0.2.1
PKG_RELEASE:=1
PKG_MAINTAINER:=Andrew Berry <andrew@furrypaws.ca>
PKG_LICENSE:=GPL-2.0-or-later

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
