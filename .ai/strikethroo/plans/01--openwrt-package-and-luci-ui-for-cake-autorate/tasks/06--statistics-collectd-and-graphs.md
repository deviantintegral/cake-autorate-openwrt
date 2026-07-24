---
id: 6
group: "statistics"
dependencies: [1, 4]
status: "pending"
created: 2026-07-23
skills:
  - collectd
  - luci
complexity_score: 6
---
# Statistics Integration (collectd tail/exec + luci-app-statistics Graphs)

## Objective
Give cake-autorate its own historical RRD graphs under LuCI Statistics → Graphs,
in the same place and style as the SQM/CAKE graphs, using an
architecture-independent collectd **tail/exec** integration (config + script, no
compiled C plugin). Metrics are parsed from the daemon's log stream — the same
source the status view uses — and rendered per instance by `luci-app-statistics`
graph definitions.

## Skills Required
- `collectd` — `collectd-mod-tail`/`-exec` configuration, metric typing, RRD series.
- `luci` — `luci-app-statistics` graph definition scripts.

## Acceptance Criteria
- [ ] A collectd tail (or thin exec) configuration parses the daemon's DATA/SUMMARY log lines and exports per-instance metrics: shaper rate and achieved rate per direction, OWD delta per direction, and load/bufferbloat state.
- [ ] `luci-app-statistics` graph definitions render those series as RRD graphs under Statistics → Graphs, labeled per instance, following the `collectd-mod-sqm` pattern.
- [ ] No compiled code is introduced (`PKG_ARCH:=all` preserved); the integration is config + script only.
- [ ] The feed is populated on a **default install** because it consumes the package-pinned output from task 4 (not user verbosity).
- [ ] Verification (on VM, after a run): collectd RRD files for the autorate metrics exist under collectd's data dir, and `luci-app-statistics` lists the autorate graph plugin; the graphs contain data points (non-empty) without any manual logging changes.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Parse the log format pinned by task 4; keep the parser thin and share its field expectations with task 8 (the status backend) so both break together only on an upstream format change (contract test lives with task 4's pinned fields).
- Metric naming and per-instance labeling chosen for legible, per-instance graphs.

## Input Dependencies
- Task 1: which output fields are package-managed / the DATA/SUMMARY field set.
- Task 4: the pinned per-instance log path and stable output format.

## Output Artifacts
- collectd tail/exec config + parser script (installed by task 2's package).
- `luci-app-statistics` graph definition(s) placed where the statistics app expects contributed graphs — consumed by task 10 (stats assertion) and task 13 (CI).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Prefer `collectd-mod-tail`: define a tail plugin block matching the DATA/SUMMARY lines with regex captures for each metric, mapping to collectd types (gauge for rates/OWD, a state value for load/bufferbloat). If a single tail regex cannot express everything, use a small `exec` reader script that reads the log and prints collectd `PUTVAL` lines.
2. Namespace the collectd plugin instance by cake-autorate instance so a multi-WAN setup produces distinct RRDs.
3. Author `luci-app-statistics` graph definitions mirroring how the SQM/CAKE graphs are defined (the `collectd-mod-sqm` graph script is the template). Provide titles, per-direction series, and per-instance panels.
4. Confirm graphs populate on a default install — this depends entirely on task 4 pinning the output, so validate against a bridge-generated config.

This complements, not replaces, `collectd-mod-sqm` (which continues graphing the underlying CAKE qdisc).
</details>
