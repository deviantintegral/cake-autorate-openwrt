#!/usr/bin/env python3
"""Minimal serial-console driver for an OpenWrt QEMU guest.

No third-party deps (pexpect/paramiko not required): talks to QEMU's serial
port over a UNIX socket and drives the ash login shell with a sentinel-based
command/response protocol so every command yields a captured stdout + exit code.

Used by tests/integration/run.sh. See that script / README for the full harness.
"""
import os
import re
import socket
import subprocess
import sys
import time
import uuid


class VMError(Exception):
    pass


class VM:
    def __init__(self, image, workdir, mem="512", ssh_port=None,
                 nics=2, log=sys.stderr):
        self.image = image
        self.workdir = workdir
        self.mem = mem
        self.nics = nics
        self.log = log
        self.serial_path = os.path.join(workdir, "serial.sock")
        self.qmp_path = os.path.join(workdir, "qmp.sock")
        self.serial_log = os.path.join(workdir, "serial.log")
        self.proc = None
        self.sock = None
        self._buf = b""
        self._logf = open(self.serial_log, "ab")

    # ---- lifecycle -----------------------------------------------------
    def start(self, extra_qemu_args=None, nic_extra=None):
        """nic_extra: optional list; nic_extra[i] is appended (verbatim, with a
        leading comma) to the `-netdev user,id=netI` options of NIC i."""
        for p in (self.serial_path, self.qmp_path):
            if os.path.exists(p):
                os.unlink(p)
        args = [
            "qemu-system-x86_64",
            "-machine", "q35,accel=kvm",
            "-cpu", "host",
            "-smp", "2",
            "-m", self.mem,
            "-nographic",
            "-serial", "unix:%s,server=on,wait=off" % self.serial_path,
            "-qmp", "unix:%s,server=on,wait=off" % self.qmp_path,
            "-drive", "file=%s,format=qcow2,if=virtio" % self.image,
        ]
        nic_extra = nic_extra or []
        for i in range(self.nics):
            netdev = "net%d" % i
            opts = ""
            if i == 0 and self.ssh_port_hint():
                opts += ",hostfwd=tcp::%d-:22" % self.ssh_port_hint()
            if i < len(nic_extra) and nic_extra[i]:
                opts += "," + nic_extra[i]
            args += [
                "-netdev", "user,id=%s%s" % (netdev, opts),
                "-device", "virtio-net-pci,netdev=%s,mac=52:54:00:12:34:%02d"
                % (netdev, 0x56 + i),
            ]
        if extra_qemu_args:
            args += extra_qemu_args
        self._log("BOOT: %s" % " ".join(args))
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        # connect to serial socket (qemu creates it async)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(self.serial_path)
                s.setblocking(False)
                self.sock = s
                break
            except (FileNotFoundError, ConnectionRefusedError, OSError):
                if self.proc.poll() is not None:
                    raise VMError("qemu exited early (rc=%s)" % self.proc.returncode)
                time.sleep(0.2)
        if self.sock is None:
            raise VMError("could not connect to serial socket")
        return self

    _ssh_port = None

    def set_ssh_port(self, port):
        self._ssh_port = port

    def ssh_port_hint(self):
        return self._ssh_port

    def stop(self):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self._logf.close()

    # ---- low level I/O -------------------------------------------------
    def _log(self, msg):
        line = ("[vmdriver] %s\n" % msg).encode()
        self._logf.write(line)
        self._logf.flush()
        if self.log:
            self.log.write(line.decode())
            self.log.flush()

    def _read_some(self, timeout):
        self.sock.settimeout(timeout)
        try:
            data = self.sock.recv(65536)
        except (socket.timeout, BlockingIOError):
            return b""
        except OSError:
            return b""
        if data:
            self._logf.write(data)
            self._logf.flush()
            self._buf += data
        return data

    def expect(self, pattern, timeout=60):
        """Block until regex `pattern` appears in the stream; return match."""
        rx = re.compile(pattern.encode() if isinstance(pattern, str) else pattern)
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = rx.search(self._buf)
            if m:
                # consume up to end of match
                self._buf = self._buf[m.end():]
                return m
            self._read_some(0.5)
            if self.proc.poll() is not None:
                raise VMError("qemu exited (rc=%s) while waiting for %r"
                              % (self.proc.returncode, pattern))
        raise VMError("timeout(%ss) waiting for %r; tail=%r"
                      % (timeout, pattern, self._buf[-400:]))

    def send(self, data):
        if isinstance(data, str):
            data = data.encode()
        self.sock.settimeout(30)
        try:
            self.sock.sendall(data)
        except (socket.timeout, OSError):
            # guest console not draining yet (early boot); ignore, caller retries
            pass

    def sendline(self, line=""):
        self.send(line + "\n")

    # ---- login ---------------------------------------------------------
    def wait_boot_and_login(self, timeout=180):
        """Wait for boot to finish and get an interactive root shell."""
        # Nudge the console; press enter until we see a prompt or login banner.
        deadline = time.time() + timeout
        got = False
        last_nudge = 0
        while time.time() < deadline:
            self._read_some(1.0)
            # BusyBox/procd root shell prompt looks like 'root@OpenWrt:...#'
            if re.search(rb"root@[^:]+:[^#]*#", self._buf):
                got = True
                break
            now = time.time()
            if (b"Please press Enter to activate this console" in self._buf
                    or b"procd:" in self._buf or now - last_nudge > 3):
                self.sendline("")
                last_nudge = now
            if self.proc.poll() is not None:
                raise VMError("qemu exited during boot (rc=%s)" % self.proc.returncode)
        if not got:
            raise VMError("no root shell prompt within %ss" % timeout)
        # Turn off terminal echo so command lines are not echoed back into the
        # capture stream (less serial traffic, cleaner captures).
        self.sendline("stty -echo 2>/dev/null")
        time.sleep(0.5)
        self._read_some(1.0)
        self._buf = b""
        return True

    # ---- command execution --------------------------------------------
    def run(self, cmd, timeout=120, check=False):
        """Run `cmd` in the guest shell, return (rc, output).

        Uses a unique sentinel so output is delimited even with async kernel
        log spam on the console.
        """
        tag = uuid.uuid4().hex[:12]
        start = "__CAs_%s__" % tag
        end = "__CAe_%s__" % tag
        self._buf = b""
        # Wrap: print START, run cmd, print END:<rc>. Capture between the START
        # marker's own newline and the END marker so the echoed command line and
        # any preceding console noise are excluded.
        full = ("printf '\\n%s\\n'; { %s\n} ; printf '%s:%%d:\\n' \"$?\"\n"
                % (start, cmd, end))
        self.send(full)
        # Wait for the START marker printed by printf (followed by newline) --
        # skip the echoed command that also contains the literal marker text by
        # anchoring on the marker at line start.
        self.expect((r"\n" + re.escape(start) + r"\r?\n").encode(), timeout=timeout)
        pat = (re.escape(end) + r":(-?\d+):").encode()
        m = self.expect_capture(pat, timeout=timeout)
        rc = int(m.group(1))
        text = self._buf_before_sentinel.decode(errors="replace")
        # strip ANSI CSI/color escapes and CRs so captured output compares cleanly
        text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
        text = text.replace("\r", "")
        cleaned = text.strip("\n")
        if check and rc != 0:
            raise VMError("cmd failed rc=%d: %s\n%s" % (rc, cmd, cleaned))
        return rc, cleaned

    # capture the buffer content that preceded the sentinel match
    _buf_before_sentinel = b""

    def expect_capture(self, pattern, timeout=60):
        rx = re.compile(pattern.encode() if isinstance(pattern, str) else pattern)
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = rx.search(self._buf)
            if m:
                self._buf_before_sentinel = self._buf[:m.start()]
                self._buf = self._buf[m.end():]
                return m
            self._read_some(0.5)
            if self.proc.poll() is not None:
                raise VMError("qemu exited (rc=%s)" % self.proc.returncode)
        raise VMError("timeout(%ss) waiting for %r" % (timeout, pattern))
