---
id: 5
group: "luci-ui"
dependencies: [2, 4]
status: "completed"
created: 2026-08-02
skills:
  - luci-javascript
complexity_score: 6
complexity_notes: "Two UI additions merged into one task on purpose: both edit the Essentials tab in overview.js, so separate tasks would put two agents in the same file concurrently."
---
# Add the "Seed rates from SQM" action and the clipping notice to the Essentials tab

## Objective

Surface both halves of the feature in the configuration form: a button that fills
the six shaper-rate fields from SQM's configured rates, and a display-only notice
reporting when the shaper has been clipped against a configured bound.

## Skills Required

`luci-javascript` — LuCI's `form`, `ui` and `rpc` client-side APIs.

## Acceptance Criteria

- [ ] Each instance section's Essentials tab gains a **"Seed rates from SQM"**
      control that fills all six shaper-rate widgets using `live.seedRates()`.
- [ ] The seed writes into the **form widgets only**. It must not call any rpcd
      write method; the user reviews the values and uses the form's existing
      Save.
- [ ] The control is disabled with a visible, specific reason when no SQM section
      matches the section's `ul_if`, or when the matching rate is `0`.
- [ ] When only one direction has a usable SQM rate, that direction's three
      fields are filled and the other three are left untouched.
- [ ] Seeded values pass the existing `min <= base <= max` validation without
      producing an error (the formula guarantees this; confirm it in the UI).
- [ ] A display-only notice renders per section reporting the `calibration`
      verdict, naming the field to change and the evidence (sample count and
      window). It contains **no** control that writes a value.
- [ ] When `calibration` returns `available:false`, the notice states the reason
      plainly (e.g. statistics not yet accumulated) rather than rendering an
      error or nothing.
- [ ] The page still renders normally when the `calibration` rpc call fails
      outright, matching the existing fallback behaviour for `sqm_interfaces`.
- [ ] Both additions carry stable selectors for the Playwright suite, following
      the existing `data-*` conventions documented in the `overview.js` header
      comment, and that header comment's selector list is updated.
- [ ] Verification: `node luci/luci-app-cake-autorate/tests/options-coverage.test.js`
      exits 0 — the form must still render exactly the 66 supported options.
- [ ] Verification: `node luci/luci-app-cake-autorate/tests/live.test.js` exits 0.

## Technical Requirements

- File: `luci/luci-app-cake-autorate/htdocs/luci-static/resources/view/cake-autorate/overview.js`.
- Declare the new method with `rpc.declare({ object: 'cake-autorate', method:
  'calibration', … })`, alongside the existing `callSqmInterfaces`.
- Follow the existing post-render seeding pattern: `updateIfWarning()` is already
  called for every section after `m.render()` resolves, because `onchange` only
  fires on edit. The calibration notice should be injected the same way.
- Use `live.seedRates()` from task 2; do not re-implement the arithmetic in the
  view.
- The verdict data is slow-moving (days). Fetch it once at render — do **not**
  add a poll.

## Input Dependencies

- Task 2 — `live.seedRates()`.
- Task 4 — the `calibration` rpcd method and its JSON contract, plus the ACL read
  entry that permits the call.

## Output Artifacts

- The seed control and the clipping notice in the configuration form, with stable
  selectors for task 6.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Read the header comment in `overview.js` first.** It documents the selectors
the Playwright suites depend on and the reasoning behind existing choices. Add
the new selectors to that list as part of this task — the comment is the contract
with task 6.

**Seeding widget values.** Get each option's UI element for the section and set
its value, then trigger validation so the ordering check re-runs:

```js
var found = this.map.lookupOption(name, section_id);
if (found && found[0]) {
    var el = found[0].getUIElement(section_id);
    if (el) el.setValue(String(value));
    found[0].triggerValidation(section_id);
}
```

Resolve the section's egress interface from the current `ul_if` widget value (not
the saved UCI value) so seeding works immediately after the user picks an
interface, before saving.

**Placement of the button.** A `form.Button` taboption on `essentials` is the
straightforward route and keeps everything inside the CBI section, so it is
naturally per-section. Set `onclick` to the seed handler. Use
`ui.addNotification` or an inline message for the refusal reason, consistent with
how the rest of the app reports non-blocking conditions.

**The notice.** Mirror `updateIfWarning()`: build or update a `div` with a stable
class and `data-*` attributes, appended into the section, with the level encoded
as an attribute so tests and CSS can key on it. Reuse the existing
`alert-message`/`warning` classes already used by `warnClass()` rather than
inventing new styling.

Write the message so it states evidence, not just a conclusion — the point of the
feature is that the user can judge it. For example: name the direction, the
fraction of the observed window spent at the bound, the sample count, and the
specific UCI field to raise or lower.

**Fetching calibration for every section.** `render()` currently awaits
`callSqmInterfaces()` and falls back to `{}` on failure. Extend that: resolve the
configured instance names and request calibration for each, tolerating individual
failures. Keep the existing `sqm_interfaces` fallback behaviour exactly as it is —
a broken calibration call must never stop the configuration form from rendering.

**Explicitly do not**: add an apply/fix button for the calibration verdict (the
plan's clarification excluded it); add a polling refresh; or change any of the 66
generated option fields.
</details>
