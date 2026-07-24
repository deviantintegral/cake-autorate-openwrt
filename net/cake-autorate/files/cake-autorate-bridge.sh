#!/bin/sh
# STUB -- owned by task 4 (UCI -> native config bridge).
#
# Task 2 created this file so the package installs
# /usr/libexec/cake-autorate/cake-autorate-bridge.sh. Task 4 replaces the body.
#
# Contract the real implementation must satisfy (see
# docs/upstream-option-inventory.md sections 2.3 and 3.4):
#   * read UCI package "cake-autorate"
#   * write /etc/cake-autorate/config.<instance_id>.sh
#   * emit ONLY the 66 valid keys -- a single unknown key is fatal to the daemon
#   * floats must carry a decimal point, integers must not, negatives never
#   * dl_if / ul_if / pinger_binary must never be emitted empty
#   * reflectors must be a bash array literal: reflectors=( "1.1.1.1" ... )
#   * force log_to_file=1 and output_summary_stats=1 so the status view and the
#     collectd tail source have something to read

echo "cake-autorate-bridge.sh: not implemented yet (task 4)" >&2
exit 1
