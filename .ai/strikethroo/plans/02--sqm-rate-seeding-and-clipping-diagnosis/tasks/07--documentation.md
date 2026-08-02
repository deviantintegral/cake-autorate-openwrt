---
id: 7
group: "documentation"
dependencies: [1, 4, 5]
status: "completed"
created: 2026-08-02
skills:
  - technical-writing
complexity_score: 3
---
# Document the seed action, the calibration method and the clipping notice

## Objective

Update the three documents that describe this feed's behaviour so they match what
now ships, including the rules the seed formula follows and what the clipping
verdict does and does not claim.

## Skills Required

`technical-writing` against an established house style.

## Acceptance Criteria

- [ ] `docs/configuration.md` documents the "Seed rates from SQM" action: the
      formula (`base = SQM`, `max = SQM`, `min = floor(SQM / 4)`), the direction
      mapping (SQM `download` → `dl_*`, `upload` → `ul_*`), and the two cases
      where it refuses.
- [ ] `docs/configuration.md` documents the clipping notice: what it reads, the
      window and sample count it reports, and that it is advisory — the user
      changes the value.
- [ ] `docs/calibration-investigation.md`'s status line no longer says
      "investigation only": Stage 1 and Stage 2a are implemented; Stage 2b, the
      threshold tuning and the active test remain unbuilt.
- [ ] `AGENTS.md`'s rpcd bullet lists `calibration` alongside `sqm_interfaces`,
      `status` and `service`, and states it is read-only.
- [ ] The documented behaviour is verified against the implementation, not the
      task descriptions — in particular the tolerance and threshold constants
      chosen in task 4 must be described as implemented.
- [ ] No claim is made that the verdict detects bufferbloat events; the docs must
      state that the diagnosis reads the shaper rate only, and briefly why.
- [ ] Verification: `grep -n 'calibration' AGENTS.md docs/configuration.md docs/calibration-investigation.md`
      shows the new content in all three files.
- [ ] Verification: every command or path quoted in the new prose is checked to
      exist (e.g. the rpcd method name matches `cmd_list`, the ACL entry matches
      the JSON).

## Technical Requirements

- Files: `docs/configuration.md`, `docs/calibration-investigation.md`,
  `AGENTS.md`.
- Match the existing voice: these documents explain *why* a thing is the way it
  is, not just what it does. `AGENTS.md` explicitly asks to be kept short.
- Do not restate the whole investigation in `configuration.md`; link to
  `docs/calibration-investigation.md` for the reasoning.

## Input Dependencies

- Task 1 — the extended `sqm_interfaces` contract.
- Task 4 — the `calibration` method, its JSON shape, and the tolerance/threshold
  constants actually chosen.
- Task 5 — the final UI wording and placement.

## Output Artifacts

Updated user-facing and agent-facing documentation.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**Read the implementation before writing.** The acceptance criteria require the
documented constants to match the code. Open `cake-autorate.rpcd` and read the
tolerance and threshold the calibration method actually uses, and the UI wording
in `overview.js`, rather than describing what the task files proposed.

**`docs/configuration.md`** already has an Essentials section that explains the
six rates and the `min <= base <= max` rule (see the "Set **base** to your
provisioned rate…" passage). Add the seed action there, adjacent to that
explanation, since it is the same subject. Then add the clipping notice, framed
as *the package telling you a bound is wrong* rather than as a measurement.

Be precise about the seed's deliberate conservatism: `max = SQM` means autorate
will not probe above a rate the user has not validated, and the clipping notice
is the mechanism that later tells them it is time to raise it. That pairing is
the design; say so in a sentence.

**`docs/calibration-investigation.md`** currently opens with
"**Status: investigation only. Nothing here is implemented or committed to.**"
Replace that with an accurate status, and mark the staged recommendations in §5
that have now been built. Leave the analysis itself intact — it is the record of
why the speed test was not built, and that reasoning is still current.

**`AGENTS.md`** — the "Other durable facts" section has a bullet beginning
"**rpcd object `cake-autorate`** exposes …". Extend that one bullet. Keep it to
a clause or two; the file explicitly asks to stay short. Worth recording there:
the calibration path is read-only and stateless, which is *why* it needed no UCI
key and therefore did not disturb Invariant 1.

**Do not** document Stage 2b, threshold auto-tuning or a speed test as if they
exist, and do not add a new top-level document — three files change, no more.
</details>
