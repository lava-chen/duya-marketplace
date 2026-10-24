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
const noRespond = new Set(Array.isArray(config.noRespond) ? config.noRespond : []);
const exitAfterCalls = Number(config.exitAfterCalls || 0);
const logging = config.log === true;

let callCount = 0;

if (config.exitOnStart === true) {
  process.stderr.write('fake driver: simulated startup failure\n');
  process.exit(3);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function defaultResult(name, args) {
  const payload = {
    name,
    arguments: args,
    driverEnv: {
      secretReached: process.env.COMPUTER_USE_TEST_SECRET !== undefined,
      permissionMode: process.env.CUA_DRIVER_PERMISSION_MODE ?? null,
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
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
          inputSchema: { type: 'object', properties: {} },
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
          if (rule.error) send({ jsonrpc: '2.0', id, error: { code: -32000, message: rule.error } });
          else send({ jsonrpc: '2.0', id, result: rule.result || defaultResult(name, params.arguments) });
        }, rule.delayMs);
        return;
      }
      if (rule.error) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: rule.error } }); return; }
      if (rule.result) { send({ jsonrpc: '2.0', id, result: rule.result }); return; }
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
