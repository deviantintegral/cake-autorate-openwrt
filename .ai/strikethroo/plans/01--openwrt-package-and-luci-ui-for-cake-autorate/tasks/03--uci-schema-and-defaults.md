---
id: 3
group: "config"
dependencies: [1]
status: "completed"
created: 2026-07-23
skills:
  - openwrt-uci
complexity_score: 5
---
# UCI Configuration Schema and Sane Defaults

## Objective
Model every supported upstream option (from the task-1 inventory) in a UCI schema
`/etc/config/cake-autorate`, one named section per cake-autorate instance, with
defaults sane enough that a working single-instance setup requires editing only
the Essentials (interface(s), enable, and min/base/max rates per direction). This
schema is the source of truth the config bridge and LuCI UI both bind to.

## Skills Required
- `openwrt-uci` — UCI config file structure, section/option typing, defaults, multi-section modeling.

## Acceptance Criteria
- [ ] A UCI default config models each instance as a named section carrying the full option set from the inventory (interfaces, adjust toggles, min/base/max rates per direction, connection-active threshold, pinger backend/count/interval, reflector list + management/health params, OWD delay thresholds, EWMA/baseline alphas, rate-adjustment multipliers, bufferbloat detection window/threshold/refractory, idle/sleep + stall handling, logging/output toggles, startup + interval timers).
- [ ] Defaults are chosen so a fresh single-instance section with only interface + min/base/max rates set is a valid, working configuration.
- [ ] Multi-instance is expressible: two named sections coexist without shared/global collisions.
- [ ] Verification: `uci import cake-autorate < <default-config>` parses cleanly and `uci show cake-autorate` lists the section(s); a coverage check confirms every option name in `docs/upstream-option-inventory.md` has a corresponding UCI option key (diff of inventory keys vs UCI keys is empty).

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- One UCI section type (e.g. `config cake-autorate 'primary'`) per instance; an `enabled` option gates procd start.
- Option names should map cleanly to upstream option names so the bridge (task 4) translation stays legible and the bidirectional-coverage assertion is simple.

## Input Dependencies
- Task 1: the option inventory (names, types, defaults, direction).

## Output Artifacts
- The UCI default config file (installed by task 2's package) — consumed by tasks 4 (bridge), 5 (init), 7 (LuCI form).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. For each inventory option, add a UCI option to the section. Use `list` for multi-value options (reflector lists). Represent booleans as `0`/`1` to match upstream shell semantics.
2. Group per-direction options as distinct keys (`egress_*` / `ingress_*` or `ul_*`/`dl_*`) rather than one combined value, so the UI and bridge can address each direction.
3. Pick defaults straight from the inventory's default column; where upstream leaves a value site-specific (the rates), leave a clearly-documented placeholder that the user must set — but everything else must default to a working value.
4. Keep an `enabled` flag per section for procd.
5. Write a small coverage assertion (a shell snippet is fine, reused by task 4's bidirectional test) that extracts option keys from the inventory and from the UCI file and diffs them.

Do not invent options upstream does not implement, and do not drop any it does — the plan's central invariant depends on exact coverage.
</details>
