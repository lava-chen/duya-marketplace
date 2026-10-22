#!/usr/bin/env node
'use strict';

// This plugin owns the MCP tool boundary. A platform-native Cua Driver is a
// subprocess, but only this reviewed desktop-tool subset reaches the agent.
const { spawn } = require('node:child_process');

// An explicit path makes managed installs predictable; otherwise let the OS
// resolve the official executable from PATH.
const configuredDriverPath = process.env.CUA_DRIVER_PATH?.trim();
const driverPath = configuredDriverPath || (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
const allowed = new Set([
  'get_guide', 'check_permissions', 'get_desktop_state', 'get_window_state',
  'list_windows', 'list_apps', 'get_accessibility_tree', 'get_screen_size',
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'bring_to_front', 'verify_state',
]);
const driverEnv = {};
for (const name of [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL',
  'CUA_DRIVER_PERMISSION_MODE',
]) {
  if (process.env[name] !== undefined) driverEnv[name] = process.env[name];
}
const driver = spawn(driverPath, ['mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: false,
  env: driverEnv,
});
let driverInput = '';
let hostInput = '';
let nextId = 1;
let started = false;
let startPromise;
let available = new Set();
let driverFailure;
const pending = new Map();

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function error(id, message, code = -32000) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function rejectPending(reason) {
  driverFailure = reason;
  for (const [id, item] of pending) { clearTimeout(item.timer); item.reject(new Error(reason)); pending.delete(id); }
}
driver.on('error', (cause) => {
  const hint = cause.code === 'ENOENT'
    ? 'Install the official Cua Driver and set its executable path in plugin setup, or add it to PATH.'
    : 'Check the configured executable path and OS permissions.';
  rejectPending(`Cua Driver could not start (${cause.message}). ${hint}`);
});
driver.on('exit', (code) => rejectPending(`Cua Driver exited (${code ?? 'signal'}).`));
driver.stderr.on('data', (chunk) => process.stderr.write(chunk));
driver.stdout.setEncoding('utf8');
driver.stdout.on('data', (chunk) => {
  driverInput += chunk;
  while (true) {
    const index = driverInput.indexOf('\n'); if (index < 0) break;
    const line = driverInput.slice(0, index); driverInput = driverInput.slice(index + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message || 'Cua Driver MCP error'));
      else item.resolve(message.result);
    } catch (cause) { process.stderr.write(`Invalid Cua Driver MCP response: ${cause.message}\n`); }
  }
});

function driverCall(method, params = {}, timeout = 60_000) {
  if (driverFailure) return Promise.reject(new Error(driverFailure));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Cua Driver ${method} timed out.`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    driver.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (cause) => {
      if (cause && pending.has(id)) { pending.delete(id); clearTimeout(timer); reject(cause); }
    });
  });
}

async function start(params) {
  if (started) return;
  if (!startPromise) startPromise = (async () => {
    const result = await driverCall('initialize', params, 30_000);
    driver.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = await driverCall('tools/list', {}, 30_000);
    available = new Set((catalog.tools || []).filter((tool) => allowed.has(tool.name)).map((tool) => tool.name));
    started = true;
    return result;
  })();
  return startPromise;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  try {
    if (message.method === 'initialize') {
      const info = await start(message.params || {});
      return reply({ protocolVersion: info.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'computer_cua', version: '0.3.0' } });
    }
    if (!started) throw new Error('Initialize the Computer Use MCP server first.');
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') {
      const catalog = await driverCall('tools/list');
      return reply({ tools: (catalog.tools || []).filter((tool) => allowed.has(tool.name)) });
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (!allowed.has(name) || !available.has(name)) throw new Error(`Computer Use tool unavailable: ${name}`);
      return reply(await driverCall('tools/call', { name, arguments: message.params?.arguments || {} }));
    }
    return error(message.id, 'Method not found', -32601);
  } catch (cause) { return error(message.id, cause.message || String(cause)); }
}

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
  if (driver.exitCode === null && !driver.killed) driver.kill();
}
process.stdin.on('end', stopDriver);
function stopOnSignal() {
  stopDriver();
  if (driver.exitCode !== null) { process.exit(0); return; }
  const timeout = setTimeout(() => process.exit(1), 2_000);
  timeout.unref();
  driver.once('exit', () => { clearTimeout(timeout); process.exit(0); });
}
process.once('SIGINT', stopOnSignal);
process.once('SIGTERM', stopOnSignal);
process.on('exit', stopDriver);
