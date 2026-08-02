# Configuration reference

How to configure cake-autorate through UCI (`/etc/config/cake-autorate`) and the
LuCI UI (**Network → Cake Autorate**). Every option here is one of the 66 the
upstream daemon actually implements; see
[`upstream-option-inventory.md`](upstream-option-inventory.md),
[`uci-schema.md`](uci-schema.md) and
[`uci-option-schema.tsv`](uci-option-schema.tsv) for the authoritative list and
strict typing.

## One section per instance

Each `config cake-autorate '<name>'` section is one independent daemon instance.
**The section name is the instance id** and must match `[A-Za-z0-9_]+`. It names
everything derived from the instance:

| Thing | Path |
| --- | --- |
| Generated daemon config | `/etc/cake-autorate/config.<name>.sh` |
| Log / status / stats source | `/var/log/cake-autorate.<name>.log` |

There is no global/shared section, so two instances can never collide. Add a
second section for a second WAN (see **Multi-instance**, below).

## Essentials first

A fresh instance needs only its two interfaces and the min/base/max shaper rates
for each direction — **everything else has a working default**. In LuCI these
live on the **Essentials** tab; in UCI they are the first block of the section:

![The Essentials tab: the Enabled switch, the DL/UL interface pickers each
confirming which live SQM device backs them, and the six min/base/max shaper
rate fields with their units and ordering rules](images/config-essentials.png)

```
config cake-autorate 'primary'
	option enabled '1'

	# Interfaces (see "Interface validation" below)
	option dl_if 'ifb4eth1'          # ingress = the SQM IFB for your WAN
	option ul_if 'eth1'              # egress  = the WAN device itself

	# Rates in Kbit/s; must satisfy  min <= base <= max  per direction
	option min_dl_shaper_rate_kbps '5000'
	option base_dl_shaper_rate_kbps '20000'
	option max_dl_shaper_rate_kbps '80000'
	option min_ul_shaper_rate_kbps '5000'
	option base_ul_shaper_rate_kbps '20000'
	option max_ul_shaper_rate_kbps '35000'
```

Set **base** to your provisioned rate, **min** to the worst rate you will
tolerate, and **max** to the best the line ever achieves. `enabled` is the one
package-local key (it gates procd and is never written to the daemon config);
leave it `0` until the interfaces and rates are correct, then set `1`.

> Interface and rate values are strictly typed. Rates are integers (Kbit/s; a
> `10mbit`-style unit suffix is accepted and normalised). Float options must keep
> their decimal point and no value may be negative — the config bridge rejects a
> malformed value rather than silently passing garbage to the daemon.

### Seed the six rates from SQM

Six unknown numbers on a blank form is the worst part of a fresh install — so
LuCI offers a starting point taken from a number you have already committed to.
Below the rate fields on **Essentials** there is a **Seed rates from SQM**
button. It reads SQM's own configured rates for this instance (the `download` /
`upload` options in `/etc/config/sqm`, returned per interface by the same rpcd
`sqm_interfaces` method that fills the interface pickers) and fills the form:

| Field | Seeded value |
| --- | --- |
| `base_<dir>_shaper_rate_kbps` | the SQM rate |
| `max_<dir>_shaper_rate_kbps` | the SQM rate |
| `min_<dir>_shaper_rate_kbps` | a quarter of the SQM rate, rounded down |

The direction mapping is sqm-scripts': SQM's `download` is the ingress rate and
seeds the `dl_*` trio, SQM's `upload` is the egress rate and seeds `ul_*`. SQM
keys its rates on the **egress** device, so the lookup is by the instance's
`ul_if`. The two directions resolve **independently** — SQM commonly has one rate
set and the other left at `0` — so a usable download rate still seeds the three
download fields, and the other three are left exactly as you had them.

Setting `max` to the SQM rate rather than above it is deliberate: autorate will
not probe past a rate you have not validated. That makes the seed safe and, on a
line that is actually faster, slightly pessimistic — which is precisely what the
[clipping notice](#when-a-bound-is-the-limit-not-the-line) below is for. The two
are one design: seed conservatively, then be told when a bound has become the
limit. `min` is a quarter because `min` is the one value that actively harms when
it is optimistic — it is a hard floor the daemon cannot shape below.

The button **writes into the form only**. Nothing is saved until you press
**Save & Apply**, and you are expected to look at the numbers first. It disables
itself, with a sentence naming the blocker to clear, in four cases:

- SQM is not configured on this router, so there are no rates to read;
- no upload interface has been picked yet, so there is nothing to look up;
- the chosen `ul_if` is not an SQM egress interface (the message lists the ones
  that are);
- SQM's rates for that interface are `0` in **both** directions — `0` is
  sqm-scripts' "no limit" setting, which carries no number to derive from.

### When a bound is the limit, not the line

A bound that is wrong is silent: the daemon starts, logs happily, and either
under-shapes or leaves half the line unused. At the foot of the **Essentials**
tab each instance therefore carries a **clipping notice**, one verdict per
direction, from the read-only rpcd `calibration` method.

It reads the shaper rate collectd has already recorded for the instance
(`bitrate-dl_shaper.rrd` and `bitrate-ul_shaper.rrd` under the statistics
`DataDir`, `/tmp/rrd` unless you moved it) over the **last 7 days**, and asks one
question: did the shaper *sit at* a configured bound instead of moving between
them? A shaper that never leaves a bound is direct evidence that the bound, not
the line, is what limits it — the controller wanted to go further and could not.

| Verdict | Means | What to do |
| --- | --- | --- |
| `pinned-max` | ≥ **90%** of samples within **0.5%** of `max_<dir>_shaper_rate_kbps` | Raise `max` if the connection can carry more. |
| `floored-min` | ≥ 90% of samples within 0.5% of `min_<dir>_shaper_rate_kbps` | Lower `min` so the daemon can shape further down. |
| `ok` | The shaper moved freely between the bounds | Nothing. |
| `insufficient-data` | Fewer than **12** valid samples in the window, or no bound configured to be clipped against | The notice says which of the two. |

The 0.5% tolerance is half the controller's own smallest step (the shipped
`shaper_rate_adjust_up_load_low` / `..._down_load_low` are `1.01` / `0.99`), so a
sample one full step away from a bound can never be counted as clipped. The
90% threshold is high enough that a shaper merely *visiting* a bound while
probing upward does not trigger it.

Every verdict states its evidence — which bound, what share of how many samples,
over how long — because the point is that you can weigh the claim rather than
obey it. That is also why the sample count is always shown: RRD retention is
usually far shorter than the 7-day window (`/tmp/rrd` means "since boot"), and a
verdict drawn from an hour of history deserves less of your trust than one drawn
from a week. Before any statistics exist the notice says so plainly rather than
looking broken or, worse, reporting "fine".

**The notice changes nothing.** `calibration` is granted under ubus `read` only,
there is no apply control anywhere in the UI, and the fix is for you to edit the
field it names and press **Save & Apply**. It is read once when the page loads,
not polled — it summarises days of history and cannot meaningfully change while
you are looking at it.

> **It reads the shaper rate and nothing else.** It does not detect bufferbloat
> events, and a `floored-min` verdict is not a claim that your link was
> bufferbloated. Conditioning the verdict on the load/bufferbloat gauge would be
> unsound: that gauge is *categorical* (`0`/`1`/`2` for idle/low/high, `+10` when
> bufferbloat is flagged) and OpenWrt records AVERAGE-only RRAs, so the mean of
> `2` and `12` is `7`, which denotes nothing at all. The shaper rate is a
> slow-moving continuous value that averages meaningfully, and clipping survives
> every layer of consolidation intact — the average of a clipped constant is that
> constant. See
> [`calibration-investigation.md`](calibration-investigation.md) for the full
> reasoning, including why a built-in speed test was rejected.

## Grouped advanced options

Beyond Essentials, the remaining options are organised into collapsible,
searchable groups. In LuCI they are tabs; the search box
(`input#cake-autorate-filter`) filters fields across **every** group at once so
you can jump straight to an option by name:

| Group (tab) | What it covers |
| --- | --- |
| **Essentials** | Interfaces + min/base/max rates (above). |
| **Shaper rates & response** | How aggressively the rate moves up/down on load and bufferbloat (`shaper_rate_adjust_*`, `high_load_thr`, refractory periods). |
| **Pingers** | Probe binary (`fping`), pinger count and ping interval. |
| **Reflectors** | The ICMP target pool and how misbehaving reflectors are detected and rotated. |
| **Delay & bufferbloat detection** | OWD delta thresholds and the EWMA smoothing that decide when the link is bufferbloated. |
| **Idle, sleep & stalls** | When the link counts as idle/stalled and how pingers sleep to save CPU. |
| **Logging & output** | Which log streams the daemon emits. Some are package-managed — see below. |

Every field except the package-local `enabled` gate is generated by iterating the
66-option inventory, so the LuCI form can never drift from what the daemon
consumes.

Each group is one tab on the instance section — here **Shaper rates & response**:

![The Shaper rates and response tab, showing the per-direction rate adjustment
and load-threshold options with their help text](images/config-shaper-tab.png)

The search box filters fields across every group at once, and reports how many
matched. It matches the **UCI option name** as well as the visible title, which
is how you map a name from the upstream documentation onto a field — searching
`owd` here surfaces all twelve one-way-delay options regardless of which tab
they live on:

![The configuration form filtered by the search term owd, reporting 12 matching
option fields and listing them across both instances](images/config-search.png)

## Interface validation against SQM

`dl_if` and `ul_if` are not free text in LuCI — they are comboboxes populated
from the **live SQM configuration** via the rpcd `sqm_interfaces` method:

- **`ul_if` (egress)** choices come from the WAN devices SQM is configured to
  shape (each `option interface` in `/etc/config/sqm`).
- **`dl_if` (ingress)** choices come from the `ifb4<iface>` devices SQM actually
  created (present under `/sys/class/net`).

If you pick an interface that SQM is configured to shape but whose `ifb4*`
ingress device is **not** live, the field shows a **visible, non-blocking
warning** (a mismatch flag) — for example, SQM says "shape `eth1`" but
`ifb4eth1` does not exist yet. The warning does not stop you saving (you may be
configuring ahead of SQM), but it flags the most common misconfiguration: an
interface cake-autorate cannot actually adjust because SQM has not put a CAKE
qdisc there. Fix it by enabling CAKE for that interface in SQM.

When a choice *is* backed by a live device, the field says so instead — the two
green lines under the interface pickers in the [Essentials
screenshot](#essentials-first) above are that confirmation
(`Backed by the live SQM ingress IFB device "ifb4eth1"`).

Remember the ownership split: **SQM creates the qdisc, cake-autorate only changes
its bandwidth.** If SQM is not shaping an interface, cake-autorate has nothing to
adjust.

## Multi-instance (multi-WAN)

Add one section per WAN, each with its own name, interfaces and rates. The procd
service opens one supervised daemon per **enabled** section and each writes its
own `/var/log/cake-autorate.<name>.log`, so instances are fully isolated — a
crash or restart of one WAN never disturbs another.

Two instances in the LuCI form, each with its own interfaces, rates and full set
of group tabs (`primary` on `eth1`/`ifb4eth1`, `secondary` on `eth0`/`ifb4eth0`):

![The configuration form with two instance sections, PRIMARY and SECONDARY, each
with its own tab strip, interface pickers and shaper rates](images/config-multi-instance.png)

```
config cake-autorate 'primary'
	option enabled '1'
	option dl_if 'ifb4eth1'
	option ul_if 'eth1'
	option min_dl_shaper_rate_kbps '5000'
	option base_dl_shaper_rate_kbps '20000'
	option max_dl_shaper_rate_kbps '80000'
	option min_ul_shaper_rate_kbps '5000'
	option base_ul_shaper_rate_kbps '20000'
	option max_ul_shaper_rate_kbps '35000'

config cake-autorate 'secondary'
	option enabled '1'
	option dl_if 'ifb4eth2'
	option ul_if 'eth2'
	option min_dl_shaper_rate_kbps '2000'
	option base_dl_shaper_rate_kbps '10000'
	option max_dl_shaper_rate_kbps '25000'
	option min_ul_shaper_rate_kbps '1000'
	option base_ul_shaper_rate_kbps '4000'
	option max_ul_shaper_rate_kbps '8000'
```

A section that omits an option simply keeps the package/daemon default for it.
In LuCI, use the add/remove controls on the config page to create and delete
instances. Apply with **Save & Apply**; the service re-runs the config bridge and
reconciles the running instance set (starts newly-enabled, stops disabled,
restarts changed — without disturbing unchanged instances).

## Logging is package-managed (so status and graphs always work)

The daemon's **only** runtime interface is its log stream: both the LuCI status
view and the collectd statistics feed parse the `SUMMARY` lines out of
`/var/log/cake-autorate.<name>.log`. There is no JSON status file.

To guarantee that stream always exists, four logging options are **forced** by
the config bridge regardless of what you set — you cannot accidentally turn off
the data the UI depends on:

| Forced option | Pinned value | Why |
| --- | --- | --- |
| `log_to_file` | `1` | the log file must exist |
| `output_summary_stats` | `1` | the `SUMMARY` lines are what get parsed |
| `log_file_path_override` | `` (empty) | pins the log to the deterministic per-instance path |
| `log_DEBUG_messages_to_syslog` | `0` | keep syslog clean |

Four related options (`log_file_max_time_mins`, `log_file_max_size_KB`,
`log_file_buffer_size_B`, `log_file_buffer_timeout_ms`) are **user-tunable but
clamped** to a sane non-zero range so a bad value can't disable log rotation or
buffering. All other logging/output toggles (`output_load_stats`, `debug`, …) are
freely yours. The **Logging & output** tab marks the managed options in its help
text.

## Reading the statistics graphs

`luci-app-cake-autorate` ships a collectd graph definition, so once the package
is installed and collectd is running you get RRD graphs with **no extra setup**.

1. Go to **Statistics → Graphs** (from `luci-app-statistics`).
2. Select the **CAKE Autorate** plugin. There is **one panel per instance** (the
   collectd plugin instance is the cake-autorate instance id, e.g. `primary`).
3. Each panel graphs, per direction (download/upload):
   - **achieved rate** and **CAKE shaper rate** (Kbit/s) — watch the shaper rate
     track load: it climbs toward `max` under sustained high load and decays back
     toward `base` when the link goes idle;
   - **average one-way-delay delta** (µs) — the latency signal that drives the
     controller;
   - **load / bufferbloat state** — a gauge where `0`/`1`/`2` = idle/low/high
     load and a value `>= 10` means bufferbloat is currently flagged (the load
     level is the value mod 10).

### Statistics caveat

The package drops its collectd config at `/etc/collectd/conf.d/cake-autorate.conf`
and loads the `exec` plugin there itself (the `tail` plugin cannot map the
string load-condition to a number). For this to take effect, collectd's main
config must **Include `/etc/collectd/conf.d`** — the stock
`luci-app-statistics` setup does. If you run a hand-rolled collectd config that
does not include that directory, add it, or the CAKE Autorate graphs will not
appear even though the daemon is logging fine.
