# UCI Schema for `cake-autorate` — options, types and defaults

Companion to [`upstream-option-inventory.md`](upstream-option-inventory.md)
(the source of truth for what upstream implements). **This** document defines
how those 66 options are expressed in UCI, and is the contract that the config
bridge (task 4) and the LuCI form (task 7) implement against.

| Artifact | Path | Role |
| --- | --- | --- |
| Shipped UCI default | `net/cake-autorate/files/cake-autorate.config` → `/etc/config/cake-autorate` | The config a fresh install gets (a package conffile). |
| **Machine-readable schema** | `docs/uci-option-schema.tsv` | Canonical UCI option → upstream option → type → default mapping. Consume this, do not retype it. |
| Verification gate | `tests/schema/test-uci-schema.sh` | Proves grammar + 66/66 bidirectional coverage + type validity. |
| UCI grammar checker | `tests/schema/uci-syntax-check.awk` | Reusable strict UCI parser (also prints a parsed key/value stream). |
| Multi-instance fixture | `tests/schema/fixtures/two-instances.uci` | Two coexisting instances; reused by the bridge tests. |

Run the gate (no router or `uci` binary needed):

```sh
tests/schema/test-uci-schema.sh
# optionally also diff the metadata against the real upstream file:
tests/schema/test-uci-schema.sh --upstream /path/to/cake-autorate-3.2.2/defaults.sh
```

---

## 1. Shape: one named section per instance

```
config cake-autorate 'primary'
	option enabled '0'
	option dl_if 'ifb-wan'
	...
```

* Section type is always `cake-autorate`. There is **no global/shared
  section** — nothing is shared between instances, so two instances cannot
  collide.
* **The section name is the instance id.** It must match `[A-Za-z0-9_]+`
  (libuci restricts names to alphanumerics and `_`), and it determines:

  | Derived from the section name | Path |
  | --- | --- |
  | Generated daemon config | `/etc/cake-autorate/config.<name>.sh` |
  | Log file / status + collectd source | `/var/log/cake-autorate.<name>.log` |
  | Rotated log | `/var/log/cake-autorate.<name>.log.old` |
  | Daemon run dir | `/var/run/cake-autorate/<name>` |

  Upstream parses the instance id out of the config *filename*
  (`config.<instance_id>.sh`), so the section name must round-trip through a
  filename unchanged — `[A-Za-z0-9_]+` guarantees that.
* `enabled` is the **only** package-local key. It gates procd and must never
  be written into the generated shell config (it is not one of the 66 upstream
  options; an unknown key is a fatal daemon error).
* Every other key in the file is *exactly* an upstream option name. UCI option
  name == upstream variable name, 1:1, no renaming. The bridge's mapping is
  therefore an identity mapping plus type formatting.

A commented second-instance example ships at the bottom of the default config.
A second instance only needs the Essentials; any option a section omits keeps
its packaged/upstream default.

## 2. Essentials

These nine keys are all a user must touch for a working single-instance setup;
everything else defaults to a working value.

| UCI option | Default | Note |
| --- | --- | --- |
| `enabled` | `0` | Ships **off** — a wrong interface would shape the wrong device. |
| `dl_if` | `ifb-wan` | Ingress device, normally the sqm-scripts IFB (`ifb4<wan>`, e.g. `ifb4eth1`). |
| `ul_if` | `wan` | WAN egress device. |
| `min_dl_shaper_rate_kbps` | `5000` | Kbit/s, `min ≤ base ≤ max`. |
| `base_dl_shaper_rate_kbps` | `20000` | |
| `max_dl_shaper_rate_kbps` | `80000` | |
| `min_ul_shaper_rate_kbps` | `5000` | |
| `base_ul_shaper_rate_kbps` | `20000` | |
| `max_ul_shaper_rate_kbps` | `35000` | |

`dl_if`/`ul_if` keep upstream's own default strings. They are placeholders, but
they **may not be blanked**: upstream rejects an empty value for any string
option whose default is non-empty (`dl_if`, `ul_if`, `pinger_binary`). LuCI
derives the real values from the live SQM config (task 9).

## 3. Types — and what the bridge must emit

UCI stores everything as text, so the type column in
`docs/uci-option-schema.tsv` is the **only** thing that tells the bridge which
lexical form upstream will accept. Upstream compares `typeof(user value)`
against `typeof(default)` and *exits* on mismatch.

| Schema type | UCI storage | Bridge must emit | Rule |
| --- | --- | --- | --- |
| `integer` | `option no_pingers '6'` | `no_pingers=6` | Bare digits. **A decimal point is fatal** (`no_pingers=6.0` → exit 1). Strip a trailing `.0`, reject anything else non-integral. |
| `float` | `option reflector_ping_interval_s '0.3'` | `reflector_ping_interval_s=0.3` | **Must contain a decimal point.** `1` is fatal → emit `1.0`. Normalise `1` → `1.0`, `.5` → `0.5`. |
| `bool` | `option debug '0'` | `debug=0` | An integer restricted to `0`/`1`. UCI truthy spellings (`true`/`yes`/`on`/`enabled`) must be normalised to `1`, falsy to `0` — never passed through. |
| `string` | `option pinger_binary 'fping'` | `pinger_binary="fping"` | Emit double-quoted and shell-escaped. `dl_if`, `ul_if`, `pinger_binary` must never be emitted empty; `log_file_path_override`, `ping_extra_args`, `ping_prefix_string` may be. |
| `list` | repeated `list reflectors '1.1.1.1'` | `reflectors=( "1.1.1.1" "8.8.8.8" )` | A bash **array literal**, entries double-quoted, order preserved. |

Additional universal rules: **no value may be negative** (upstream's `typeof`
classifies `-1` as `negative-integer` and rejects it), and only these 66 keys
may ever be emitted.

The three families are also distinguishable without the TSV — floats/integers
are told apart by the *default's* lexical form — but do not re-derive them:
read the `type` column.

## 4. Package-managed options

`managed` column in the TSV:

| managed | Meaning | Options |
| --- | --- | --- |
| `forced` | The bridge writes `uci_default` unconditionally, **after** copying user options. LuCI shows these read-only or not at all. | `log_to_file=1`, `output_summary_stats=1`, `log_file_path_override=""`, `log_DEBUG_messages_to_syslog=0` |
| `bounded` | User-settable, but the bridge clamps to a sane non-zero range (these bound log growth on a tmpfs `/var/log`). | `log_file_max_time_mins`, `log_file_max_size_KB`, `log_file_buffer_size_B`, `log_file_buffer_timeout_ms` |
| `user` | Free. | the other 58 |

Rationale: the daemon's only runtime interface is its log stream. Without
`log_to_file=1` nothing is written at all under procd (there is no terminal),
and without `output_summary_stats=1` there are no `SUMMARY` lines for the LuCI
status view or the collectd tail source. `log_file_path_override=""` pins the
log to `/var/log/cake-autorate.<instance>.log`; a non-existent override
directory makes the daemon exit.

## 5. Deviations from upstream defaults

Everything in the shipped config equals upstream's `defaults.sh` value except:

| Option | Upstream | Packaged | Why |
| --- | --- | --- | --- |
| `output_summary_stats` | `0` | `1` | Forced: the status view and RRD graphs parse `SUMMARY` lines. |
| `debug` | `1` | `0` | `/var/log` is tmpfs on OpenWrt; `DEBUG` lines dominate the log and cost RAM. `SUMMARY` output is unaffected. User-settable. |

Both are recorded in the TSV (`uci_default` vs `upstream_default`), so the gate
catches any further drift.

## 6. Grouping for the LuCI form

The `group` and `essential` columns drive the form's information architecture:
`essentials` (8 + `enabled`), `shaper` (11), `pingers` (5), `reflectors` (10),
`detection` (10), `idle` (8), `logging` (14) = 66. The `units_range` column
carries the units/range text from the inventory and is suitable as field help.

## 7. What is *not* proven here

`uci import cake-autorate` / `uci show cake-autorate` are not run by this gate —
libuci is not available on a build host. The grammar checker was written as a
strict subset of libuci's own parser (`file.c` / `util.c`, citations in the awk
header), but the authoritative device-side parse belongs to the task-10 VM run.

`docs/uci-option-schema.tsv` is currently a **repo-side** artifact: the package
Makefile does not install it. If the bridge wants to read it at runtime rather
than embedding the mapping, an install stanza (e.g. to
`/usr/share/cake-autorate/option-schema.tsv`) has to be added to
`net/cake-autorate/Makefile`.
