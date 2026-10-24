'use strict';

// Access policy for Computer Use.
//
// The policy engine fails closed: an unconfigured plugin denies every desktop
// input. Read tools stay available, revocation only blocks write tools, and
// every write goes through one decision funnel so the audit can record the
// rule that produced the verdict.

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

// Desktop input tools. Revocation and the app policy only apply to these.
const writeTools = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'bring_to_front']);
// Observation tools. They never change the desktop and never need consent.
const readTools = new Set(['get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state', 'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size', 'verify_state', 'computer_use_status', 'computer_use_screenshot']);
// Control plane tools. They change plugin state, not the desktop.
const controlTools = new Set(['computer_use_revoke', 'computer_use_stop']);

function toolTier(name) {
  if (writeTools.has(name)) return 'write';
  if (controlTools.has(name)) return 'control';
  if (readTools.has(name)) return 'read';
  return 'unknown';
}

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
  const p = policy || { default_access: 'deny' };
  const candidates = [context.processName, context.title, context.app].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  const denied = (p.denied_apps || []).find((pattern) => candidates.some((v) => matches(pattern, v)));
  if (denied) return { allowed: false, rule: 'denied-app', reason: `App blocked by deny pattern "${denied}"` };
  const defaultAccess = p.default_access || 'deny';
  if (!candidates.length) return defaultAccess === 'allow' ? { allowed: true, rule: 'default-allow' } : { allowed: false, rule: 'no-identity', reason: 'No observed app/window identity is available for this call; re-observe the desktop and select a visible window (default access is deny).' };
  const allowed = (p.allowed_apps || []).find((pattern) => candidates.some((v) => matches(pattern, v)));
  if (allowed) return { allowed: true, rule: 'allowed-app' };
  if (defaultAccess === 'allow') return { allowed: true, rule: 'default-allow' };
  return { allowed: false, rule: 'not-allowed', reason: `App is not in the configured allow list (${candidates.join(', ')})` };
}
function parsePolicy(raw) {
  if (!raw || !String(raw).trim()) return { default_access: 'deny', allowed_apps: [], denied_apps: [] };
  const value = JSON.parse(raw);
  const allowed = value?.allowed_apps ?? [];
  const denied = value?.denied_apps ?? [];
  const validPatterns = (patterns) => Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === 'string' && pattern.trim().length > 0);
  if (!value || !['allow', 'deny', undefined].includes(value.default_access) || !validPatterns(allowed) || !validPatterns(denied)) throw new Error('COMPUTER_USE_ACCESS_POLICY must be JSON with default_access allow|deny and non-empty string pattern arrays');
  return { default_access: value.default_access || 'deny', allowed_apps: allowed, denied_apps: denied };
}

// The single decision funnel for every desktop input call. Every branch
// returns the rule that produced the verdict so the audit can record it.
function evaluateWriteCall({ policy, revoked = false, target = null, tool = '', args = {} } = {}) {
  if (revoked) {
    return { allowed: false, rule: 'revoked', reason: 'Computer Use is revoked. Ask the user before resuming.' };
  }
  const appVerdict = checkAppAccess(policy, target || {});
  if (!appVerdict.allowed) return { allowed: false, rule: appVerdict.rule || 'app-policy', reason: appVerdict.reason };
  const unsafeKey = (tool === 'press_key' || tool === 'hotkey') ? validateKeyCombo(args) : null;
  if (unsafeKey) return { allowed: false, rule: 'unsafe-key', reason: `Input blocked by safety policy: ${unsafeKey}` };
  const text = tool === 'type_text' ? args.text : tool === 'set_value' ? args.value : null;
  const unsafeText = validateText(text);
  if (unsafeText) return { allowed: false, rule: 'unsafe-text', reason: `Input blocked by safety policy: ${unsafeText}` };
  return { allowed: true, rule: appVerdict.rule || 'allowed', reason: null };
}

module.exports = {
  checkAppAccess,
  controlTools,
  evaluateWriteCall,
  isWriteTool: (name) => writeTools.has(name),
  parsePolicy,
  readTools,
  toolTier,
  validateKeyCombo,
  validateText,
  writeTools,
};
