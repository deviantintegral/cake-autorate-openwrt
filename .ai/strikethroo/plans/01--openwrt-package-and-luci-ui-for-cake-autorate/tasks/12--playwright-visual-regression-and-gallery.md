---
id: 12
group: "testing"
dependencies: [7, 9]
status: "pending"
created: 2026-07-23
skills:
  - playwright
  - javascript
complexity_score: 6
---
# Playwright Visual-Regression and Human-Review Gallery

## Objective
Add the screenshot side of the Playwright suite, serving two distinct purposes:
(1) **visual-regression diffs** — full-page screenshots of every LuCI page/tab and
key state compared against committed baselines with dynamic regions masked; and
(2) a **published human-review gallery** — a browsable set of labelled full-page
screenshots so a maintainer can evaluate the real UI from CI artifacts without a
device.

## Skills Required
- `playwright` — `toHaveScreenshot()`, masking, snapshot baselines, artifact generation.
- `javascript` — test/gallery authoring.

## Acceptance Criteria
- [ ] Full-page screenshots are captured for each LuCI page/tab and key state: empty config, populated single instance, multi-instance, status view, and post-Save-&-Apply.
- [ ] A visual-regression comparison runs against committed in-repo baselines using a pinned browser engine and viewport, with **inherently dynamic regions masked** (live status rates/deltas/uptime, timestamps) so only structural/visual change registers.
- [ ] A browsable **human-review gallery** of labelled full-page screenshots of every page/state is produced as a CI artifact.
- [ ] A documented command refreshes the baselines.
- [ ] Verification: `npx playwright test tests/visual` runs the comparison against baselines (masking applied) and reports any diffs; a gallery `index.html` (or equivalent) is produced listing every expected page/state, each image present and legible.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Reuse the `playwright.config` / login fixture from task 11 (same engine + viewport pin).
- Mask dynamic DOM regions (the status view cells marked in task 9) so diffs are meaningful, not flaky.
- Baselines committed in-repo; document the update command.

## Input Dependencies
- Task 7: config form pages/tabs/states to capture.
- Task 9: status view (its dynamic regions are the masked areas).

## Output Artifacts
- `tests/visual/` specs, committed baselines, and a gallery generator — consumed by task 13 (CI UI job publishes diffs + gallery) and documented in task 14.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Reuse task 11's Playwright project; add a `tests/visual` spec that navigates to each page/state and calls `expect(page).toHaveScreenshot({ fullPage: true, mask: [ ...dynamic locators... ] })`.
2. Enumerate the states: empty config, single instance populated, multi-instance, status view, post-Save-&-Apply. Name each snapshot clearly.
3. Mask the live status regions (use the stable markers coordinated in task 9) and any timestamps; pin engine + viewport in config.
4. Generate the human-review gallery: after capture, emit an `index.html` embedding/linking every labelled full-page screenshot so a maintainer can browse all pages/states. This gallery is **always published** regardless of whether the diff gates the build.
5. Document `npx playwright test --update-snapshots` (or the chosen wrapper) as the baseline-refresh command in the testing doc (task 14).

Whether the diff gates the build is a design choice; the gallery must always publish. Keep baselines in-repo.
</details>
