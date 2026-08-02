---
id: 1
group: "sqm-rate-seeding"
dependencies: []
status: "completed"
created: 2026-08-02
skills:
  - posix-shell
  - shell-testing
complexity_score: 4
---
# Expose SQM's configured download/upload rates from the sqm_interfaces rpcd method

## Objective

Make the `sqm_interfaces` rpcd method return SQM's configured `download` and
`upload` rate for each interface, so the LuCI form can seed cake-autorate's six
shaper-rate fields from a number the user has already supplied to SQM. The
change is strictly additive to the method's existing JSON.

## Skills Required

`posix-shell` for the BusyBox-compatible awk/shell in the rpcd backend, and
`shell-testing` for extending the existing rpcd test suite.

## Acceptance Criteria

- [ ] `parse_sqm_sections()` captures `option download` and `option upload` in
      addition to `interface` and `enabled`.
- [ ] Each object in the `interfaces` array returned by `sqm_interfaces` carries
      `download_kbps` and `upload_kbps` as JSON **numbers** (not strings), with a
      missing or non-numeric value emitted as `0`.
- [ ] Every field the method returned before (`egress`, `ingress_ifb`,
      `sqm_enabled`, `ifb_present`, `mismatch`, `egress_choices`,
      `ingress_choices`, `ifb_devices`, `sqm_config_present`) is unchanged in
      name, position and value.
- [ ] `tests/rpcd/test-rpcd.sh` gains cases asserting the two new fields for: a
      section with both rates set, a section with `download '0'`, and a section
      with neither option present. All pre-existing assertions in that file
      still pass **unmodified**.
- [ ] Verification: `tests/rpcd/test-rpcd.sh` exits 0 and prints no FAIL lines.
- [ ] Verification: with a fixture config,
      `CAKE_AUTORATE_SQM_CONFIG=<fixture> CAKE_AUTORATE_RPCD_LIB=0 ./net/cake-autorate/files/cake-autorate.rpcd call sqm_interfaces </dev/null | jsonfilter -e '@.interfaces[0].download_kbps'`
      prints the fixture's download rate.

## Technical Requirements

- File: `net/cake-autorate/files/cake-autorate.rpcd`.
- sqm-scripts stores both rates in `/etc/config/sqm` as `option download` and
  `option upload`, **already in Kbit/s** — the same unit cake-autorate uses, so
  there is no conversion.
- `parse_sqm_sections()` currently emits tab-separated `iface<TAB>enabled` and
  `do_sqm_interfaces()` splits it with `${line%%<TAB>*}` / `${line#*<TAB>}`. With
  four fields that two-way split no longer works — switch to an explicit split
  (e.g. `IFS=<TAB>` with `set --`, or read into positional parameters).
- The backend runs under `set -u` and sources OpenWrt's non-nounset-clean
  `/lib/functions.sh`; do not disturb the existing `set +u` wrapping.
- Must stay BusyBox-awk compatible — no GNU awk extensions.

## Input Dependencies

None. This is the first task and depends only on code already in the tree.

## Output Artifacts

- An extended `sqm_interfaces` JSON contract carrying `download_kbps` and
  `upload_kbps` per interface, consumed by task 2 (the seed helper) and task 5
  (the LuCI action).
- New assertions in `tests/rpcd/test-rpcd.sh`.

## Implementation Notes

<details>
<summary>Detailed implementation guidance</summary>

**1. Extend the awk in `parse_sqm_sections()`.**

The current awk tracks `iface` and `en` per `config` block and prints
`iface "\t" en` at each block boundary and at `END`. Add two more accumulators,
reset them where `iface`/`en` are reset, and print four tab-separated fields:

```awk
$1 == "config" {
    if (have) print iface "\t" en "\t" dl "\t" ul
    iface = ""; en = "1"; dl = "0"; ul = "0"; have = 0; next
}
$1 == "option" && $2 == "interface" { iface = deq($3); have = 1 }
$1 == "option" && $2 == "enabled"   { en = deq($3) }
$1 == "option" && $2 == "download"  { dl = deq($3) }
$1 == "option" && $2 == "upload"    { ul = deq($3) }
END { if (have) print iface "\t" en "\t" dl "\t" ul }
```

Keep the existing `deq()` helper for stripping quotes. Note the defaults are set
in the `config` branch, so also initialise them before the first block (awk
uninitialised variables stringify to `""`, which the sanitiser below turns into
`0`).

**2. Split four fields in `do_sqm_interfaces()`.**

Replace the two-way `${line%%TAB*}` / `${line#*TAB}` extraction. A portable way
that works in BusyBox ash:

```sh
OIFS="$IFS"; IFS="$TAB"
# shellcheck disable=SC2086
set -- $line
IFS="$OIFS"
iface="${1:-}"; en="${2:-1}"; dl_raw="${3:-0}"; ul_raw="${4:-0}"
```

Be careful: the surrounding loop already manipulates `IFS` (it sets it to a
newline to iterate `$sections`). Save and restore around the inner split so the
outer loop keeps working.

**3. Sanitise to a JSON number.**

A rate must be emitted as a bare JSON number. Anything non-numeric (empty,
`auto`, a stray unit suffix) becomes `0`:

```sh
json_num() {
    case "$1" in
        ''|*[!0-9]*) printf '0' ;;
        *)           printf '%s' "$1" ;;
    esac
}
```

This deliberately rejects negative and decimal values — SQM rates are
non-negative integers in Kbit/s.

**4. Add the fields to the emitted object.**

Extend the existing `objs="$objs$sep{...}"` construction, appending after
`mismatch` so the existing field order is untouched:

```sh
,"download_kbps":$(json_num "$dl_raw"),"upload_kbps":$(json_num "$ul_raw")
```

**5. Tests.**

`tests/rpcd/test-rpcd.sh` already drives the backend with
`CAKE_AUTORATE_SQM_CONFIG` pointing at fixture files and `CAKE_AUTORATE_RPCD_LIB`
to source it. Follow the existing fixture and assertion style in that file
exactly — do not invent a new harness. Add three cases:

- both rates set → `download_kbps` and `upload_kbps` equal the fixture values;
- `option download '0'` → `download_kbps` is `0`;
- neither option present → both are `0`.

Confirm the output is still valid JSON (pipe through `jsonfilter`), since an
unquoted or malformed number would break every consumer.

**Do not** add any UCI key to the `cake-autorate` config, and do not touch the
bridge — this task only reads `/etc/config/sqm`.
</details>
