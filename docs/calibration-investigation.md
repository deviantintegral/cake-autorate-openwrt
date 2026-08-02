# Autoconfiguration / calibration — design investigation

**Status: investigation only. Nothing here is implemented or committed to.**

Question asked: should this feed grow a feature that measures the line — speed
test, latency, jitter — and then recommends or sets cake-autorate's settings?

Short answer: **yes, there is a real problem worth solving, but a speed test is
the weakest of the three available instruments and should be the last thing
built, not the first.** The package already collects better data than a speed
test can produce — and then decimates most of it away before it reaches the
statistics feed (§3.1).

---

## 1. The problem is real

A fresh instance ships six rate numbers that are meaningless for any actual
line (`net/cake-autorate/files/cake-autorate.config`):

```
min_dl 5000   base_dl 20000   max_dl 80000
min_ul 5000   base_ul 20000   max_ul 35000
```

The guidance for replacing them — ours in `docs/configuration.md` and
upstream's README alike — is:

> Set **base** to your provisioned rate, **min** to the worst rate you will
> tolerate, and **max** to the best the line ever achieves.

Every one of those is a fact about the link's behaviour *over time* that a new
user does not have and has no on-router way to obtain. Six unknown numbers on a
blank form is the largest onboarding cliff in the package, and it is the one
place where a wrong answer is silent: the daemon starts, logs happily, and
either under-shapes or leaves half the line unused.

Upstream has no calibration, no wizard and no speed test — confirmed by reading
the repo tree at `master`. So this is genuinely unclaimed ground, not something
we would be duplicating.

## 2. Why the speed test is the wrong headline feature

### It answers the least important parameter and cannot answer the most important one

cake-autorate exists *because* the line rate varies. A 30-second saturating test
is a single draw from the distribution you are trying to characterise, taken at
whatever moment the user pressed the button.

- **`max`** is the value a speed test *can* estimate — and it is the most
  forgiving one. The daemon continuously probes upward and backs off on delay,
  so a `max` that is somewhat wrong self-corrects. Upstream even recommends
  setting it *slightly below* the line maximum, because "the algorithm
  repeatedly tests for the maximum rate available, [so] it may permit some
  excess latency at a traffic peak."
- **`min`** is the value that hurts when wrong, and a speed test is
  structurally incapable of producing it. `min` is a hard floor; if the line
  later degrades below it, the daemon *cannot* shape low enough and you get
  sustained bufferbloat — the exact failure the package exists to prevent.
  Upstream's rule is "the lowest possible observed bufferbloat-free bandwidth",
  which is a worst-case observation. A test run at a good moment yields an
  optimistic `min`, i.e. actively harmful output.
- **The delay thresholds** (`dl_owd_delta_thr_ms`, `ul_owd_delta_thr_ms` and
  their `avg_` counterparts, defaulting to 30/60 ms) are what actually decide
  whether the controller is trigger-happy or asleep on a given link — 30 ms is
  lax for clean fibre and jumpy for Starlink. Upstream ships no guidance for
  them at all. **A throughput test tells you nothing about them.**

So the instrument users intuitively ask for measures the parameter that matters
least and stays silent on the two that matter most.

### The costs land on exactly our audience

- **Metered data.** Saturating both directions costs real money on LTE/5G. A
  100 Mbit/s link for 30 s is ~375 MB *per direction*; 300 Mbit/s is ~1.1 GB.
  Those are the links cake-autorate is for.
- **The shaper is in the way.** Measured with the shaper live, you measure your
  own shaper. A correct test has to stop the instance and lift the SQM rate
  first. Today nothing in this feed touches `tc` — AGENTS.md is explicit that
  SQM owns the qdisc and we only change its bandwidth. Calibration would be the
  first component to reach across that line. (Doing it via SQM's UCI +
  `/etc/init.d/sqm restart` stays inside the rule; raw `tc` does not.)
- **Router CPU.** On modest hardware the router is the bottleneck, so you
  calibrate to the CPU's ceiling and then shape to it forever. Only a test that
  reports CPU saturation catches this.
- **Dependency weight.** Both packages are noarch and dependency-light. The
  realistic options are `speedtest-netperf` (pulls `netperf`, and leans on the
  public bufferbloat.net servers whose own README warns that "continuous or
  high-rate use of the servers may result in denied access") or the Go clients
  `speedtest-go` / `librespeed-go` (multi-MB, arch-specific). None of these
  should become a hard dependency of a noarch package.

## 3. We are already sitting on better data

Every instance writes `SUMMARY` lines carrying, per sample: achieved dl/ul rate,
average OWD delta per direction, load condition (`idle`/`low`/`high`, `_bb` on a
bufferbloat event) and the current CAKE shaper rate. The field contract is
pinned in AGENTS.md Invariant 2 and already parsed by two consumers — the rpcd
status method and the collectd exec reader.

That stream contains, for free and continuously, the things a speed test cannot
give:

| Wanted | Available from the log |
| --- | --- |
| `max` | high percentile of achieved rate during `high` load |
| `base` | typical sustained achieved rate under load |
| `min` | how deep the shaper was actually driven during `_bb` events |
| delay thresholds | the idle OWD-delta noise floor and its spread |
| "your bounds are wrong" | shaper pinned at `min` or at `max` for long stretches |

That last row is worth its own feature regardless of everything else: it is a
diagnosis the package can make today and currently does not.

**This is also upstream's own sanctioned tuning workflow.** `ANALYSIS.md` +
`fn_parse_autorate_log.m` tell you to export the log and plot it in
Octave/MATLAB — desktop software, manual interpretation, and, notably, no stated
rules of thumb for what to change afterwards. An on-router "analyse the log and
recommend settings" feature is a direct replacement for a workflow upstream
already endorses but makes painful. That is a much stronger position than
inventing a measurement methodology from scratch.

**The structural limit of passive observation:** it only ever sees rates your
own traffic demanded. If the link is never saturated, `max` is a lower bound and
must be reported as one. That — and only that — is the gap an active test fills.

### 3.1 Use the statistics feed we already ship

The raw log retains only ~10 minutes plus one rotation
(`log_file_max_time_mins 10`, `log_file_max_size_KB 2000`), so it cannot be the
history source on its own. But the retained history already exists: the collectd
exec reader feeds RRDs, and **`luci-app-cake-autorate` already hard-depends on
`luci-app-statistics`** (`LUCI_DEPENDS`), which pulls `collectd-mod-rrdtool` and
`rrdtool1`. Wherever the UI is installed, the per-instance RRDs *and* the
`rrdtool` binary to read them back are guaranteed present. A stats-driven
calibrator needs **no new dependency** — which makes it markedly cheaper than
accumulating a bespoke digest of our own.

The catch is that the data is decimated twice before it lands:

1. **Our reader keeps one sample per interval.** `cake-autorate-collectd.sh`
   takes `tail -n 1000 | grep '^SUMMARY; ' | tail -n 1` — a single
   *instantaneous* sample per 30 s tick, out of a stream emitting many per
   second. Correct for a status-graph feed; lossy for statistics.
2. **OpenWrt sets `RRASingle '1'`** in `luci_statistics`, so collectd creates
   **AVERAGE-only RRAs — no MIN, no MAX**. With `RRARows 288` over
   `2hour 1day 1week 1month 1year`, 1-week rows average ~35 minutes each and
   1-year rows ~30 hours.

What survives, per parameter:

| Signal | Survives decimation? |
| --- | --- |
| Peak achieved rate (→ `max`) | Poorly — spot-sampled, then averaged. Only the 2-hour RRA (~25 s/row) is near-raw. |
| Bufferbloat events (→ `min`) | No. `_bb` is transient and rarely sampled; and averaging a categorical gauge (0/1/2/10/11/12) is meaningless — the mean of 2 and 12 is 7, which denotes nothing. |
| **Shaper rate** | **Yes.** A slow-moving state variable: spot sampling represents it fairly and averaging it is meaningful. |

**So calibrate off the shaper rate, not off throughput.** `min`/`base`/`max` are
bounds on a quantity the daemon already estimates continuously — the analyser is
not measuring the line, it is reading back the controller's own standing opinion
of it, which is what a speed test was a crude proxy for in the first place.

**Clipping is the highest-confidence signal and needs no changes at all.** If
the shaper sits pinned at the configured `max` for long stretches, `max` is too
low; if it is floored at `min` while bufferbloat is being flagged, `min` is too
high. Clipping survives every layer of averaging — the average of a clipped
constant is that constant.

To go beyond clipping, fix the decimation at the source rather than working
around it: have the exec reader aggregate over *all* `SUMMARY` lines since the
last tick instead of `tail -1`, emitting per-interval max achieved rate, min
shaper rate, a bufferbloat-event count and a high percentile of OWD delta as
additional metrics. AVERAGE-only RRAs then become calibration-grade, because
what is averaged is per-interval maxima rather than smeared spot samples. The
change is additive — new DS names create new RRD files and existing graphs are
untouched — but it costs reader CPU (it runs as `nobody` on possibly low-power
hardware) and it moves the collectd field contract, so both parsers have to
change in lockstep.

**Retention caveat.** `DataDir` defaults to `/tmp/rrd`, so history is since-boot
unless the user has moved `rrd_storage_path` to persistent storage. The feature
must report the window it actually has data for rather than assume a year of it.

## 4. The cheapest win is neither of those

The rpcd backend already parses `/etc/config/sqm` for interfaces
(`do_sqm_interfaces`), but ignores SQM's configured `download` / `upload` rates
— numbers the user has already entered and already believes.

Seeding a fresh instance from them (`base` = the SQM rate, `max` at or slightly
above it, `min` at a deliberately conservative fraction) turns "six blank
numbers" into "six plausible numbers to accept or edit". No new dependency, no
new architectural boundary, no data cost, no measurement methodology to defend.
Highest value per unit of risk on this whole page.

## 5. Recommendation — three stages, in this order

**Stage 1 — seed and explain (build this).**
Extend the rpcd `sqm_interfaces` method to also return SQM's configured rates;
add a "seed rates from SQM" action to the Essentials tab for an unconfigured
instance; add a short "how to pick these six numbers" section to
`docs/configuration.md`. Removes most of the cliff for near-zero cost and risk.

**Stage 2 — recommendations from the statistics we already collect (the actual
feature).** A Calibration view that reads the per-instance RRDs with the
`rrdtool` binary `luci-app-statistics` already brings, and *recommends*
`min`/`base`/`max` **and the OWD delta thresholds**, with an explicit Apply step
and a stated confidence and window ("based on 4 days of history; the link was
never saturated in it, so max is a lower bound"). Build it in two steps:

- **2a — clipping diagnosis.** Works against today's RRDs unmodified: report
  when the shaper is pinned at the configured `max`, or floored at `min` while
  bufferbloat is flagged, and recommend the bound that is wrong. Highest
  confidence per unit of work on this page, and it survives the AVERAGE-only
  consolidation intact (§3.1).
- **2b — distribution-based values.** Requires the exec reader to emit
  per-interval aggregates instead of one spot sample (§3.1) so the RRDs become
  calibration-grade. Then derive `base`/`max` from the shaper-rate distribution,
  `min` from how far bufferbloat actually drove it down, and the delay
  thresholds from the idle OWD-delta noise floor.

This is the differentiated feature: it is the only one of the three that can
tune the delay thresholds, it costs no data and no new dependency, and it reuses
both the log-stream interface AGENTS.md declares canonical and the stats
pipeline built on top of it.

**Stage 3 — active test, optional, only if still wanted.**
Runtime-detected optional dependency, never a hard one. Explicit data-cost
estimate before it runs. Stops the instance and lifts the shaper via SQM's UCI,
not raw `tc`. Reports router CPU saturation. Feeds the `max` estimate *only* —
never `min`. Framed as "measure the ceiling", not "configure my connection".

If only one stage is ever built, build Stage 1. If two, Stage 1 and 2. Stage 3
is the part most likely to be wrong in ways users will attribute to
cake-autorate rather than to the test.

## 6. Constraints any implementation must respect

- **The bridge allows exactly the 66 upstream options plus `enabled`.** An
  unrecognised option inside a `config cake-autorate` section is fatal — the
  bridge's unknown-key guard skips the whole section ("unknown UCI option … not
  one of the 66 upstream options" in `cake-autorate-bridge.sh`), and the
  bidirectional coverage assertion (Invariant 1) will not tolerate a stray key
  on the other side either. Calibration
  state (last run, retained samples, recommendations) therefore **cannot** live
  in the instance section. It needs its own UCI section type or a file outside
  UCI.
- **Invariant 2 stands.** Read the log stream; do not invent a daemon status
  file. A calibration report is our artifact, not a daemon status surface, and
  should not be confusable with one.
- **The collectd field contract is shared.** The rpcd status method and the
  exec reader parse the same 13-field `SUMMARY` line. Enriching the reader with
  per-interval aggregates (§3.1) moves that contract, so both parsers and
  `tests/statistics/test-collectd-parser.sh` change together. Keep new metrics
  additive — new DS names, so existing RRDs and graphs keep working.
- **SQM owns the qdisc.** Anything that changes shaping during a measurement
  goes through SQM's config, not `tc`.
- **Both packages are noarch.** Keep it that way; no hard dependency on an
  arch-specific test binary.
- **Never auto-apply an optimistic `min`.** Whatever the source, `min` should be
  derived conservatively and be the value the UI most encourages review of.
