---
id: 10
group: "testing"
dependencies: [5, 6]
status: "completed"
created: 2026-07-23
skills:
  - shell
  - openwrt-testing
complexity_score: 7
complexity_notes: "Full unattended install→configure→induce-load→assert→remove harness on a real 25.12.x VM; the induced-load step is essential or the shaping assertion can never fire."
---
# VM Integration Test Harness

## Objective
Prove, unattended, that the package installs, configures, runs, shapes, and reports
on a real OpenWrt 25.12.x system. The harness boots a 25.12.x VM, installs the
built packages via **apk** plus `sqm-scripts`, enables SQM, applies a known
multi-instance UCI config, starts the service, **induces controlled WAN
conditions** (e.g. `netem` delay/loss) so the control loop actually moves the CAKE
bandwidth, and asserts observable outcomes with captured evidence.

## Skills Required
- `shell` — VM orchestration glue, apk install, UCI apply, `tc`/`netem`, assertions.
- `openwrt-testing` — booting/driving an OpenWrt image, procd/service inspection.

## Acceptance Criteria
- [ ] The harness boots an OpenWrt **25.12.x** VM and installs the built packages via `apk` plus `sqm-scripts` and dependencies.
- [ ] It enables SQM on a WAN and applies a **two-instance** UCI config, then starts the service.
- [ ] It **induces controlled WAN load** (e.g. `tc qdisc ... netem delay/loss` on the test link, or a controllable reflector) so the daemon leaves base rate.
- [ ] It asserts: one daemon per enabled instance under procd; the CAKE qdisc bandwidth **moves** in response (assert direction/occurrence over a window, not exact values); each instance writes its own runtime status at a distinct path; collectd receives the autorate metrics; clean stop/removal leaves the system tidy.
- [ ] It is scripted for CI, pinned to 25.12.x, and produces machine-checkable pass/fail plus captured evidence (logs, `tc` output, screenshots).
- [ ] Verification: `./tests/integration/run.sh` exits 0 and prints `PASS`, writing `tc`-before/after output and collectd evidence to an artifacts directory; a deliberately misconfigured run exits non-zero.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Use the available VM-spawning capability; pin the SDK/image to a specific 25.12.x point release.
- Shaping assertion must tolerate timing: compare CAKE bandwidth across a window and assert change occurred in the expected direction, with generous thresholds and settle time.

## Input Dependencies
- Task 5: the running procd service (multi-instance).
- Task 6: the collectd statistics integration (metrics assertion).
- (Transitively task 2's built apk artifacts, installed here.)

## Output Artifacts
- `tests/integration/` harness (scripts + fixtures) producing pass/fail + evidence — consumed by task 13 (CI Integration job) and referenced by task 14 (testing doc).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Provision a 25.12.x VM image; copy in the built `.apk` artifacts and `apk add` them plus `sqm-scripts` and deps.
2. Configure SQM on the WAN so a CAKE qdisc (and its `ifb4*`) exists; apply a two-instance `cake-autorate` UCI config; `service cake-autorate start`.
3. Induce load: attach `netem` delay/loss to the test link (or drive a controllable reflector) so measured latency rises and the control loop reduces CAKE bandwidth. Without this the daemon sits at base rate and the shaping assertion can never fire.
4. Assertions: `ubus call service list` shows two instances; capture `tc qdisc show` for the CAKE qdisc at t0 and over a window, assert the bandwidth changed in the expected direction; check two distinct per-instance status/log paths exist; confirm collectd RRDs for autorate metrics grow; `service stop` + `apk del` leaves no stray processes/files.
5. Emit a single machine-checkable PASS/FAIL and save all evidence to an artifacts dir for CI upload.

Keep the shaping check about *direction/occurrence over a window*, never an exact rate — that is the documented anti-flake mitigation.
</details>
