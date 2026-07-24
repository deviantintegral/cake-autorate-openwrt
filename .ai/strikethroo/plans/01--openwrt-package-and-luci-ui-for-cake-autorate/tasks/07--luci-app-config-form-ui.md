---
id: 7
group: "luci"
dependencies: [1, 3]
status: "pending"
created: 2026-07-23
skills:
  - luci
  - javascript
complexity_score: 7
complexity_notes: "Large form.Map surface over ~76 options; the live status view and the rpcd backend are split into tasks 9 and 8 so this task is config editing only."
---
# luci-app-cake-autorate Config Form UI

## Objective
Build the LuCI application's configuration form: a `form.Map`-based view that
exposes every supported option clearly, leading with a compact **Essentials**
group and organizing the remaining ~76 options into logically grouped, collapsible
sections with a search/filter, each field carrying help text and links to upstream
documentation. It supports creating, editing, enabling, and deleting multiple
named instances, registers the Services menu entry, and ships rpcd ACLs scoped to
the package's UCI and runtime files.

## Skills Required
- `luci` — `luci-app-*` package layout, `form.Map`/`form.TypedSection`, menu (`menu.d`) and ACL (`acl.d`) JSON.
- `javascript` — client-side LuCI view (`view/*.js`, CBI JS API).

## Acceptance Criteria
- [ ] Every UCI option from task 3 renders as a form field with a per-option description; concepts needing more than a sentence link to upstream docs.
- [ ] The form leads with an **Essentials** group (interface(s), enable, min/base/max rates per direction); the remaining options are in logically grouped **collapsible** sections (Rates, Delay/EWMA & baselines, Reflectors, Bufferbloat detection, Idle/sleep & stalls, Logging/output, Timers).
- [ ] A **search/filter** lets the user jump to a named option.
- [ ] Multiple named instances can be created, edited, enabled, and deleted from the UI.
- [ ] A Services → cake-autorate menu entry exists; rpcd ACLs restrict access to the package's UCI and runtime files.
- [ ] No decorative controls: every field binds to a real UCI option that the daemon consumes.
- [ ] Verification (browser or Playwright): loading Services → cake-autorate shows the Essentials group first, collapsible groups below, and a working search filter; the count of rendered option fields equals the inventory option count from task 1.

Use your internal Todo tool to track these and keep on track.

## Technical Requirements
- Client-rendered `form.Map` with stable option IDs/roles (task 11/12 depend on stable selectors).
- Interface fields are placeholders here; task 9 rewires them to SQM-validated choices. Do not accept free-text interfaces as the final design — leave the field addressable for task 9.
- ACL JSON granting read/write to `cake-autorate` UCI and read to its runtime files.

## Input Dependencies
- Task 1: inventory (help text source, option coverage target).
- Task 3: UCI schema (the options to bind).

## Output Artifacts
- `luci-app-cake-autorate` view/menu/ACL resources (its Makefile skeleton exists from task 2) — consumed by task 9 (status view + interface wiring) and tasks 11/12 (Playwright).

## Implementation Notes
<details>
<summary>Detailed guidance</summary>

1. Build the LuCI app under the `luci-app-cake-autorate` package: `htdocs/luci-static/resources/view/cake-autorate/*.js` for the view, `root/usr/share/luci/menu.d/*.json` for the menu, `root/usr/share/rpcd/acl.d/*.json` for ACLs.
2. Use `form.Map` with a `TypedSection` over the `cake-autorate` UCI type to get multi-instance add/remove/enable. Give the section `addremove` + `anonymous=false` for named instances.
3. Model groups as tabs or collapsible fieldsets: create the Essentials options first, then grouped option sets. For collapsibility + search, either use LuCI tabs plus a client-side filter input that hides non-matching options, or a custom widget — keep option IDs stable.
4. Pull descriptions from the task-1 inventory; add `.href`/doc links where a concept needs more than a sentence.
5. Ensure the rendered field count equals the inventory count (the coverage invariant, testable by Playwright in task 11).

Bind every field to a real option — the audited failure mode was UI controls with no daemon backing. Do not reintroduce it.
</details>
