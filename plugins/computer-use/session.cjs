'use strict';

// Session state for the Computer Use plugin: the control lease and the stop
// switch.
//
// The lease makes the desktop single-controller: only one plugin process may
// drive the desktop at a time. A process that finds a live owner is told who
// the owner is instead of fighting for the desktop. A lease left behind by a
// crashed process is taken over, because the pid is checked for liveness.

const fs = require('node:fs/promises');
const path = require('node:path');

const LOCK_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 10_000;
const LEASE_NAME = 'computer-use-lease.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return cause.code === 'EPERM';
  }
}

function createSession({ clock = null, dataDir = process.env.DUYA_PLUGIN_DATA || null } = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  let stopped = false;
  let stoppedReason = null;
  let held = false;

  function leaseFile() {
    if (!dataDir) return null;
    return path.join(dataDir, LEASE_NAME);
  }

  async function withLock(fn) {
    const file = leaseFile();
    if (!file) return fn(null);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const deadline = now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    while (!acquired) {
      try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; }
      catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        try {
          const stat = await fs.stat(lock);
          if (now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { recursive: true, force: true });
        } catch (statCause) { if (statCause.code !== 'ENOENT') throw statCause; }
        if (now() >= deadline) throw new Error('Timed out acquiring the Computer Use control lease');
        await sleep(15);
      }
    }
    try { return await fn(file); }
    finally { await fs.rm(lock, { recursive: true, force: true }); }
  }

  // Take the desktop lease. A live owner blocks the caller and is reported.
  async function acquireLease() {
    return withLock(async (file) => {
      if (!file) return { ok: true, owner: process.pid, skipped: true };
      let current = null;
      try { current = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (cause) { if (cause.code !== 'ENOENT') current = null; }
      const owner = Number(current?.pid);
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isProcessAlive(owner)) {
        return { ok: false, owner };
      }
      const temporary = `${file}.${process.pid}.${now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify({ pid: process.pid, acquiredAt: now() })}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
      held = true;
      return { ok: true, owner: process.pid };
    });
  }

  async function releaseLease() {
    if (!held) return false;
    held = false;
    const file = leaseFile();
    if (!file) return false;
    try {
      const current = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Number(current?.pid) !== process.pid) return false;
      await fs.rm(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  function stop(reason = null) {
    stopped = true;
    stoppedReason = reason;
    return { stopped: true, reason };
  }

  return {
    acquireLease,
    releaseLease,
    stop,
    isStopped: () => stopped,
    stopReason: () => stoppedReason,
    holdsLease: () => held,
    leasePath: leaseFile,
    dataDir,
  };
}

module.exports = { createSession, isProcessAlive };
