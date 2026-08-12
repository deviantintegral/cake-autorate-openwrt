#!/usr/bin/env python3
"""cake-autorate OpenWrt VM integration harness (host side).

Boots a pinned OpenWrt 25.12.x VM under QEMU/KVM, installs the built .apk
packages plus sqm-scripts and its dependencies, applies a two-instance
cake-autorate UCI config over two SQM CAKE WANs, puts a download load on the
primary WAN so the control loop moves the CAKE bandwidth, and checks what
happens, saving evidence to an artifacts dir.

Prints one PASS/FAIL line and exits 0 when every check passed, non-zero when
any check failed or the VM could not be brought up.

Run by tests/integration/run.sh -- see that script and the README for how CI
uses it and what happens without KVM.
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
        # In --serve mode also expose the guest's uhttpd (LuCI, guest :80) on a
        # host port via QEMU user-mode hostfwd, so a host browser (Playwright,
        # tests/ui) can reach LuCI at http://<host>:<port>/. The default guest
        # address on net0 (net=10.0.3.0/24) is 10.0.3.15, which is where uhttpd
        # (bound to 0.0.0.0:80) answers. Purely additive: WAN/serial are untouched.
        nic0 = "net=10.0.3.0/24"
        if getattr(self.args, "serve", False):
            nic0 += ",hostfwd=tcp:%s:%d-:80" % (self.args.serve_host,
                                                self.args.serve_port)
        self.vm.start(nic_extra=[nic0, None],
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
        # Matched by glob: the apk filename carries PKG_VERSION-rPKG_RELEASE, so
        # a literal name here would make every version bump a test edit.
        rc, out = self.g(
            "for d in /dev/vdb /dev/vdc /dev/vdd; do "
            "[ -b $d ] && mount -t ext4 -o ro $d /mnt/seed 2>/dev/null && "
            "ls /mnt/seed/cake-autorate-*.apk >/dev/null 2>&1 && "
            "echo MOUNTED=$d && break; done")
        self.A.check("seed: ext4 fixture disk mounts and holds the apks",
                     "MOUNTED=" in out, out.strip())

    def wait_for_net(self):
        """Wait until the guest can reach the package repo.

        Probed over HTTP, not with ping. What this gates is `apk install`, which
        needs TCP; ICMP to the internet only stands in for that, and it can fail
        while TCP is fine. It does exactly that on GitHub-hosted runners: they
        run on Azure, which drops outbound ICMP echo whatever
        net.ipv4.ping_group_range says, so a ping probe reported "guest has no
        internet" on a guest whose TCP worked and failed both VM jobs.

        ICMP is still covered elsewhere. The reflectors cake-autorate measures
        against are the SLIRP gateways 10.0.2.2 / 10.0.3.2, which QEMU answers
        itself and which are checked directly, so the fping path is still
        exercised -- just not against the internet.
        """
        self.log("== waiting for WAN/internet (HTTP) ==")
        url = "http://downloads.openwrt.org/releases/"
        # uclient-fetch is the OpenWrt default; busybox wget is the fallback for
        # an image built without it. Both accept -T (timeout) and -O.
        probe = ("if uclient-fetch -q -T 5 -O /dev/null %s 2>/dev/null || "
                 "wget -q -T 5 -O /dev/null %s 2>/dev/null; "
                 "then echo NETOK; else echo NETNO; fi" % (url, url))
        ok = False
        for i in range(30):
            rc, out = self.g(probe, t=25)
            if "NETOK" in out:
                ok = True
                break
            time.sleep(2)
        self.A.check("net: guest reaches downloads.openwrt.org over HTTP (for apk)", ok)
        return ok

    def install(self):
        self.log("== installing packages ==")
        self.g("apk update 2>&1 | tail -2", t=180)
        # Pull tc-full in FIRST, as its own transaction, so it lands in `world`
        # as an explicit user choice. This is the v0.2.0 regression guard: the
        # package used to depend on the concrete `tc-tiny`, which is
        # unsatisfiable next to an installed tc-full (the two providers of
        # virtual `tc` conflict), and every install below this line would fail
        # with "unable to select packages". A fresh VM picks a provider only
        # when something asks for `tc`, so without this the bug is invisible
        # here -- the old dependency resolved fine and shipped broken.
        #
        # Assert on the output text, not rc: every apk call here is piped into
        # `tail`, so the recorded rc is tail's and is always 0.
        _, out_tc = self.g("apk add tc-full 2>&1 | tail -5", t=180,
                           capture="apk-tc-full.txt")
        self.A.check("install: tc-full (the conflicting `tc` provider) installed first",
                     "ERROR" not in out_tc, out_tc.strip()[-200:])
        # Dependencies plus the two local apks. apk pulls the declared deps
        # (bash, fping, tc, kmod-sched-cake, sqm-scripts, collectd-mod-exec,
        # luci-base) from the online repo; rrdtool is added so RRDs get written.
        #
        # The apks are matched by glob, so no version appears here (see
        # mount_seed). The guest shell expands them, and `cake-autorate-*.apk`
        # cannot also match the LuCI package, whose name starts "luci-app-".
        # mount_seed has already checked the base apk is present, so an
        # unexpanded pattern reaching apk would not skip anything silently.
        rc, out = self.g(
            "apk add --allow-untrusted "
            "collectd collectd-mod-exec collectd-mod-rrdtool sqm-scripts "
            "/mnt/seed/cake-autorate-*.apk "
            "/mnt/seed/luci-app-cake-autorate-*.apk 2>&1 | tail -25",
            t=400, capture="apk-install.txt")
        # Name the failure mode rather than letting it surface as ten missing
        # paths: if a dependency ever names a concrete provider of a virtual
        # package again, apk refuses the whole transaction with exactly this.
        self.A.check("install: apk resolved every dependency (no provider conflict)",
                     "unable to select packages" not in out, out.strip()[-300:])
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
        # One short command per path: a single long multi-echo line can be cut
        # off by the serial console during a fast burst of output.
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
        # Installing must be sufficient on its own: rpcd only enumerates
        # /usr/libexec/rpcd/* when it starts, so the base package's postinst
        # reloads it. Assert that BEFORE any reload of our own -- the harness used
        # to reload rpcd here unconditionally, which hid the fact that nothing in
        # the package did, and users met that as a LuCI app whose menu did not
        # appear until they restarted rpcd by hand.
        rc, live = self.g("ubus list cake-autorate >/dev/null 2>&1 "
                          "&& echo LIVE || echo MISSING",
                          capture="ubus-object-after-install.txt")
        self.A.check("install: postinst left the ubus object 'cake-autorate' live "
                     "(no manual rpcd reload)",
                     live.strip().endswith("LIVE"), live.strip()[-120:])
        # Teeth for the BASE package's postinst specifically. The check above
        # passes either way: apk installs luci-app-cake-autorate second, and the
        # postinst luci.mk generates for it reloads rpcd too, so it would cover
        # for a base package that reloads nothing. Exercise that package alone --
        # take the object away, reinstall just its apk, and require its own
        # postinst to bring the object back with no help from anyone.
        #
        # `wait_for session` (rpcd's own object) first, so "the object is gone" is
        # judged against an rpcd that is actually up again, not one still starting.
        self.g("rm -f /usr/libexec/rpcd/cake-autorate; /etc/init.d/rpcd restart; "
               "ubus -t 10 wait_for session; echo rpcd-back")
        rc, gone = self.g("ubus list cake-autorate >/dev/null 2>&1 "
                          "&& echo LIVE || echo MISSING")
        self.A.check("install: control -- removing the backend really does cost "
                     "rpcd the object (so the check below can fail)",
                     gone.strip().endswith("MISSING"), gone.strip()[-120:])
        self.g("apk add --allow-untrusted --force-reinstall "
               "/mnt/seed/cake-autorate-*.apk 2>&1 | tail -5", t=200,
               capture="apk-reinstall-base.txt")
        rc, back = self.g("ubus list cake-autorate >/dev/null 2>&1 "
                          "&& echo LIVE || echo MISSING",
                          capture="ubus-object-after-base-reinstall.txt")
        self.A.check("install: the base package's own postinst reloads rpcd -- "
                     "object live after reinstalling that package alone",
                     back.strip().endswith("LIVE"), back.strip()[-120:])
        # Repair anyway, so a regression in either postinst fails exactly the
        # checks above instead of cascading through every later ubus assertion.
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
        # --- regression probe: the libuci nounset bug --------------------------
        # The bridge used to run `set -u` and then source /lib/functions.sh on
        # its on-device libuci path. /lib/functions.sh reads IPKG_INSTROOT, which
        # is normally unset, so the bridge aborted and wrote no per-instance
        # config. Run the bridge and record what happened. On a fixed bridge
        # `defect` is False and everything below is skipped; if it ever comes
        # back, the workaround below keeps the rest of the run useful.
        rc, dfx = self.g(
            "rm -f /etc/cake-autorate/config.*.sh 2>/dev/null; "
            "env -u IPKG_INSTROOT /usr/libexec/cake-autorate/cake-autorate-bridge.sh 2>&1 | head -3; "
            "echo '--- generated:'; ls /etc/cake-autorate/config.*.sh 2>&1")
        defect = ("parameter not set" in dfx) or ("config." not in dfx)
        self.artifact("bridge-defect.txt",
                      "on-device libuci bridge run (no fix applied):\n\n%s\n\n"
                      "defect_present=%s\n" % (dfx, defect))
        if defect:
            # Reported loudly but not counted in the verdict: this harness is
            # here to exercise the running stack, and the unit tests own the
            # bridge itself. See RESULT.txt.
            self.warnings.append(
                "BRIDGE DEFECT: the config bridge aborts on its on-device libuci "
                "path under `set -u` while sourcing /lib/functions.sh "
                "(IPKG_INSTROOT and CONFIG_LIST_STATE read unbound); no "
                "per-instance config is generated and the service refuses to "
                "start. Fix: wrap the libuci calls in `set +u`. The harness "
                "patches that in the VM so the rest of the run still counts.")
            # Apply the one-line fix in the VM only, never in the repo, so the
            # rest of the stack -- procd multi-instance, shaping, rpcd, collectd
            # -- can still be checked live.
            self.log("patching set +u into stream_from_libuci inside the VM")
            self.g("sed -i 's|^stream_from_libuci() {|&\\n    set +u|' "
                   "/usr/libexec/cake-autorate/cake-autorate-bridge.sh; "
                   "export IPKG_INSTROOT=''; echo patched")
            rc, ver = self.g("rm -f /etc/cake-autorate/config.*.sh; "
                             "/usr/libexec/cake-autorate/cake-autorate-bridge.sh 2>&1 | head -2; "
                             "echo '--- generated:'; ls /etc/cake-autorate/config.*.sh 2>&1")
            self.artifact("bridge-fixed.txt", ver)
            self.log("post-fix bridge run: %s" % ver.replace("\n", " ")[:200])
        if self.args.negative:
            # Break the config on purpose: an invalid pinger binary makes the
            # primary daemon exit at startup, so the "both instances running"
            # check below must fail. That is how we know the checks have teeth.
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
        # Also capture the no-arg listing path.
        rc, stall = self.g("ubus call cake-autorate status 2>/dev/null", capture="rpcd-status.txt")
        has_p = '"primary"' in stp
        has_s = '"secondary"' in sts
        has_rate = ("cake_dl_rate_kbps" in stp) or ('"available":true' in stp.replace(" ", ""))
        self.A.check("rpcd: status method returns populated per-instance data",
                     has_p and has_s and has_rate,
                     ("primary=%s secondary=%s" % (stp.replace("\n", " ")[:150],
                                                   sts.replace("\n", " ")[:80])))
        # Reported but not counted in the verdict: listing with no instance
        # returns an empty object.
        if '"primary"' not in stall:
            self.warnings.append(
                "RPCD DEFECT: `status` with no instance returns an empty object. "
                "list_instances() sources /lib/functions.sh and calls config_load "
                "under `set -u` (same cause as the bridge) and aborts inside its "
                "command-substitution subshell. Per-instance status still works. "
                "Fix: `set +u` around the UCI read.")

    def assert_collectd(self):
        self.log("== wiring + asserting collectd metrics ==")
        # A collectd config that Includes the package drop-in and writes RRDs.
        # This covers the documented catch: the global collectd config must
        # Include /etc/collectd/conf.d, or the drop-in's exec plugin -- and so
        # the cake-autorate reader -- never loads.
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
    # SERVE MODE (opt-in, for the tests/ui Playwright suites). Boots, installs
    # and configures exactly like a normal run, then brings up LuCI (uhttpd and a
    # known root password) and stays up, reachable on the forwarded host port,
    # until a stop-file appears or a signal arrives. Writes a JSON "ready" file
    # with the base URL and credentials. It never runs the load/shaping checks --
    # it is a live endpoint, not a pass/fail run, and must not change run.sh's
    # verdict.
    # ------------------------------------------------------------------
    def host_http_probe(self, path="/", timeout=5):
        """Probe the forwarded LuCI port from the host, which is exactly what
        the browser will reach. Returns (status_or_None, body) and follows
        redirects, so an http -> /cgi-bin/luci/ 302 still resolves."""
        import urllib.request
        import urllib.error
        url = "http://%s:%d%s" % (self.args.serve_host, self.args.serve_port, path)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ca-harness"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read(2000).decode(errors="replace")
                return resp.getcode(), body
        except urllib.error.HTTPError as e:
            try:
                body = e.read(2000).decode(errors="replace")
            except Exception:
                body = ""
            return e.code, body
        except Exception as e:  # connection refused / reset / timeout
            return None, str(e)

    def enable_luci(self):
        self.log("== bringing up LuCI (uhttpd + root password) ==")
        pw = self.args.root_password
        # Set a known root password so LuCI's rpcd login accepts it (the stock
        # image ships an empty password; LuCI still needs one to authenticate).
        self.g("(echo '%s'; echo '%s') | passwd root >/dev/null 2>&1; echo pw-set" % (pw, pw))
        # The two-WAN topology (network-two-wan.sh) deletes LAN and puts both
        # NICs in the firewall 'wan' zone, which drops inbound HTTP. The
        # forwarded LuCI port arrives through that zone, so open 80/443 and stop
        # the firewall outright -- the VM is disposable -- to be sure the browser
        # can reach uhttpd.
        self.g("uci -q delete firewall.luci_serve; "
               "uci set firewall.luci_serve=rule; "
               "uci set firewall.luci_serve.name='Allow-LuCI-serve'; "
               "uci set firewall.luci_serve.src='wan'; "
               "uci set firewall.luci_serve.proto='tcp'; "
               "uci set firewall.luci_serve.dest_port='80 443'; "
               "uci set firewall.luci_serve.target='ACCEPT'; "
               "uci commit firewall; "
               "/etc/init.d/firewall stop 2>/dev/null; echo fw-opened")
        # uhttpd + the LuCI web UI must be present for the admin views; install
        # whatever is missing (base release images do not always bundle LuCI).
        rc, have = self.g("[ -x /etc/init.d/uhttpd ] && echo UHAVE || echo UMISS; "
                          "[ -e /www/cgi-bin/luci ] && echo LHAVE || echo LMISS")
        if "UMISS" in have or "LMISS" in have:
            self.log("installing LuCI/uhttpd (missing: %s)" % have.replace("\n", " "))
            self.g("apk add --allow-untrusted luci-base luci-mod-admin-full "
                   "luci-theme-bootstrap uhttpd uhttpd-mod-ubus rpcd "
                   "rpcd-mod-file rpcd-mod-luci 2>&1 | tail -8", t=400)
        # Ensure the ubus/file rpcd bits LuCI's client needs are present too.
        self.g("apk add --allow-untrusted uhttpd-mod-ubus rpcd-mod-file rpcd-mod-luci "
               "2>&1 | tail -3 || true", t=200)
        # rpcd carries the login/session backend + our file-object; reload it so
        # the ACL for luci-app-cake-autorate and the cake-autorate object are live.
        self.g("/etc/init.d/rpcd enable 2>/dev/null; /etc/init.d/rpcd restart 2>/dev/null; "
               "/etc/init.d/uhttpd enable 2>/dev/null; /etc/init.d/uhttpd restart 2>&1 | tail -3; "
               "sleep 2; echo uhttpd-up")
        # Diagnostics captured once so a failure is debuggable from artifacts.
        self.g("echo '# listeners:'; netstat -ltn 2>/dev/null | grep ':80' || ss -ltn 2>/dev/null | grep ':80'; "
               "echo '# uhttpd cfg:'; uci show uhttpd 2>/dev/null | grep -E 'listen_http|redirect' ; "
               "echo '# cgi:'; ls -l /www/cgi-bin/ 2>&1; "
               "echo '# uhttpd log:'; logread 2>/dev/null | grep -i uhttpd | tail -5",
               capture="serve-luci-diag.txt")
        # Check LuCI answers from the host through the forwarded port.
        ok = False
        detail = ""
        for _ in range(30):
            code, body = self.host_http_probe("/cgi-bin/luci/")
            if code in (200, 301, 302, 303, 403) or (body and "luci" in body.lower()):
                ok = True
                detail = "HTTP %s from host; body[:80]=%r" % (code, body[:80])
                break
            # also try root
            code2, body2 = self.host_http_probe("/")
            if code2 in (200, 301, 302, 303, 403):
                ok = True
                detail = "HTTP %s (root) from host" % code2
                break
            detail = "code=%s code2=%s err=%r" % (code, code2, str(body)[:80])
            time.sleep(2)
        self.A.check("serve: LuCI answers on the forwarded host port", ok, detail)
        self.artifact("serve-luci-probe.txt", detail + "\n")
        return ok

    def write_ready(self):
        import json
        base = "http://%s:%d" % (self.args.serve_host, self.args.serve_port)
        info = {
            "available": True,
            "base_url": base,
            "luci_url": base + "/cgi-bin/luci/",
            "overview_path": "/cgi-bin/luci/admin/network/cake-autorate/overview",
            "status_path": "/cgi-bin/luci/admin/network/cake-autorate/status",
            "username": "root",
            "password": self.args.root_password,
            "pid": os.getpid(),
        }
        path = self.args.serve_ready_file
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(info, f)
        os.replace(tmp, path)
        self.log("SERVE READY: %s (user=root pass=%s) -> %s"
                 % (info["luci_url"], self.args.root_password, path))
        print("SERVE_READY %s" % info["luci_url"], flush=True)

    def serve_wait(self):
        import signal
        self._serve_stop = False

        def _sig(*_a):
            self._serve_stop = True
        signal.signal(signal.SIGTERM, _sig)
        signal.signal(signal.SIGINT, _sig)
        stopf = self.args.serve_stop_file
        self.log("== serving; waiting for stop-file %s or SIGTERM ==" % stopf)
        last_keepalive = 0.0
        deadline = time.time() + self.args.serve_max_seconds
        while not self._serve_stop:
            if stopf and os.path.exists(stopf):
                self.log("stop-file observed; shutting down VM")
                break
            if time.time() > deadline:
                self.log("serve max lifetime reached; shutting down VM")
                break
            now = time.time()
            # Keepalive drains the serial console and confirms the guest is alive.
            if now - last_keepalive > 15:
                try:
                    self.g("true", t=15)
                except Exception:
                    self.log("guest keepalive failed; shutting down")
                    break
                last_keepalive = now
            time.sleep(1)

    def run_serve(self):
        rc = 1
        try:
            self.boot()
            self.mount_seed()
            if not self.wait_for_net():
                raise VMError("guest has no internet; cannot apk install")
            self.install()
            self.configure_network_and_sqm()
            self.configure_cake_autorate()
            if self.enable_luci():
                self.write_ready()
                rc = 0
                self.serve_wait()
        except VMError as e:
            self.log("SERVE ERROR (infrastructure): %s" % e)
        except Exception as e:  # noqa
            import traceback
            self.log("SERVE ERROR: %r" % e)
            self.logf.write(traceback.format_exc())
        finally:
            if self.vm:
                self.vm.stop()
            # Never leave a ready-file behind claiming a live endpoint.
            try:
                if rc != 0 and os.path.exists(self.args.serve_ready_file):
                    os.unlink(self.args.serve_ready_file)
            except OSError:
                pass
            self.logf.close()
        return rc

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
            # save the tail of the serial log as evidence
            try:
                self.g("logread 2>/dev/null | grep -i cake-autorate | tail -20", capture="syslog-cake.txt")
            except Exception:
                pass
            if self.vm:
                self.vm.stop()
        p, n = self.A.summary()
        verdict = "PASS" if (self.A.all_ok() and n > 0) else "FAIL"
        # Negative mode installs a broken config, so the checks are meant to
        # fail; a non-zero exit here is the point.
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
    # --- serve mode (opt-in; live LuCI endpoint for tests/ui Playwright) -------
    ap.add_argument("--serve", action="store_true",
                    help="boot+install+configure, bring up LuCI, and stay up")
    ap.add_argument("--serve-host", default="127.0.0.1")
    ap.add_argument("--serve-port", type=int, default=8080)
    ap.add_argument("--root-password", default="cakeautorate")
    ap.add_argument("--serve-ready-file", default="")
    ap.add_argument("--serve-stop-file", default="")
    ap.add_argument("--serve-max-seconds", type=int, default=1800)
    args = ap.parse_args()
    if args.serve:
        sys.exit(Harness(args).run_serve())
    sys.exit(Harness(args).run())


if __name__ == "__main__":
    main()
