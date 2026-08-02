---
id: 4
group: "clipping-diagnosis"
dependencies: [3]
status: "pending"
created: 2026-08-02
skills:
  - posix-shell
  - shell-testing
complexity_score: 6
complexity_notes: "Cohesive single-file addition (method + verdict + degradation + ACL) kept whole on purpose: the riskiest sub-part, the rrdtool output parse, was already split out as task 3, and splitting the remainder would put two agents in one shell file behind an artificial seam."
---
# Add the read-only `calibration` rpcd method

## Objective

Add a read-only rpcd method that reads an instance's shaper-rate RRDs, compares
them against the instance's configured `min`/`max`, and reports whether the
shaper has been clipped against either bound — the evidence that a configured
bound, not the line, is the limit.

## Skills Required

`posix-shell` for the rpcd backend, `shell-testing` for the suite.

## Acceptance Criteria

- [ ] A `calibration` method taking `{"instance":"<id>"}` is registered in
      `cmd_list` and dispatched in `cmd_call`, validated with the existing
      `valid_instance()` guard.
- [ ] It resolves the RRD files as
      `<DataDir>/<host>/cake_autorate-<instance>/bitrate-{dl,ul}_shaper.rrd`,
      taking `DataDir` from the `luci_statistics` UCI config and defaulting to
      `/tmp/rrd`.
- [ ] It reads the instance's configured `min_dl/max_dl/min_ul/max_ul` shaper
      rates from the `cake-autorate` UCI config.
- [ ] Per direction it returns the verdict plus the evidence behind it: the
      number of valid samples, the fraction of samples at the configured `max`
      (within tolerance), the fraction at the configured `min`, and the verdict
      (`pinned-max`, `floored-min`, or `ok`).
- [ ] The verdict is suppressed — reported as insufficient data, not `ok` — when
      the valid sample count is below a stated minimum.
- [ ] Degrades to `{"available":false,"reason":"…"}` (mirroring `do_status`'s
      existing style) when `rrdtool` is absent, the RRD file is missing, or no
      valid samples exist. It must never exit non-zero for these normal states.
- [ ] Filesystem paths and the `rrdtool` binary are overridable by
      `CAKE_AUTORATE_*` environment variables, following the existing
      `CAKE_AUTORATE_SQM_CONFIG` / `CAKE_AUTORATE_NET_DIR` convention.
- [ ] `luci-app-cake-autorate.json` ACL lists `calibration` under **`read`**
      `ubus` only. It must NOT appear under `write`.
- [ ] Verification: `tests/rpcd/test-rpcd.sh` exits 0, with cases for a
      pinned-at-max fixture, a floored-at-min fixture, a healthy fixture, a
      missing-RRD case, a missing-`rrdtool` case and a too-few-samples case.
- [ ] Verification: `jsonfilter -e '@.dl.verdict'` against the pinned fixture's
      output prints `pinned-max`.
- [ ] Verification: `grep -c '"calibration"' luci/luci-app-cake-autorate/root/usr/share/rpcd/acl.d/luci-app-cake-autorate.json`
      returns 1, and the string does not appear inside the `write` block.

## Technical Requirements

- Files: `net/cake-autorate/files/cake-autorate.rpcd`,
  `luci/luci-app-cake-autorate/root/usr/share/rpcd/acl.d/luci-app-cake-autorate.json`,
  `tests/rpcd/test-rpcd.sh`.
- collectd's on-disk layout is
  `<DataDir>/<host>/<plugin>-<plugin_instance>/<type>-<type_instance>.rrd`. The
  exec reader sets the plugin instance to the cake-autorate instance id and emits
  type instances `bitrate-dl_shaper` / `bitrate-ul_shaper`.
- Reads the shaper rate **only**. Do not read the load-condition gauge: it is
  categorical (0/1/2/10/11/12) and collectd's AVERAGE-only RRAs make its mean
  meaningless.
- Uses the sample parser from task 3; does not re-implement it.
- Runs under `set -u`; keep the existing `set +u` wrapping around any
  `config_load`/`config_foreach` block.

## Input Dependencies

Task 3 — the `rrdtool fetch` sample parser and its fixtures.

## Output Artifacts

- The `calibration` rpcd method and its JSON contract, consumed by the LuCI
  notice in task 5.
- ACL read entry.
- Test coverage for every verdict and degradation path.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Follow `do_status` as the model.** It already demonstrates the house style for
this exact shape of method: validate the instance, look for a data source, and
degrade to `{"available":false,"reason":…}` when the data is not there yet
(`no-log` / `no-data`). Use the same vocabulary and the same non-error
degradation, because "statistics have not accumulated yet" is the normal state on
a fresh install, not a fault.

**Resolving `DataDir`.** luci-app-statistics stores it in the `luci_statistics`
UCI config (the rrdtool plugin section). Read it with the standard UCI helpers
and default to `/tmp/rrd` when unset. The `<host>` path component is collectd's
hostname — derive it the same way the collectd reader does
(`COLLECTD_HOSTNAME`, falling back to the system hostname); if exactly one
directory exists under `DataDir`, using it is an acceptable fallback.

**Clipping test.** For each direction:

```
samples  = rrd_samples < (rrdtool fetch <file> AVERAGE -s -<window>)
n        = count(samples)
if n < MIN_SAMPLES: verdict = insufficient-data
pinned   = count(|s - max_configured| <= tol) / n
floored  = count(|s - min_configured| <= tol) / n
verdict  = pinned  >= THRESH ? "pinned-max"
         : floored >= THRESH ? "floored-min"
         : "ok"
```

Pick a tolerance and threshold that are defensible and **state them in a comment
and in the returned JSON** so the UI can explain itself — e.g. a tolerance of a
small percentage of the configured bound (the shaper rate is a computed value and
will not land exactly on the bound), and a threshold like "most of the observed
window". Do not invent configuration options for these; hardcode them with a
comment giving the rationale (the PRE_PLAN hook forbids adding config not asked
for).

**Why no bufferbloat condition.** The original work order said "floored at min
*during bufferbloat*". Conditioning on the load gauge is unsound here — see the
plan's Background. A shaper sitting at `min` is already sufficient evidence that
the controller wanted to go lower and could not. Add a comment saying so, so a
future reader does not "fix" it by adding the load gauge back.

**JSON shape** (keep it flat and self-describing):

```json
{
  "available": true,
  "window_s": 604800,
  "dl": { "samples": 812, "pinned_max_fraction": 0.93,
          "floored_min_fraction": 0.0, "verdict": "pinned-max",
          "configured_min": 5000, "configured_max": 80000 },
  "ul": { ... }
}
```

**Environment overrides.** Add ones analogous to the existing pair, e.g. a
variable for the RRD base directory and one for the `rrdtool` binary path, so the
test suite can point at fixtures and a stub script. Document them in the file
header comment alongside the existing overrides.

**Tests.** Extend `tests/rpcd/test-rpcd.sh` in its existing style. Create a stub
`rrdtool` executable in the fixture area that `cat`s a chosen fixture, and point
the override at it. Cover every acceptance-criteria case, and assert on parsed
JSON via `jsonfilter` rather than substring matching, so a malformed document
fails loudly.

**Explicitly do not**: add any write capability or apply action; add a UCI key to
a `cake-autorate` section (fatal — the bridge's unknown-key guard skips the
section); modify the collectd reader or the `SUMMARY` contract; or add a
dependency to either Makefile.
</details>
