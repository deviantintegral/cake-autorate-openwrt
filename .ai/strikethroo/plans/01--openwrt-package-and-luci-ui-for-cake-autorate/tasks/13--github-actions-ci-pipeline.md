---
id: 13
group: "ci"
dependencies: [2, 10, 11, 12]
status: "pending"
created: 2026-07-23
skills:
  - github-actions
  - yaml
complexity_score: 6
---
# GitHub Actions CI Pipeline

## Objective
Build the feed and run both test suites automatically on every change. A GitHub
Actions workflow runs on push and pull request with three jobs pinned to a specific
25.12.x point release: **Build** (25.12.x SDK, build the feed once, publish apk
artifacts), **Integration** (run the task-10 VM harness on a KVM-capable runner,
with an explicit "no KVM" signal — never a silent pass), and **UI** (run the
task-11 functional and task-12 visual suites headlessly, publishing both the diff
results and the browsable human-review gallery). Build artifacts feed the
downstream jobs.

## Skills Required
- `github-actions` — workflow/jobs/matrix, artifacts, runner selection, KVM handling.
- `yaml` — workflow authoring.

## Acceptance Criteria
- [ ] A `.github/workflows/*.yml` workflow triggers on push and pull request.
- [ ] **Build** job sets up the 25.12.x SDK, builds the feed once (no per-arch matrix — packages are `PKG_ARCH:=all`), and uploads the resulting `.apk` artifacts.
- [ ] **Integration** job consumes the built artifacts and runs the task-10 harness on a GitHub-hosted `ubuntu` runner exposing `/dev/kvm` (self-hosted KVM runner documented as fallback); when a runner cannot virtualize, it emits an explicit "integration skipped: no KVM" status — **never a silent pass** — while Build and UI stay green independently.
- [ ] **UI** job runs the task-11 functional suite and the task-12 visual comparison headlessly and publishes both the diff results and the human-review screenshot gallery as artifacts.
- [ ] Jobs are ordered so the Build artifacts feed Integration and UI; each publishes machine-checkable pass/fail plus evidence.
- [ ] Verification: `actionlint .github/workflows/*.yml` reports no errors; the workflow defines the three jobs with the build→(integration, ui) artifact wiring and the KVM-detection/skip step present.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Pin a specific 25.12.x point release across jobs.
- The repo has **no git remote yet** — publishing the feed to GitHub is a documented prerequisite (task 14), not part of this code deliverable; the workflow is authored to run once the remote exists.
- KVM detection must produce a distinct, visible status rather than passing silently.

## Input Dependencies
- Task 2: the buildable feed (SDK build target).
- Task 10: the VM integration harness (Integration job).
- Tasks 11 & 12: the Playwright functional + visual suites and gallery (UI job).

## Output Artifacts
- `.github/workflows/` CI workflow — referenced by task 14 (testing doc) and satisfying the plan's CI success criterion.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Author one workflow with three jobs. `build` sets up the 25.12.x SDK, runs the feed build, and `actions/upload-artifact`s the `.apk` files.
2. `integration` `needs: build`, downloads the artifacts, checks for `/dev/kvm`; if absent, print/`echo` an explicit "integration skipped: no KVM" and mark the job with that status (do not silently succeed). If present, run `tests/integration/run.sh` and upload its evidence (logs, `tc` output, screenshots).
3. `ui` `needs: build`, installs Node/Playwright, runs `tests/functional` and `tests/visual`, and uploads the diff results plus the human-review gallery artifact.
4. Keep `build` and `ui` green independently of `integration` so a non-KVM runner still yields signal.
5. Validate locally with `actionlint`. Settle caching (SDK/toolchain, Playwright browsers) and runner selection here.

The GitHub-hosting prerequisite (create/push the remote) is documented in task 14, not implemented here.
</details>
