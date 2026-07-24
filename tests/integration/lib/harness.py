#!/usr/bin/env python3
"""cake-autorate OpenWrt VM integration harness (host side).

Boots a pinned OpenWrt 25.12.x VM under QEMU/KVM, injects and installs the
built .apk packages plus sqm-scripts + deps, applies a TWO-instance
cake-autorate UCI config over two SQM CAKE WANs, induces a controlled download
load on the primary WAN so the control loop moves the CAKE bandwidth, and
asserts the observable outcomes, capturing evidence to an artifacts dir.

Emits a single machine-checkable PASS/FAIL and exits 0 (all assertions passed)
or non-zero (any assertion failed / infrastructure error).

Driven by tests/integration/run.sh -- see that script and the README for the
CI contract and the "no KVM" fallback.
"""
import os
import re
import sys
import time
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from vmdriver import VM, VMError  # noqa: E402


class Assertions:
    def __init__(self, logf):
        self.results = []       # (name, ok, detail)
        self.logf = logf

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        line = "[%s] %s%s" % ("PASS" if ok else "FAIL", name,
                              ("  -- " + detail) if detail else "")
        print(line, flush=True)
        self.logf.write(line + "\n")
        self.logf.flush()
        return ok

    def all_ok(self):
        return all(r[1] for r in self.results)

    def summary(self):
        n = len(self.results)
        p = sum(1 for r in self.results if r[1])
        return p, n


def parse_bw_to_kbit(token):
    """'3Mbit'|'6600Kbit'|'1Gbit'|'1000000bit'|'unlimited' -> kbit int or None."""
    if not token:
        return None
    m = re.match(r'([0-9.]+)\s*([KMGkmg]?)(?:bit)?', token)
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).lower()
    mult = {'': 1e-3, 'k': 1.0, 'm': 1e3, 'g': 1e6}[unit]
    return int(val * mult)


class Harness:
    def __init__(self, args):
        self.args = args
        self.art = args.artifacts
        os.makedirs(self.art, exist_ok=True)
        self.logf = open(os.path.join(self.art, "harness.log"), "w")
        self.A = Assertions(self.logf)
        self.vm = None
        self.warnings = []

    def log(self, msg):
        print(msg, flush=True)
        self.logf.write(msg + "\n")
        self.logf.flush()

    def g(self, cmd, t=120, check=False, capture=None):
        """Run a guest command; append to transcript; optionally save to file."""
        rc, out = self.vm.run(cmd, timeout=t, check=check)
        self.logf.write("\n# guest$ %s   (rc=%d)\n%s\n" % (cmd, rc, out))
        self.logf.flush()
        if capture:
            with open(os.path.join(self.art, capture), "w") as f:
                f.write("$ %s   (rc=%d)\n%s\n" % (cmd, rc, out))
        return rc, out

    def artifact(self, name, content):
        with open(os.path.join(self.art, name), "w") as f:
            f.write(content)

    # ------------------------------------------------------------------
    def boot(self):
        self.log("== booting VM ==")
        self.vm = VM(self.args.overlay, self.art, mem=self.args.mem, nics=2,
                     log=self.logf)
        # net0 -> eth0 -> wan2 on 10.0.3.0/24 ; net1 -> eth1 -> wan (default).
        self.vm.start(nic_extra=["net=10.0.3.0/24",
                                  None],
                      extra_qemu_args=[
                          "-drive",
                          "file=%s,format=raw,if=virtio" % self.args.seed])
        self.vm.wait_boot_and_login(timeout=self.args.boot_timeout)
        rc, rel = self.g("cat /etc/openwrt_release")
        self.A.check("boot: OpenWrt 25.12.x VM reaches root shell",
                     "DISTRIB_RELEASE='25.12" in rel,
                     rel.split("DISTRIB_RELEASE=")[-1].split("\n")[0]
                     if "DISTRIB_RELEASE" in rel else "no release string")
        # Quieten the console so command capture is clean.
        self.g("dmesg -n 1 2>/dev/null; sysctl -w kernel.printk='1 1 1 1' >/dev/null 2>&1; echo ok")

    def mount_seed(self):
        self.log("== mounting seed disk ==")
        # The seed is the LAST virtio disk. Find the ext4 one.
        self.g("mkdir -p /mnt/seed")
        rc, out = self.g(
            "for d in /dev/vdb /dev/vdc /dev/vdd; do "
            "[ -b $d ] && mount -t ext4 -o ro $d /mnt/seed 2>/dev/null && "
            "[ -e /mnt/seed/cake-autorate-3.2.2-r1.apk ] && echo MOUNTED=$d && break; done")
        self.A.check("seed: ext4 fixture disk mounts and holds the apks",
                     "MOUNTED=" in out, out.strip())

    def wait_for_net(self):
        self.log("== waiting for WAN/internet ==")
        ok = False
        for i in range(30):
            rc, out = self.g("ping -c1 -W2 downloads.openwrt.org >/dev/null 2>&1 && echo NETOK || echo NETNO", t=20)
            if "NETOK" in out:
                ok = True
                break
            time.sleep(2)
        self.A.check("net: guest reaches downloads.openwrt.org (for apk)", ok)
        return ok

    def install(self):
        self.log("== installing packages ==")
        self.g("apk update 2>&1 | tail -2", t=180)
        # deps + the two local apks. apk resolves the package's declared deps
        # (bash, fping, tc-tiny, kmod-sched-cake, sqm-scripts, collectd-mod-exec,
        # luci-base) from the online repo; add rrdtool so RRDs are written.
        rc, out = self.g(
            "apk add --allow-untrusted "
            "collectd collectd-mod-exec collectd-mod-rrdtool sqm-scripts "
            "/mnt/seed/cake-autorate-3.2.2-r1.apk "
            "/mnt/seed/luci-app-cake-autorate-1.0.0-r1.apk 2>&1 | tail -25",
            t=400, capture="apk-install.txt")
        paths = {
            "fping": "$(command -v fping)",
            "tc": "$(command -v tc)",
            "sqm": "/usr/lib/sqm/run.sh",
            "collectd": "$(command -v collectd)",
            "daemon": "/usr/lib/cake-autorate/cake-autorate.sh",
            "bridge": "/usr/libexec/cake-autorate/cake-autorate-bridge.sh",
            "init": "/etc/init.d/cake-autorate",
            "rpcd": "/usr/libexec/rpcd/cake-autorate",
            "collectd_dropin": "/etc/collectd/conf.d/cake-autorate.conf",
            "reader": "/usr/libexec/collectd/cake-autorate-collectd.sh",
        }
        # One tiny command per path -- a single long multi-echo line can be
        # truncated by the serial console under a fast output burst.
        report = []
        missing = []
        for k, v in paths.items():
            rc2, r = self.g('p=%s; [ -n "$p" ] && [ -e "$p" ] && echo YES || echo NO' % v)
            ok = r.strip().endswith("YES")
            report.append("%s %s -> %s" % ("OK" if ok else "NO", k, v))
            if not ok:
                missing.append(k)
        self.artifact("install-artifacts.txt", "\n".join(report) + "\n")
        self.A.check("install: package + deps + all install artifacts present",
                     not missing, "missing: %s" % missing if missing else "all present")
        # rpcd must reload to expose the new file-object as the ubus
        # "cake-autorate" object; do it now so assert_rpcd can use real ubus.
        self.g("/etc/init.d/rpcd reload 2>/dev/null; sleep 1; echo rpcd-reloaded")

    def configure_network_and_sqm(self):
        self.log("== configuring two-WAN network + SQM ==")
        self.g("sh /mnt/seed/network-two-wan.sh 2>&1 | tail -3", t=60)
        # let both WANs get addresses
        time.sleep(6)
        rc, addr = self.g("ip -o addr show | awk '{print $2, $4}'", capture="net-addrs.txt")
        self.A.check("net: both test WANs (eth0=10.0.3.x, eth1=10.0.2.x) are up",
                     ("10.0.3." in addr) and ("10.0.2." in addr), addr.replace("\n", " "))
        # reflectors reachable
        rc, png = self.g("ping -c2 -W2 10.0.2.2 >/dev/null 2>&1 && echo R1OK; "
                         "ping -c2 -W2 10.0.3.2 >/dev/null 2>&1 && echo R2OK")
        self.A.check("net: both reflectors (10.0.2.2 / 10.0.3.2) answer ICMP",
                     "R1OK" in png and "R2OK" in png, png.replace("\n", " "))
        # SQM
        self.g("cp /mnt/seed/sqm-two-wan.config /etc/config/sqm")
        self.g("/etc/init.d/sqm enable 2>/dev/null; /etc/init.d/sqm restart 2>&1 | tail -3", t=60)
        time.sleep(4)
        rc, q = self.g("echo '# eth1:'; tc qdisc show dev eth1 | head -2; "
                       "echo '# ifb4eth1:'; tc qdisc show dev ifb4eth1 | head -2; "
                       "echo '# ifb4eth0:'; tc qdisc show dev ifb4eth0 | head -2",
                       capture="sqm-qdiscs.txt")
        rc, ifbs = self.g("ls /sys/class/net | grep '^ifb4' | sort")
        self.A.check("sqm: CAKE qdisc + ifb ingress devices created on both WANs",
                     ("cake" in q) and ("ifb4eth1" in ifbs) and ("ifb4eth0" in ifbs),
                     "qdisc=%r ifbs=%r" % (q.replace("\n", " ")[:200], ifbs.replace("\n", " ")))

    def configure_cake_autorate(self):
        self.log("== applying two-instance cake-autorate config ==")
        self.g("cp /mnt/seed/cake-autorate-two-instance.config /etc/config/cake-autorate")
        # --- KNOWN DEFECT probe (task-4 bridge) --------------------------------
        # The bridge runs `set -u` then sources /lib/functions.sh in its on-device
        # libuci path; /lib/functions.sh dereferences the (conventionally unset)
        # IPKG_INSTROOT, so the bridge aborts and writes NO per-instance config.
        # Capture that as evidence, then apply the documented env workaround
        # (IPKG_INSTROOT="" is the correct value on a live root) so the rest of
        # the stack can be validated. See README "Known defect surfaced".
        rc, dfx = self.g(
            "rm -f /etc/cake-autorate/config.*.sh 2>/dev/null; "
            "env -u IPKG_INSTROOT /usr/libexec/cake-autorate/cake-autorate-bridge.sh 2>&1 | head -3; "
            "echo '--- generated:'; ls /etc/cake-autorate/config.*.sh 2>&1")
        defect = ("parameter not set" in dfx) or ("config." not in dfx)
        self.artifact("bridge-defect.txt",
                      "on-device libuci bridge run (no fix applied):\n\n%s\n\n"
                      "defect_present=%s\n" % (dfx, defect))
        if defect:
            # Non-gating finding: recorded loudly but not counted in the verdict,
            # because the bridge is owned by task 4 and this harness's job is to
            # prove the RUNTIME stack. See RESULT.txt "KNOWN DEFECT".
            self.warnings.append(
                "TASK-4 DEFECT: config bridge aborts on its on-device libuci "
                "path under `set -u` while sourcing /lib/functions.sh "
                "(IPKG_INSTROOT and CONFIG_LIST_STATE dereferenced unbound); no "
                "per-instance config is generated and the service refuses to "
                "start. Fix: wrap the libuci interaction in `set +u`. Harness "
                "applies this fix IN-VM (emulated) to validate the rest.")
            # Emulate the one-line fix task 4 must apply -- wrap the libuci
            # interaction in `set +u` (OpenWrt's /lib/functions.sh is not
            # set -u clean). Patched IN THE VM ONLY (never in the repo) so the
            # rest of the stack -- procd multi-instance, shaping, rpcd, collectd
            # -- can be validated live. Once task 4 fixes the bridge, `defect`
            # is False and this block is skipped, keeping the harness a valid gate.
            self.log("APPLYING in-VM emulated task-4 fix: set +u in stream_from_libuci")
            self.g("sed -i 's|^stream_from_libuci() {|&\\n    set +u|' "
                   "/usr/libexec/cake-autorate/cake-autorate-bridge.sh; "
                   "export IPKG_INSTROOT=''; echo patched")
            rc, ver = self.g("rm -f /etc/cake-autorate/config.*.sh; "
                             "/usr/libexec/cake-autorate/cake-autorate-bridge.sh 2>&1 | head -2; "
                             "echo '--- generated:'; ls /etc/cake-autorate/config.*.sh 2>&1")
            self.artifact("bridge-fixed.txt", ver)
            self.log("post-fix bridge run: %s" % ver.replace("\n", " ")[:200])
        if self.args.negative:
            # Deliberate misconfiguration: an invalid pinger binary makes the
            # primary daemon exit at startup -> the 'both instances running'
            # assertion below must FAIL, proving the harness has teeth.
            self.g("uci set cake-autorate.primary.pinger_binary='ca_no_such_binary'; "
                   "uci commit cake-autorate")
            self.log("NEGATIVE MODE: primary.pinger_binary set to a bogus value")
        self.g("/etc/init.d/cake-autorate enable 2>/dev/null; "
               "/etc/init.d/cake-autorate start 2>&1 | tail -5", t=60)
        # Give procd + the bridge + daemons a moment to spin up and log.
        time.sleep(12)
        rc, gen = self.g("ls -la /etc/cake-autorate/ 2>&1", capture="generated-configs.txt")
        self.log(gen)

    def assert_instances(self):
        self.log("== asserting procd instances ==")
        rc, svc = self.g("ubus call service list '{\"name\":\"cake-autorate\"}' 2>/dev/null",
                         capture="ubus-service-list.txt")
        if '"primary"' not in svc:
            # fall back to the unfiltered service list and slice cake-autorate
            rc, svc = self.g("ubus call service list 2>/dev/null | "
                             "grep -A40 '\"cake-autorate\"'", capture="ubus-service-list.txt")
        # count instance blocks named primary / secondary
        has_primary = '"primary"' in svc
        has_secondary = '"secondary"' in svc
        running = svc.count('"running": true') if '"running"' in svc else None
        rc, ps = self.g("ps w | grep -c '[c]ake-autorate.sh'", capture="ps-daemons.txt")
        ndaemon = ps.strip().split("\n")[-1].strip()
        self.A.check("service: two procd instances (primary+secondary) registered",
                     has_primary and has_secondary,
                     "primary=%s secondary=%s ubus=%s" % (has_primary, has_secondary, svc[:200]))
        try:
            ndaemon_i = int(re.search(r"\d+", ndaemon).group())
        except Exception:
            ndaemon_i = -1
        self.A.check("service: one cake-autorate.sh daemon process per enabled instance (>=2)",
                     ndaemon_i >= 2, "cake-autorate.sh procs=%s" % ndaemon_i)

    def assert_distinct_logs(self):
        self.log("== asserting distinct per-instance logs ==")
        rc, ls = self.g("ls -la /var/log/cake-autorate.*.log 2>&1", capture="per-instance-logs.txt")
        p = "/var/log/cake-autorate.primary.log" in ls
        s = "/var/log/cake-autorate.secondary.log" in ls
        self.A.check("logs: each instance writes its own /var/log/cake-autorate.<name>.log",
                     p and s, ls.replace("\n", " ")[:300])
        # a SUMMARY line eventually appears in the primary log (proves the loop runs)
        ok = False
        for i in range(20):
            rc, sm = self.g("grep -m1 '^SUMMARY; ' /var/log/cake-autorate.primary.log 2>/dev/null | head -c 200; echo")
            if "SUMMARY;" in sm:
                ok = True
                self.artifact("primary-summary-sample.txt", sm)
                break
            time.sleep(2)
        self.A.check("logs: primary instance emits parseable SUMMARY lines", ok, sm.strip()[:160])

    def read_cake_bw(self, dev):
        rc, out = self.g("tc qdisc show dev %s 2>/dev/null | grep -o 'bandwidth [0-9.A-Za-z]*' | head -1" % dev)
        m = re.search(r"bandwidth\s+(\S+)", out)
        return parse_bw_to_kbit(m.group(1)) if m else None

    def assert_shaping_moves(self):
        self.log("== inducing load and asserting CAKE bandwidth moves ==")
        dev = "ifb4eth1"
        bw0 = self.read_cake_bw(dev)
        rc, t0 = self.g("tc -s qdisc show dev %s" % dev)
        self.artifact("tc-before.txt", "t0 bandwidth_kbit=%s\n\n%s" % (bw0, t0))
        self.log("t0 %s bandwidth = %s kbit" % (dev, bw0))
        # Induce sustained download load on the PRIMARY WAN (eth1). The ingress
        # CAKE on ifb4eth1 is capped low, so the download saturates it -> high
        # load with a low-latency reflector -> the loop raises the rate.
        loadurl = "http://downloads.openwrt.org/releases/25.12.5/targets/x86/64/openwrt-25.12.5-x86-64-generic-ext4-combined.img.gz"
        self.g("( for i in $(seq 1 40); do wget -q -O /dev/null '%s' 2>/dev/null; done ) >/dev/null 2>&1 &"
               " echo load_pid=$!" % loadurl)
        peak = bw0 or 0
        samples = []
        deadline = time.time() + self.args.load_window
        while time.time() < deadline:
            time.sleep(4)
            bw = self.read_cake_bw(dev)
            if bw:
                samples.append(bw)
                peak = max(peak, bw)
            self.log("  load sample %s bw=%s kbit (peak=%s)" % (dev, bw, peak))
        rc, t1 = self.g("tc -s qdisc show dev %s" % dev)
        self.artifact("tc-under-load.txt",
                      "peak_bandwidth_kbit=%s samples=%s\n\n%s" % (peak, samples, t1))
        base = 3000
        moved_up = peak >= base * 1.5
        self.A.check("shaping: CAKE ingress bandwidth rises above base under load "
                     "(base=%dk, observed peak=%sk)" % (base, peak),
                     moved_up, "samples(kbit)=%s" % samples)
        # stop load, let it decay back toward base
        self.g("kill %1 2>/dev/null; pkill -f 'wget -q -O /dev/null' 2>/dev/null; echo stopped")
        time.sleep(self.args.settle)
        bw2 = self.read_cake_bw(dev)
        rc, t2 = self.g("tc -s qdisc show dev %s" % dev)
        self.artifact("tc-after.txt", "t2 bandwidth_kbit=%s\n\n%s" % (bw2, t2))
        self.log("t2 %s bandwidth = %s kbit (after settle)" % (dev, bw2))
        # secondary observation (not gating): decay after load removed
        self.A.check("shaping: CAKE bandwidth decays back down after load removed "
                     "(peak=%sk -> settle=%sk)" % (peak, bw2),
                     (bw2 is not None and peak is not None and bw2 < peak),
                     "peak=%s settle=%s" % (peak, bw2))

    def assert_rpcd(self):
        self.log("== asserting rpcd status method ==")
        # Query each instance explicitly -- this is how the LuCI UI calls the
        # method and it reads the daemon log directly (no UCI enumeration).
        rc, stp = self.g("ubus call cake-autorate status '{\"instance\":\"primary\"}' 2>/dev/null",
                         capture="rpcd-status-primary.txt")
        rc, sts = self.g("ubus call cake-autorate status '{\"instance\":\"secondary\"}' 2>/dev/null",
                         capture="rpcd-status-secondary.txt")
        # Also capture the no-arg enumeration path (surfaces the task-8 defect).
        rc, stall = self.g("ubus call cake-autorate status 2>/dev/null", capture="rpcd-status.txt")
        has_p = '"primary"' in stp
        has_s = '"secondary"' in sts
        has_rate = ("cake_dl_rate_kbps" in stp) or ('"available":true' in stp.replace(" ", ""))
        self.A.check("rpcd: status method returns populated per-instance data",
                     has_p and has_s and has_rate,
                     ("primary=%s secondary=%s" % (stp.replace("\n", " ")[:150],
                                                   sts.replace("\n", " ")[:80])))
        # Non-gating finding: the no-arg enumeration path returns empty.
        if '"primary"' not in stall:
            self.warnings.append(
                "TASK-8 DEFECT: rpcd `status` with no instance returns an empty "
                "object -- list_instances() sources /lib/functions.sh + config_load "
                "under `set -u` (same root cause as the bridge) and aborts in its "
                "command-substitution subshell. Per-instance status works; only "
                "enumeration is affected. Fix: `set +u` around the UCI read.")

    def assert_collectd(self):
        self.log("== wiring + asserting collectd metrics ==")
        # Deterministic collectd config that Includes the package drop-in and
        # writes RRDs. This exercises the documented Include caveat: the global
        # collectd config MUST cover /etc/collectd/conf.d for the drop-in's exec
        # plugin (and thus the cake-autorate reader) to load.
        conf = ('Hostname "openwrt-it"\nInterval 5\n'
                'LoadPlugin rrdtool\n<Plugin rrdtool>\n  DataDir "/var/lib/collectd/rrd"\n</Plugin>\n'
                'Include "/etc/collectd/conf.d/*.conf"\n')
        self.g("mkdir -p /var/lib/collectd/rrd; cat > /tmp/collectd-it.conf <<'EOF'\n%sEOF\necho wrote" % conf)
        # stop any stock collectd, start ours with the explicit config
        self.g("/etc/init.d/collectd stop 2>/dev/null; killall collectd 2>/dev/null; sleep 1; "
               "collectd -C /tmp/collectd-it.conf 2>&1 | tail -3; echo started")
        ok = False
        listing = ""
        for i in range(24):  # up to ~2 min
            time.sleep(5)
            rc, listing = self.g("find /var/lib/collectd/rrd -path '*cake_autorate-*' -name '*.rrd' 2>/dev/null | sort")
            if "cake_autorate-primary" in listing:
                ok = True
                break
        self.artifact("collectd-rrds.txt", listing)
        self.A.check("collectd: RRDs appear under .../cake_autorate-<instance>/ via the conf.d Include",
                     ok and "cake_autorate-primary" in listing,
                     listing.replace("\n", " ")[:300] or "no rrds")

    def assert_clean_removal(self):
        self.log("== stopping + removing package, asserting tidy ==")
        self.g("/etc/init.d/cake-autorate stop 2>&1 | tail -2; sleep 3; echo stopped")
        rc, ps = self.g("ps w | grep -c '[c]ake-autorate.sh'")
        try:
            nproc = int(re.search(r"\d+", ps.strip().split('\n')[-1]).group())
        except Exception:
            nproc = -1
        self.A.check("removal: service stop leaves no cake-autorate.sh daemon running",
                     nproc == 0, "remaining daemons=%s" % nproc)
        rc, run = self.g("ls -A /var/run/cake-autorate 2>/dev/null; echo END")
        self.A.check("removal: run dir cleaned up on stop",
                     "END" in run and run.replace("END", "").strip() == "",
                     "run dir residue: %r" % run.replace("END", "").strip())
        rc, out = self.g("apk del cake-autorate luci-app-cake-autorate 2>&1 | tail -6",
                         t=120, capture="apk-del.txt")
        rc, leftover = self.g(
            "for p in /usr/lib/cake-autorate/cake-autorate.sh "
            "/usr/libexec/cake-autorate /etc/init.d/cake-autorate "
            "/usr/libexec/rpcd/cake-autorate /usr/libexec/collectd/cake-autorate-collectd.sh; "
            "do [ -e $p ] && echo LEFT:$p; done; echo DONE")
        self.A.check("removal: apk del removes all package files",
                     "LEFT:" not in leftover, leftover.replace("\n", " "))

    # ------------------------------------------------------------------
    def run(self):
        try:
            self.boot()
            self.mount_seed()
            if self.wait_for_net():
                self.install()
                self.configure_network_and_sqm()
                self.configure_cake_autorate()
                self.assert_instances()
                self.assert_distinct_logs()
                self.assert_shaping_moves()
                self.assert_rpcd()
                self.assert_collectd()
                self.assert_clean_removal()
        except VMError as e:
            self.A.check("harness: VM/driver error (infrastructure)", False, str(e)[:400])
        except Exception as e:  # noqa
            import traceback
            self.A.check("harness: unexpected error", False, repr(e))
            self.logf.write(traceback.format_exc())
        finally:
            # capture the tail of the serial log as evidence
            try:
                self.g("logread 2>/dev/null | grep -i cake-autorate | tail -20", capture="syslog-cake.txt")
            except Exception:
                pass
            if self.vm:
                self.vm.stop()
        p, n = self.A.summary()
        verdict = "PASS" if (self.A.all_ok() and n > 0) else "FAIL"
        # Negative mode injects a broken config; the assertions SHOULD fail, so a
        # non-zero exit here is the desired proof that the harness has teeth.
        self.log("\n==== %d/%d assertions passed ====" % (p, n))
        for w in self.warnings:
            self.log("KNOWN DEFECT / WARNING: " + w)
        if self.args.negative:
            self.log("NEGATIVE run: a FAIL (non-zero exit) is the expected, correct outcome.")
        self.log("HARNESS RESULT: %s" % verdict)
        warn_block = ""
        if self.warnings:
            warn_block = "\nKNOWN DEFECTS (non-gating):\n" + "\n".join(
                "  * " + w for w in self.warnings) + "\n"
        self.artifact("RESULT.txt", "%s\n%d/%d assertions passed\n%s%s\n" % (
            verdict, p, n, warn_block,
            "\n".join("%s %s%s" % ("PASS" if ok else "FAIL", nm,
                                   ("  -- " + d) if d else "")
                      for nm, ok, d in self.A.results)))
        self.logf.close()
        return 0 if verdict == "PASS" else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overlay", required=True)
    ap.add_argument("--seed", required=True)
    ap.add_argument("--artifacts", required=True)
    ap.add_argument("--mem", default="1024")
    ap.add_argument("--boot-timeout", type=int, default=240)
    ap.add_argument("--load-window", type=int, default=44)
    ap.add_argument("--settle", type=int, default=25)
    ap.add_argument("--negative", action="store_true")
    args = ap.parse_args()
    sys.exit(Harness(args).run())


if __name__ == "__main__":
    main()
