'use strict';
/*
 * globalSetup: bring up a LIVE LuCI for the suite, exactly once.
 *
 * Two ways to get an endpoint (first that applies wins):
 *   1. CA_UI_BASE_URL   -- an already-running LuCI (e.g. a dev router, or a VM
 *                          someone booted by hand). No VM is spawned.
 *   2. tests/integration --serve  -- boot the pinned OpenWrt VM, install the
 *                          built apks, configure two instances, bring up uhttpd
 *                          with a known root password, and forward guest :80 to
 *                          a host port. This is the default CI path.
 *
 * Writes ./.runtime/serve-state.json describing the endpoint, or
 * {available:false} when none could be brought up (e.g. no KVM). The login
 * fixture reads it and the specs skip themselves when nothing is available, so
 * a runner without KVM is a skip rather than a failure. globalTeardown reads
 * the same file to shut the VM down.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const UI_DIR = __dirname;
const REPO_ROOT = path.resolve(UI_DIR, '..', '..');
const RUNTIME_DIR = path.join(UI_DIR, '.runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'serve-state.json');
const READY_FILE = path.join(RUNTIME_DIR, 'serve-ready.json');
const STOP_FILE = path.join(RUNTIME_DIR, 'serve-stop');
const SERVE_LOG = path.join(RUNTIME_DIR, 'serve.log');
const RUN_SH = path.join(REPO_ROOT, 'tests', 'integration', 'run.sh');

const SERVE_PORT = process.env.CA_UI_SERVE_PORT || '8080';
const SERVE_HOST = process.env.CA_UI_SERVE_HOST || '127.0.0.1';
const ROOT_PW = process.env.CA_UI_ROOT_PASSWORD || 'cakeautorate';
// apk install pulls deps from the network; allow a generous first-boot budget.
const READY_TIMEOUT_MS = parseInt(process.env.CA_UI_READY_TIMEOUT_MS || '900000', 10);

function writeState(obj) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
}

/*
 * Record "no live LuCI" and decide whether that is a skip or a failure.
 *
 * A runner without KVM genuinely cannot boot the VM, and there the specs skip
 * themselves so the pipeline stays green-or-skipped. But CA_IT_REQUIRE_KVM=1
 * (which CI sets) means a live run has to happen, so any reason the endpoint
 * did not come up -- no KVM, missing apks, a boot error -- fails the run.
 * Without this a broken environment skips every spec and the suite still exits
 * 0, which looks exactly like a pass.
 */
function unavailable(state, message) {
  writeState({ available: false, external: false, serve_log: SERVE_LOG, ...state });
  if (process.env.CA_IT_REQUIRE_KVM === '1') {
    throw new Error(
      `[global-setup] CA_IT_REQUIRE_KVM=1 but no live LuCI came up: ${state.reason}\n`
      + `${message}\n`
      + `Refusing to skip -- a required live run must fail loudly, not report success.`);
  }
  console.warn(message);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function globalSetup() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const f of [STATE_FILE, READY_FILE, STOP_FILE]) {
    try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
  }

  // --- Path 1: external endpoint -------------------------------------------
  if (process.env.CA_UI_BASE_URL) {
    const base = process.env.CA_UI_BASE_URL.replace(/\/$/, '');
    writeState({
      available: true,
      external: true,
      base_url: base,
      luci_url: base + '/cgi-bin/luci/',
      overview_path: '/cgi-bin/luci/admin/services/cake-autorate/overview',
      status_path: '/cgi-bin/luci/admin/services/cake-autorate/status',
      username: process.env.CA_UI_USERNAME || 'root',
      password: process.env.CA_UI_ROOT_PASSWORD || '',
    });
    console.log(`[global-setup] using external LuCI at ${base}`);
    return;
  }

  // --- Path 2: boot the VM in --serve mode ---------------------------------
  console.log(`[global-setup] booting tests/integration VM in --serve mode `
    + `(LuCI -> http://${SERVE_HOST}:${SERVE_PORT}/) ...`);
  const logFd = fs.openSync(SERVE_LOG, 'w');
  const child = spawn('sh', [RUN_SH, '--serve'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      CA_UI_READY_FILE: READY_FILE,
      CA_UI_STOP_FILE: STOP_FILE,
      CA_UI_SERVE_PORT: String(SERVE_PORT),
      CA_UI_SERVE_HOST: SERVE_HOST,
      CA_UI_ROOT_PASSWORD: ROOT_PW,
    },
  });
  child.unref();

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(READY_FILE)) {
      const info = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
      writeState({
        available: true,
        external: false,
        base_url: info.base_url,
        luci_url: info.luci_url,
        overview_path: info.overview_path,
        status_path: info.status_path,
        username: info.username,
        password: info.password,
        harness_pid: info.pid,
        launcher_pid: child.pid,
        stop_file: STOP_FILE,
        serve_log: SERVE_LOG,
      });
      console.log(`[global-setup] LuCI is live at ${info.luci_url} `
        + `(login root / ${info.password})`);
      return;
    }
    if (exited) {
      // run.sh finished without ever signalling ready: no KVM, or an infra
      // error. Treat as "no live LuCI" -> specs skip. Details are in serve.log.
      const tail = safeTail(SERVE_LOG);
      unavailable(
        { reason: `serve process exited (code=${exitCode}) before LuCI was ready` },
        `[global-setup] serve exited early (code=${exitCode}); `
        + `UI specs will SKIP. Tail of ${SERVE_LOG}:\n${tail}`);
      return;
    }
    await sleep(2000);
  }

  // Timed out waiting for readiness. Signal a stop and record unavailability.
  try { fs.writeFileSync(STOP_FILE, 'timeout'); } catch (_e) { /* ignore */ }
  unavailable(
    {
      reason: `timed out after ${READY_TIMEOUT_MS} ms waiting for LuCI`,
      launcher_pid: child.pid,
      stop_file: STOP_FILE,
    },
    `[global-setup] timed out waiting for LuCI; UI specs will SKIP. See ${SERVE_LOG}`);
};

function safeTail(file, n = 40) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.slice(-n).join('\n');
  } catch (_e) {
    return '(no log)';
  }
}
