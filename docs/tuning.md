# Tuning on a radio link (5G / LTE / WISP)

cake-autorate's defaults assume the queue it can see is the queue that matters.
On a radio uplink that assumption breaks, and the failure is not subtle: the
daemon parks the shaper on `min_ul_shaper_rate_kbps` and stays there.

This page explains why, and how to measure your way out of it with
`cake-autorate-probe`, the diagnostic this package installs at
`/usr/bin/cake-autorate-probe`.

## The failure mode: a controller with no fixed point

On a 5G/LTE/WISP link a large part of the loaded latency comes from the **RAN
uplink scheduler** — the radio's own grant/queue machinery, downstream of your
router. No shaper can remove it: it is not in a queue you own.

cake-autorate does not know that. It compares measured one-way-delay deltas
against `ul_owd_delta_thr_ms`, and if the threshold sits **below** the radio's
own delay floor:

1. every interval looks like bufferbloat, forever;
2. each detection cuts the shaper (up to 25% per 300 ms);
3. from a 10 Mbit base that reaches `min_ul_shaper_rate_kbps` in about **1.5
   seconds**;
4. the delay does not fall, because it was never yours to remove — so the
   detector keeps firing.

There is no stable operating point above the floor. On the graphs it looks like
a link that "collapsed"; in the `SUMMARY` log it is `ul_high_bb` on essentially
every line. Raising the shaper rates does nothing; only the **threshold** moves
the fixed point.

The opposite mistake looks identical from the outside: if the shaper is set
*above* what the link can actually carry, the queue simply forms past your
router and latency climbs with an empty local queue. Same symptom, opposite fix.
So the first job is to tell the two apart.

## What the probe measures

CAKE knows which of the two is happening, and says so in one number: its own
**egress backlog**. The egress qdisc is the only one that queues on upload, so:

| Observation during upload | Meaning | What to do |
| --- | --- | --- |
| **backlog > 0** | CAKE is holding the queue. SQM is working; the residual latency is the radio's floor. | Raise `ul_owd_delta_thr_ms` above the measured excess. Shaping harder buys nothing. |
| **backlog ≈ 0, latency climbing** | The queue has moved past your router — the shaper is above real capacity. | Lower `base_ul_shaper_rate_kbps` until a backlog appears. |

`cake-autorate-probe` samples `tc -s qdisc show` at 4 Hz alongside `fping`,
isolates the **upload-saturation window** (detected from the qdisc's `Sent` byte
counter, not from speedtest's output), and reports the latency and backlog for
that window separately from the rest of the run.

It needs only what the package already depends on — `tc` and `fping`. The Ookla
`speedtest` CLI is optional: if one is on `PATH` (or `./speedtest` exists in the
current directory) the probe drives it to generate load; otherwise it samples
for 40 seconds while **you** generate the upload load.

## Tune against sparse ICMP, not the speedtest's loaded latency

The number the probe highlights is measured with **sparse ICMP** — the same
signal cake-autorate's own reflectors use, at a comparable probe rate. That is
the whole point: it is directly comparable to `ul_owd_delta_thr_ms`.

A speedtest's built-in "loaded latency" measures the delay experienced by **its
own bulk flows**, which sit at the back of a queue their own traffic created. It
routinely reads about **twice** the sparse-ICMP figure. Tune against that number
and you set a threshold so high the detector never fires — which trades the
collapse for a shaper that never responds to real bufferbloat at all.

If you take one thing from this page: the two numbers are not interchangeable,
and only one of them is in the same units as the daemon's decision.

## Running it

```sh
# stop the daemon first: while it runs it is moving the very shaper rate the
# report compares against, so the measurement chases a moving target.
/etc/init.d/cake-autorate stop

# -s pins the speedtest server: a server that differs between runs is the
#    single biggest source of noise in these measurements.
cake-autorate-probe -r 1.1.1.1 -s 12345
```

With one SQM queue enabled there is nothing to choose, so the probe reads the
interface out of SQM's own config and says which one it took:

```
cake-autorate-probe: no -i given: measuring eth1, the egress SQM is configured to shape
```

| Flag | Meaning |
| --- | --- |
| `-i` | egress interface carrying the CAKE qdisc (the instance's `ul_if`). **Default: derived from SQM** — see below |
| `-r` | ICMP reflector to sample RTT against |
| `-s` | Ookla speedtest server id — pin it |
| `-b` | seconds of idle baseline before load (default 10) |
| `-h` | print the header comment, which is the usage text |

### Which interface gets measured

SQM owns the CAKE qdisc, so with no `-i` the probe asks SQM: it enumerates the
`queue` sections in `/etc/config/sqm` (through the `uci` CLI), keeps the enabled
ones, and reads their `interface` option.

- **Exactly one** — it uses that interface and prints the line above. Nothing
  about the run is left implicit.
- **None** — it stops and asks for `-i`, because there is nothing to derive
  from.
- **Several** (multi-WAN) — it stops and **lists the candidates** rather than
  picking one, since measuring the wrong WAN produces a confident report about
  a link you were not asking about:

  ```
  cake-autorate-probe: SQM shapes more than one interface; pass -i to choose:
      -i eth1
      -i wwan0
  ```

An `ifb4*` device is **never** auto-selected. It is the ingress half; the
egress qdisc is the only one that queues on upload, so measuring the ifb would
not fail loudly — it would quietly invert the verdict. Pass `-i` explicitly if
you ever genuinely want one.

Run it two or three times before believing a number. It exits non-zero if `tc`
or `fping` is missing, if the interface could not be derived, or if the
interface has no CAKE qdisc (which usually means SQM is not running, or `-i`
names the wrong device).

## Reading the report

Abridged output from a run against a 9500 Kbit upload shaper on a 5G WISP link:

```
-- ICMP RTT to 1.1.1.1, idle baseline (ms)
  p50     25.4   p95     25.8   p99     25.8   max     25.8   (n=38)

-- ICMP RTT to 1.1.1.1, whole load phase, up+down (ms)
  p50     91.0   p95     94.0   p99     94.0   max     94.0   (n=96)

-- ICMP RTT during UPLOAD SATURATION only (ms)  <-- tune against this
  p50     91.0   p95     94.0   p99     94.0   max     94.0   (n=90)

-- CAKE egress backlog during upload saturation (bytes)
  p50  18820.0   p95  18820.0   p99  18820.0   max  18820.0   (n=76)

-- per-second timeline ('*' = upload saturation)
   shaper / ul rate / backlog / drops-per-sec / rtt mean / rtt max
  * +04s    9500 Kbit  ul   9280 Kbit  backlog   18820 B  drops    0  rtt   91.5 /   93.0 ms
  * +05s    9500 Kbit  ul   9280 Kbit  backlog   18820 B  drops    0  rtt   90.4 /   94.0 ms

-- verdict
  measured over: upload saturation
  idle p50 25.4 ms -> loaded p95 94.0 ms  (excess 68.6 ms)
  peak CAKE egress backlog: 18820 bytes = 15.8 ms at 9500 Kbit
  => CAKE IS holding the egress queue, and only 15.8 ms of the
     68.6 ms excess is CAKE's own queue. The rest is downstream
     of your shaper (RAN scheduling / modem) and no shaper can remove
     it. Set ul_owd_delta_thr_ms above 68.6 ms with margin, or
     cake-autorate will cut the rate forever chasing it.
```

What each block is for:

- **idle baseline** — the link's unloaded RTT. Everything else is read as an
  excess over this p50.
- **whole load phase** — download *and* upload. Useful context, wrong number to
  tune against: the egress qdisc does not queue while you are downloading, so
  this dilutes the upload signal.
- **upload saturation only** — the window where the offered egress rate is
  within striking distance of the shaper rate. This is the number that is
  comparable to `ul_owd_delta_thr_ms`.
- **backlog** — the diagnosis. Non-zero means CAKE owns the queue; the report
  converts the peak to milliseconds (`bytes × 8 / shaper Kbit`) so you can see
  how much of the excess is genuinely CAKE's.
- **timeline** — per-second, with `*` marking the isolated upload window, for
  spotting a run where load never materialised or the shaper moved mid-run.

If the window is reported as **NOT FOUND**, no sample reached 50% of the shaper
rate: the upload phase was shorter than the sample interval, or no load
materialised. Re-run with a longer upload.

## Turning the number into a threshold

With `backlog > 0` and an excess of *E* ms over the idle p50:

1. Set `ul_owd_delta_thr_ms` **above E, with margin** — round up rather than
   sitting on the measurement (in the run above, 68.6 ms → 75).
2. Leave the shaper rates alone. They were never the problem in this case.
3. Start the daemon and watch its own `SUMMARY` stream, which is the authority
   on what the controller actually sees:

   ```sh
   /etc/init.d/cake-autorate start
   grep '^SUMMARY' /var/log/cake-autorate.<instance>.log | tail -40
   ```

   Field 8 is `UL_AVG_OWD_DELTA_US` (microseconds) and field 10 is
   `UL_LOAD_CONDITION`, counting from field 0 == `SUMMARY` — see
   [`upstream-option-inventory.md`](upstream-option-inventory.md) §3. Under
   sustained upload you want the delta to stay **below** your new threshold and
   the condition to be `ul_high`, not `ul_high_bb`, with the CAKE UL rate
   holding well above `min_ul_shaper_rate_kbps`.
4. If the shaper still collapses, the threshold is still under the floor —
   re-measure and raise again. If bufferbloat now never registers at all, you
   have gone too far (or the backlog told you to lower the shaper rate instead).

The same reasoning applies to `dl_owd_delta_thr_ms`, but the probe does not
measure it: the download queue lives on the `ifb4*` ingress device, where the
"backlog" is an artefact of ingress shaping rather than a real queue you can
reason about the same way. Downlink RAN buffering is also usually the smaller
problem.

## Field result

A 50/10 5G WISP link, measured with this tool:

| | Upload |
| --- | --- |
| Unshaped ceiling | 10.46 Mbps |
| With `ul_owd_delta_thr_ms = 35` (daemon collapsing to its floor) | 3.50 Mbps |
| With `ul_owd_delta_thr_ms = 75` (from the measured excess) | **8.83 Mbps** — 84% of the ceiling |

The daemon's own `SUMMARY` stream corroborated the diagnosis: under sustained
high load the UL average OWD delta never exceeded **38 ms**, while the
speedtest's in-band loaded latency reported roughly **82 ms** of excess over
idle. Tuning against the speedtest's number would have set a threshold more than
twice as high as anything the controller ever measures.

## Caveats

- The probe reports the **upload** direction only. That is where the RAN
  scheduling floor lives, and it is the only direction whose queue CAKE holds on
  a device you can watch directly.
- Sub-second sampling needs a busybox built with fractional `sleep` (or the
  `usleep` applet). Without either, the probe falls back to 1 Hz and says so —
  a queue that fills and drains in milliseconds is badly undersampled there, so
  treat a 1 Hz run's backlog figures as a lower bound.
- The run is a snapshot of the radio conditions at that moment. A link that is
  fine at 03:00 and congested at 21:00 will report two different floors; tune
  for the worse one.
- The parsers behind all of this (`tc` rate-unit normalisation, the qdisc
  parser, the saturation window, the percentile helper, the RTT sampler, and
  the SQM interface derivation including its ifb4 guard) are covered off-device
  by [`tests/probe/test-probe.sh`](../tests/probe/test-probe.sh).
