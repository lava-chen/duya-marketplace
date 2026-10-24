#!/usr/bin/env node
'use strict';

// This plugin owns the MCP tool boundary. A platform-native Cua Driver is a
// subprocess, but only this reviewed desktop-tool subset reaches the agent.
//
// The engine is deliberately stateful:
//   - every observation mints a state handle, and an action names the state it
//     was derived from, so an action can never be applied to a screen the
//     agent did not look at;
//   - every action answers with a receipt, so the agent knows whether the
//     action may already have landed;
//   - every failure answers with a stable code and a retry hint.

const { randomUUID } = require('node:crypto');
const { createDriverClient } = require('./driver-client.cjs');
const { evaluateWriteCall, parsePolicy, toolTier, writeTools } = require('./policy.cjs');
const { createAuditor, defaultAuditPath } = require('./audit.cjs');
const { ComputerUseError, RETRY_BY_CODE, codeFromDriverMessage, driverFailure, receiptFrom } = require('./errors.cjs');
const { resolveWindowTarget, toDriverArguments } = require('./driver-args.cjs');
const { parseDriverObservation } = require('./identity.cjs');
const { createObservationStore } = require('./observation.cjs');
const { parseDisplayMetrics } = require('./geometry.cjs');
const { createScreenshotService, inspectImage } = require('./screenshot.cjs');
const { createSession } = require('./session.cjs');
const { getRevocation, revokeFor } = require('./control-state.cjs');

const PLUGIN_VERSION = '0.5.0';
const MINIMUM_DRIVER_VERSION = '0.38.0';

const allowed = new Set([
  'get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state',
  'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size',
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front', 'verify_state',
]);
// Observations that describe the screen and therefore mint a state handle.
const observing = new Set(['get_desktop_state', 'get_window_state', 'list_windows', 'get_accessibility_tree', 'get_screen_size']);

const stateParameter = {
  type: 'string',
  description: 'The state_id of the observation this action was derived from. Required for coordinate and element actions.',
};

const localTools = [
  { name: 'computer_use_status', description: 'Show whether Computer Use input access is currently revoked.', inputSchema: { type: 'object', properties: {} } },
  { name: 'computer_use_revoke', description: 'Revoke Computer Use input access until the shared timeout expires.', inputSchema: { type: 'object', properties: { duration_seconds: { type: 'integer', minimum: 1, maximum: 3600 } } } },
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
  { name: 'computer_use_stop', description: 'Release this Computer Use session and refuse every later write.', inputSchema: { type: 'object', properties: { reason: { type: 'string' } } } },
];

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const observationTtlMs = envNumber('COMPUTER_USE_OBSERVATION_TTL_MS', 1500);
const stateTtlMs = envNumber('COMPUTER_USE_STATE_TTL_MS', 30_000);
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
const observations = createObservationStore({ ttlMs: observationTtlMs, stateTtlMs });
const screenshots = createScreenshotService({ ttlMs: screenshotTtlMs });
const session = createSession({ dataDir: process.env.DUYA_PLUGIN_DATA || null });
const auditor = createAuditor({ file: defaultAuditPath() });

function getPolicy() {
  try { return parsePolicy(process.env.COMPUTER_USE_ACCESS_POLICY); }
  catch (cause) { throw new ComputerUseError('INVALID_REQUEST', `Invalid Computer Use access policy: ${cause.message}`); }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function error(id, message, code = -32000) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function reply(id, result) { return { jsonrpc: '2.0', id, result }; }

function snapshotIdOf(result) {
  const body = result?.structuredContent || {};
  if (typeof body.snapshot_id === 'string') return body.snapshot_id;
  if (Array.isArray(result?.content)) {
    const text = result.content.find((block) => block.type === 'text')?.text || '';
    return text.match(/snapshot_id[=: ]+(s[0-9a-f]{8})/i)?.[1] || null;
  }
  return null;
}

// The driver's own handle for the capture a reply carries. A desktop capture
// has no element snapshot, so this is the only id it offers.
function captureIdOf(result) {
  const body = result?.structuredContent || {};
  if (typeof body.capture_id === 'string' && body.capture_id) return body.capture_id;
  return snapshotIdOf(result);
}

// The window an observation is about: the requested window for a window
// observation, the active window for a desktop observation.
function observedTarget(name, args, parsed, result) {
  const body = result?.structuredContent || {};
  const requestedId = args.window_id ?? args.windowId ?? null;
  const requestedPid = typeof args.pid === 'number' ? args.pid : null;
  if (requestedId !== null || requestedPid !== null) {
    const match = parsed.windows.find((window) => (
      (requestedId === null || window.id === String(requestedId))
      && (requestedPid === null || window.pid === requestedPid)
    ));
    if (match) return match;
    return {
      id: requestedId === null ? null : String(requestedId),
      pid: requestedPid,
      title: body.window_title || body.title || null,
      app: body.app_name || body.app || null,
      processName: body.process_name || body.app_name || null,
    };
  }
  return parsed.active || null;
}

function stateSummary(state) {
  return {
    state_id: state.state_id,
    generation: state.generation,
    observed_at: new Date(state.createdAt).toISOString(),
    target: state.window
      ? { window_id: state.window.id, pid: state.window.pid, title: state.window.title, app: state.window.app }
      : null,
    screenshot: state.screenshot
      ? { id: state.screenshot.id, width: state.screenshot.width, height: state.screenshot.height, mime_type: state.screenshot.mimeType }
      : null,
    display: state.display
      ? { scale: state.display.scale, coordinate_space: state.display.coordinateSpace, monitors: state.display.monitors }
      : null,
  };
}

function enrichObservation(result, state) {
  const structured = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : {};
  return { ...result, structuredContent: { ...structured, ...stateSummary(state) } };
}

function receiptSummary(receipt, extra = {}) {
  return {
    state_id: extra.stateId ?? null,
    outcome: extra.outcome ?? 'delivered',
    action_sent: extra.actionSent ?? null,
    dispatch_status: extra.dispatchStatus ?? null,
    code: extra.code ?? null,
    retry: extra.retry ?? null,
    duration_ms: extra.durationMs ?? null,
  };
}

async function recordAudit(entry) {
  try { await auditor.record(entry); }
  catch (cause) { process.stderr.write(`Computer Use audit write failed: ${cause.message}\n`); }
}

function failureCode(cause) {
  return cause instanceof ComputerUseError ? cause.code : codeFromDriverMessage(cause.message);
}

function failureRetry(cause, code) {
  return cause instanceof ComputerUseError ? cause.retry : (RETRY_BY_CODE[code] || 'retry');
}

// The policy column of the audit trail: what the funnel decided and why.
// A refusal that never reached the driver is a denial; a call the driver
// answered badly passed the policy and failed later.
function policyConclusion({ tool, dispatched, failure }) {
  if (!writeTools.has(tool)) return null;
  if (dispatched) return { decision: 'allow', rule: 'allowed', reason: null };
  const rule = failure.rule || String(failure.code).toLowerCase().replace(/_/g, '-');
  return { decision: 'deny', rule, reason: failure.message };
}

// The coordinate space an observation was taken in. The driver needs to know
// it: screen pixels for a desktop capture, window-local pixels for a window
// capture.
function observationScope(tool) {
  if (tool === 'get_desktop_state') return 'desktop';
  if (tool === 'get_window_state') return 'window';
  return null;
}

// Refresh the desktop observation when the cached one is too old. The
// observation is reused inside its lifetime, so a burst of writes does not
// capture the whole screen again.
async function ensureObservation(args = {}, name = '') {
  const cached = observations.current();
  if (cached && observations.isFresh()) return cached;
  const result = await driver.call('tools/call', { name: 'get_desktop_state', arguments: {} });
  const parsed = parseDriverObservation(result);
  let windows = parsed.windows;
  let active = parsed.active;
  if (observations.requestedIdentity(args) || typeof args.element_token === 'string' || typeof args.pid === 'number') {
    const listed = await driver.call('tools/call', { name: 'list_windows', arguments: {} });
    const listParsed = parseDriverObservation(listed);
    const unique = new Map([...windows, ...listParsed.windows].map((window) => [`${window.pid ?? ''}:${window.id}:${window.title || ''}`, window]));
    windows = [...unique.values()];
    active = active || listParsed.active;
  }
  const snapshotId = snapshotIdOf(result);
  observations.store({
    tool: 'get_desktop_state',
    scope: observationScope('get_desktop_state'),
    result,
    args,
    windows,
    active,
    metrics: parseDisplayMetrics(result),
    snapshotId,
    target: active,
    screenshot: inspectImage(result, captureIdOf(result)),
  });
  return observations.current();
}

// Bind an action to the observation it was derived from.
//
// A state handle is the only thing that makes an action safe to replay: it
// names the screen the agent looked at. Without it, a coordinate or an
// element reference has nothing to be checked against and the action is
// refused rather than guessed.
async function bindAction(name, args) {
  const stateId = typeof args.state_id === 'string' ? args.state_id.trim() : '';
  const hasCoordinates = Number.isFinite(args.x) && Number.isFinite(args.y);
  const elementToken = observations.parseElementToken(args.element_token);

  if (stateId) {
    const state = observations.resolveState(stateId);
    if (!state) {
      throw new ComputerUseError('STALE_STATE', `The observation ${stateId} is unknown, superseded or expired; observe again before acting.`, { stateId });
    }
    if (elementToken) {
      if (!state.snapshotId) {
        throw new ComputerUseError('ELEMENT_UNAVAILABLE', `The observation ${stateId} carries no element references; observe the window again.`, { stateId });
      }
      if (elementToken.snapshotId !== state.snapshotId) {
        throw new ComputerUseError('STALE_STATE', `The element reference ${args.element_token} belongs to a different observation than ${stateId}; observe again.`, { stateId });
      }
    }
    if (hasCoordinates && state.screenshot?.width && state.screenshot?.height) {
      const { x, y } = args;
      if (x < 0 || y < 0 || x >= state.screenshot.width || y >= state.screenshot.height) {
        throw new ComputerUseError('STALE_STATE', `The point (${x}, ${y}) lies outside the ${state.screenshot.width}x${state.screenshot.height} capture of ${stateId}; observe again.`, { stateId });
      }
    }
    if (!observations.windowStillObserved(state)) {
      throw new ComputerUseError('STALE_STATE', `The window observed in ${stateId} is no longer on screen; observe again.`, { stateId });
    }
    const requested = observations.requestedIdentity(args);
    if (requested && state.window?.id) {
      const otherWindow = (requested.id !== null && requested.id !== state.window.id)
        || (requested.pid !== null && state.window.pid !== null && requested.pid !== state.window.pid);
      if (otherWindow) {
        throw new ComputerUseError('STALE_STATE', `The action names a different window than the observation ${stateId}; observe that window again.`, { stateId });
      }
    }
    return { state, target: state.window, generation: state.generation };
  }

  if (hasCoordinates) {
    throw new ComputerUseError('STALE_STATE', 'Coordinate actions must carry the state_id of the observation the coordinates come from; observe again and pass it.');
  }
  if (elementToken) {
    throw new ComputerUseError('STALE_STATE', `The element reference ${args.element_token} must be paired with the state_id of the observation it came from.`);
  }

  // A window level action without a state: fall back to a fresh observation.
  const observation = await ensureObservation(args, name);
  const resolved = observations.resolveTarget({ args, name });
  if (resolved.error) throw new ComputerUseError('STALE_STATE', resolved.error);
  return { state: null, target: resolved.target, generation: observation.generation };
}

// The real driver requires pid and window_id for a window read and refuses to
// guess one of them. When the caller named only a pid, the window is looked
// up instead of being invented.
async function windowIdForPid(pid) {
  const listed = await driver.call('tools/call', { name: 'list_windows', arguments: { pid } });
  const candidates = parseDriverObservation(listed).windows.filter((window) => window.pid === pid);
  if (candidates.length !== 1) return null;
  const numeric = Number(candidates[0].id);
  return Number.isFinite(numeric) ? numeric : null;
}

async function observe(name, args) {
  let forwarded = args;
  if (name === 'get_window_state' && typeof args.pid === 'number' && args.window_id === undefined) {
    const windowId = await windowIdForPid(args.pid);
    if (windowId !== null) forwarded = { ...args, window_id: windowId };
  }
  const result = await driver.call('tools/call', { name, arguments: forwarded });
  const failure = driverFailure(result);
  if (failure) {
    throw new ComputerUseError(failure.code, failure.message, {
      outcome: failure.refused ? 'not_delivered' : 'unknown',
      actionSent: failure.refused ? false : null,
      dispatchStatus: null,
    });
  }
  const parsed = parseDriverObservation(result);
  const snapshotId = snapshotIdOf(result);
  const state = observations.store({
    tool: name,
    scope: observationScope(name),
    result,
    args,
    windows: parsed.windows,
    active: parsed.active,
    metrics: parseDisplayMetrics(result),
    snapshotId,
    target: observedTarget(name, args, parsed, result),
    screenshot: inspectImage(result, captureIdOf(result)),
  });
  return { result: enrichObservation(result, state), state };
}

async function callDriverTool(name, args, callId = randomUUID()) {
  const startedAt = Date.now();
  const tier = toolTier(name);
  if (!allowed.has(name) || !driver.tools.has(name)) {
    throw new ComputerUseError('INVALID_REQUEST', `Computer Use tool unavailable: ${name}`);
  }
  let policy = null;
  let target = null;
  let generation = null;
  let stateId = null;
  let boundState = null;
  // A refusal that happens before the driver is reached never lands an
  // action, so it is recorded as not delivered rather than as unknown.
  let dispatched = false;

  try {
    if (writeTools.has(name)) {
      if (session.isStopped()) {
        throw new ComputerUseError('CONTROL_STOPPED', 'This Computer Use session was stopped; observe again to start a new one.');
      }
      const lease = await session.acquireLease();
      if (!lease.ok) {
        throw new ComputerUseError('CONTROL_BUSY', `Another Computer Use session already controls the desktop (pid ${lease.owner}).`, { owner: lease.owner });
      }
      const revocation = await getRevocation();
      if (revocation.revoked) {
        throw new ComputerUseError('POLICY_DENIED', 'Computer Use is revoked. Ask the user before resuming.', { rule: 'revoked' });
      }
      policy = getPolicy();
      const bound = await bindAction(name, args);
      target = bound.target;
      generation = bound.generation;
      boundState = bound.state || null;
      stateId = bound.state?.state_id || null;
      const verdict = evaluateWriteCall({ policy, revoked: false, target, tool: name, args });
      if (!verdict.allowed) {
        throw new ComputerUseError('POLICY_DENIED', verdict.reason, { rule: verdict.rule, stateId });
      }
    }

    dispatched = true;
    // The plugin's own vocabulary never reaches the driver: it rejects
    // unknown arguments. What the driver gets is its own shape, with the
    // target identity and the coordinate scope taken from the observation.
    const forwarded = toDriverArguments({
      args,
      state: boundState,
      schema: driver.tools.get(name)?.inputSchema,
    });
    const result = await driver.call('tools/call', { name, arguments: forwarded });
    const failure = driverFailure(result);
    if (failure) {
      const error = new ComputerUseError(failure.code, failure.message, {
        outcome: failure.refused ? 'not_delivered' : 'unknown',
        actionSent: failure.refused ? false : null,
        dispatchStatus: receiptFrom(result).dispatchStatus ?? null,
        stateId,
      });
      error.refused = failure.refused;
      error.driverCode = failure.driverCode;
      error.nextCall = failure.nextCall;
      throw error;
    }
    const receipt = receiptFrom(result);
    const summary = receiptSummary(receipt, {
      stateId,
      outcome: 'delivered',
      actionSent: receipt.actionSent === undefined ? true : receipt.actionSent,
      dispatchStatus: receipt.dispatchStatus ?? null,
      durationMs: Date.now() - startedAt,
    });
    await recordAudit({
      callId,
      tool: name,
      tier,
      generation,
      stateId,
      target,
      result: 'allowed',
      outcome: summary.outcome,
      actionSent: summary.action_sent,
      dispatchStatus: summary.dispatch_status,
      policy: policy ? { decision: 'allow', rule: 'allowed', reason: null } : null,
      durationMs: summary.duration_ms,
      args,
    });
    const structured = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : {};
    return { result: { ...result, structuredContent: { ...structured, ...summary } } };
  } catch (cause) {
    const receipt = receiptFrom(cause.result);
    const code = failureCode(cause);
    // A refusal never reached the platform, so the action was not sent.
    const refused = cause.refused === true || dispatched === false;
    const actionSent = refused ? false : (receipt.actionSent === undefined ? null : receipt.actionSent);
    const outcome = refused ? 'not_delivered' : (actionSent === false ? 'not_delivered' : 'unknown');
    const failure = cause instanceof ComputerUseError
      ? cause
      : new ComputerUseError(code, cause.message || String(cause), {
        outcome,
        actionSent,
        dispatchStatus: receipt.dispatchStatus ?? null,
        stateId,
      });
    failure.outcome = outcome;
    failure.actionSent = actionSent;
    await recordAudit({
      callId,
      tool: name,
      tier,
      generation,
      // A refusal never reached the driver, so the bound state is still the
      // one the caller named: keep it for the forensics.
      stateId: stateId ?? (typeof args.state_id === 'string' ? args.state_id : null),
      target,
      result: 'error',
      outcome: failure.outcome,
      actionSent: failure.actionSent,
      dispatchStatus: failure.dispatchStatus ?? receipt.dispatchStatus ?? null,
      code: failure.code,
      retry: failure.retry,
      policy: policyConclusion({ tool: name, dispatched, failure }),
      errorCode: failure.code,
      durationMs: Date.now() - startedAt,
      args,
    });
    // The refusal is already in the trail; the caller must not record it twice.
    failure.audited = true;
    throw failure;
  }
}

async function captureScreenshot(args = {}) {
  const windowId = args.window_id ?? args.windowId ?? null;
  const pid = typeof args.pid === 'number' ? args.pid : null;
  const target = windowId !== null || pid !== null ? { window_id: windowId, pid } : {};
  const tool = windowId !== null || pid !== null ? 'get_window_state' : 'get_desktop_state';
  const key = `${tool}:${windowId ?? 'desktop'}:${pid ?? ''}`;
  const maxAgeMs = Number.isFinite(Number(args.max_age_ms)) ? Number(args.max_age_ms) : screenshotTtlMs;

  const cached = screenshots.peek(key, maxAgeMs, args.region || null, args.format || null);
  if (cached) {
    return { capture: cached, state: null, cached: true };
  }
  // A window capture needs both identities: the driver refuses to guess one.
  let forwarded = { ...target };
  if (tool === 'get_window_state') {
    if (forwarded.window_id === null || forwarded.window_id === undefined) {
      const resolved = pid !== null ? await windowIdForPid(pid) : null;
      if (resolved !== null) forwarded.window_id = resolved;
    }
    forwarded = resolveWindowTarget({ args: forwarded, windows: observations.current()?.windows || [] });
    if (forwarded.window_id === null || forwarded.window_id === undefined) delete forwarded.window_id;
  }
  const result = await driver.call('tools/call', { name: tool, arguments: forwarded });
  const failure = driverFailure(result);
  if (failure) {
    throw new ComputerUseError(failure.code, failure.message, {
      outcome: failure.refused ? 'not_delivered' : 'unknown',
      actionSent: failure.refused ? false : null,
    });
  }
  const parsed = parseDriverObservation(result);
  const snapshotId = snapshotIdOf(result);
  const state = observations.store({
    tool,
    scope: observationScope(tool),
    result,
    args: target,
    windows: parsed.windows,
    active: parsed.active,
    metrics: parseDisplayMetrics(result),
    snapshotId,
    target: observedTarget(tool, target, parsed, result),
    screenshot: inspectImage(result, captureIdOf(result)),
  });
  const capture = await screenshots.capture({ result, key, region: args.region || null, format: args.format || null, maxAgeMs, refresh: args.refresh === true });
  return { capture, state, cached: false };
}

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
      const tools = [...driver.tools.values()]
        .filter((tool) => allowed.has(tool.name))
        .map((tool) => {
          if (!writeTools.has(tool.name)) return tool;
          const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
          const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
          return { ...tool, inputSchema: { ...schema, properties: { ...properties, state_id: stateParameter } } };
        });
      return reply(message.id, { tools: [...tools, ...localTools] });
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const callId = randomUUID();
      try {
        return await dispatchTool({ id: message.id, name, args, callId });
      } catch (cause) {
        // A call that never produced a result still belongs in the trail.
        if (!cause.audited) {
          const code = failureCode(cause);
          await recordAudit({
            callId,
            tool: name,
            tier: toolTier(name),
            result: 'error',
            outcome: 'not_delivered',
            actionSent: false,
            dispatchStatus: null,
            code,
            retry: failureRetry(cause, code),
            policy: null,
            errorCode: code,
            args,
          });
        }
        throw cause;
      }
    }
    return error(message.id, 'Method not found', -32601);
  } catch (cause) {
    if (cause instanceof ComputerUseError) return error(message.id, cause.toMessage());
    return error(message.id, cause.message || String(cause));
  }
}

async function dispatchTool({ id, name, args, callId }) {
  if (name === 'computer_use_status') {
    const revocation = await getRevocation();
    await recordAudit({ callId, tool: name, tier: toolTier(name), result: 'allowed', outcome: 'delivered', actionSent: null, policy: null, args });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(revocation) }] });
  }
  if (name === 'computer_use_revoke') {
    const seconds = Math.max(1, Math.min(3600, Number(args.duration_seconds) || 120));
    const revokedUntil = await revokeFor(seconds);
    await recordAudit({ callId, tool: name, tier: toolTier(name), result: 'allowed', args: { duration_seconds: seconds } });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify({ revoked: true, revokedUntil, duration_seconds: seconds }) }] });
  }
  if (name === 'computer_use_stop') {
    const stopped = session.stop(typeof args.reason === 'string' ? args.reason : null);
    await session.releaseLease();
    await recordAudit({ callId, tool: name, tier: toolTier(name), result: 'allowed', args: { reason: stopped.reason } });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(stopped) }] });
  }
  if (name === 'computer_use_screenshot') {
    const { capture, state } = await captureScreenshot(args);
    const summary = {
      width: capture.width,
      height: capture.height,
      cropped: capture.cropped,
      cached: capture.cached,
      ageMs: capture.ageMs,
      capturedAt: new Date(capture.capturedAt).toISOString(),
      ...(state ? stateSummary(state) : {}),
    };
    await recordAudit({
      callId,
      tool: name,
      tier: toolTier(name),
      generation: state?.generation ?? null,
      stateId: state?.state_id ?? null,
      target: state?.window ?? null,
      result: 'allowed',
      outcome: 'delivered',
      actionSent: null,
      policy: null,
      args,
    });
    return reply(id, {
      content: [
        { type: 'image', data: capture.data, mimeType: capture.mimeType },
        { type: 'text', text: JSON.stringify(summary) },
      ],
      structuredContent: summary,
    });
  }
  if (observing.has(name)) {
    const { result, state } = await observe(name, args);
    await recordAudit({
      callId,
      tool: name,
      tier: toolTier(name),
      generation: state.generation,
      stateId: state.state_id,
      target: state.window,
      result: 'allowed',
      outcome: 'delivered',
      actionSent: null,
      policy: null,
      args,
    });
    return reply(id, result);
  }
  const { result } = await callDriverTool(name, args, callId);
  return reply(id, result);
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
  void session.releaseLease();
  void driver.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.stdin.on('end', stopDriver);
process.once('SIGINT', stopDriver);
process.once('SIGTERM', stopDriver);
process.on('exit', () => { void session.releaseLease(); void driver.stop(); });
