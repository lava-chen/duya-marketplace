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
  for (const [key, value] of Object.entries(args)) {
    if (/text|value|password|secret|token/i.test(key)) output[key] = typeof value === 'string' ? `[redacted:${value.length} chars]` : '[redacted]';
    else if (typeof value === 'string') output[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
    else if (Array.isArray(value)) output[key] = value.slice(0, 20);
    else if (value && typeof value === 'object') output[key] = '[object]';
  }
  return output;
}
async function audit(record) {
  const entry = { ts: new Date().toISOString(), ...record, args: safeArgs(record.args) };
  const file = defaultAuditPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}
module.exports = { audit, defaultAuditPath };
