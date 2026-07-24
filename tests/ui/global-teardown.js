'use strict';
/*
 * globalTeardown: shut down the VM that globalSetup booted (if any).
 *
 * Preferred shutdown is the stop-file: the harness serve loop polls for it and
 * then cleanly powers the VM off. We fall back to signalling the process group.
 * External endpoints (CA_UI_BASE_URL) and the "unavailable" case are no-ops.
 */
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '.runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'serve-state.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_e) { return false; }
}

module.exports = async function globalTeardown() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_e) {
    return; // nothing recorded
  }
  if (state.external || !state.stop_file) return;

  console.log('[global-teardown] stopping serve VM ...');
  try { fs.writeFileSync(state.stop_file, 'stop'); } catch (_e) { /* ignore */ }

  // Wait for the harness process to exit cleanly (it powers the VM off first).
  const deadline = Date.now() + 90 * 1000;
  const pids = [state.harness_pid, state.launcher_pid].filter(Boolean);
  while (Date.now() < deadline && pids.some(alive)) {
    await sleep(1000);
  }

  // Backstop: if anything is still alive, signal the launcher's process group.
  if (pids.some(alive) && state.launcher_pid) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-state.launcher_pid, sig); } catch (_e) { /* ignore */ }
      try { process.kill(state.launcher_pid, sig); } catch (_e) { /* ignore */ }
      await sleep(3000);
      if (!pids.some(alive)) break;
    }
  }
  console.log('[global-teardown] serve VM stopped.');
};
