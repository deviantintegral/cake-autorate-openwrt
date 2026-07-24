#!/bin/sh
# Runs IN THE GUEST. Reconfigure the stock OpenWrt network into a two-WAN
# topology so the harness can drive two independent cake-autorate instances,
# each with its own SQM CAKE qdisc:
#
#   eth1 -> wan   (qemu netdev net1, 10.0.2.0/24, gw 10.0.2.2) -- PRIMARY,
#                 keeps the default route + internet, receives the download load.
#   eth0 -> wan2  (qemu netdev net0, 10.0.3.0/24, gw 10.0.3.2) -- SECONDARY,
#                 no default route (defaultroute 0) so all load stays on eth1.
#
# Both gateways (10.0.2.2 / 10.0.3.2) answer ICMP under qemu SLIRP, so each
# instance has a reachable, low-latency reflector.
set -e

# Drop the stock bridge/lan so eth0 is free to become wan2.
uci -q delete network.lan || true
uci -q delete network.wan || true
uci -q delete network.wan6 || true
# remove the br-lan device section (first @device)
while uci -q delete network.@device[0]; do :; done

uci set network.wan=interface
uci set network.wan.device='eth1'
uci set network.wan.proto='dhcp'

uci set network.wan2=interface
uci set network.wan2.device='eth0'
uci set network.wan2.proto='dhcp'
uci set network.wan2.defaultroute='0'
uci set network.wan2.peerdns='0'

uci commit network
/etc/init.d/network restart
