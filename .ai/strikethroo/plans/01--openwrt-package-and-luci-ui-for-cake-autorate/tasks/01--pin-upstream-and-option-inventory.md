---
id: 1
group: "foundation"
dependencies: []
status: "completed"
created: 2026-07-23
skills:
  - openwrt-packaging
  - shell
complexity_score: 5
---
# Pin Upstream Tag and Compile the Option Inventory

## Objective
Choose and pin a specific upstream `lynxthecat/cake-autorate` release tag (with a
verifiable source hash) and produce a complete, checked inventory of every
configuration option the pinned release implements. This inventory is the single
source of truth consumed by the UCI schema (task 3), the config bridge (task 4),
the LuCI UI (task 7), and the statistics parser (task 6). It also records which
logging/output options are parser-critical and must be package-pinned.

## Skills Required
- `openwrt-packaging` — understanding of how a package Makefile pins a source tag/hash.
- `shell` — reading upstream's shell config template/`defaults.sh` to enumerate options.

## Acceptance Criteria
- [ ] A pinned upstream tag is selected and its tarball SHA-256 recorded (in a form the task-2 Makefile can reuse as `PKG_SOURCE_VERSION`/`PKG_HASH`).
- [ ] A committed reference document `docs/upstream-option-inventory.md` lists **every** upstream configuration option with: name, type, default value, units/range, direction (egress/ingress/global), and a one-line semantic description.
- [ ] The parser-relevant logging/output options (the settings that control the DATA/SUMMARY log lines the status view and collectd source parse) are explicitly flagged as "package-managed / pinned".
- [ ] Verification: fetch the upstream config template at the pinned tag and count option assignments, then compare to the inventory row count — they must match. Example: `grep -cE '^[A-Za-z_]+=' <upstream config template>` equals the number of option rows in `docs/upstream-option-inventory.md`.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Upstream repo: `lynxthecat/cake-autorate` (canonical bash implementation). Do **not** use the Darkmoon C rewrite.
- Inspect the config template (historically `config.primary.sh` / `defaults.sh` in-repo) at the chosen tag.
- Record the tag as an immutable ref plus a content hash so the build is reproducible.

## Input Dependencies
None. This is the foundation task.

## Output Artifacts
- `docs/upstream-option-inventory.md` — the option inventory (source of truth).
- A recorded pinned tag + source hash (embedded in the inventory doc header or a small `docs/upstream-pin.md`) for task 2 to consume.

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Clone or browse `https://github.com/lynxthecat/cake-autorate`. Pick the latest stable tag (a `vX.Y.Z` release), not `master`. Record the exact tag string.
2. Get the tarball hash: download `https://github.com/lynxthecat/cake-autorate/archive/refs/tags/<tag>.tar.gz` and `sha256sum` it. Record both the tag and hash.
3. Open the upstream default config (the file that lists all `SOMETHING=value` variables — e.g. `defaults.sh` and/or `config.primary.sh`). Every assignment is one option.
4. For each option create a row: `name | type | default | units/range | direction | meaning`. Types: bool (0/1), integer, float, string, list. Direction: many options come in `dl_`/`ul_` (download/ingress vs upload/egress) pairs — capture both.
5. Identify the logging/output options that determine what the daemon prints to its log stream (e.g. what enables the periodic DATA/SUMMARY lines, output verbosity, the log file path/rotation). Flag these as **package-managed**: task 4's bridge will pin them so the status/stats feed is always populated.
6. Write `docs/upstream-option-inventory.md`. Put the pinned tag + hash at the top.
7. Sanity-check the count with the grep command in Acceptance Criteria so tasks 3/4 can assert bidirectional coverage against a known number.

The cross-cutting invariant for the whole plan: **every option the UI exposes must be one the daemon actually consumes, and vice versa.** This inventory is where that contract is anchored.
</details>
