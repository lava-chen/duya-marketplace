#!/usr/bin/env node
'use strict';

// This plugin owns the MCP tool boundary. A platform-native Cua Driver is a
// subprocess, but only this reviewed desktop-tool subset reaches the agent.
//
// The server is a thin adapter: the driver lifecycle lives in driver-client.cjs,
// the access decision in policy.cjs, the observation bookkeeping in
// observation.cjs, the capture handling in screenshot.cjs and the trail in
// audit.cjs.
const { randomUUID } = require('node:crypto');
const { createDriverClient } = require('./driver-client.cjs');
const { evaluateWriteCall, parsePolicy, toolTier, writeTools } = require('./policy.cjs');
const { createAuditor, defaultAuditPath } = require('./audit.cjs');
const { parseDriverObservation } = require('./identity.cjs');
const { createObservationStore } = require('./observation.cjs');
const { parseDisplayMetrics, toDriverCoordinates } = require('./geometry.cjs');
const { createScreenshotService } = require('./screenshot.cjs');
const { getRevocation, revokeFor } = require('./control-state.cjs');

const PLUGIN_VERSION = '0.4.0';
const MINIMUM_DRIVER_VERSION = '0.38.0';

const allowed = new Set([
  'get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state',
  'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size',
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front', 'verify_state',
]);
const localTools = [
  { name: 'computer_use_revoke', description: 'Revoke Computer Use input access until the shared timeout expires.', inputSchema: { type: 'object', properties: { duration_seconds: { type: 'integer', minimum: 1, maximum: 3600 } } } },
  { name: 'computer_use_status', description: 'Show whether Computer Use input access is currently revoked.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'computer_use_screenshot',
    description: 'Capture the desktop or one observed window, optionally cropped, with an explicit freshness window.',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: 'string' },
        pid: { type: 'integer' },
        region: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } } },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        max_age_ms: { type: 'integer', minimum: 0 },
        refresh: { type: 'boolean' },
      },
    },
  },
];

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const observationTtlMs = envNumber('COMPUTER_USE_OBSERVATION_TTL_MS', 1500);
const screenshotTtlMs = envNumber('COMPUTER_USE_SCREENSHOT_TTL_MS', 5000);
const minimumDriverVersion = process.env.COMPUTER_USE_MIN_DRIVER_VERSION?.trim() || MINIMUM_DRIVER_VERSION;

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
  minimumVersion: minimumDriverVersion,
  logger: { warn: (message) => process.stderr.write(`${message}\n`), debug: () => {} },
});
const observations = createObservationStore({ ttlMs: observationTtlMs, snapshotTtlMs: 30_000 });
const screenshots = createScreenshotService({ ttlMs: screenshotTtlMs });
const auditor = createAuditor({ file: defaultAuditPath() });

function getPolicy() {
  try { return parsePolicy(process.env.COMPUTER_USE_ACCESS_POLICY); }
  catch (cause) { throw new Error(`Invalid Computer Use access policy: ${cause.message}`); }
}

function requestsWindow(args = {}) {
  const target = args.target && typeof args.target === 'object' ? args.target : {};
  const named = [args.window_id, args.windowId, args.hwnd, args.target_window_id, args.targetWindowId, target.window_id, target.windowId]
    .some((value) => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)));
  return named || typeof args.element_token === 'string' || typeof args.pid === 'number';
}

// Refresh the desktop observation when the cached one is too old. The
// observation is reused inside its lifetime so a burst of writes does not
// capture the whole screen again.
async function ensureObservation(args = {}, name = '') {
  const cached = observations.snapshot();
  if (cached && observations.isFresh()) return cached;
  const result = await driver.call('tools/call', { name: 'get_desktop_state', arguments: {} });
  const parsed = parseDriverObservation(result);
  let windows = parsed.windows;
  let active = parsed.active;
  if (requestsWindow(args) || (['set_value', 'bring_to_front'].includes(name) && typeof args.window_title === 'string')) {
    const listed = await driver.call('tools/call', { name: 'list_windows', arguments: {} });
    const listParsed = parseDriverObservation(listed);
    const unique = new Map([...windows, ...listParsed.windows].map((window) => [`${window.pid ?? ''}:${window.id}:${window.title || ''}`, window]));
    windows = [...unique.values()];
    active = active || listParsed.active;
  }
  return observations.store({
    tool: 'get_desktop_state',
    result,
    args,
    windows,
    active,
    metrics: parseDisplayMetrics(result),
  });
}

// Convert agent coordinates into the space the driver expects. Nothing is
// converted unless the observation declares a logical coordinate space.
function applyCoordinateConversion(args = {}, metrics = null) {
  if (!metrics || typeof args.x !== 'number' || typeof args.y !== 'number') return args;
  const converted = toDriverCoordinates({ x: args.x, y: args.y }, metrics);
  if (!converted || !converted.converted) return args;
  return { ...args, x: converted.x, y: converted.y };
}

// Observation tools feed the generation counter: a desktop observation starts a
// new generation, a window list only extends the current one, and a window
// state registers the element reference the agent will use for a later write.
function recordObservation(name, args, result) {
  const parsed = parseDriverObservation(result);
  if (name === 'get_desktop_state') {
    observations.store({
      tool: name,
      result,
      args,
      windows: parsed.windows,
      active: parsed.active,
      metrics: parseDisplayMetrics(result),
    });
    return;
  }
  if (name === 'list_windows') {
    observations.mergeWindows(parsed.windows, parsed.active);
    return;
  }
  if (name === 'get_window_state') {
    const snapshotId = snapshotIdOf(result);
    if (!snapshotId) return;
    const body = result?.structuredContent || {};
    const requestedId = args.window_id ?? args.windowId ?? null;
    const requestedPid = typeof args.pid === 'number' ? args.pid : null;
    const observed = (observations.snapshot()?.windows || []).find((window) => (
      (requestedId === null || window.id === String(requestedId))
      && (requestedPid === null || window.pid === requestedPid)
    ));
    const fallback = {
      id: requestedId === null ? null : String(requestedId),
      pid: requestedPid,
      title: body.window_title || body.title || null,
      app: body.app_name || body.app || null,
      processName: body.process_name || body.app_name || null,
    };
    observations.registerSnapshot(snapshotId, { target: observed || fallback, tool: name });
  }
}

function snapshotIdOf(result) {
  const body = result?.structuredContent || {};
  if (typeof body.snapshot_id === 'string') return body.snapshot_id;
  if (Array.isArray(result?.content)) {
    const text = result.content.find((block) => block.type === 'text')?.text || '';
    return text.match(/snapshot_id[=: ]+(s[0-9a-f]{8})/i)?.[1] || null;
  }
  return null;
}

async function recordAudit(entry) {
  try { await auditor.record(entry); }
  catch (cause) { process.stderr.write(`Computer Use audit write failed: ${cause.message}\n`); }
}

// The plugin does not capture the screen itself: the driver returns the image
// with the observation. This adds the crop, the format and the freshness
// contract, plus a cache so a repeated capture does not hit the driver again.
async function captureScreenshot(args = {}) {
  const windowId = args.window_id ?? args.windowId ?? null;
  const pid = typeof args.pid === 'number' ? args.pid : null;
  const target = windowId !== null || pid !== null ? { window_id: windowId, pid } : {};
  const tool = windowId !== null || pid !== null ? 'get_window_state' : 'get_desktop_state';
  const result = await driver.call('tools/call', { name: tool, arguments: target });
  recordObservation(tool, target, result);
  return screenshots.capture({
    result,
    key: `${tool}:${windowId ?? 'desktop'}:${pid ?? ''}`,
    region: args.region || null,
    format: args.format || null,
    maxAgeMs: Number.isFinite(Number(args.max_age_ms)) ? Number(args.max_age_ms) : screenshotTtlMs,
    refresh: args.refresh === true,
  });
}

async function callDriverTool(name, args) {
  const startedAt = Date.now();
  const callId = randomUUID();
  const tier = toolTier(name);
  if (!allowed.has(name) || !driver.tools.has(name)) {
    throw new Error(`Computer Use tool unavailable: ${name}`);
  }
  let policy = null;
  let target = null;
  let generation = null;
  if (writeTools.has(name)) {
    const revocation = await getRevocation();
    if (revocation.revoked) {
      const reason = 'Computer Use is revoked. Ask the user before resuming.';
      await recordAudit({
        callId, tool: name, tier, result: 'denied',
        policy: { decision: 'deny', rule: 'revoked', reason },
        durationMs: Date.now() - startedAt, args,
      });
      throw new Error(reason);
    }
    policy = getPolicy();
    const observation = await ensureObservation(args, name);
    generation = observation.generation;
    const resolved = observations.resolveTarget({ args, name });
    if (resolved.error) {
      await recordAudit({
        callId, tool: name, tier, generation, result: 'denied',
        policy: { decision: 'deny', rule: 'no-target', reason: resolved.error },
        durationMs: Date.now() - startedAt, args,
      });
      throw new Error(resolved.error);
    }
    target = resolved.target;
    const verdict = evaluateWriteCall({ policy, revoked: revocation.revoked, target, tool: name, args });
    if (!verdict.allowed) {
      await recordAudit({
        callId, tool: name, tier, generation, target, result: 'denied',
        policy: { decision: 'deny', rule: verdict.rule, reason: verdict.reason },
        durationMs: Date.now() - startedAt, args,
      });
      throw new Error(verdict.reason);
    }
    args = applyCoordinateConversion(args, observation.metrics);
  }
  try {
    const result = await driver.call('tools/call', { name, arguments: args });
    recordObservation(name, args, result);
    await recordAudit({
      callId,
      tool: name,
      tier,
      generation,
      target,
      result: 'allowed',
      policy: policy ? { decision: 'allow', rule: 'allowed', reason: null } : null,
      durationMs: Date.now() - startedAt,
      args,
    });
    return { result };
  } catch (cause) {
    await recordAudit({
      callId,
      tool: name,
      tier,
      generation,
      target,
      result: 'error',
      policy: policy ? { decision: 'allow', rule: 'allowed', reason: null } : null,
      errorCode: 'DRIVER_ERROR',
      durationMs: Date.now() - startedAt,
      args,
    });
    throw cause;
  }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function error(id, message, code = -32000) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function reply(id, result) { return { jsonrpc: '2.0', id, result }; }

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  try {
    if (message.method === 'initialize') {
      const info = await driver.start();
      return reply(message.id, {
        protocolVersion: info.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'computer_cua', version: PLUGIN_VERSION },
      });
    }
    if (message.method === 'ping') return reply(message.id, {});
    if (message.method === 'tools/list') {
      const tools = [...driver.tools.values()].filter((tool) => allowed.has(tool.name));
      return reply(message.id, { tools: [...tools, ...localTools] });
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      let args = message.params?.arguments || {};
      if (name === 'computer_use_status') return reply(message.id, { content: [{ type: 'text', text: JSON.stringify(await getRevocation()) }] });
      if (name === 'computer_use_revoke') {
        const seconds = Math.max(1, Math.min(3600, Number(args.duration_seconds) || 120));
        const revokedUntil = await revokeFor(seconds);
        await recordAudit({ callId: randomUUID(), tool: name, tier: toolTier(name), result: 'allowed', args: { duration_seconds: seconds } });
        return reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ revoked: true, revokedUntil, duration_seconds: seconds }) }] });
      }
      if (name === 'computer_use_screenshot') {
        const capture = await captureScreenshot(args);
        const summary = {
          width: capture.width,
          height: capture.height,
          cropped: capture.cropped,
          cached: capture.cached,
          ageMs: capture.ageMs,
          capturedAt: new Date(capture.capturedAt).toISOString(),
        };
        return reply(message.id, {
          content: [
            { type: 'image', data: capture.data, mimeType: capture.mimeType },
            { type: 'text', text: JSON.stringify(summary) },
          ],
          structuredContent: summary,
        });
      }
      const { result } = await callDriverTool(name, args);
      return reply(message.id, result);
    }
    return error(message.id, 'Method not found', -32601);
  } catch (cause) {
    return error(message.id, cause.message || String(cause));
  }
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
