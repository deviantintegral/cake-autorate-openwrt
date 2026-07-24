---
id: 8
group: "luci"
dependencies: [2, 4]
status: "completed"
created: 2026-07-23
skills:
  - shell
  - rpcd
complexity_score: 7
complexity_notes: "Three related rpcd concerns (SQM interface derivation, log-stream status parsing, service control) share the log parser with task 6 and back the LuCI status view in task 9."
---
# rpcd Backend: SQM Interface Derivation, Log-Stream Status, Service Controls

## Objective
Provide the rpcd backend the LuCI app calls: (a) derive and validate shaping
interfaces from the **live SQM configuration** — the WAN egress device and the
corresponding ingress `ifb4*` that SQM created — and detect mismatches; (b) parse
live per-instance status from the daemon's **log stream** (shaped vs achieved
rates, load condition, OWD deltas, active reflectors, uptime), sharing the parser
contract with the collectd source (task 6); (c) expose Start/Stop/Restart service
controls. All methods are gated by the package's ACLs.

## Skills Required
- `rpcd` — ubus/rpcd object registration (`/usr/libexec/rpcd/*`), method schema, ACL integration.
- `shell` — parsing SQM UCI + `tc`/`ifb` state and the cake-autorate log stream.

## Acceptance Criteria
- [ ] An rpcd method returns the SQM-derived interface choices (WAN egress device + its ingress `ifb4*`) and flags a mismatch when a requested interface is not the one SQM built.
- [ ] An rpcd method returns per-instance live status parsed from the daemon log stream (shaped/achieved rates, load condition, OWD deltas, active reflectors, uptime), keyed by instance.
- [ ] rpcd methods perform Start/Stop/Restart on the service (per instance where applicable).
- [ ] All methods are declared in ACLs so only authorized sessions can call them.
- [ ] The status parser shares its expected field set with task 6's collectd source (one parser contract, not two).
- [ ] Verification (on VM): with SQM configured on a WAN, the interface method returns the egress device + `ifb4*`; while the daemon runs, the status method returns populated fields for each instance; the restart method changes observable service state (`service ... status` / `ubus`).

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Derive interfaces from the live SQM config (`/etc/config/sqm` + actual `ifb4*` devices), not free text.
- Parse the per-instance log path/format pinned by task 4.
- Register as a standard rpcd object with a `list`/`call` interface and matching ACL entries.

## Input Dependencies
- Task 2: package layout / install path for the rpcd script and ACLs.
- Task 4: the pinned log path + output format (status parsing) and the per-instance path scheme.

## Output Artifacts
- rpcd backend script + ACL entries (installed by the package) — consumed by task 9 (status view + interface UI) and exercised by tasks 10/11.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Create `/usr/libexec/rpcd/cake-autorate` responding to `list` (method schema) and `call` (dispatch). Methods: `sqm_interfaces`, `status`, `service` (with an action arg: start/stop/restart).
2. `sqm_interfaces`: read `/etc/config/sqm` to find the configured WAN egress device, then find the matching `ifb4*` ingress device SQM created (enumerate `ip link`/`tc qdisc` for `ifb4<iface>`). Return both, plus a validity flag; when a given interface has no corresponding SQM qdisc, mark it a mismatch.
3. `status`: for each instance, tail its pinned log path, parse the latest DATA/SUMMARY line into fields, and return JSON keyed by instance. Factor the line-parsing into a shared snippet so task 6's collectd reader and this method agree on the field set (the tested parser contract).
4. `service`: invoke `/etc/init.d/cake-autorate <action>` (optionally per instance) and return the result.
5. Add ACL JSON granting these methods; the LuCI menu/session must map to the ACL group.

Keep the parser thin and shared — a format change at a new upstream tag should break exactly one place, caught by the field-set contract test.
</details>
