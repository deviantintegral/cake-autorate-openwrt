---
id: 14
group: "docs"
dependencies: [4, 6, 9, 10, 13]
status: "completed"
created: 2026-07-23
skills:
  - technical-writing
complexity_score: 4
---
# Documentation (README, Config Reference, Testing Doc, AGENTS.md)

## Objective
Produce the fixed documentation set (clarification #10): a feed README, a
user-facing configuration reference, a testing doc, and a repo-level `AGENTS.md`.
No standalone upstream-submission-notes document is produced — that guidance folds
into the README and AGENTS.md. The docs must encode the two cross-cutting facts so
future work does not reintroduce the audited failure modes: the UCI↔config bridge
bidirectional invariant, and that the daemon's only runtime interface is its log
stream.

## Skills Required
- `technical-writing` — clear, accurate developer/user documentation.

## Acceptance Criteria
- [ ] **README** (feed): what the packages are; how to build with the 25.12.x SDK; how to install via `apk`; the `sqm-scripts` dependency; the relationship to upstream cake-autorate; how a manual `/root/cake-autorate/` install should be handled (coexist, no auto-migration); a brief upstream-submission-readiness note; and the GitHub-hosting prerequisite (no remote yet — publishing to GitHub enables the CI workflow).
- [ ] **User configuration reference**: the Essentials-first path (interface + rates) vs. the grouped advanced options; how interfaces are validated against SQM; multi-instance setup; a note that the logging/output feeding stats is package-managed; and how to read the statistics graphs.
- [ ] **Testing doc**: how to run the VM integration suite (including the induced-load step) and the Playwright suites locally and in CI; the pinned 25.12.x target and apk-based install commands; how to view the published screenshot gallery; and how to review/update the visual-regression baselines.
- [ ] **AGENTS.md**: feed layout; the UCI→config bridge invariant (every option maps both ways); the log-stream-is-the-only-runtime-interface fact; the `sqm-scripts` dependency; and how to run the two suites and the CI pipeline.
- [ ] Verification: the four files exist and `grep` confirms each required topic heading is present (e.g. README contains "apk", "sqm-scripts", "/root/cake-autorate"; AGENTS.md contains "log stream" and "bridge"; testing doc contains "netem" and "baseline"; config reference contains "Essentials" and "Statistics").

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Content must match the shipped behavior of the packages/tests/CI, not the plan's aspirations — write after the referenced tasks are implemented.

## Input Dependencies
- Task 4: the bridge invariant + package-managed output (README/config-ref/AGENTS.md).
- Task 6: statistics behavior (config reference).
- Task 9: the LuCI UI (config reference).
- Task 10: the VM test + induced-load step (testing doc).
- Task 13: the CI pipeline + gallery/baseline flow (testing doc, README prerequisite).

## Output Artifacts
- `README.md`, a user configuration reference, a testing doc, and `AGENTS.md` at the repo/feed root.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Write the README first — it is the entry point; cover build (SDK), install (apk), deps, upstream relationship, manual-install coexistence, submission note, and the GitHub-hosting prerequisite for CI.
2. Config reference: lead with Essentials, then the grouped advanced sections; explain SQM interface validation, multi-instance, package-managed output, and reading the Statistics graphs.
3. Testing doc: exact local + CI commands, the 25.12.x pin, apk install, `netem` induced-load, viewing the gallery, and the baseline-update command from task 12.
4. AGENTS.md: short and durable — feed layout, the bidirectional bridge invariant, log-stream-only runtime interface, sqm dependency, and how to run the suites/CI.

Keep the two cross-cutting invariants explicit in AGENTS.md so future automated work does not reintroduce the audited defects.
</details>
