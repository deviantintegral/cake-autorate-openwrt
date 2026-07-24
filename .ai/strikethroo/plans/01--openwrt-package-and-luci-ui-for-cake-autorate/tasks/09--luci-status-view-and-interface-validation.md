---
id: 9
group: "luci"
dependencies: [7, 8]
status: "completed"
created: 2026-07-23
skills:
  - luci
  - javascript
complexity_score: 6
---
# LuCI Status View and SQM-Validated Interface Selection

## Objective
Complete the LuCI app: add the live per-instance status view (polling the task-8
rpcd backend), rewire the config form's interface fields to the SQM-derived,
validated choices (warning on mismatch instead of accepting free text), and expose
Start/Stop/Restart controls. This closes the "runs but shapes nothing" failure by
binding interfaces to the qdisc SQM actually built, and gives users a live readout.

## Skills Required
- `luci` — status view rendering, polling (`poll.add`), `ui.js` widgets.
- `javascript` — client-side integration with rpcd via `rpc.declare`.

## Acceptance Criteria
- [ ] A status view renders live per-instance state (shaped vs achieved rates, load condition, OWD deltas, active reflectors, uptime), refreshed by polling the task-8 `status` method.
- [ ] The config form's interface fields are populated from the task-8 `sqm_interfaces` method as validated choices (dropdown/validated), and a mismatch (interface not backed by an SQM qdisc) surfaces a visible warning rather than silently accepting it.
- [ ] Start/Stop/Restart buttons invoke the task-8 `service` method and reflect the resulting state.
- [ ] Verification (Playwright/VM): the status tab shows live values while the daemon runs; choosing an interface with no SQM qdisc surfaces a warning; clicking Restart changes the observable service state.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Use `rpc.declare` to bind the rpcd methods; `poll.add` for live status refresh.
- Interface fields must present SQM-derived choices and validate against them; keep option IDs stable for Playwright.

## Input Dependencies
- Task 7: the config form + package resources (interface fields to rewire, menu/ACL).
- Task 8: the rpcd methods (`sqm_interfaces`, `status`, `service`).

## Output Artifacts
- Status view + interface-validation + controls wiring in `luci-app-cake-autorate` — exercised by tasks 11 (functional) and 12 (visual/gallery).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Add a status view (its own tab/page) that `rpc.declare`s the `status` method and uses `poll.add` to refresh every few seconds, rendering a per-instance table. Mark the dynamic cells with stable, identifiable containers so task 12 can mask them in visual diffs.
2. Replace the placeholder interface fields from task 7 with a widget populated from `sqm_interfaces`; validate the selection and render a warning (e.g. `ui.addNotification` or an inline error) on mismatch.
3. Add Start/Stop/Restart buttons wired to the `service` method; update displayed state on completion.
4. Ensure the polling and controls respect the ACLs from task 8.

The status view's changing values are exactly the regions task 12 masks — coordinate stable selectors/markers now.
</details>
