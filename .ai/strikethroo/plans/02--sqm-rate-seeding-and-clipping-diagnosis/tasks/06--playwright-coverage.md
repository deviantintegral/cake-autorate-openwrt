---
id: 6
group: "luci-ui"
dependencies: [5]
status: "completed"
created: 2026-08-02
skills:
  - playwright
complexity_score: 4
---
# Cover the seed action and the clipping notice in the Playwright functional suite

## Objective

Prove the two UI additions work in a real browser against a live LuCI, since both
are client-side behaviours that the node unit suites cannot reach.

## Skills Required

`playwright` — the existing functional project under `tests/ui`.

## Acceptance Criteria

- [ ] A functional test drives the Essentials tab and asserts that clicking
      "Seed rates from SQM" fills all six shaper-rate inputs with the values the
      formula predicts from the VM's SQM configuration.
- [ ] A test asserts the seeded values produce no validation error (no
      `.cbi-input-invalid` on the six fields).
- [ ] A test asserts the refusal path: with no matching SQM section or a `0`
      rate, the control is disabled and a reason is visible.
- [ ] A test asserts the calibration notice renders and, on a fresh VM with no
      accumulated statistics, states the not-yet-available reason rather than an
      error or an empty node.
- [ ] Tests use the `data-*` selectors documented in the `overview.js` header
      comment — not text matching or brittle structural paths.
- [ ] Verification: `cd tests/ui && npx playwright test --project=functional`
      exits 0 with the new tests reported as passing.
- [ ] Verification: the run is reported honestly — if `/dev/kvm` is unavailable
      the suite must be seen to **skip visibly**, and that must be stated rather
      than reported as a pass.

## Technical Requirements

- Directory: `tests/ui`, `--project=functional`.
- The suite boots a live OpenWrt VM in serve mode via the existing global setup;
  it needs QEMU and `/dev/kvm`.
- Follow the fixture and helper conventions already present in the functional
  project — do not introduce a second way of reaching the page.
- The VM's SQM fixture determines the expected seeded numbers; read it rather
  than hardcoding a rate that may drift.

## Input Dependencies

Task 5 — the seed control, the notice, and their documented selectors.

## Output Artifacts

Functional test coverage for both UI additions, and a screenshot of the
Essentials tab showing the seed control and the notice (useful evidence for the
plan's Self Validation).

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Test philosophy — "write a few tests, mostly integration".** Meaningful tests
verify custom business logic, critical paths, and edge cases specific to this
application. Test *your* code, not the framework or library.

*When TO write tests:* custom business logic and algorithms; critical user
workflows and data transformations; edge cases and error conditions for core
functionality; integration points between components; complex validation logic or
calculations.

*When NOT to write tests:* third-party library functionality; framework features;
simple CRUD operations without custom logic; trivial getters/setters or static
configuration; obvious functionality that would break immediately if incorrect.

*Rules:* combine related scenarios into a single test rather than one per
assertion; favour integration and critical-path coverage over per-method unit
tests; question whether simple functions need dedicated coverage.

Concretely here: do **not** re-test the seed arithmetic — task 2 already pins it
in a fast node suite. These tests exist to prove the wiring works in a browser:
that the click reaches the widgets, that validation stays clean, that the refusal
path is visible, and that the notice renders.

**Getting the expected values.** The VM's SQM fixture (see
`tests/integration/fixtures/`) carries the configured rates. Derive the expected
six numbers from it in the test (`base = R`, `max = R`, `min = Math.floor(R/4)`)
rather than pasting literals, so a fixture change does not silently invalidate
the assertion.

**Reporting honestly.** `docs/testing.md` records that VM-backed steps skip
*visibly* without `/dev/kvm`. If the environment cannot run the suite, say that
plainly in the task report — a skipped suite is not a passing suite, and claiming
otherwise would fail the plan's verification gate.

**Screenshots.** The visual project maintains committed baselines; adding new UI
may require refreshing them with
`npx playwright test --project=visual --update-snapshots`. Only do so if the
visual project actually fails because of this change, and say so explicitly if
baselines were regenerated.
</details>
