#!/usr/bin/env node
'use strict';

// A controllable stand-in for the official Cua Driver MCP server.
//
// The plugin launches the driver as `node <fake-driver.cjs> mcp`, so the fake
// is spawnable on every platform without a shell or an executable bit.
//
// The plugin deliberately forwards only an allowlisted environment to the
// driver child, so the fake cannot be configured through arbitrary env vars.
// Instead it reads one JSON file from the temporary directory:
//
//   <TMPDIR>/fake-driver-config.json
//
// {
//   "version": "0.38.0",                  // serverInfo.version
//   "tools": ["click", ...],              // tools/list catalog
//   "scenario": { "click": { "error": "..." } },
//   "receipt": { "action_sent": true, "dispatch_status": "possibly_sent" },
//   "errorReceipt": { "action_sent": false },
//   "screen": { "width": 8, "height": 6 },// attach a capture to observations
//   "windowChangeAfter": 1,               // the observed window disappears after N calls
//   "exitOnStart": false,
//   "exitAfterCalls": 0,
//   "noRespond": ["get_desktop_state"],
//   "log": false
// }

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_TOOLS = [
  'get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state',
  'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size',
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front', 'verify_state',
];
const ACTION_TOOLS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front',
]);

// The real driver rejects unknown arguments and reports a missing required
// field as a tool error, not as a protocol error. The fake driver does the
// same, so the plugin cannot pass here and then fail against the real driver.
//
// The accepted arguments below are the real 0.38.0 schemas, captured from
// `cua-driver describe <tool>`.
const TOOL_SCHEMAS = {
  get_guide: { properties: ['session', 'topic'], required: [] },
  check_permissions: { properties: ['prompt', 'session'], required: [] },
  get_desktop_state: { properties: ['max_image_dimension', 'screenshot_out_file', 'session'], required: [] },
  get_window_state: {
    properties: ['capture_mode', 'display_only', 'full_output', 'include_accessibility_tree', 'include_screenshot', 'max_depth', 'max_dimension', 'max_elements', 'max_image_dimension', 'pid', 'query', 'screenshot_out_file', 'session', 'since', 'timeout_ms', 'tree_format', 'verbose', 'window_id'],
    required: ['pid', 'window_id'],
  },
  list_windows: { properties: ['app', 'on_screen_only', 'pid', 'session'], required: [] },
  list_apps: { properties: ['session'], required: [] },
  get_accessibility_tree: { properties: ['session'], required: [] },
  get_screen_size: { properties: ['session'], required: [] },
  click: {
    properties: ['action', 'button', 'capture_id', 'count', 'delivery_mode', 'element_token', 'from_zoom', 'modifier', 'pid', 'scope', 'session', 'target', 'window_id', 'x', 'y'],
    required: [],
  },
  double_click: { properties: ['delivery_mode', 'element_token', 'from_zoom', 'modifier', 'pid', 'session', 'window_id', 'x', 'y'], required: [] },
  right_click: { properties: ['delivery_mode', 'element_token', 'from_zoom', 'modifier', 'pid', 'session', 'window_id', 'x', 'y'], required: [] },
  drag: {
    properties: ['button', 'delivery_mode', 'duration_ms', 'from_x', 'from_y', 'from_zoom', 'modifier', 'pid', 'scope', 'session', 'steps', 'target', 'to_x', 'to_y', 'window_id'],
    required: ['from_x', 'from_y', 'to_x', 'to_y'],
  },
  scroll: { properties: ['amount', 'by', 'delivery_mode', 'direction', 'element_token', 'pid', 'scope', 'session', 'target', 'window_id', 'x', 'y'], required: ['direction'] },
  type_text: { properties: ['delay_ms', 'delivery_mode', 'element_token', 'pid', 'scope', 'session', 'target', 'text', 'window_id', 'x', 'y'], required: ['text'] },
  press_key: { properties: ['delivery_mode', 'element_token', 'key', 'modifiers', 'pid', 'scope', 'session', 'target', 'window_id', 'x', 'y'], required: ['key'] },
  hotkey: { properties: ['delivery_mode', 'element_token', 'keys', 'pid', 'scope', 'session', 'target', 'window_id', 'x', 'y'], required: ['keys'] },
  set_value: { properties: ['delivery_mode', 'element_token', 'pid', 'session', 'value', 'window_id'], required: ['value'] },
  bring_to_front: { properties: ['pid', 'session', 'window_id'], required: ['pid'] },
  verify_state: { properties: ['expect', 'include_screenshot', 'pid', 'session', 'stable_samples', 'timeout_ms', 'window_id'], required: ['pid', 'window_id', 'expect'] },
};

// The real driver reports a tool failure inside the result (isError) with a
// structured code, not as a JSON-RPC error.
function validateArgs(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return null;
  const accepted = new Set(schema.properties);
  const unknown = Object.keys(args || {}).filter((key) => !accepted.has(key));
  if (unknown.length) {
    return {
      code: 'invalid_arguments',
      message: `${name}: unknown argument ${unknown[0]}; accepted: ${schema.properties.join(', ')}`,
      detail: `unknown argument ${unknown[0]}`,
    };
  }
  const missing = schema.required.filter((key) => args?.[key] === undefined || args?.[key] === null);
  if (missing.length) {
    return {
      code: 'invalid_arguments',
      message: `${name}: invalid arguments: missing field \`${missing[0]}\``,
      detail: `missing field ${missing[0]}`,
    };
  }
  return null;
}

function configPath() {
  const root = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(root, 'fake-driver-config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();
const version = config.version || '0.38.0';
const tools = Array.isArray(config.tools) ? config.tools : DEFAULT_TOOLS;
const scenario = config.scenario && typeof config.scenario === 'object' ? config.scenario : {};
const receipt = config.receipt && typeof config.receipt === 'object' ? config.receipt : null;
const errorReceipt = config.errorReceipt && typeof config.errorReceipt === 'object' ? config.errorReceipt : null;
const noRespond = new Set(Array.isArray(config.noRespond) ? config.noRespond : []);
const exitAfterCalls = Number(config.exitAfterCalls || 0);
const windowChangeAfter = Number(config.windowChangeAfter || 0);
const logging = config.log === true;

let callCount = 0;
let screenPng = null;

function buildScreen() {
  if (!config.screen || typeof config.screen !== 'object') return null;
  const width = Number(config.screen.width) || 8;
  const height = Number(config.screen.height) || 6;
  if (screenPng) return screenPng;
  try {
    const { encodePng } = require(path.join(__dirname, '..', '..', 'png.cjs'));
    const pixels = Buffer.alloc(width * height * 4, 120);
    screenPng = encodePng({ width, height, pixels });
  } catch {
    screenPng = null;
  }
  return screenPng;
}

if (config.exitOnStart === true) {
  process.stderr.write('fake driver: simulated startup failure\n');
  process.exit(3);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function windows() {
  const base = [
    { window_id: 1, pid: 101, title: 'Blocked App', process_name: 'blocked.exe' },
    { window_id: 2, pid: 202, title: 'Allowed App', process_name: 'allowed.exe' },
  ];
  if (windowChangeAfter > 0 && callCount > windowChangeAfter) {
    return [{ window_id: 1, pid: 101, title: 'Blocked App', process_name: 'blocked.exe' }];
  }
  return base;
}

// The catalog carries the real 0.38.0 schemas, so the plugin sees the same
// accepted arguments it will see against the real driver.
function inputSchemaFor(name) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return { type: 'object', properties: {} };
  const properties = {};
  for (const key of schema.properties) properties[key] = { type: 'string' };
  const input = { type: 'object', properties, additionalProperties: false };
  if (schema.required.length) input.required = schema.required;
  return input;
}

// A tool failure as the real driver reports it: inside the result, with
// isError and a structured code.
function toolErrorResult(error) {
  const detail = typeof error === 'string' ? { code: 'tool_invocation_failed', message: error } : error;
  return {
    content: [{ type: 'text', text: detail.message || detail.code || 'tool error' }],
    isError: true,
    structuredContent: {
      code: detail.code || 'tool_invocation_failed',
      ...(detail.detail ? { detail: detail.detail } : {}),
      ...(detail.hint ? { hint: detail.hint } : {}),
      ...(detail.effect ? { effect: detail.effect } : {}),
      ...(detail.status ? { status: detail.status } : {}),
      ...(detail.next_call ? { next_call: detail.next_call } : {}),
    },
  };
}

function withScreen(result) {
  const png = buildScreen();
  if (!png) return result;
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    ...result,
    content: [...content, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
  };
}

function defaultResult(name, args) {
  const payload = {
    name,
    arguments: args,
    calls: callCount,
    driverEnv: {
      secretReached: process.env.COMPUTER_USE_TEST_SECRET !== undefined,
      permissionMode: process.env.CUA_DRIVER_PERMISSION_MODE ?? null,
    },
  };
  const result = { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  if (receipt && ACTION_TOOLS.has(name)) {
    result.structuredContent = { ...payload, ...receipt };
  }
  return result;
}

function respond(request) {
  const { id, method } = request;
  const params = request.params || {};
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-cua-driver', version },
      },
    });
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: {
        tools: tools.map((name) => ({
          name,
          description: `fake ${name}`,
          inputSchema: inputSchemaFor(name),
        })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    callCount += 1;
    if (exitAfterCalls > 0 && callCount > exitAfterCalls) {
      process.stderr.write(`fake driver: simulated crash after ${exitAfterCalls} calls\n`);
      process.exit(7);
    }
    if (noRespond.has(name)) return;
    const rule = scenario[name];
    if (rule && typeof rule === 'object') {
      if (rule.delayMs) {
        setTimeout(() => {
          if (rule.error) send({ jsonrpc: '2.0', id, error: { code: -32000, message: rule.error, data: errorReceipt || undefined } });
          else if (rule.toolError) send({ jsonrpc: '2.0', id, result: toolErrorResult(rule.toolError) });
          else send({ jsonrpc: '2.0', id, result: rule.result || defaultResult(name, params.arguments) });
        }, rule.delayMs);
        return;
      }
      if (rule.error) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: rule.error, data: errorReceipt || undefined } });
        return;
      }
      if (rule.toolError) {
        send({ jsonrpc: '2.0', id, result: toolErrorResult(rule.toolError) });
        return;
      }
      if (rule.result) { send({ jsonrpc: '2.0', id, result: rule.result }); return; }
    }
    const invalid = validateArgs(name, params.arguments);
    if (invalid) {
      send({ jsonrpc: '2.0', id, result: toolErrorResult(invalid) });
      return;
    }
    if (name === 'get_desktop_state' || name === 'list_windows' || name === 'get_window_state') {
      const payload = { windows: windows(), active_window_id: 1, calls: callCount };
      const result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      if (name === 'get_window_state') {
        result.structuredContent = { snapshot_id: 's12345678', window_title: 'Allowed App', app_name: 'allowed.exe' };
      }
      send({ jsonrpc: '2.0', id, result: withScreen(result) });
      return;
    }
    send({ jsonrpc: '2.0', id, result: defaultResult(name, params.arguments) });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake driver: unknown method ${method}` } });
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (logging) process.stderr.write(`fake driver: ${line}\n`);
  if (request.id === undefined) return;
  respond(request);
});
input.on('close', () => process.exit(0));
