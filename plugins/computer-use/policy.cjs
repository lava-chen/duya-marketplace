'use strict';

const blockedKeys = [
  { modifiers: ['ctrl', 'alt'], key: 'delete', reason: 'Ctrl+Alt+Delete is a system-reserved combo' },
  { modifiers: ['ctrl', 'meta'], key: 'q', reason: 'Cmd+Ctrl+Q is the macOS force-logout shortcut' },
  { modifiers: ['meta', 'shift'], key: 'backspace', reason: 'Cmd+Shift+Backspace empties the Trash without confirmation' },
  { modifiers: ['alt'], key: 'f4', reason: 'Alt+F4 closes the foreground window' },
];
const blockedText = [
  ['curl | bash', 'curl|bash can execute downloaded code'], ['curl | sh', 'curl|sh can execute downloaded code'],
  ['wget | bash', 'wget|bash can execute downloaded code'], ['rm -rf /', 'rm -rf / wipes the root filesystem'],
  ['rm -rf ~', 'rm -rf ~ wipes the user home directory'], ['rm -rf *', 'rm -rf * is a broad delete'],
  ['format c:', 'format c: reformats the Windows system drive'], ['mkfs', 'mkfs formats a block device'],
  ['dd if=', 'dd if= is a low-level disk write'], ['sudo ', 'sudo escalates privileges'],
];
const shellTokens = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node', 'deno', 'ruby', 'perl', 'osascript']);
const writeTools = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'bring_to_front']);

function validateKeyCombo(args = {}) {
  const modifiers = (args.modifiers || args.keys || []).map((m) => String(m).toLowerCase().trim());
  const key = String(args.key ?? args.key_name ?? '').toLowerCase().trim();
  for (const blocked of blockedKeys) {
    if (key === blocked.key && modifiers.length === blocked.modifiers.length && blocked.modifiers.every((m) => modifiers.includes(m))) return blocked.reason;
  }
  // Cua Driver hotkey uses an array of key names in some releases.
  const chord = (args.keys || args.key_combo || []).map((m) => String(m).toLowerCase().trim());
  if (chord.length) {
    const chordKey = chord.find((k) => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'super'].includes(k));
    const mods = chord.filter((k) => k !== chordKey).map((m) => m === 'control' ? 'ctrl' : ['cmd', 'super'].includes(m) ? 'meta' : m);
    for (const blocked of blockedKeys) if (chordKey === blocked.key && mods.length === blocked.modifiers.length && blocked.modifiers.every((m) => mods.includes(m))) return blocked.reason;
  }
  return null;
}
function validateText(text) {
  if (typeof text !== 'string' || !text) return null;
  const safe = text.slice(0, 100_000).replace(/\s+/g, ' ').toLowerCase();
  for (const [pattern, reason] of blockedText) if (safe.includes(pattern)) return reason;
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const token = lines[i].trim().toLowerCase().split(/\s+/, 1)[0];
    if (shellTokens.has(token)) return `line ${i + 1} starts with shell command "${token}"`;
  }
  return null;
}
function glob(pattern) { return new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'); }
function matches(pattern, value) { return /[*?]/.test(pattern) ? glob(pattern).test(value) : value.toLowerCase().includes(pattern.toLowerCase()); }
function checkAppAccess(policy, context = {}) {
  const p = policy || { default_access: 'allow' };
  const candidates = [context.processName, context.title, context.app].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  const denied = (p.denied_apps || []).find((pattern) => candidates.some((v) => matches(pattern, v)));
  if (denied) return { allowed: false, reason: `App blocked by deny pattern "${denied}"` };
  const defaultAccess = p.default_access || 'allow';
  if (!candidates.length) return defaultAccess === 'allow' ? { allowed: true } : { allowed: false, reason: 'No app/window identity is available and default access is deny' };
  const allowed = (p.allowed_apps || []).find((pattern) => candidates.some((v) => matches(pattern, v)));
  if (allowed) return { allowed: true };
  if (defaultAccess === 'allow') return { allowed: true };
  return { allowed: false, reason: `App is not in the configured allow list (${candidates.join(', ')})` };
}
function parsePolicy(raw) {
  if (!raw) return { default_access: 'allow', allowed_apps: [], denied_apps: [] };
  const value = JSON.parse(raw);
  if (!value || !['allow', 'deny', undefined].includes(value.default_access) || !Array.isArray(value.allowed_apps || []) || !Array.isArray(value.denied_apps || [])) throw new Error('COMPUTER_USE_ACCESS_POLICY must be JSON with default_access allow|deny and string pattern arrays');
  return { default_access: value.default_access || 'deny', allowed_apps: value.allowed_apps || [], denied_apps: value.denied_apps || [] };
}
module.exports = { checkAppAccess, parsePolicy, validateKeyCombo, validateText, writeTools };
