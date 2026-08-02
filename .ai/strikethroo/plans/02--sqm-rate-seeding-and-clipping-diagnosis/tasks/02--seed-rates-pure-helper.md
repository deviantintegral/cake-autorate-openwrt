---
id: 2
group: "sqm-rate-seeding"
dependencies: [1]
status: "completed"
created: 2026-08-02
skills:
  - javascript
  - unit-testing
complexity_score: 3
---
# Add the pure seedRates() helper and its unit tests

## Objective

Put the seed arithmetic — turning one SQM rate into a min/base/max trio — in a
pure, unit-tested function in `live.js`, so the LuCI view stays declarative and
the formula is verifiable off device.

## Skills Required

`javascript` for the LuCI `baseclass` module, `unit-testing` for the plain-node
test suite alongside it.

## Acceptance Criteria

- [ ] `live.js` exports `seedRates(sqm, egressIface)` returning
      `{ dl: {min, base, max} | null, ul: {min, base, max} | null }`.
- [ ] For a usable rate R the trio is `base = R`, `max = R`,
      `min = Math.floor(R / 4)` — matching the plan's agreed formula exactly.
- [ ] The two directions resolve **independently**: SQM may have `download` set
      and `upload` at `0`, and that must yield a usable `dl` and a `null` `ul`.
- [ ] Returns `null` for a direction whose rate is `0`, missing, negative or
      non-numeric; returns `{dl: null, ul: null}` when no interface matches
      `egressIface` or when the `sqm` object is empty/undefined.
- [ ] `dl` derives from SQM's `download_kbps` and `ul` from `upload_kbps` (the
      sqm-scripts direction mapping — do not transpose them).
- [ ] New cases in `luci/luci-app-cake-autorate/tests/live.test.js` cover: a
      normal rate, a `0` rate in one direction only, a missing interface, an
      empty `sqm` object, and the `Math.floor` rounding of an
      indivisible-by-four rate.
- [ ] Verification: `node luci/luci-app-cake-autorate/tests/live.test.js` exits 0
      and reports the new assertions among its passing count.
- [ ] Verification: `node luci/luci-app-cake-autorate/tests/options-coverage.test.js`
      still exits 0 (proving the module load stub was not broken).

## Technical Requirements

- File: `luci/luci-app-cake-autorate/htdocs/luci-static/resources/cake-autorate/live.js`.
- `live.js` is a LuCI class file returning `baseclass.extend({...})`; the test
  suite loads it with a stub `baseclass` whose `extend()` returns the plain
  object. Add the function to that same exported object so the existing loading
  trick keeps working.
- The input shape is the `sqm_interfaces` JSON from task 1: an object with an
  `interfaces` array whose entries carry `egress`, `download_kbps` and
  `upload_kbps`.
- Pure function only — no DOM, no `rpc`, no side effects.

## Input Dependencies

Task 1 — the `download_kbps` / `upload_kbps` fields on each interface object,
which define this function's input contract.

## Output Artifacts

- `live.seedRates()`, consumed by the LuCI seed action in task 5.
- Extended `tests/live.test.js`.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Placement.** `live.js` already holds `interfaceChoices()` and
`interfaceStatus()`, which do exactly this kind of pure decision work over the
same `sqm_interfaces` payload. Put `seedRates()` next to them and follow their
comment style — these functions are documented with *why*, not *what*.

**Suggested implementation:**

```js
/*
 * Derive a min/base/max trio per direction from SQM's configured rates.
 *
 * base = max = the SQM rate: that is the rate the user told SQM the line does,
 * so autorate may shape DOWN from it but never probes above a rate the user has
 * not validated. min is a deliberately conservative floor -- an over-optimistic
 * min is the one value that actively harms, since it is a hard floor the daemon
 * cannot shape below when the line degrades.
 *
 * The directions resolve independently: SQM commonly has one rate set and the
 * other left at 0 ("no limit"), which carries nothing to seed from.
 */
seedRates: function (sqm, egressIface) {
    var out = { dl: null, ul: null };
    var list = (sqm && Array.isArray(sqm.interfaces)) ? sqm.interfaces : [];
    var match = null;

    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].egress === egressIface) {
            match = list[i];
            break;
        }
    }
    if (!match)
        return out;

    out.dl = this.rateTrio(match.download_kbps);
    out.ul = this.rateTrio(match.upload_kbps);
    return out;
},

/* One direction: a usable positive integer rate -> its trio, else null. */
rateTrio: function (rate) {
    var r = Number(rate);
    if (!isFinite(r) || Math.floor(r) !== r || r <= 0)
        return null;
    return { min: Math.floor(r / 4), base: r, max: r };
}
```

Expose `rateTrio` too if the test suite finds it convenient to assert directly;
otherwise keep it internal and test through `seedRates`.

**Rounding.** `Math.floor(r / 4)` is specified deliberately — for R = 4999 the
min is 1249, not 1249.75. cake-autorate rates are integers and a decimal point
is a fatal type error upstream, so never emit a fractional value.

**Tests.** Follow the existing structure in `live.test.js` exactly — same
assertion helper, same describe/label style, same stub-`baseclass` load. Add a
case per bullet in the acceptance criteria. Include the rounding case with a rate
that is not divisible by four (e.g. 4999 → min 1249) so the floor behaviour is
pinned by a test rather than assumed.

**Scope.** Do not wire this into the view — that is task 5. Do not add an apply
or write path anywhere; the seed only ever fills form widgets the user then
saves themselves.
</details>
