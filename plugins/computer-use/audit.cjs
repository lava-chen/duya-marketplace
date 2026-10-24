'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function defaultAuditPath() {
  if (process.env.COMPUTER_USE_AUDIT_PATH) return process.env.COMPUTER_USE_AUDIT_PATH;
  const root = process.platform === 'win32' ? (process.env.APPDATA || os.homedir()) : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'computer-use', 'audit.jsonl');
}

function safeArgs(args = {}) {
  const output = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (/text|value|password|secret|token/i.test(key)) output[key] = typeof value === 'string' ? `[redacted:${value.length} chars]` : '[redacted]';
    else if (typeof value === 'string') output[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 20);
    else if (value && typeof value === 'object') output[key] = '[object]';
  }
  return output;
}

function targetIdentity(target) {
  if (!target || typeof target !== 'object') return null;
  const identity = {
    windowId: target.id ?? target.windowId ?? null,
    pid: target.pid ?? null,
    title: target.title ?? null,
    app: target.app ?? null,
    processName: target.processName ?? null,
  };
  if (identity.windowId === null && identity.pid === null && !identity.title && !identity.app) return null;
  return identity;
}

// Structured audit trail. Every record carries a stable call identifier, the
// tool, the target identity, the result and the policy conclusion. Writes are
// rotated and a failing audit log degrades to memory instead of breaking the
// tool call it describes.
function createAuditor({
  file = defaultAuditPath(),
  clock = null,
  maxBytes = 5_000_000,
  keep = 3,
  memoryLimit = 200,
  stderr = process.stderr,
} = {}) {
  const now = () => (clock?.now ? clock.now() : Date.now());
  const memory = [];
  let degraded = false;
  let lastError = null;

  async function rotate() {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size < maxBytes) return false;
    for (let index = keep; index >= 1; index--) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      if (index === keep) await fs.rm(to, { force: true });
      await fs.rename(from, to).catch(() => {});
    }
    return true;
  }

  async function record(entry = {}) {
    const full = {
      ts: new Date(now()).toISOString(),
      callId: entry.callId || null,
      tool: entry.tool || null,
      tier: entry.tier || null,
      generation: entry.generation ?? null,
      stateId: entry.stateId || null,
      target: targetIdentity(entry.target),
      result: entry.result || 'unknown',
      outcome: entry.outcome || null,
      actionSent: entry.actionSent ?? null,
      dispatchStatus: entry.dispatchStatus || null,
      code: entry.code || entry.errorCode || null,
      retry: entry.retry || null,
      policy: entry.policy || null,
      durationMs: entry.durationMs ?? null,
      errorCode: entry.errorCode || null,
      args: safeArgs(entry.args),
    };
    memory.push(full);
    while (memory.length > memoryLimit) memory.shift();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await rotate();
      await fs.appendFile(file, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
      degraded = false;
      return { ok: true, degraded: false, entry: full };
    } catch (cause) {
      degraded = true;
      lastError = cause;
      stderr?.write?.(`Computer Use audit write failed: ${cause.message}\n`);
      return { ok: false, degraded: true, error: cause, entry: full };
    }
  }

  return {
    record,
    rotate,
    recent: () => memory.slice(),
    degraded: () => degraded,
    lastError: () => lastError,
    file,
  };
}

module.exports = { createAuditor, defaultAuditPath, safeArgs, targetIdentity };
