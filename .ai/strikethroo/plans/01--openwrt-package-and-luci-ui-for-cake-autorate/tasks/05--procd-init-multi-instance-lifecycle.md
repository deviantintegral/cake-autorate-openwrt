---
id: 5
group: "service"
dependencies: [2, 4]
status: "completed"
created: 2026-07-23
skills:
  - openwrt-procd
  - shell
complexity_score: 6
---
# procd Init Script and Multi-Instance Service Lifecycle

## Objective
Author the procd init script that runs one cake-autorate daemon per enabled UCI
instance, regenerating each instance's shell config via the bridge before start,
wiring reload triggers so LuCI "Save & Apply" reliably (re)starts affected
instances (including cold-start when first enabled), ordering start after `sqm`
(which must have created the qdisc), and namespacing per-instance runtime/log
paths so multiple WANs never collide.

## Skills Required
- `openwrt-procd` — `procd_open_instance`/`procd_set_param`, `service_triggers`, `start_service`/`reload_service`, `USE_PROCD`.
- `shell` — UCI iteration and glue.

## Acceptance Criteria
- [ ] `service cake-autorate start` starts exactly one daemon process per **enabled** UCI section; disabled sections start nothing.
- [ ] Before starting an instance, the init script invokes the task-4 bridge to (re)generate that instance's config.
- [ ] Reload triggers are wired so `Save & Apply` / `reload` applies config changes, including the cold-start case where an instance is enabled for the first time.
- [ ] Start ordering is after `sqm` so the CAKE qdisc exists first; the init does **not** attempt qdisc setup (SQM owns it).
- [ ] Per-instance runtime/log/status paths are namespaced by instance name (no shared paths).
- [ ] Verification (on a VM/target): `/etc/init.d/cake-autorate start` with a two-instance enabled config → `ubus call service list cake-autorate` (or `ps`) shows two running instances at distinct paths; enabling a third instance then `reload` starts it without disrupting the others.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- `START` value orders after sqm.
- Use `procd_add_reload_trigger` / config change triggers for `cake-autorate` UCI.
- Respect the per-instance path scheme established by the bridge (task 4).

## Input Dependencies
- Task 2: package layout / install path for the init script.
- Task 4: the bridge (invoked to materialize per-instance config) and its per-instance path scheme.

## Output Artifacts
- The procd init script (installed by task 2's package) — exercised by task 8 (service controls) and task 10 (VM integration test).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. `USE_PROCD=1`; in `start_service`, `config_load cake-autorate` and `config_foreach start_instance cake-autorate`.
2. `start_instance` skips when `enabled` is 0; otherwise runs the bridge for that section, then `procd_open_instance <name>` / `procd_set_param command <daemon> <per-instance args>` / `procd_set_param respawn` / `procd_close_instance`.
3. `service_triggers`: `procd_add_reload_trigger cake-autorate` so UCI changes trigger reload; ensure `reload_service` re-runs the bridge and restarts only affected instances (a full stop/start is acceptable if per-instance reload is impractical, but cold-enable must work).
4. Set `START` after `sqm`'s start order so the qdisc is up first.
5. Namespace `/var/run` and `/var/log` artifacts per instance (matching task 4).

Do not touch the qdisc — the plan requires SQM to own setup and cake-autorate to only adjust bandwidth.
</details>
