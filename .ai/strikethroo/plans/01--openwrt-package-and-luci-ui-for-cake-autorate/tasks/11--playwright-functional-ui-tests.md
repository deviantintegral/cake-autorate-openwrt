---
id: 11
group: "testing"
dependencies: [7, 9]
status: "pending"
created: 2026-07-23
skills:
  - playwright
  - javascript
complexity_score: 6
---
# Playwright Functional UI Tests

## Objective
Regression-test the LuCI functionality in a real headless browser. The suite drives
the LuCI app against a running instance: loading the config page, exercising each
group/tab, creating/editing/deleting a second instance, saving and applying,
verifying the status view populates, and exercising the Start/Stop/Restart
controls — asserting on real DOM/state with selectors chosen for stability against
LuCI's client-rendered forms.

## Skills Required
- `playwright` — headless browser automation, fixtures, auth to LuCI, stable locators, explicit waits.
- `javascript` — test authoring.

## Acceptance Criteria
- [ ] Tests load Services → cake-autorate and exercise each option group/tab.
- [ ] Tests create, edit, and delete a second named instance and perform Save & Apply.
- [ ] Tests verify the status view populates with live per-instance data.
- [ ] Tests exercise Start/Stop/Restart and assert the resulting state.
- [ ] An "Essentials-only" path is covered: an instance with only interface + rates set yields a valid saved config.
- [ ] Selectors use stable IDs/roles with explicit waits (no arbitrary sleeps).
- [ ] Verification: `npx playwright test tests/functional` passes headlessly (all specs green) against a running LuCI environment.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Target the VM from task 10 or an equivalent running LuCI environment.
- Use LuCI login handling and stable option IDs/roles exposed by tasks 7/9.

## Input Dependencies
- Task 7: config form (groups, CRUD, options).
- Task 9: status view + interface validation + controls.

## Output Artifacts
- `tests/functional/` Playwright specs + `playwright.config` — consumed by task 12 (shares harness/config) and task 13 (CI UI job).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Set up `playwright.config` with a project pinning the browser engine (task 12 reuses it). Add a login fixture that authenticates to LuCI.
2. Write specs: (a) open the config page, assert Essentials group present and each collapsible group reachable, exercise the search filter; (b) create a second instance, edit fields, Save & Apply, assert persistence; delete it; (c) open the status view and assert live fields appear; (d) click Start/Stop/Restart and assert state changes.
3. Use role/ID-based locators and `expect(...).toBeVisible()`/state waits, not timeouts.
4. Cover the essentials-only path: set only interface + min/base/max rates, Save & Apply, assert a valid running config.

Keep fixtures minimal and selectors stable — LuCI's client-rendered DOM is the main flake source; coordinate IDs with tasks 7/9.
</details>
