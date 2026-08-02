---
id: 3
group: "clipping-diagnosis"
dependencies: []
status: "completed"
created: 2026-08-02
skills:
  - posix-shell
  - shell-testing
complexity_score: 5
complexity_notes: "Output-format uncertainty against RRDtool 1.0.x is the main risk in the whole plan; split out from the calibration method (task 4) so it carries its own fixture-based tests."
---
# Parse `rrdtool fetch` output into a stream of valid samples

## Objective

Build the small, self-contained shell helper that turns `rrdtool fetch` output
into a plain list of numeric samples, with its own fixture-based tests. This is
isolated from the verdict logic because RRDtool on OpenWrt is **1.0.x**, whose
output formatting is the least certain part of this plan.

## Skills Required

`posix-shell` (BusyBox ash + awk) for the parser, `shell-testing` for the
fixture-driven suite.

## Acceptance Criteria

- [ ] A helper in `net/cake-autorate/files/cake-autorate.rpcd` accepts
      `rrdtool fetch` output on stdin and emits one numeric value per line,
      skipping the header row and every `nan`/`NaN`/`-nan`/`UNKN` sample.
- [ ] Scientific notation as RRDtool emits it (e.g. `1.2345678900e+04`) is
      converted to a plain number usable in later arithmetic.
- [ ] Rows with a timestamp but no value, blank lines and trailing whitespace are
      tolerated without emitting garbage.
- [ ] The helper reports how many valid samples it produced, so callers can
      refuse to draw a conclusion from too few.
- [ ] The invocation used is `rrdtool fetch <file> AVERAGE …` — **never**
      `rrdtool xport`, which does not exist in RRDtool 1.0.x.
- [ ] Fixture files capturing representative `rrdtool fetch` output (a normal
      run, an all-`nan` run, and an empty/near-empty run) live under the rpcd
      test fixtures directory.
- [ ] Verification: `tests/rpcd/test-rpcd.sh` exits 0, with new cases asserting
      the parsed sample count and values for each fixture.
- [ ] Verification: piping the all-`nan` fixture through the helper produces
      **zero** output lines and a reported count of 0.

## Technical Requirements

- File: `net/cake-autorate/files/cake-autorate.rpcd` (helper function), plus
  fixtures under the existing `tests/` fixture layout.
- BusyBox awk only — no GNU awk extensions.
- The backend runs under `set -u`.
- RRDtool 1.0.x `fetch` prints a header line of DS names, then rows of
  `<timestamp>: <value> [<value>…]`. Value formatting and the exact NaN spelling
  vary; parse defensively rather than matching one exact shape.

## Input Dependencies

None — this task is independent and can run in parallel with task 1.

## Output Artifacts

- A tested sample-extraction helper consumed by task 4 (the calibration method).
- `rrdtool fetch` output fixtures reusable by task 4's tests.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Why this is separate.** RRDtool 1.0.x is ancient (the OpenWrt feed carries only
`rrdtool1`, which `luci-app-statistics` depends on). Its `fetch` output is the
single format assumption the clipping diagnosis rests on, so it gets its own
helper and its own fixtures — if the real on-device format differs, only this
function and its fixtures need to change.

**Representative input to parse** (capture real output on device where possible;
otherwise this shape):

```
                           value

1754006400: 1.2345678900e+04
1754006430: 1.2000000000e+04
1754006460: nan
1754006490: -nan
1754006520: 1.1980000000e+04
```

**Suggested helper:**

```sh
# rrd_samples  --  stdin: `rrdtool fetch` output; stdout: one plain number per
# valid sample. The header line has no colon, so keying on a ":"-terminated
# first field skips it without needing to know the DS name.
rrd_samples() {
    awk '
        /^[[:space:]]*$/ { next }
        $1 !~ /:$/       { next }          # header / prose lines
        {
            v = $2
            if (v == "" ) next
            lv = tolower(v)
            if (lv ~ /nan/ || lv == "unkn" || lv == "u") next
            # force numeric conversion; handles 1.23e+04 and plain decimals
            printf "%.6f\n", v + 0
        }
    '
}
```

`v + 0` in awk performs the scientific-notation conversion, and `%.6f` prints a
plain decimal. If a caller wants integers (Kbit/s), round at the call site rather
than here — keep this helper lossless.

Provide the count either by having callers `wc -l` the output, or with a
companion that returns both. Prefer the simplest thing that satisfies the
criteria; do not build a general-purpose statistics library.

**Fixtures.** Put them where `tests/rpcd/test-rpcd.sh` already keeps fixture
data, following that file's existing conventions. Three files:

1. `fetch-normal` — a mix of valid values and a couple of `nan` rows.
2. `fetch-all-nan` — header plus only `nan` rows.
3. `fetch-empty` — header only (or completely empty).

**Tests.** Extend `tests/rpcd/test-rpcd.sh` in its existing style. Assert the
exact emitted values for the normal fixture (not just the count), so a
mis-parsed exponent is caught rather than passing as "some number".

**Explicitly do not**: call `rrdtool xport`; add a dependency on `rrdtool` to
either Makefile (it arrives via `luci-app-statistics`); or attempt to read the
load-condition gauge — the verdict deliberately uses only the shaper rate.
</details>
