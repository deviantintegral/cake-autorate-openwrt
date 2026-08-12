# Upstream Option Inventory — `lynxthecat/cake-autorate`

**This document is the single source of truth for every configuration option the
packaged daemon consumes.** The UCI schema (task 3), the config bridge (task 4),
the statistics parser (task 6) and the LuCI form (task 7) must all be checked
against this file.

Cross-cutting invariant for the plan: *every option the UI exposes must be one
the daemon actually consumes, and vice versa.*

---

## 1. Pinned upstream source

| Field | Value |
| --- | --- |
| Upstream project | `lynxthecat/cake-autorate` (canonical **bash** implementation) |
| Pinned tag | `v3.2.2` |
| Tag commit (annotated/lightweight ref) | `495038fd673a2146be08c2c4b76f77125c3c274b` |
| Release date of tree | 2024-11-27 |
| Tarball URL (canonical) | `https://codeload.github.com/lynxthecat/cake-autorate/tar.gz/refs/tags/v3.2.2` |
| Tarball URL (equivalent) | `https://github.com/lynxthecat/cake-autorate/archive/refs/tags/v3.2.2.tar.gz` |
| Tarball size | 95660 bytes |
| **SHA-256** | `892d8e648f6b3705f31799736e697874da3802b5e56ce4aea257cfdf6a376414` |

Both URL forms were downloaded independently and produced byte-identical
tarballs with the same SHA-256, so the hash is safe to pin.

This is **not** the "Darkmoon" C rewrite. `v3.2.2` is the latest tag on the
bash implementation (full tag list at time of pinning: `v1.0.0`, `v1.0.1`,
`v1.1.0`, `v1.1.1`, `v1.2.0`, `v1.2.1`, `v3.0.0`, `v3.0.1`, `v3.1.0`, `v3.1.1`,
`v3.2.0`, `v3.2.1`, `v3.2.2`).

### For the task-2 OpenWrt Makefile

```make
PKG_NAME:=cake-autorate
PKG_VERSION:=3.2.2
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/lynxthecat/cake-autorate/tar.gz/refs/tags/v$(PKG_VERSION)?
PKG_HASH:=892d8e648f6b3705f31799736e697874da3802b5e56ce4aea257cfdf6a376414
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
```

(If a `PKG_SOURCE_PROTO:=git` style pin is preferred instead,
`PKG_SOURCE_VERSION:=495038fd673a2146be08c2c4b76f77125c3c274b` is the tag
commit. The tarball + `PKG_HASH` form above is preferred — it is reproducible
and needs no git at build time.)

### Verification commands (re-runnable)

```sh
curl -sSL -o cake-autorate-3.2.2.tar.gz \
  https://codeload.github.com/lynxthecat/cake-autorate/tar.gz/refs/tags/v3.2.2
sha256sum cake-autorate-3.2.2.tar.gz
# => 892d8e648f6b3705f31799736e697874da3802b5e56ce4aea257cfdf6a376414

tar xzf cake-autorate-3.2.2.tar.gz
grep -cE '^[A-Za-z_]+=' cake-autorate-3.2.2/defaults.sh
# => 66   (must equal the number of option rows in section 4 of this document)
```

---

## 2. Where the options live, and how upstream validates them

Relevant files inside the tarball:

| File | Role |
| --- | --- |
| `defaults.sh` | **Authoritative option list.** Every option with its default. |
| `config.primary.sh` | Per-instance user config. Overrides a subset of `defaults.sh`. |
| `cake-autorate.sh` | The daemon. Sources `defaults.sh` then the instance config. |
| `lib.sh` | Helper library, includes `typeof`/`str_type` used for config validation. |
| `cake-autorate.template` | procd init template (`%%SCRIPT_PREFIX%%` placeholder). |
| `launcher.sh.template` | Launches one daemon per `config.*.sh` found. |

### 2.1 The valid-option set is derived mechanically from `defaults.sh`

`cake-autorate.sh` (v3.2.2, line 95):

```sh
mapfile -t valid_config_entries < <(grep -E '^[^(#| )].*=' "${SCRIPT_PREFIX}/defaults.sh" \
  | sed -e 's/[\t ]*\#.*//g' -e 's/=.*//g')
```

So **the option universe is exactly the set of top-level assignments in
`defaults.sh`** — 66 of them. `config.primary.sh` contains 15 assignments, all
of which are a strict subset of those 66 (they are convenience overrides, not
extra options).

### 2.2 Unknown keys are a **fatal** error

Any key present in the instance config that is not in `valid_config_entries`
causes `ERROR: The key '<k>' ... is not a valid config entry.` and
`exit 1`. The single exemption hard-coded upstream is the legacy key
`config_file_check`, which is accepted and ignored.

> **Config bridge (task 4) requirement:** never emit a key outside the 66 listed
> in section 4. A single stray key stops the daemon from starting at all.

### 2.3 Value **types** are strictly validated

Before sourcing the instance config, the daemon compares `typeof(user_value)`
against `typeof(default_value)` and refuses to start on mismatch. `typeof`
(from `lib.sh`) recognises only:

| typeof result | Matching regex / condition |
| --- | --- |
| `integer` | `^[0-9]+$` |
| `float` | `^[0-9]*\.[0-9]+$` |
| `negative-integer` | `^-[0-9]+$` (always rejected — no default is negative) |
| `negative-float` | `^-[0-9]*\.[0-9]+$` (always rejected) |
| `string` | anything else scalar |
| `array` | `declare -a` (i.e. `reflectors=( ... )`) |
| `map` | `declare -A` (unused by any option) |

Consequences the config bridge **must** honour:

* An option whose default is a **float must be written with a decimal point.**
  `reflector_ping_interval_s=0.3` is valid; `reflector_ping_interval_s=1` is a
  fatal type error. Emit `1.0`.
* An option whose default is an **integer must not carry a decimal point.**
  `no_pingers=6.0` is a fatal type error.
* **Negative values are never accepted** for any option.
* A **string** option whose default is non-empty may not be set to the empty
  string (extra check in `validate_config_entry`). This applies to `dl_if`,
  `ul_if`, `pinger_binary`. The three string options whose defaults *are* empty
  (`log_file_path_override`, `ping_extra_args`, `ping_prefix_string`) may be
  left empty.
* `reflectors` must be emitted as a bash array literal, e.g.
  `reflectors=( "1.1.1.1" "8.8.8.8" )`.

### 2.4 Instance identity, script and config prefixes

* `SCRIPT_PREFIX` is the first existing directory of:
  `$CAKE_AUTORATE_SCRIPT_PREFIX`, `/jffs/scripts/cake-autorate`,
  `/opt/cake-autorate`, `/usr/lib/cake-autorate`, `/root/cake-autorate`.
  **For an OpenWrt package `/usr/lib/cake-autorate` is the natural install
  prefix** (it is in the built-in list, so no env var is needed).
* `CONFIG_PREFIX` is the first existing directory of:
  `$CAKE_AUTORATE_CONFIG_PREFIX`, `/jffs/configs/cake-autorate`,
  `$SCRIPT_PREFIX`. To keep config out of `/usr/lib`, the package should set
  `CAKE_AUTORATE_CONFIG_PREFIX` (e.g. `/etc/cake-autorate`) in the procd init
  script, or place `config.*.sh` under `$SCRIPT_PREFIX`.
* The instance id is parsed from the config **filename**:
  `config.<instance_id>.sh`. An empty id is a fatal error.
  `config.primary.sh` ⇒ `instance_id=primary`.
* `run_path=/var/run/cake-autorate/<instance_id>` (created at start, `rm -r`'d
  at exit). Contains `proc_pids`, and the generated helper scripts
  `log_file_export` and `log_file_reset`, plus `last_log_file_export`.

> Known upstream cosmetic bug at this tag: `cake_autorate_version="3.2.1"` is
> hard-coded at `cake-autorate.sh:17` even though the tag is `v3.2.2`. Do not
> use the daemon's self-reported version for the LuCI version display — use the
> package version.

---

## 3. Log/output surface (what the status view and collectd parse)

### 3.1 Log file path

Derived at runtime (`cake-autorate.sh` ~line 860):

```
log_file_path = /var/log/cake-autorate.<instance_id>.log
```

or, if `log_file_path_override` is a **directory that exists**:

```
log_file_path = ${log_file_path_override}/cake-autorate.<instance_id>.log
```

If `log_file_path_override` is set but is not an existing directory, the daemon
logs an ERROR and **exits**. On rotation the previous contents are moved to
`${log_file_path}.old`.

For the default `config.primary.sh` instance the path is therefore
**`/var/log/cake-autorate.primary.log`**.

### 3.2 Common line prefix

Every line written by `log_msg` has the shape:

```
<TYPE>; <YYYY-MM-DD-HH:MM:SS>; <EPOCHREALTIME>; <payload...>
```

Fields are separated by `"; "` (semicolon + space). `TYPE` is one of
`DEBUG`, `ERROR`, `SYSLOG`, `INFO`, `SHAPER`, `DATA`, `LOAD`, `REFLECTOR`,
`SUMMARY`.

`*_HEADER` lines are printed once at startup (only when the corresponding
`output_*_stats` toggle is on) and are written *directly* to the log file, not
through `log_msg`, so they carry **no** `TYPE; datetime; timestamp` prefix.

### 3.3 Line formats

**`SUMMARY`** — emitted once per processed ping response when
`output_summary_stats=1`. 13 fields total. This is the cheapest useful feed and
is the recommended source for the LuCI status view and collectd.

```
SUMMARY_HEADER; LOG_DATETIME; LOG_TIMESTAMP; DL_ACHIEVED_RATE_KBPS; UL_ACHIEVED_RATE_KBPS;
DL_SUM_DELAYS; UL_SUM_DELAYS; DL_AVG_OWD_DELTA_US; UL_AVG_OWD_DELTA_US;
DL_LOAD_CONDITION; UL_LOAD_CONDITION; CAKE_DL_RATE_KBPS; CAKE_UL_RATE_KBPS
```

Index (0-based, after splitting on `"; "`):
`0=SUMMARY`, `1=datetime`, `2=epoch`, `3=dl_achieved_kbps`, `4=ul_achieved_kbps`,
`5=dl_sum_delays`, `6=ul_sum_delays`, `7=dl_avg_owd_delta_us`,
`8=ul_avg_owd_delta_us`, `9=dl_load_condition`, `10=ul_load_condition`,
`11=cake_dl_rate_kbps`, `12=cake_ul_rate_kbps`.

`*_LOAD_CONDITION` is a string, one of `dl_idle`/`dl_low`/`dl_high` (and
`ul_*` equivalents), possibly suffixed by the daemon's bufferbloat/decay state.

**`DATA`** — emitted once per processed ping response when
`output_processing_stats=1`. 31 fields total (the most detailed feed; heavier).

```
DATA_HEADER; LOG_DATETIME; LOG_TIMESTAMP; PROC_TIME_US; DL_ACHIEVED_RATE_KBPS; UL_ACHIEVED_RATE_KBPS;
DL_LOAD_PERCENT; UL_LOAD_PERCENT; ICMP_TIMESTAMP; REFLECTOR; SEQUENCE;
DL_OWD_BASELINE; DL_OWD_US; DL_OWD_DELTA_EWMA_US; DL_OWD_DELTA_US; DL_ADJ_DELAY_THR;
UL_OWD_BASELINE; UL_OWD_US; UL_OWD_DELTA_EWMA_US; UL_OWD_DELTA_US; UL_ADJ_DELAY_THR;
DL_SUM_DELAYS; DL_AVG_OWD_DELTA_US; DL_ADJ_AVG_OWD_DELTA_THR_US;
UL_SUM_DELAYS; UL_AVG_OWD_DELTA_US; UL_ADJ_AVG_OWD_DELTA_THR_US;
DL_LOAD_CONDITION; UL_LOAD_CONDITION; CAKE_DL_RATE_KBPS; CAKE_UL_RATE_KBPS
```

Note: the column labelled `PROC_TIME_US` actually receives `${EPOCHREALTIME}`,
not a processing duration. Do not interpret it as a duration.

**`LOAD`** — emitted on every achieved-rate sample when `output_load_stats=1`.
8 fields.

```
LOAD_HEADER; LOG_DATETIME; LOG_TIMESTAMP; PROC_TIME_US;
DL_ACHIEVED_RATE_KBPS; UL_ACHIEVED_RATE_KBPS; CAKE_DL_RATE_KBPS; CAKE_UL_RATE_KBPS
```

**`REFLECTOR`** — emitted on each reflector comparison when
`output_reflector_stats=1`. 17 fields.

```
REFLECTOR_HEADER; LOG_DATETIME; LOG_TIMESTAMP; PROC_TIME_US; REFLECTOR;
MIN_SUM_OWD_BASELINES_US; SUM_OWD_BASELINES_US; SUM_OWD_BASELINES_DELTA_US; SUM_OWD_BASELINES_DELTA_THR_US;
MIN_DL_DELTA_EWMA_US; DL_DELTA_EWMA_US; DL_DELTA_EWMA_DELTA_US; DL_DELTA_EWMA_DELTA_THR;
MIN_UL_DELTA_EWMA_US; UL_DELTA_EWMA_US; UL_DELTA_EWMA_DELTA_US; UL_DELTA_EWMA_DELTA_THR
```

**`SHAPER`** — emitted on each `tc qdisc change` when `output_cake_changes=1`;
free-form text, not a fixed-column record.

### 3.3.1 How the file is written — a live log ends mid-line

`maintain_log_file` in `cake-autorate.sh` does not write lines. It writes fixed
character counts:

```sh
read -r -N "${log_file_buffer_size_B}" -t "${log_file_buffer_timeout_s}" -u "${log_fd}" log_chunk
printf '%s' "${log_chunk}" >&${log_file_fd}
```

`read -N` stops at a **count**, not at a newline, so every flush ends the file
wherever it happened to land — normally part-way through a record. The last line
of a live log is therefore almost always a fragment:

```
SUMMARY; 2026-08-12-16:25:36; 17865663
```

Consequences for anything that reads this log:

* A fragment still matches `^SUMMARY; `, so **"last line matching the prefix"
  is the wrong selector.** It picks the fragment far more often than not: at the
  default six pingers on a 0.3 s interval the daemon writes ~20 SUMMARY lines a
  second, and the file spends nearly all of its time cut somewhere inside the
  most recent one.
* A field count is necessary but **not sufficient**: a cut inside the final
  field leaves 13 fields with a truncated last value (`4184` arriving as `41`).
  Only the absent trailing newline distinguishes it, so the last record counts
  as usable only when the file ends on a newline.
* Nothing is corrupted permanently — the next flush appends the remainder with
  no separator, so the line completes itself. A reader just has to skip it until
  it does.

Both consumers therefore take the newest record that is a `SUMMARY`, carries at
least 13 fields, **and** is newline-terminated: `newest_summary_line` in
`cake-autorate.rpcd` and in `cake-autorate-collectd.sh`. Getting this wrong is
not a rare edge: it made the LuCI status view flip to "no data yet" between
polls while the daemon was writing continuously, and it silently skipped most
collectd intervals.

### 3.3.2 Rotation happens on a timer, whether or not the daemon is talking

`maintain_log_file` rotates when `SECONDS - t_log_file_start_s >
log_file_max_time_s` — a wall-clock check in its own loop, so it fires on
`log_file_max_time_mins` (10 by default) even when the daemon has written
nothing. And it does go quiet: with `enable_sleep_function=1` it stops the
pingers after `sustained_idle_sleep_thr_s` of an idle link and emits no SUMMARY
lines at all until traffic returns.

`rotate_log_file` is `cat log > log.old; : > log`, so a freshly rotated log holds
only the `*_HEADER` lines. A reader that stops there reports "no data" for an
instance that is running perfectly well; it must fall back to
`${log_file_path}.old`. Both consumers do.

### 3.4 Package-managed / pinned options

These options control whether the parseable log stream exists at all. The
task-4 config bridge **must force them** regardless of UCI input, otherwise the
LuCI status view and the collectd source silently show nothing.

| Option | Forced value | Why |
| --- | --- | --- |
| `log_to_file` | `1` | Without this nothing is written to `log_file_path`; the daemon only prints to a terminal, and under procd there is no terminal. **Hard requirement.** |
| `output_summary_stats` | `1` | Produces the `SUMMARY` lines the status view and collectd parse. **Hard requirement.** |
| `log_file_path_override` | `""` (or a package-chosen existing dir) | Pins the log path to `/var/log/cake-autorate.<instance>.log` so the parser can find it. If ever exposed, the bridge must validate the directory exists or the daemon exits. |
| `log_file_max_time_mins` | package default (e.g. `10`) | Bounds rotation so the parser never reads an unbounded file. May be user-tunable, but must stay > 0. |
| `log_file_max_size_KB` | package default (e.g. `2000`) | Same; also the OOM guard on small routers. |
| `log_file_buffer_size_B` | `512` | Buffering delay before lines hit the file; keep small so the status view is near-live. |
| `log_file_buffer_timeout_ms` | `500` | Same. |
| `output_processing_stats` | `0` (user-selectable "verbose") | `DATA` lines are far heavier than `SUMMARY`. Only enable on explicit user request. |
| `output_load_stats` | `0` (user-selectable) | Extra `LOAD` lines. |
| `output_reflector_stats` | `0` (user-selectable) | Extra `REFLECTOR` lines. |
| `output_cake_changes` | `0` (user-selectable) | Free-form `SHAPER` lines; useful for troubleshooting only. |
| `debug` | `1` (upstream default; user-selectable) | `DEBUG` lines go to the log file. |
| `log_DEBUG_messages_to_syslog` | `0` | Upstream explicitly warns this generates a LOT of syslog records. Do not let the UI turn this on casually. |

Minimum viable pin for a working status view + statistics feed:
`log_to_file=1`, `output_summary_stats=1`, `log_file_path_override=""`.

---

## 4. Full option inventory (66 options)

Source: `defaults.sh` at tag `v3.2.2`. Row order matches file order.

Legend for **Direction**: `ingress` = download / `dl_` side, `egress` =
upload / `ul_` side, `global` = applies to the instance as a whole.
Legend for **Type**: the upstream `typeof` class, with `(bool)` marking integers
that are semantically 0/1 toggles. Remember §2.3: floats need a decimal point.

| # | Name | Type | Default | Units / range | Direction | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `output_processing_stats` | integer (bool) | `0` | 0 or 1 | global | Emit the per-ping `DATA` monitoring lines (full processing detail). |
| 2 | `output_load_stats` | integer (bool) | `0` | 0 or 1 | global | Emit `LOAD` lines showing achieved dl/ul rates on every rate sample. |
| 3 | `output_reflector_stats` | integer (bool) | `0` | 0 or 1 | global | Emit `REFLECTOR` lines with per-reflector baseline/EWMA comparison data. |
| 4 | `output_summary_stats` | integer (bool) | `0` | 0 or 1 | global | Emit the condensed `SUMMARY` lines (rates, delays, load conditions, shaper rates). |
| 5 | `output_cake_changes` | integer (bool) | `0` | 0 or 1 | global | Emit a `SHAPER` line for every `tc qdisc change` the daemon issues. |
| 6 | `debug` | integer (bool) | `1` | 0 or 1 | global | Emit `DEBUG` lines; when 0 all DEBUG messages are dropped early. |
| 7 | `log_DEBUG_messages_to_syslog` | integer (bool) | `0` | 0 or 1 | global | Also send every DEBUG record to syslog via `logger` (very high volume). |
| 8 | `log_to_file` | integer (bool) | `1` | 0 or 1 | global | Write the log stream to `log_file_path`; when 0 output only goes to a terminal. |
| 9 | `log_file_max_time_mins` | integer | `10` | minutes, > 0 | global | Rotate the log file once this much wall time of log lines has accumulated. |
| 10 | `log_file_max_size_KB` | integer | `2000` | KB (bytes/1024), > 0 | global | Rotate the log file once this many KB of log lines have accumulated. |
| 11 | `log_file_path_override` | string | `""` | absolute path to an **existing** directory, or empty | global | Directory to hold `cake-autorate.<instance>.log`; empty means `/var/log`. A non-existent directory is fatal. |
| 12 | `dl_if` | string | `ifb-wan` | interface name, non-empty | ingress | Interface carrying the download (ingress) CAKE qdisc, normally the IFB device. |
| 13 | `ul_if` | string | `wan` | interface name, non-empty | egress | Interface carrying the upload (egress) CAKE qdisc. |
| 14 | `pinger_binary` | string | `fping` | one of `fping`, `tsping`, `ping` | global | Which probe binary to use: `fping` round-robin RTT, `tsping` ICMP type 13 OWD, `ping` (iputils) individual RTT. Must exist on PATH or the daemon exits. |
| 15 | `reflectors` | array | 30 public DNS IPs (Cloudflare, Google, Quad9, AdGuard, Neustar, OpenDNS, CleanBrowsing) | list of IPv4/IPv6 addresses; length should be ≥ `no_pingers` | global | Ordered pool of ICMP reflectors. The first `no_pingers` entries are used; the rest are spares for rotation. |
| 16 | `randomize_reflectors` | integer (bool) | `1` | 0 or 1 | global | Shuffle the `reflectors` array at startup so instances do not all hammer the same hosts. |
| 17 | `no_pingers` | integer | `6` | count, ≥ 1 and ≤ `${#reflectors[@]}` | global | Number of concurrent pinger processes / reflectors kept live. |
| 18 | `reflector_ping_interval_s` | float | `0.3` | seconds | global | Interval between probes. Aggregate ICMP rate ≈ `no_pingers / reflector_ping_interval_s`; drives CPU use. |
| 19 | `dl_owd_delta_thr_ms` | float | `30.0` | milliseconds | ingress | One-way-delay increase above baseline that classifies a download sample as delayed. Auto-compensated for max on-wire packet size. |
| 20 | `ul_owd_delta_thr_ms` | float | `30.0` | milliseconds | egress | Same for upload. |
| 21 | `dl_avg_owd_delta_thr_ms` | float | `60.0` | milliseconds | ingress | Average OWD delta at which the maximum bufferbloat down-adjustment is applied on download. |
| 22 | `ul_avg_owd_delta_thr_ms` | float | `60.0` | milliseconds | egress | Same for upload. |
| 23 | `adjust_dl_shaper_rate` | integer (bool) | `1` | 0 or 1 | ingress | Actually apply download shaper rate changes; 0 = monitor only. |
| 24 | `adjust_ul_shaper_rate` | integer (bool) | `1` | 0 or 1 | egress | Actually apply upload shaper rate changes; 0 = monitor only. |
| 25 | `min_dl_shaper_rate_kbps` | integer | `5000` | Kbit/s, ≤ base | ingress | Floor for the download shaper rate. |
| 26 | `base_dl_shaper_rate_kbps` | integer | `20000` | Kbit/s, between min and max | ingress | Steady-state download shaper rate the daemon decays back toward. |
| 27 | `max_dl_shaper_rate_kbps` | integer | `80000` | Kbit/s, ≥ base | ingress | Ceiling for the download shaper rate. |
| 28 | `min_ul_shaper_rate_kbps` | integer | `5000` | Kbit/s, ≤ base | egress | Floor for the upload shaper rate. |
| 29 | `base_ul_shaper_rate_kbps` | integer | `20000` | Kbit/s, between min and max | egress | Steady-state upload shaper rate. |
| 30 | `max_ul_shaper_rate_kbps` | integer | `35000` | Kbit/s, ≥ base | egress | Ceiling for the upload shaper rate. |
| 31 | `enable_sleep_function` | integer (bool) | `1` | 0 or 1 | global | Pause all pingers when the connection has been idle, saving CPU and needless ICMP. |
| 32 | `connection_active_thr_kbps` | integer | `2000` | Kbit/s | global | Achieved rate below which a direction counts as idle rather than low-load. |
| 33 | `sustained_idle_sleep_thr_s` | float | `60.0` | seconds | global | How long both directions must stay below `connection_active_thr_kbps` before the pingers sleep. |
| 34 | `min_shaper_rates_enforcement` | integer (bool) | `0` | 0 or 1 | global | Drop both shapers to their configured minimum rates on connection idle or stall. |
| 35 | `startup_wait_s` | float | `0.0` | seconds, ≥ 0 | global | Delay before the daemon starts work (lets interfaces settle after a reboot). |
| 36 | `log_file_buffer_size_B` | integer | `512` | bytes | global | Size of the write buffer in front of the log file. |
| 37 | `log_file_buffer_timeout_ms` | integer | `500` | milliseconds | global | Flush the log buffer after this long even if it is not full. |
| 38 | `log_file_export_compress` | integer (bool) | `1` | 0 or 1 | global | gzip exported log files and append `.gz` to the export filename. |
| 39 | `ping_extra_args` | string | `""` | raw argument string, may be empty | global | Extra arguments appended to the ping/fping command line (e.g. `-I wwan0 -m $((0x300))`). No error checking upstream. |
| 40 | `ping_prefix_string` | string | `""` | raw command prefix, may be empty | global | Wrapper command prefixed to the ping binary (e.g. `mwan3 use gpon exec`). The wrapper must `exec` ping, not fork it. |
| 41 | `monitor_achieved_rates_interval_ms` | integer | `200` | milliseconds | global | How often achieved rx/tx byte counters are sampled. Auto-adjusted for max on-wire packet size. |
| 42 | `bufferbloat_detection_window` | integer | `6` | samples, > `bufferbloat_detection_thr` | global | Number of recent delay samples retained in the detection window. |
| 43 | `bufferbloat_detection_thr` | integer | `3` | samples, ≤ window | global | Number of delayed samples within the window that triggers a bufferbloat event. |
| 44 | `alpha_baseline_increase` | float | `0.001` | EWMA alpha, 0–1 | global | How rapidly the OWD baseline is allowed to rise (slow, so path changes are tracked without masking bufferbloat). |
| 45 | `alpha_baseline_decrease` | float | `0.9` | EWMA alpha, 0–1 | global | How rapidly the OWD baseline is allowed to fall (fast, to track the shortest path). |
| 46 | `alpha_delta_ewma` | float | `0.095` | EWMA alpha, 0–1 | global | Smoothing factor applied to the OWD delta from baseline. |
| 47 | `shaper_rate_min_adjust_down_bufferbloat` | float | `0.99` | multiplier, 0–1 | global | Smallest shaper-rate reduction factor applied on a bufferbloat event. |
| 48 | `shaper_rate_max_adjust_down_bufferbloat` | float | `0.75` | multiplier, 0–1 | global | Largest shaper-rate reduction factor, applied at `*_avg_owd_delta_thr_ms`. |
| 49 | `shaper_rate_adjust_up_load_high` | float | `1.04` | multiplier, ≥ 1 | global | Shaper-rate increase factor while load is high and no bufferbloat is seen. |
| 50 | `shaper_rate_adjust_down_load_low` | float | `0.99` | multiplier, 0–1 | global | Decay factor bringing an above-base rate back down toward base on low/idle load. |
| 51 | `shaper_rate_adjust_up_load_low` | float | `1.01` | multiplier, ≥ 1 | global | Decay factor bringing a below-base rate back up toward base on low/idle load. |
| 52 | `high_load_thr` | float | `0.75` | fraction of current shaper rate, 0–1 | global | Achieved-rate fraction above which the load is classified "high" (converted internally to a percent). |
| 53 | `bufferbloat_refractory_period_ms` | integer | `300` | milliseconds | global | Minimum gap between successive bufferbloat-driven rate reductions; should exceed the time to refill the detection window. |
| 54 | `decay_refractory_period_ms` | integer | `1000` | milliseconds | global | Minimum gap between successive decay (toward-base) rate changes. |
| 55 | `reflector_health_check_interval_s` | float | `1.0` | seconds | global | How often reflector health is evaluated. |
| 56 | `reflector_response_deadline_s` | float | `1.0` | seconds | global | A reflector response later than this counts as an offence against that reflector. |
| 57 | `reflector_misbehaving_detection_window` | integer | `60` | samples/health-check ticks | global | Window length over which reflector offences are counted. |
| 58 | `reflector_misbehaving_detection_thr` | integer | `3` | offences, ≤ window | global | Offences within the window before a reflector is deemed misbehaving and replaced. |
| 59 | `reflector_replacement_interval_mins` | integer | `60` | minutes | global | How often a random live reflector is proactively swapped for a spare. |
| 60 | `reflector_comparison_interval_mins` | integer | `1` | minutes | global | How often live reflectors are compared against each other (drives `REFLECTOR` lines). |
| 61 | `reflector_sum_owd_baselines_delta_thr_ms` | float | `20.0` | milliseconds | global | Max allowed excess of a reflector's summed OWD baselines over the minimum before rotation. |
| 62 | `reflector_owd_delta_ewma_delta_thr_ms` | float | `10.0` | milliseconds | global | Max allowed excess of a reflector's OWD delta EWMA over the minimum before rotation. |
| 63 | `stall_detection_thr` | integer | `5` | multiples of the ping response interval | global | No reflector response for this many intervals is one of the two stall conditions. |
| 64 | `connection_stall_thr_kbps` | integer | `10` | Kbit/s | global | Achieved rate below which, combined with no ping responses, the connection is declared stalled. |
| 65 | `global_ping_response_timeout_s` | float | `10.0` | seconds | global | With no ping response at all for this long, shaper rates are forced to their minimums. |
| 66 | `if_up_check_interval_s` | float | `10.0` | seconds | global | How often to re-check that the interfaces' rx/tx byte files exist (boot / sleep recovery). |

**Row count: 66.**

---

## 5. Count reconciliation

| Measurement | Value |
| --- | --- |
| `grep -cE '^[A-Za-z_]+=' defaults.sh` | 66 |
| Upstream's own extraction `grep -E '^[^(#\| )].*=' defaults.sh \| sed -e 's/[\t ]*\#.*//g' -e 's/=.*//g' \| wc -l` | 66 |
| Option rows in section 4 | 66 |
| **Match** | ✅ yes |

The two grep expressions were diffed line-by-line and produce an **identical**
list of names, so the simple `^[A-Za-z_]+=` form is a faithful stand-in for the
daemon's own `valid_config_entries` derivation.

Additional notes so future counts reconcile:

* `grep -cE '^[A-Za-z_]+=' config.primary.sh` returns **15**. Those 15 names
  (`dl_if`, `ul_if`, `adjust_dl_shaper_rate`, `adjust_ul_shaper_rate`,
  `min_dl_shaper_rate_kbps`, `base_dl_shaper_rate_kbps`,
  `max_dl_shaper_rate_kbps`, `min_ul_shaper_rate_kbps`,
  `base_ul_shaper_rate_kbps`, `max_ul_shaper_rate_kbps`,
  `connection_active_thr_kbps`, `output_processing_stats`, `output_load_stats`,
  `output_reflector_stats`, `output_summary_stats`) are a **strict subset** of
  the 66. `config.primary.sh` adds no options; it only pre-populates the ones
  most users touch. The authoritative count is therefore `defaults.sh`'s 66.
* `reflectors=(` is a multi-line bash array. It is a **single** option and is
  matched exactly once by both greps (the closing `)` line does not match).
* `config_file_check` is a legacy key that the daemon explicitly exempts from
  validation but that no longer exists in `defaults.sh`. It is **not** an
  option and is not counted; do not emit it.

---

## 6. Notes for downstream tasks

**Task 2 (Makefile):** use `PKG_VERSION:=3.2.2` and the `PKG_HASH` in §1. Install
into `/usr/lib/cake-autorate` (already in upstream's `POSSIBLE_SCRIPT_PREFIXES`).
`cake-autorate.template` and `launcher.sh.template` contain `%%SCRIPT_PREFIX%%`
and `%%CONFIG_PREFIX%%` placeholders that upstream's `setup.sh` substitutes —
the package should substitute them at install time rather than run `setup.sh`.
Runtime dependencies: `bash` (bashisms throughout: `EPOCHREALTIME`, `mapfile`,
`printf -v`, namerefs), `fping` (default `pinger_binary`), `tc`/`kmod-sched-cake`.

**Task 3 (UCI schema):** exactly these 66 names, no more. Types must map to the
`typeof` classes in §2.3 — the schema needs a "float" notion distinct from
"integer" or the bridge will emit type-invalid values.

**Task 4 (config bridge):** must (a) emit only the 66 valid keys, (b) format
floats with a decimal point and integers without, (c) never emit negatives,
(d) never emit an empty string for `dl_if`/`ul_if`/`pinger_binary`, (e) emit
`reflectors` as a bash array literal, and (f) force the package-managed logging
options in §3.4 (`log_to_file=1`, `output_summary_stats=1`).

**Task 6 (statistics parser):** parse
`/var/log/cake-autorate.<instance_id>.log`, split on `"; "`, key off field 0
being `SUMMARY`, and use the 13-field layout in §3.3. Handle the rotation
artefact `${log_file_path}.old` (§3.3.2), the unprefixed `SUMMARY_HEADER` line
and the mid-line fragment a live log always ends with (§3.3.1).

**Task 7 (LuCI):** the version string to display is the package version
(`3.2.2`), not `cake_autorate_version` (stale `3.2.1` upstream at this tag).
