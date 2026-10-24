#!/usr/bin/env node
'use strict';

// This plugin owns the MCP tool boundary. A platform-native Cua Driver is a
// subprocess, but only this reviewed desktop-tool subset reaches the agent.
//
// The driver lifecycle lives in driver-client.cjs: it starts lazily, performs
// the version handshake, answers health checks and restarts a crashed driver
// with a backoff instead of locking the plugin for the rest of its life.
const { createDriverClient } = require('./driver-client.cjs');
const { checkAppAccess, parsePolicy, validateKeyCombo, validateText, writeTools } = require('./policy.cjs');
const { audit } = require('./audit.cjs');
const { parseDriverObservation, selectTargetWindow } = require('./identity.cjs');
const { getRevocation, revokeFor } = require('./control-state.cjs');
const tokenWindows = new Map();

// An explicit path makes managed installs predictable; otherwise let the OS
// resolve the official executable from PATH.
const configuredDriverPath = process.env.CUA_DRIVER_PATH?.trim();
const driverPath = configuredDriverPath || (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
// Extra arguments are optional; the default launches the driver's MCP mode.
const configuredDriverArgs = process.env.CUA_DRIVER_ARGS?.trim();
function driverArgs() {
  if (!configuredDriverArgs) return ['mcp'];
  try {
    const parsed = JSON.parse(configuredDriverArgs);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) return parsed;
  } catch {}
  return ['mcp'];
}
const allowed = new Set([
  'get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state',
  'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size',
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front', 'verify_state',
]);
const localTools = [
  { name: 'computer_use_revoke', description: 'Revoke Computer Use input access until the shared timeout expires.', inputSchema: { type: 'object', properties: { duration_seconds: { type: 'integer', minimum: 1, maximum: 3600 } } } },
  { name: 'computer_use_status', description: 'Show whether Computer Use input access is currently revoked.', inputSchema: { type: 'object', properties: {} } },
];
function getPolicy() {
  try { return parsePolicy(process.env.COMPUTER_USE_ACCESS_POLICY); }
  catch (cause) { throw new Error(`Invalid Computer Use access policy: ${cause.message}`); }
}
function hasAppRestrictions(policy) {
  return policy.default_access === 'deny' || policy.allowed_apps.length > 0 || policy.denied_apps.length > 0;
}
function rememberWindowSnapshot(args, result) {
  const body = result?.structuredContent || {};
  let snapshotId = body.snapshot_id;
  if (typeof snapshotId !== 'string' && Array.isArray(result?.content)) {
    const text = result.content.find((block) => block.type === 'text')?.text || '';
    snapshotId = text.match(/snapshot_id[=: ]+(s[0-9a-f]{8})/i)?.[1];
  }
  if (typeof snapshotId !== 'string') return;
  const windows = parseDriverObservation(result).windows;
  const window = windows.find((item) => item.id === String(args.window_id) && item.pid === args.pid);
  const fallback = {
    id: args.window_id === undefined ? null : String(args.window_id),
    pid: args.pid ?? null,
    title: body.window_title || body.title || null,
    app: body.app_name || body.app || null,
    processName: body.process_name || body.app_name || null,
  };
  const identity = window || fallback;
  if (identity.id && identity.pid) {
    tokenWindows.set(snapshotId, identity);
    if (tokenWindows.size > 512) tokenWindows.delete(tokenWindows.keys().next().value);
  }
}
function tokenWindow(args) {
  const token = typeof args.element_token === 'string' ? args.element_token : '';
  const snapshotId = token.match(/^(s[0-9a-f]{8}):\d+$/i)?.[1];
  return snapshotId ? tokenWindows.get(snapshotId) || null : null;
}
async function observeTarget(name, args, policy) {
  const targetArg = args.target && typeof args.target === 'object' ? args.target : {};
  const requestedWindow = [args.window_id, args.windowId, args.hwnd, args.target_window_id, args.targetWindowId, targetArg.window_id, targetArg.windowId]
    .some((value) => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)));
  const tokenIdentity = tokenWindow(args);
  let observation = { windows: [], active: null };
  try {
    const result = await driver.call('tools/call', { name: 'get_desktop_state', arguments: {} });
    observation = parseDriverObservation(result);
    if (requestedWindow || tokenIdentity || (['set_value', 'bring_to_front'].includes(name) && args.window_title)) {
      const windows = await driver.call('tools/call', { name: 'list_windows', arguments: {} });
      const listed = parseDriverObservation(windows);
      const unique = new Map([...observation.windows, ...listed.windows].map((window) => [`${window.pid ?? ''}:${window.id}:${window.title || ''}`, window]));
      observation = { windows: [...unique.values()], active: observation.active || listed.active };
    }
  } catch (cause) {
    if (hasAppRestrictions(policy)) throw new Error(`Could not establish a fresh target window identity: ${cause.message}`);
    return {};
  }
  const observedTarget = selectTargetWindow(observation, args, name);
  let target = observedTarget;
  if (tokenIdentity) {
    const targetArg = args.target && typeof args.target === 'object' ? args.target : {};
    const requestedId = args.window_id ?? args.windowId ?? targetArg.window_id ?? targetArg.windowId;
    const requestedPid = args.pid ?? targetArg.pid;
    const conflicts = targetArg.kind === 'desktop' || (requestedId !== undefined && String(requestedId) !== tokenIdentity.id) || (requestedPid !== undefined && requestedPid !== tokenIdentity.pid);
    const currentlyObserved = observation.windows.some((window) => window.id === tokenIdentity.id && window.pid === tokenIdentity.pid);
    if (conflicts || !currentlyObserved) target = null;
    else target = tokenIdentity;
  }
  if (!target && hasAppRestrictions(policy)) throw new Error('App access policy requires a fresh, observed target window identity; re-observe the desktop and select a visible window.');
  return target || {};
}

const driverEnv = {};
for (const name of [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL',
  'CUA_DRIVER_PERMISSION_MODE',
]) {
  if (process.env[name] !== undefined) driverEnv[name] = process.env[name];
}
const driver = createDriverClient({
  command: driverPath,
  args: driverArgs(),
  env: driverEnv,
  minimumVersion: process.env.COMPUTER_USE_MIN_DRIVER_VERSION?.trim() || '0.38.0',
  logger: { warn: (message) => process.stderr.write(`${message}\n`), debug: () => {} },
});

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function error(id, message, code = -32000) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  try {
    if (message.method === 'initialize') {
      const info = await driver.start();
      return reply({ protocolVersion: info.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'computer_cua', version: '0.3.0' } });
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') {
      const tools = [...driver.tools.values()].filter((tool) => allowed.has(tool.name));
      return reply({ tools: [...tools, ...localTools] });
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (name === 'computer_use_status') return reply({ content: [{ type: 'text', text: JSON.stringify(await getRevocation()) }] });
      if (name === 'computer_use_revoke') {
        const seconds = Math.max(1, Math.min(3600, Number(args.duration_seconds) || 120));
        const revokedUntil = await revokeFor(seconds);
        await audit({ action: name, ok: true, args: { duration_seconds: seconds } }).catch(() => {});
        return reply({ content: [{ type: 'text', text: JSON.stringify({ revoked: true, revokedUntil, duration_seconds: seconds }) }] });
      }
      if (!allowed.has(name) || !driver.tools.has(name)) throw new Error(`Computer Use tool unavailable: ${name}`);
      const startedAt = Date.now();
      if (writeTools.has(name)) {
        let denied;
        const revocation = await getRevocation();
        if (revocation.revoked) denied = 'Computer Use is revoked. Ask the user before resuming.';
        if (!denied) {
          const policy = getPolicy();
          const target = await observeTarget(name, args, policy);
          const appVerdict = checkAppAccess(policy, target);
          if (!appVerdict.allowed) denied = appVerdict.reason;
        }
        const unsafeKey = !denied && (name === 'press_key' || name === 'hotkey') ? validateKeyCombo(args) : null;
        if (unsafeKey) denied = `Input blocked by safety policy: ${unsafeKey}`;
        const text = name === 'type_text' ? args.text : name === 'set_value' ? args.value : null;
        const unsafeText = !denied && validateText(text);
        if (unsafeText) denied = `Input blocked by safety policy: ${unsafeText}`;
        if (denied) {
          void audit({ action: name, ok: false, errorCode: 'POLICY_DENIED', durationMs: Date.now() - startedAt, args }).catch((cause) => process.stderr.write(`Computer Use audit write failed: ${cause.message}\n`));
          throw new Error(denied);
        }
      }
      try {
        const result = await driver.call('tools/call', { name, arguments: args });
        if (name === 'get_window_state') rememberWindowSnapshot(args, result);
        void audit({ action: name, ok: true, durationMs: Date.now() - startedAt, args }).catch((cause) => process.stderr.write(`Computer Use audit write failed: ${cause.message}\n`));
        return reply(result);
      } catch (cause) {
        void audit({ action: name, ok: false, errorCode: 'DRIVER_ERROR', durationMs: Date.now() - startedAt, args }).catch((auditCause) => process.stderr.write(`Computer Use audit write failed: ${auditCause.message}\n`));
        throw cause;
      }
    }
    return error(message.id, 'Method not found', -32601);
  } catch (cause) { return error(message.id, cause.message || String(cause)); }
}

let hostInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  hostInput += chunk;
  while (true) {
    const index = hostInput.indexOf('\n'); if (index < 0) break;
    const line = hostInput.slice(0, index); hostInput = hostInput.slice(index + 1);
    if (!line.trim()) continue;
    try { const message = JSON.parse(line); void handle(message).then((response) => { if (response) send(response); }); }
    catch (cause) { process.stderr.write(`Invalid MCP request: ${cause.message}\n`); }
  }
});
let shuttingDown = false;
function stopDriver() {
  if (shuttingDown) return;
  shuttingDown = true;
  void driver.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.stdin.on('end', stopDriver);
process.once('SIGINT', stopDriver);
process.once('SIGTERM', stopDriver);
process.on('exit', () => { void driver.stop(); });
