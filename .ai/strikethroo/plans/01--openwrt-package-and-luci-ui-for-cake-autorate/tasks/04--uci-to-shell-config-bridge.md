---
id: 4
group: "config"
dependencies: [1, 3]
status: "pending"
created: 2026-07-23
skills:
  - shell
complexity_score: 6
---
# UCI-to-Shell Config Bridge

## Objective
Author the deterministic, idempotent bridge that generates upstream's per-instance
shell config (`config.<instance>.sh` or equivalent) from each UCI section at
service start/reload. The bridge always pins the parser-critical logging/output
options so the status view and statistics feed are guaranteed populated regardless
of user verbosity, and normalizes reflectors (IPv4/IPv6) and rate units. It also
enforces the plan's core invariant: every UCI option maps to a generated config
key and every consumed config key traces back to a UCI option.

## Skills Required
- `shell` — POSIX/ash-safe scripting, UCI access (`config_load`/`config_foreach` or `uci -q get`), text generation.

## Acceptance Criteria
- [ ] Running the bridge against a UCI config produces one upstream config file per enabled instance at a known, per-instance-namespaced path.
- [ ] The parser-critical logging/output options (flagged in task 1) are **always pinned** to known-good values (required DATA/SUMMARY fields, stable format, known per-instance log path) — user settings cannot disable them.
- [ ] Reflector lists are validated/normalized for IPv4 and IPv6; rate units normalized to what upstream expects.
- [ ] The bridge is idempotent: running it twice with unchanged UCI yields byte-identical output.
- [ ] A bidirectional coverage assertion passes: every UCI option maps to a generated config key and every generated key maps back to a UCI option (no silent drops, no extraneous keys).
- [ ] Verification: run the bridge on a two-instance fixture → two config files at the expected distinct paths; run the coverage assertion → exit 0 with "all options mapped"; run the bridge twice → `diff` of outputs is empty.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Read UCI via the standard `/lib/functions.sh` helpers; emit upstream's exact config variable names/format at the pinned tag.
- Per-instance log/status paths must be namespaced by instance name to prevent multi-instance collisions (the exact defect audited in Darkmoon).

## Input Dependencies
- Task 1: the inventory (option names + which output options are package-managed).
- Task 3: the UCI schema (the keys the bridge reads).

## Output Artifacts
- The bridge script (installed by task 2's package) — invoked by task 5 (init) and depended on by task 6 (stats parser) and task 8 (status parser), which consume the pinned output format.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Iterate enabled UCI sections. For each, translate every UCI option to its upstream config variable and write `config.<instance>.sh` at upstream's expected location (or the location the daemon is told to read).
2. Force the logging/output options identified in task 1: enable the periodic DATA/SUMMARY output, pin the output format/fields the parser needs, and set a per-instance log path like `/var/log/cake-autorate.<instance>.log`. Do this **after** copying user options so users cannot override them.
3. Normalize reflectors: accept IPv4 and IPv6 addresses/hosts; drop/flag invalid entries; preserve upstream's expected list format.
4. Make output deterministic (stable ordering, no timestamps) so idempotency holds and diffs are meaningful.
5. Implement the coverage assertion by reusing task 3's key extraction: set of UCI keys must equal set of emitted config keys (modulo the package-pinned output keys, which are asserted present separately). Fail loudly on any mismatch.

This bridge is where UCI↔shell drift risk is neutralized — keep the mapping table explicit and tested.
</details>
