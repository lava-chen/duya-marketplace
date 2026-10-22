'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const LOCK_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function controlPath() {
  const dataDir = process.env.DUYA_PLUGIN_DATA;
  if (!dataDir) throw new Error('DUYA_PLUGIN_DATA is required for shared Computer Use controls');
  return path.join(dataDir, 'computer-use-control.json');
}
async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(controlPath(), 'utf8'));
    const until = Number(value.revokedUntil);
    if (!Number.isFinite(until)) throw new Error('invalid revoke ledger');
    return { revokedUntil: until };
  } catch (cause) {
    if (cause.code === 'ENOENT') return { revokedUntil: 0 };
    throw new Error(`Could not read Computer Use control ledger: ${cause.message}`);
  }
}
async function withLock(fn) {
  const file = controlPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { recursive: true, force: true });
      } catch (statCause) { if (statCause.code !== 'ENOENT') throw statCause; }
      if (Date.now() >= deadline) throw new Error('Timed out acquiring Computer Use control ledger lock');
      await sleep(15);
    }
  }
  try { return await fn(file); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function revokeFor(seconds) {
  return withLock(async (file) => {
    let previous = 0;
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Number.isFinite(Number(value.revokedUntil))) previous = Number(value.revokedUntil);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const revokedUntil = Math.max(previous, Date.now() + seconds * 1000);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ revokedUntil })}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    return revokedUntil;
  });
}
async function getRevocation() {
  const state = await readState();
  return { revoked: Date.now() < state.revokedUntil, revokedUntil: state.revokedUntil || null };
}
module.exports = { controlPath, getRevocation, revokeFor };
